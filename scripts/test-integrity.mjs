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
  const { findIssues, buildAdminCSV } = await import(pathToFileURL(out).href);

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
    check("export keeps Pedro's 40 columns first",
      lines[0].startsWith('"Study ID","Assessment Type","Hospital","Enrollment Date"'), lines[0].slice(0, 80));
    check("export appends provenance columns",
      /"Service","Hospital ID","Entered By","Record ID","Status","Void Reason"$/.test(lines[0]));
    check("header and row column counts agree", cols(lines[0]) === cols(lines[1]), `${cols(lines[0])} vs ${cols(lines[1])}`);
    check("newlines in notes cannot split a row", !lines[1].includes("line two") || cols(lines[1]) === cols(lines[0]));
    check("service name resolved in export", lines[1].includes("Dr. Castrellon"));
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
