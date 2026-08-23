#!/usr/bin/env node
/* ═══════════════════════════════════════════════
   CLINICAL PARITY CHECK

   Our src/App.jsx carries our UI and backend, but the
   clinical engine must stay byte-identical to Pedro's
   upstream file. A silent drift here changes what score
   a patient gets, so this is a hard gate — not a lint.

   Usage:
     node scripts/verify-clinical-parity.mjs            # vs UPSTREAM_SHA in UPSTREAM.md
     node scripts/verify-clinical-parity.mjs <sha>      # vs a specific upstream commit

   Requires the upstream ref to be fetched:
     T=$(gh auth token -u yashaefimenko-ai)
     git fetch "https://x-access-token:$T@github.com/plasticsresearch2022/f2f-score.git" \
       main:refs/remotes/upstream/main
═══════════════════════════════════════════════ */
import fs from "fs";
import { execFileSync } from "child_process";

/* Every top-level declaration that encodes clinical meaning.
   Add to this list whenever Pedro introduces a new one. */
const CLINICAL_SECTIONS = [
  "HOSPITALS", "OUTCOME_FIELDS", "CD_OPTIONS", "cdGradeFromOption",
  "buildCopyText", "buildFullCSV", "RISK_FLAGS", "DOMAINS", "TIERS",
  "FLAG_TIER", "FLAG_ACTIONS", "computeScore", "getTier", "buildRecs",
];

function readUpstreamSha() {
  const m = fs.readFileSync("UPSTREAM.md", "utf8").match(/^UPSTREAM_SHA:\s*(\S+)/m);
  if (!m) throw new Error("UPSTREAM.md is missing an `UPSTREAM_SHA:` line");
  return m[1];
}

/* Git normalises line endings on checkout under core.autocrlf, so the working
   file can be CRLF while the stored blob is LF. Comparing raw then reports
   every section as drifted at once — which is noise that would train someone
   to ignore a check whose whole job is to be believed. Compare content. */
const normalize = (s) => s.replace(/\r\n/g, "\n").replace(/\s+$/, "");

/* Slice from a top-level declaration to the next one. The file is
   deliberately single-file and flat, so this is reliable. */
function section(src, name) {
  const lines = normalize(src).split("\n");
  const start = new RegExp(`^(?:const|function|async function)\\s+${name}\\b`);
  const s = lines.findIndex((l) => start.test(l));
  if (s < 0) return null;
  let e = s + 1;
  while (e < lines.length && !/^(const |function |export |async function |\/\* )/.test(lines[e])) e++;
  return lines.slice(s, e).join("\n");
}

const sha = process.argv[2] || readUpstreamSha();
const ours = fs.readFileSync("src/App.jsx", "utf8");

let theirs;
try {
  theirs = execFileSync("git", ["show", `${sha}:src/App.jsx`], { encoding: "utf8" });
} catch {
  console.error(`Cannot read src/App.jsx at ${sha}. Fetch upstream first — see the header of this file.`);
  process.exit(2);
}

const drifted = [];
const missing = [];
for (const name of CLINICAL_SECTIONS) {
  const a = section(theirs, name);
  const b = section(ours, name);
  if (a === null) { missing.push(`${name} (absent upstream)`); continue; }
  if (b === null) { missing.push(`${name} (absent in ours)`); continue; }
  if (a !== b) drifted.push(name);
}

const width = Math.max(...CLINICAL_SECTIONS.map((s) => s.length));
for (const name of CLINICAL_SECTIONS) {
  const state = drifted.includes(name) ? "DRIFTED"
    : missing.some((m) => m.startsWith(name)) ? "MISSING" : "ok";
  console.log(`  ${name.padEnd(width)}  ${state}`);
}

console.log();
if (drifted.length === 0 && missing.length === 0) {
  console.log(`PASS — clinical engine byte-identical to upstream ${sha}`);
  process.exit(0);
}
if (missing.length) console.error("MISSING: " + missing.join(", "));
if (drifted.length) console.error("DRIFTED: " + drifted.join(", "));
console.error("\nFAIL — the clinical engine diverged from upstream. Either re-sync from");
console.error("Pedro's file, or if the change is intentional, say so explicitly in the commit.");
process.exit(1);
