#!/usr/bin/env node
/* Build the research workbook from live data, exactly as the browser does,
   and write it to disk so it can be opened and eyeballed.

   Usage: node export-workbook.mjs <out.xlsx> */
import fs from "fs";
import path from "path";
import { build } from "esbuild";
import { pathToFileURL } from "url";
import { mkdtempSync, rmSync } from "fs";
import { execFileSync } from "child_process";

const RUN = (q) => JSON.parse(execFileSync("node", ["sql-bridge.mjs", "-q", q], { encoding: "utf8", cwd: import.meta.dirname }));
const dest = process.argv[2];
if (!dest) { console.error("usage: export-workbook.mjs <out.xlsx>"); process.exit(2); }

const root = path.join(import.meta.dirname, "..", "..");
const dir = mkdtempSync(path.join(root, "node_modules", ".f2f-xw-"));
try {
  globalThis.fetch = async (url) => {
    const f = path.join(root, "public", String(url).replace(/^\//, ""));
    if (!fs.existsSync(f)) return { ok: false, status: 404 };
    const b = fs.readFileSync(f);
    return { ok: true, status: 200, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) };
  };

  const appOut = path.join(dir, "App.mjs");
  const wbOut = path.join(dir, "wb.mjs");
  await build({
    entryPoints: [path.join(root, "src", "App.jsx")],
    bundle: true, format: "esm", outfile: appOut, jsx: "automatic", platform: "node",
    external: ["react", "react-dom", "react/jsx-runtime", "framer-motion", "@supabase/supabase-js", "fflate"],
    define: { "import.meta.env": JSON.stringify({}) }, loader: { ".jsx": "jsx" }, logLevel: "silent",
  });
  await build({
    entryPoints: [path.join(root, "src", "lib", "workbook.js")],
    bundle: true, format: "esm", outfile: wbOut, platform: "node",
    external: ["fflate"], logLevel: "silent",
  });

  globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {}, key: () => null, length: 0 };
  const { buildResearchRows } = await import(pathToFileURL(appOut).href);
  const { buildWorkbook } = await import(pathToFileURL(wbOut).href);

  const cases = RUN(`select study_id as "studyId", assessment_type as "assessmentType", score,
                            enrollment_date as "enrollmentDate", created_at as "savedAt", voided_at as "voidedAt"
                       from public.assessments`);
  const outcomes = RUN(`select study_id as "studyId", outcomes, any_event as "anyEvent",
                               clavien_dindo as "clavienDindo", notes, secondary, voided_at as "voidedAt"
                          from public.outcomes`);

  const rows = buildResearchRows(cases, outcomes);
  const blob = await buildWorkbook(rows);
  fs.writeFileSync(dest, Buffer.from(new Uint8Array(await blob.arrayBuffer())));
  console.log(`${rows.length} patients -> ${dest} (${(fs.statSync(dest).size / 1024).toFixed(1)} KB)`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
