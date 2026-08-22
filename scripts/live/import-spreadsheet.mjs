#!/usr/bin/env node
/* ═══════════════════════════════════════════════
   IMPORT THE RESEARCH SPREADSHEET

   Brings Pedro's master workbook ("F2F DataCollection - collective")
   into Postgres as source='import' rows.

   PHI IS DELIBERATELY DROPPED. The sheet carries two direct HIPAA
   identifiers — `Hospital Account #` and full `DOB` — and this project
   is de-identified by design with no BAA in place. Neither column is
   read into the database. The hospital account number is the study's
   de-identification link and belongs in the offline log, not here.

   Also skipped: Age and Sex. They are legitimate research covariates
   and are NOT identifiers at these values, but the schema has no home
   for them yet; adding demographic fields is a design decision, not an
   import decision.

   Imported assessments carry no per-question answers, because the sheet
   never recorded them — only totals. That is exactly why they are marked
   source='import': the admin integrity check skips score reconciliation
   for them instead of reporting every one as tampered.

   Usage:
     node import-spreadsheet.mjs <file.csv>            # dry run, prints a plan
     node import-spreadsheet.mjs <file.csv> --commit   # actually write
═══════════════════════════════════════════════ */
import fs from "fs";
import { execFileSync } from "child_process";

const RUN = (q) => JSON.parse(execFileSync("node", ["sql-bridge.mjs", "-q", q], { encoding: "utf8", cwd: import.meta.dirname }));
const q = (v) => (v === null || v === undefined || v === "" ? "null" : `'${String(v).replace(/'/g, "''")}'`);

const file = process.argv[2];
const COMMIT = process.argv.includes("--commit");
if (!file) { console.error("usage: import-spreadsheet.mjs <file.csv> [--commit]"); process.exit(2); }

