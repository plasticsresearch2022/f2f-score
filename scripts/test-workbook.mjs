#!/usr/bin/env node
/* ═══════════════════════════════════════════════
   WORKBOOK EXPORT TESTS

   Builds a real .xlsx through the same code path the browser uses,
   then unzips it and checks the parts that a CSV cannot carry and
   that a visual glance will not catch: all six sheets still present,
   merged group headers intact, conditional formatting and dropdown
   validation widened to cover every exported row, formulas live, and
   no PHI written.

   Usage:  npm run test:workbook
═══════════════════════════════════════════════ */
import fs from "fs";
import path from "path";
import { build } from "esbuild";
import { pathToFileURL } from "url";
import { mkdtempSync, rmSync } from "fs";
import { unzipSync, strFromU8 } from "fflate";

const results = [];
const check = (label, ok, detail = "") => results.push([label, ok, detail]);

const dir = mkdtempSync(path.join("node_modules", ".f2f-wb-"));
try {
  /* The exporter fetches its template over HTTP in the browser; serve it
     from disk here so the code path is otherwise identical. */
  globalThis.fetch = async (url) => {
    const file = path.join("public", String(url).replace(/^\//, ""));
    if (!fs.existsSync(file)) return { ok: false, status: 404 };
    const buf = fs.readFileSync(file);
    return { ok: true, status: 200, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
  };

  const out = path.join(dir, "workbook.mjs");
  await build({
    entryPoints: ["src/lib/workbook.js"],
    bundle: true, format: "esm", outfile: out, platform: "node",
    external: ["fflate"], logLevel: "silent",
  });
  const { buildWorkbook } = await import(pathToFileURL(out).href);

  /* 14 patients — deliberately more than the 10-12 rows his ranges covered,
     which is exactly where formatting silently stopped applying. */
  const patients = Array.from({ length: 14 }, (_, i) => ({
    studyId: `PGH-${String(i + 1).padStart(3, "0")}`,
    firstDate: "2026-05-01", firstScore: 13, reassessScore: i === 0 ? 11 : null,
    preopDate: "2026-05-11", preopScore: 9,
    debridements: 1, flapType: "Local rotational",
    cfl: "N", pfl: i === 3 ? "Y" : "N", ssi: "N", hem: "N", deh: "N", mort: "N",
    anyEvent: i === 3 ? "YES — EVENT" : "NO event", clavien: "IIIb",
    minorComp: "Y", minorDetail: "Minor dehiscence", readmit30: "N", reop30: "N",
    los: 49, icu: "N", recur90: "Unknown", fu30: "Y", fu90: "N",
    notes: 'Prolonged LOS — "social" case',      // quotes + em-dash: XML escaping
  }));

  const blob = await buildWorkbook(patients);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  fs.writeFileSync(path.join(dir, "out.xlsx"), bytes);

  check("produces a valid zip", bytes[0] === 0x50 && bytes[1] === 0x4b, `magic ${bytes[0]},${bytes[1]}`);
  const zip = unzipSync(bytes);
  const sheet = strFromU8(zip["xl/worksheets/sheet1.xml"]);
  const wb = strFromU8(zip["xl/workbook.xml"]);

  /* Everything a CSV would have thrown away */
  check("keeps all six sheets", (wb.match(/<sheet /g) || []).length === 6,
    `${(wb.match(/<sheet /g) || []).length} sheets`);
  check("keeps the merged group headers", (sheet.match(/<mergeCell /g) || []).length === 12,
    `${(sheet.match(/<mergeCell /g) || []).length} merges`);
  check("keeps conditional formatting", sheet.includes("<conditionalFormatting"));
  check("keeps dropdown validation", sheet.includes("<dataValidation "));
  check("keeps styles part", Boolean(zip["xl/styles.xml"]));

  /* Rows */
  const rows = [...sheet.matchAll(/<row[^>]*\sr="(\d+)"/g)].map((m) => Number(m[1]));
  check("writes one row per patient after the headers",
    rows.length === 16 && Math.max(...rows) === 16, `rows: ${rows.join(",")}`);
  check("dimension covers every row", sheet.includes('<dimension ref="A1:AE16"/>'),
    (sheet.match(/<dimension ref="[^"]*"/) || [])[0]);

  /* The bug this test exists for: his ranges stopped at row 10-12, so
     patients 11+ would lose the endpoint colour and the dropdowns. */
  const cfRef = (sheet.match(/<conditionalFormatting sqref="([^"]+)"/) || [])[1] || "";
  const cfEnd = Number((cfRef.match(/T3:T(\d+)/) || [])[1] || 0);
  check("conditional formatting covers every row", cfEnd >= 16, `${cfRef} (need >= row 16)`);
  const dvRefs = [...sheet.matchAll(/<dataValidation[^>]*sqref="([^"]+)"/g)].map((m) => m[1]);
  check("dropdown validation covers every row",
    dvRefs.every((r) => !/[A-Z]+3:[A-Z]+(\d|1[0-5])\b/.test(r)), dvRefs.join(" | "));

  /* Formulas must stay live, not be frozen to values.
     Quotes and > are XML-escaped inside <f>, which is what Excel expects. */
  check("Age stays a formula", sheet.includes("DATEDIF(C3,F3,&quot;Y&quot;)"),
    (sheet.match(/<c r="D3".*?<\/c>/s) || [])[0]);
  check("optimization duration stays a formula", sheet.includes("<f>I3-F3</f>"));
  check("primary endpoint stays a formula", sheet.includes("COUNTIF(N3:S3,&quot;Y&quot;)&gt;0"),
    (sheet.match(/<c r="T3".*?<\/c>/s) || [])[0]);

  /* Data + escaping */
  check("study IDs written", sheet.includes("PGH-001") && sheet.includes("PGH-014"));
  check("dates written as Excel serials", /<c r="F3" s="40"><v>4\d{4}<\/v><\/c>/.test(sheet),
    (sheet.match(/<c r="F3"[^>]*>.*?<\/c>/) || [])[0]);
  check("quotes and em-dashes escaped", sheet.includes("&quot;social&quot;") && sheet.includes("—"));
  check("cell styles applied", sheet.includes('<c r="A3" s="38"'));

  /* PHI columns must stay empty */
  check("Hospital Account # left blank", /<c r="B3" s="39"\/>/.test(sheet),
    (sheet.match(/<c r="B3"[^>]*\/?>/) || [])[0]);
  check("DOB left blank", /<c r="C3" s="40"\/>/.test(sheet), (sheet.match(/<c r="C3"[^>]*\/?>/) || [])[0]);
  check("no account numbers anywhere",
    !Object.values(zip).some((b) => /\b(PG|LCH)\d{6,}\b/.test(strFromU8(b))));

  const width = Math.max(...results.map(([l]) => l.length));
  let bad = 0;
  for (const [label, ok, detail] of results) {
    if (!ok) bad++;
    console.log(`  ${label.padEnd(width)}  ${ok ? "ok" : "FAILED"}${!ok && detail ? `\n      → ${detail}` : ""}`);
  }
  console.log();
  if (bad === 0) console.log(`PASS — ${results.length} workbook checks`);
  else { console.error(`FAIL — ${bad} of ${results.length} failed`); process.exit(1); }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
