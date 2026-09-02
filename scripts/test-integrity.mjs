#!/usr/bin/env node
/* ═══════════════════════════════════════════════
   DATA INTEGRITY TESTS

   The whole reason for the admin dashboard is the claim that a bad
   entry gets caught. These tests exercise that claim directly.

   Fixtures use empty answers on purpose: computeScore({}) is 0 for
   every domain, so a "correct" row is unambiguous and a tampered one
   is any row claiming otherwise. That keeps the fixtures independent
   of the clinical point values, which are Pedro's to change.

   Usage:  npm run test:integrity
═══════════════════════════════════════════════ */
import { build } from "esbuild";
import { pathToFileURL } from "url";
import { mkdtempSync, rmSync } from "fs";
import path from "path";

const dir = mkdtempSync(path.join("node_modules", ".f2f-test-"));
const results = [];
const check = (label, ok, detail) => results.push([label, ok, detail]);

const DAY = 24 * 60 * 60 * 1000;
const iso = (ms) => new Date(ms).toISOString();
const ymd = (ms) => iso(ms).slice(0, 10);

/* A row that agrees with the scoring engine: no answers, therefore zero. */
const clean = (over = {}) => ({
  remoteId: "r1", studyId: "LCH-001", assessmentType: "new",
  answers: {}, domainScores: { bio: 0, wound: 0, comorbidities: 0, functional: 0 },
  score: 0, tierId: "low", enrollmentDate: ymd(Date.now()), savedAt: iso(Date.now()),
  source: "app", engineVersion: "1.2",
  serviceId: "s1", enteredBy: "R. Patel", ...over,
});

