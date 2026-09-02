#!/usr/bin/env node
/* Run the real database through the admin dashboard's own findIssues(),
   so what an admin will see is verified against live data rather than
   fixtures. Read-only.

   Usage: node preview-issues.mjs */
import { build } from "esbuild";
import { pathToFileURL } from "url";
import { mkdtempSync, rmSync } from "fs";
import { execFileSync } from "child_process";
import path from "path";

const RUN = (q) => JSON.parse(execFileSync("node", ["sql-bridge.mjs", "-q", q], { encoding: "utf8", cwd: import.meta.dirname }));

const dir = mkdtempSync(path.join("..", "..", "node_modules", ".f2f-preview-"));
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
  const { findIssues } = await import(pathToFileURL(out).href);

  const cases = RUN(`select id as "remoteId", study_id as "studyId", assessment_type as "assessmentType",
                            answers, domain_scores as "domainScores", score, source, engine_version as "engineVersion",
                            enrollment_date as "enrollmentDate", created_at as "savedAt",
                            entered_by_name as "enteredBy", supersedes_id as "supersedesId", voided_at as "voidedAt"
                       from public.assessments`);
  const outcomes = RUN(`select id as "remoteId", study_id as "studyId", outcomes, any_event as "anyEvent",
                               entered_by_name as "enteredBy", voided_at as "voidedAt"
                          from public.outcomes`);

  const issues = findIssues(cases, outcomes);
  console.log(`${cases.length} assessments, ${outcomes.length} outcomes → ${issues.length} issue(s)\n`);
  for (const i of issues) {
    console.log(`[${i.sev.toUpperCase()}] ${i.title}`);
    console.log(`        ${i.body}\n`);
  }
  if (!issues.length) console.log("No issues found.");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
