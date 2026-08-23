#!/usr/bin/env node
/* ═══════════════════════════════════════════════
   BUILD THE EXPORT TEMPLATE

   A CSV cannot carry Pedro's workbook: six sheets, merged and
   coloured group headers, conditional formatting on the primary
   endpoint, dropdown validation, column widths, and formulas that
   compute Age, optimization duration and the endpoint itself.

   So the export writes into HIS workbook rather than reconstructing
   it. This strips the sheet clean and leaves the formatting intact.

   Removes, so no PHI is ever committed:
     - every data row (3+) from "Account - Clinical Data"
     - the Hospital Account # strings from the shared string table,
       which survive row deletion because they live in their own part
     - calcChain.xml, which would reference cells that no longer exist

   Usage:  node scripts/build-workbook-template.mjs <source.xlsx>
   Output: public/F2F-workbook-template.xlsx
═══════════════════════════════════════════════ */
import fs from "fs";
import path from "path";
import { unzipSync, zipSync, strToU8, strFromU8 } from "fflate";

const src = process.argv[2];
if (!src) { console.error("usage: build-workbook-template.mjs <source.xlsx>"); process.exit(2); }

const zip = unzipSync(new Uint8Array(fs.readFileSync(src)));
const text = (p) => strFromU8(zip[p]);

/* ── 1. Strip data rows from the clinical sheet ── */
let sheet = text("xl/worksheets/sheet1.xml");
const open = sheet.indexOf("<sheetData>") + "<sheetData>".length;
const close = sheet.indexOf("</sheetData>");
const body = sheet.slice(open, close);

const headerRows = [...body.matchAll(/<row[^>]*\sr="(\d+)"[^>]*>.*?<\/row>/gs)]
  .filter((m) => Number(m[1]) <= 2)
  .map((m) => m[0])
  .join("");
if (!headerRows) { console.error("could not find header rows 1-2"); process.exit(1); }

sheet = sheet.slice(0, open) + headerRows + sheet.slice(close);
sheet = sheet.replace(/<dimension ref="[^"]*"\/>/, '<dimension ref="A1:AE2"/>');
/* Row 3 carried the shared-formula definitions; with it gone, any leftover
   si= references would dangle. The exporter writes full formulas instead. */
sheet = sheet.replace(/ t="shared"[^>]*si="\d+"/g, "");
zip["xl/worksheets/sheet1.xml"] = strToU8(sheet);

/* ── 2. Scrub PHI from the shared string table ── */
let shared = text("xl/sharedStrings.xml");
let scrubbed = 0;
shared = shared.replace(/<si>(.*?)<\/si>/gs, (whole, inner) => {
  const plain = inner.replace(/<[^>]+>/g, "");
  if (/^\s*(PG|LCH)\d{6,}/i.test(plain)) { scrubbed++; return "<si><t/></si>"; }
  return whole;
});
zip["xl/sharedStrings.xml"] = strToU8(shared);

/* ── 3. Drop calcChain (Excel rebuilds it) ── */
delete zip["xl/calcChain.xml"];
zip["[Content_Types].xml"] = strToU8(
  text("[Content_Types].xml").replace(/<Override PartName="\/xl\/calcChain\.xml"[^>]*\/>/, "")
);
zip["xl/_rels/workbook.xml.rels"] = strToU8(
  text("xl/_rels/workbook.xml.rels").replace(/<Relationship[^>]*calcChain\.xml"[^>]*\/>/, "")
);

/* ── 4. Verify nothing identifying survived ──
   Scoped deliberately: other sheets legitimately hold small numbers in
   column C (form layout), and a blanket "numeric C cell" rule flags those
   as birth dates. The real invariant is that the clinical sheet has no
   data rows at all. */
const everything = Object.entries(zip).map(([n, b]) => `${n}\n${strFromU8(b)}`).join("\n");
const finalSheet = strFromU8(zip["xl/worksheets/sheet1.xml"]);
const dataRows = [...finalSheet.matchAll(/<row[^>]*\sr="(\d+)"/g)].filter((m) => Number(m[1]) >= 3);
const dobSerials = [...finalSheet.matchAll(/<v>(\d+)<\/v>/g)]
  .map((m) => Number(m[1]))
  .filter((n) => n >= 12000 && n <= 40000);   // 1932-2009 as Excel serials

const leaks = [
  ["account numbers anywhere",        /\b(PG|LCH)\d{6,}\b/.test(everything)],
  ["data rows on the clinical sheet", dataRows.length > 0],
  ["birth-date serials on that sheet", dobSerials.length > 0],
];
let bad = 0;
for (const [label, hit] of leaks) {
  if (hit) bad++;
  console.log(`  ${hit ? "LEAK " : "clean"}  ${label}`);
}
if (bad) { console.error("\nrefusing to write a template containing PHI"); process.exit(1); }

const outDir = path.join(process.cwd(), "public");
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, "F2F-workbook-template.xlsx");
fs.writeFileSync(outFile, Buffer.from(zipSync(zip, { level: 9 })));

console.log(`\nscrubbed ${scrubbed} account-number strings`);
console.log(`wrote ${outFile} (${(fs.statSync(outFile).size / 1024).toFixed(1)} KB)`);