/* ── CSV parsing (quote-aware; the Notes column is free text) ── */
function parseCSV(text) {
  const rows = []; let row = [], cell = "", inQ = false;
  const s = text.replace(/^﻿/, "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQ) {
      if (c === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else inQ = false; }
      else cell += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else if (c !== "\r") cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

/* Column indices from the sheet's two-row merged header. */
const C = {
  studyId: 0, account: 1, dob: 2, age: 3, sex: 4,
  firstDate: 5, firstScore: 6, reassess: 7, preopDate: 8, preopScore: 9,
  optDays: 10, debridements: 11, flapType: 12,
  cfl: 13, pfl: 14, ssi: 15, hem: 16, deh: 17, mort: 18,
  primary: 19, clavien: 20,
  minorComp: 21, minorDetail: 22, readmit: 23, reop: 24, los: 25, icu: 26,
  recur90: 27, fu30: 28, fu90: 29, notes: 30,
};

const rows = parseCSV(fs.readFileSync(file, "utf8"))
  .slice(2)                                   // two header rows
  .filter(r => (r[C.studyId] || "").trim());  // template filler rows have no Study ID

const yes = (v) => /^y(es)?$/i.test((v || "").trim());
/* Number("") is 0, not NaN — without the emptiness guard a blank pre-op
   score silently becomes a real assessment scoring zero. */
const num = (v) => {
  const s = String(v ?? "").trim();
  if (s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};
const usDate = (v) => {
  const m = String(v || "").trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  return m ? `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}` : null;
};
const hospOf = (sid) => {
  const p = String(sid).split("-")[0].toUpperCase();
  return { LCH: ["LCH", "Larkin Community Hospital"], PGH: ["PGH", "Palmetto General Hospital"],
           DMC: ["DMC", "Delray Medical Center"], NLN: ["NLN", "Nemours Lake Nona Children's Hospital"] }[p]
      || ["OTH", "Other"];
};
/* TIERS from App.jsx — kept in sync by eye; only used to label imported rows. */
const tierOf = (s) => s == null ? [null, null]
  : s <= 5 ? ["low", "LOW RISK"] : s <= 12 ? ["moderate", "MODERATE RISK"]
  : s <= 19 ? ["high", "HIGH RISK"] : ["not_ideal", "NOT AN IDEAL CANDIDATE"];

/* ── Build the plan ── */
const assessments = [], outcomes = [], notes = [];

for (const r of rows) {
  const sid = r[C.studyId].trim();
  const [hid, hname] = hospOf(sid);

  for (const [type, dIdx, sIdx] of [["new", C.firstDate, C.firstScore], ["preop", C.preopDate, C.preopScore]]) {
    const score = num(r[sIdx]), date = usDate(r[dIdx]);
    if (score === null) continue;
    const [tierId, tierLabel] = tierOf(score);
    assessments.push({ sid, type, date, score, tierId, tierLabel, hid, hname });
  }

  /* An outcome row is only meaningful once the endpoints were actually
     adjudicated — a blank primary endpoint means follow-up is incomplete. */
  const primary = (r[C.primary] || "").trim();
  if (primary) {
    const extra = [
      r[C.flapType] && `Flap: ${r[C.flapType].trim()}`,
      num(r[C.debridements]) !== null && `Debridements: ${r[C.debridements].trim()}`,
      yes(r[C.minorComp]) && `Minor complication: ${(r[C.minorDetail] || "yes").trim()}`,
      yes(r[C.readmit]) && "30-day readmission",
      yes(r[C.reop]) && "30-day reoperation",
      num(r[C.los]) !== null && `LOS since enrollment: ${r[C.los].trim()} days`,
      yes(r[C.icu]) && "ICU admission",
      (r[C.recur90] || "").trim() && `90-day recurrence: ${r[C.recur90].trim()}`,
      (r[C.notes] || "").trim(),
    ].filter(Boolean).join(" · ");

    outcomes.push({
      sid, hid,
      o: { cfl: yes(r[C.cfl]), pfl: yes(r[C.pfl]), ssi: yes(r[C.ssi]),
           hem: yes(r[C.hem]), deh: yes(r[C.deh]), mort: yes(r[C.mort]), ana: false },
      anyEvent: /yes/i.test(primary),
      clavien: (r[C.clavien] || "").trim() || null,
      notes: extra || null,
      recordedAt: usDate(r[C.preopDate]) || usDate(r[C.firstDate]),
    });
  } else {
    notes.push(`${sid}: no 30-day outcome recorded yet — skipped`);
  }
}

/* ── Report ── */
console.log(`Parsed ${rows.length} patient rows from ${file.split(/[\\/]/).pop()}`);
console.log(`\nDROPPED (PHI, never read into the database):`);
console.log(`  Hospital Account #   ${rows.filter(r => (r[C.account] || "").trim()).length} values`);
console.log(`  DOB                  ${rows.filter(r => (r[C.dob] || "").trim()).length} values`);
console.log(`SKIPPED (no schema field yet): Age, Sex\n`);

console.log(`WILL IMPORT`);
console.log(`  assessments  ${assessments.length}`);
console.log(`  outcomes     ${outcomes.length}`);
for (const n of notes) console.log(`  note: ${n}`);

const existing = RUN(`select study_id, assessment_type from public.assessments`);
const dupes = assessments.filter(a => existing.some(e => e.study_id === a.sid && e.assessment_type === a.type));
if (dupes.length) {
  console.log(`\n  ${dupes.length} would duplicate rows already in the database:`);
  for (const d of dupes) console.log(`    ${d.sid} ${d.type} (score ${d.score})`);
  console.log(`  These are SKIPPED — the June rows carry real per-question answers,`);
  console.log(`  which are strictly better than the spreadsheet's totals.`);
}
const toInsert = assessments.filter(a => !dupes.includes(a));

if (!COMMIT) { console.log(`\nDRY RUN — re-run with --commit to write ${toInsert.length} assessments and ${outcomes.length} outcomes.`); process.exit(0); }

/* ── Commit ── */
const admin = RUN(`select id from public.profiles where role='admin' limit 1`)[0];
const svc = RUN(`select id from public.services where slug='pilot-2026-06'`)[0];
if (!admin || !svc) { console.error("need an admin profile and the pilot-2026-06 service"); process.exit(1); }
const BY = "Imported from research spreadsheet";

for (const a of toInsert) {
  RUN(`insert into public.assessments
        (user_id, service_id, study_id, hospital, hospital_id, enrollment_date, assessment_type,
         answers, domain_scores, score, tier_id, tier_label, entered_by_name, source, created_at)
       values (${q(admin.id)}, ${q(svc.id)}, ${q(a.sid)}, ${q(a.hname)}, ${q(a.hid)}, ${q(a.date)}, ${q(a.type)},
               '{}'::jsonb, '{}'::jsonb, ${a.score}, ${q(a.tierId)}, ${q(a.tierLabel)},
               ${q(BY)}, 'import', coalesce(${q(a.date)}::timestamptz, now()))`);
}
for (const o of outcomes) {
  RUN(`insert into public.outcomes
        (user_id, service_id, study_id, outcomes, clavien_dindo, notes, any_event,
         entered_by_name, source, recorded_at)
       values (${q(admin.id)}, ${q(svc.id)}, ${q(o.sid)}, ${q(JSON.stringify(o.o))}::jsonb,
               ${q(o.clavien)}, ${q(o.notes)}, ${o.anyEvent},
               ${q(BY)}, 'import', coalesce(${q(o.recordedAt)}::timestamptz, now()))`);
}

const after = RUN(`select (select count(*)::int from public.assessments) as a,
                          (select count(*)::int from public.outcomes) as o`)[0];
console.log(`\nCOMMITTED. assessments=${after.a}  outcomes=${after.o}`);
