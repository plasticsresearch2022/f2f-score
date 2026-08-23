#!/usr/bin/env node
/* Generate the research export from live data and compare it, column for
   column, against the real master workbook. Proves the export drops into
   Pedro's sheet rather than merely looking similar.

   Usage: node verify-export-format.mjs <original.csv> [--write out.csv] */
import { build } from "esbuild";
import { pathToFileURL } from "url";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "fs";
import { execFileSync } from "child_process";
import path from "path";

const RUN = (q) => JSON.parse(execFileSync("node", ["sql-bridge.mjs", "-q", q], { encoding: "utf8", cwd: import.meta.dirname }));
const orig = process.argv[2];
if (!orig) { console.error("usage: verify-export-format.mjs <original.csv> [--write out.csv]"); process.exit(2); }
const writeIdx = process.argv.indexOf("--write");

const dir = mkdtempSync(path.join("..", "..", "node_modules", ".f2f-fmt-"));
try {
  const out = path.join(dir, "App.mjs");
  await build({
    entryPoints: [path.join("..", "..", "src", "App.jsx")],
    bundle: true, format: "esm", outfile: out, jsx: "automatic", platform: "node",
    external: ["react", "react-dom", "react/jsx-runtime", "framer-motion", "@supabase/supabase-js"],
    define: { "import.meta.env": JSON.stringify({}) },
    loader: { ".jsx": "jsx" }, logLevel: "silent",
  });
  globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {}, key: () => null, length: 0 };
  const { buildResearchCSV } = await import(pathToFileURL(out).href);

  const cases = RUN(`select study_id as "studyId", assessment_type as "assessmentType", score,
                            enrollment_date as "enrollmentDate", created_at as "savedAt", voided_at as "voidedAt"
                       from public.assessments`);
  const outcomes = RUN(`select study_id as "studyId", outcomes, any_event as "anyEvent",
                               clavien_dindo as "clavienDindo", notes, secondary, voided_at as "voidedAt"
                          from public.outcomes`);

  const csv = buildResearchCSV(cases, outcomes);
  const lines = csv.split("\n");
  const cells = (l) => l.slice(1, -1).split('","').map(c => c.replace(/""/g, '"'));

  const theirs = readFileSync(orig, "utf8").replace(/^﻿/, "").split(/\r?\n/).slice(0, 2).map(l => l.split(","));
  const ours = [cells(lines[0]), cells(lines[1])];

  let bad = 0;
  for (let h = 0; h < 2; h++) {
    for (let i = 0; i < Math.max(theirs[h].length, ours[h].length); i++) {
      const t = theirs[h][i] ?? "", o = ours[h][i] ?? "";
      if (t !== o) { bad++; console.log(`  row${h + 1} col${i}: workbook ${JSON.stringify(t)} != export ${JSON.stringify(o)}`); }
    }
  }
  console.log(bad === 0
    ? `HEADER MATCHES the workbook exactly (2 rows x ${ours[0].length} columns)`
    : `HEADER MISMATCH — ${bad} cell(s) differ`);

  console.log(`\nExport: ${lines.length - 2} patient rows`);
  const width = ours[1].map((h, i) => Math.max((h || ours[0][i] || "").length, 12));
  const show = [0, 5, 6, 7, 8, 9, 10, 19, 20];
  console.log("  " + show.map(i => (ours[1][i] || ours[0][i] || `c${i}`).trim().slice(0, 14).padEnd(15)).join(""));
  for (const l of lines.slice(2)) {
    const r = cells(l);
    console.log("  " + show.map(i => String(r[i] ?? "").slice(0, 14).padEnd(15)).join(""));
  }

  if (writeIdx > -1 && process.argv[writeIdx + 1]) {
    writeFileSync(process.argv[writeIdx + 1], "﻿" + csv, "utf8");
    console.log(`\nwrote ${process.argv[writeIdx + 1]}`);
  }
  process.exit(bad === 0 ? 0 : 1);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