try {
  const out = path.join(dir, "App.test.mjs");
  await build({
    entryPoints: ["src/App.jsx"],
    bundle: true, format: "esm", outfile: out, jsx: "automatic", platform: "node",
    external: ["react", "react-dom", "react/jsx-runtime", "framer-motion", "@supabase/supabase-js"],
    define: { "import.meta.env": JSON.stringify({}) },
    loader: { ".jsx": "jsx" }, logLevel: "silent",
  });
  const { findIssues, buildAdminCSV, ENGINE_VERSION } = await import(pathToFileURL(out).href);

  /* ── A clean dataset must be silent ── */
  {
    const issues = findIssues([clean()], [{ studyId: "LCH-001", serviceId: "s1", outcomes: {}, anyEvent: false }]);
    check("clean dataset reports no issues", issues.length === 0, issues.map(i => i.title).join("; "));
  }

  /* ── Tampering: stored score disagrees with the answers ── */
  {
    const issues = findIssues([clean({ score: 14 })], []);
    const hit = issues.find(i => /Score does not match/.test(i.title));
    check("catches a tampered total score", Boolean(hit) && hit.sev === "bad", issues.map(i => i.title).join("; "));
  }

  /* ── Tampering: a domain subtotal was edited ── */
  {
    const row = clean({ domainScores: { bio: 7, wound: 0, comorbidities: 0, functional: 0 } });
    const issues = findIssues([row], []);
    const hit = issues.find(i => /Domain total inconsistent/.test(i.title));
    check("catches an edited domain subtotal", Boolean(hit) && hit.sev === "bad", issues.map(i => i.title).join("; "));
  }

  /* ── Double entry: same study, same type, neither a correction ── */
  {
    const issues = findIssues([clean(), clean({ remoteId: "r2", enteredBy: "J. Lee" })], []);
    const hit = issues.find(i => /Duplicate/.test(i.title));
    check("flags duplicate assessments", Boolean(hit), issues.map(i => i.title).join("; "));
    check("names both people on a duplicate", Boolean(hit && /R\. Patel/.test(hit.body) && /J\. Lee/.test(hit.body)), hit?.body);
  }

  /* ── A correction is not a duplicate ── */
  {
    const issues = findIssues([clean(), clean({ remoteId: "r2", supersedesId: "r1" })], []);
    check("a correction is not reported as a duplicate", !issues.some(i => /Duplicate/.test(i.title)),
      issues.map(i => i.title).join("; "));
  }

  /* ── Missing primary endpoint past 30 days ── */
  {
    const old = Date.now() - 45 * DAY;
    const issues = findIssues([clean({ enrollmentDate: ymd(old), savedAt: iso(old) })], []);
    const hit = issues.find(i => /No 30-day outcome/.test(i.title));
    check("flags a missing 30-day outcome", Boolean(hit), issues.map(i => i.title).join("; "));
    check("does not flag a recent enrolment", !findIssues([clean()], []).some(i => /No 30-day outcome/.test(i.title)));
  }

  /* ── Orphaned outcome ── */
  {
    const issues = findIssues([], [{ studyId: "LCH-999", serviceId: "s1", outcomes: {}, enteredBy: "J. Lee" }]);
    check("flags an outcome with no assessment", issues.some(i => /Outcome with no assessment/.test(i.title)),
      issues.map(i => i.title).join("; "));
  }

  /* ── Exemptions: reconciling these would compare against the wrong engine ── */
  {
    // Imported rows have no per-question answers, only a total.
    const issues = findIssues([clean({ source: "import", score: 14, engineVersion: "pre-1.1" })], []);
    check("imported rows are not reported as tampered",
      !issues.some(i => /Score does not match/.test(i.title)), issues.map(i => i.title).join("; "));
  }
  {
    // Scored under older point values — different, not wrong.
    const issues = findIssues([clean({ score: 14, engineVersion: "pre-1.1" })], []);
    check("old-engine rows are not reported as tampered",
      !issues.some(i => /Score does not match/.test(i.title)), issues.map(i => i.title).join("; "));
    check("old-engine rows are surfaced as a version warning",
      issues.some(i => /scored on engine pre-1\.1/.test(i.title)), issues.map(i => i.title).join("; "));
  }
  {
    // The exemption must not become a blanket amnesty for current rows.
    const issues = findIssues([clean({ score: 14, engineVersion: ENGINE_VERSION })], []);
    check("current-engine rows are still reconciled",
      issues.some(i => /Score does not match/.test(i.title)), issues.map(i => i.title).join("; "));
  }

  /* ── Voided rows drop out of analysis ── */
  {
    const issues = findIssues([clean({ score: 14, voidedAt: iso(Date.now()) })], []);
    check("voided rows are excluded from issues", issues.length === 0, issues.map(i => i.title).join("; "));
  }

  /* ── Export shape ── */
  {
    const cases = [clean()];
    const outcomes = [{ studyId: "LCH-001", serviceId: "s1", outcomes: { cfl: false }, anyEvent: false,
                        notes: "line one\nline two\r\nline three", clavienDindo: "I", recordedAt: iso(Date.now()) }];
    const csv = buildAdminCSV(cases, outcomes, { s1: "Dr. Castrellon" });
    const lines = csv.split("\n");
    const cols = (s) => (s.match(/","/g) || []).length + 1;

    check("export has exactly one row per case", lines.length === 2, `${lines.length} lines`);
    check("export keeps Pedro's columns first",
      lines[0].startsWith('"Study ID","Assessment Type","Hospital","Enrollment Date"'), lines[0].slice(0, 80));
    check("export appends provenance columns",
      /"Service","Hospital ID","Entered By","Record ID","Status","Void Reason"$/.test(lines[0]));
    check("header and row column counts agree", cols(lines[0]) === cols(lines[1]), `${cols(lines[0])} vs ${cols(lines[1])}`);
    check("newlines in notes cannot split a row", !lines[1].includes("line two") || cols(lines[1]) === cols(lines[0]));
    check("service name resolved in export", lines[1].includes("Dr. Castrellon"));
  }

  /* ── Research export must reproduce the master workbook exactly ── */
  {
    const { buildResearchCSV } = await import(pathToFileURL(out).href);
    const day = (n) => ymd(Date.now() - n * DAY);
    const cases = [
      clean({ remoteId: "a1", studyId: "PGH-002", assessmentType: "new",   score: 13, enrollmentDate: day(40) }),
      clean({ remoteId: "a2", studyId: "PGH-002", assessmentType: "preop", score: 9,  enrollmentDate: day(30) }),
      clean({ remoteId: "a3", studyId: "PGH-009", assessmentType: "new",   score: 14, enrollmentDate: day(10) }),
    ];
    const outcomes = [{
      studyId: "PGH-002", outcomes: { cfl: false, pfl: true, ssi: false, hem: false, deh: false, mort: false },
      anyEvent: true, clavienDindo: "IIIb", notes: "Prolonged LOS",
      secondary: { debridements: 1, flapType: "Local rotational", minorComp: "Y", minorDetail: "Minor dehiscence",
                   readmit30: "N", reop30: "N", los: 49, icu: "N", recur90: "Unknown", fu30: "Y", fu90: "N" },
    }];
    const lines = buildResearchCSV(cases, outcomes).split("\n");
    const cells = (l) => l.slice(1, -1).split('","').map(c => c.replace(/""/g, '"'));

    check("research export has two header rows + one row per patient", lines.length === 4, `${lines.length} lines`);

    /* The exact header strings, including the trailing spaces in the real file. */
    const h1 = cells(lines[0]), h2 = cells(lines[1]);
    check("header is 31 columns wide", h1.length === 31 && h2.length === 31, `${h1.length}/${h2.length}`);
    check("group header row matches the workbook",
      h1[0] === "Study ID" && h1[10] === "Optimization Duration (days)" && h1[11] === "Surgery  " &&
      h1[13] === "PRIMARY OUTCOMES — 30 DAYS" && h1[21] === "SECONDARY OUTCOMES" && h1[28] === "Administrative",
      JSON.stringify([h1[11], h1[13]]));
    check("field header row matches the workbook",
      h2[5] === "First F2F score" && h2[7] === "Reassesment" && h2[8] === "Preoperative F2F score" &&
      h2[16] === "Hematoma/Seroma → OR" && h2[19] === "◉ PRIMARY ENDPOINT" &&
      h2[25] === "LOS since enrollment (days) " && h2[30] === "Notes",
      JSON.stringify([h2[7], h2[19], h2[25]]));

    const r = cells(lines[2]);
    check("pivots both scores onto one patient row", r[0] === "PGH-002" && r[6] === "13" && r[9] === "9",
      JSON.stringify(r.slice(0, 11)));
    check("computes optimization duration from the dates", r[10] === "10", `got ${r[10]}`);
    check("writes dates in M/D/YYYY like the workbook", /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(r[5]), r[5]);
    check("PHI columns are blank", r[1] === "" && r[2] === "" && r[3] === "" && r[4] === "",
      JSON.stringify(r.slice(1, 5)));
    check("primary endpoints written as Y/N", r[13] === "N" && r[14] === "Y", `${r[13]}/${r[14]}`);
    check("primary endpoint uses the workbook's wording", r[19] === "YES — EVENT", r[19]);
    check("secondary outcomes land in their own columns",
      r[11] === "1" && r[12] === "Local rotational" && r[22] === "Minor dehiscence" && r[25] === "49" && r[27] === "Unknown",
      JSON.stringify([r[11], r[12], r[22], r[25], r[27]]));

    const r2 = cells(lines[3]);
    check("a patient with no outcome leaves outcome columns blank",
      r2[0] === "PGH-009" && r2[19] === "" && r2[20] === "" && r2[13] === "", JSON.stringify(r2.slice(13, 21)));
  }

  const width = Math.max(...results.map(([l]) => l.length));
  let bad = 0;
  for (const [label, ok, detail] of results) {
    if (!ok) bad++;
    console.log(`  ${label.padEnd(width)}  ${ok ? "ok" : "FAILED"}${!ok && detail ? `\n      → ${detail}` : ""}`);
  }
  console.log();
  if (bad === 0) console.log(`PASS — ${results.length} integrity checks`);
  else { console.error(`FAIL — ${bad} of ${results.length} failed`); process.exit(1); }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
