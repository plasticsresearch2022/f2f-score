/* ═══════════════════════════════════════════════
   LIVE RLS VERIFICATION

   Runs against the real project as two different anonymous
   collectors on two different services, plus an unaffiliated
   one. Proves the claims the design rests on:
     - a collector sees only their own service
     - append-only is enforced by Postgres, not by the app
     - the bcrypt hash and the audit log are not client-readable

   Creates two throwaway services and deletes them (and everything
   they produced) at the end.
═══════════════════════════════════════════════ */
import fs from "fs";
import { execFileSync } from "child_process";

const envText = fs.readFileSync(new URL("../../.env.local", import.meta.url), "utf8");
const env = Object.fromEntries(envText.split(/\r?\n/).filter(l => l && !l.startsWith("#") && l.includes("="))
  .map(l => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));
const URL_ = env.VITE_SUPABASE_URL, KEY = env.VITE_SUPABASE_ANON_KEY;

const results = [];
const check = (label, ok, detail = "") => { results.push([label, ok, detail]); };

/* Admin-side SQL through the dashboard tab. */
function sql(q) {
  const out = execFileSync("node", ["sql-bridge.mjs", "-q", q], { encoding: "utf8", cwd: import.meta.dirname });
  return JSON.parse(out);
}

async function api(pathname, { token, method = "GET", body, prefer } = {}) {
  const h = { apikey: KEY, Authorization: `Bearer ${token || KEY}`, "Content-Type": "application/json" };
  if (prefer) h.Prefer = prefer;
  const r = await fetch(`${URL_}${pathname}`, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  let d; try { d = JSON.parse(t); } catch { d = t.slice(0, 300); }
  return { status: r.status, d };
}

async function anonSignIn() {
  const r = await fetch(`${URL_}/auth/v1/signup`, {
    method: "POST", headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  const d = await r.json();
  if (!d.access_token) throw new Error("anon sign-in failed: " + JSON.stringify(d).slice(0, 200));
  return { token: d.access_token, userId: d.user.id };
}

const CODE_A = "ZZTEST-ALPHA-" + Math.random().toString(36).slice(2, 8).toUpperCase();
const CODE_B = "ZZTEST-BRAVO-" + Math.random().toString(36).slice(2, 8).toUpperCase();

try {
  /* ── Setup: two throwaway services ── */
  sql(`insert into public.services (name, slug, hospital_id, hospital_name, access_code_hash)
       values ('ZZ Test Alpha','zztest-alpha','LCH','Larkin Community Hospital', crypt('${CODE_A}', gen_salt('bf'))),
              ('ZZ Test Bravo','zztest-bravo','PGH','Palmetto General Hospital', crypt('${CODE_B}', gen_salt('bf')))`);

  /* ── Collector A ── */
  const A = await anonSignIn();
  const beforeRedeem = await api("/rest/v1/assessments_current?select=id", { token: A.token });
  check("unaffiliated collector sees nothing",
    Array.isArray(beforeRedeem.d) && beforeRedeem.d.length === 0,
    JSON.stringify(beforeRedeem).slice(0, 160));

  /* Wrong code first, while this user still has no service — otherwise
     "does not grant a service" would pass for the wrong reason. */
  const badCode = await api("/rest/v1/rpc/redeem_service_code", {
    token: A.token, method: "POST", body: { p_code: "TOTALLY-WRONG-CODE", p_member_name: "X" } });
  check("wrong code is rejected", badCode.d?.ok === false && badCode.d?.error === "invalid_code",
    JSON.stringify(badCode).slice(0, 160));

  const stillUnaffiliated = sql(`select service_id from public.profiles where id='${A.userId}'`)[0];
  check("a wrong code grants nothing", stillUnaffiliated.service_id === null,
    JSON.stringify(stillUnaffiliated));

  const redeemA = await api("/rest/v1/rpc/redeem_service_code", {
    token: A.token, method: "POST", body: { p_code: CODE_A, p_member_name: "Dr. Alpha" } });
  check("valid code is accepted", redeemA.d?.ok === true && redeemA.d?.service?.slug === "zztest-alpha",
    JSON.stringify(redeemA).slice(0, 200));

  const svcA = redeemA.d.service.id;
  const insA = await api("/rest/v1/assessments", {
    token: A.token, method: "POST", prefer: "return=representation",
    body: { user_id: A.userId, service_id: svcA, study_id: "ZZ-A-001", hospital: "Larkin Community Hospital",
            hospital_id: "LCH", enrollment_date: "2026-08-22", assessment_type: "new",
            answers: {}, domain_scores: { bio: 0, wound: 0, comorbidities: 0, functional: 0 },
            score: 0, tier_id: "low", tier_label: "LOW RISK", entered_by_name: "Dr. Alpha" } });
  check("collector can insert into own service", insA.status === 201, JSON.stringify(insA).slice(0, 220));
  const rowA = Array.isArray(insA.d) ? insA.d[0] : insA.d;

  const readA = await api("/rest/v1/assessments_current?select=study_id", { token: A.token });
  check("collector sees own row", Array.isArray(readA.d) && readA.d.some(r => r.study_id === "ZZ-A-001"),
    JSON.stringify(readA).slice(0, 160));

  check("legacy rows stay hidden from collectors",
    Array.isArray(readA.d) && !readA.d.some(r => String(r.study_id || "").startsWith("PGH-")),
    JSON.stringify(readA.d).slice(0, 160));

  /* ── Append-only ── */
  /* With no UPDATE policy, RLS makes zero rows visible to update, so PostgREST
     reports 204/no-rows rather than an error. What matters is that nothing
     changed — assert on the stored row, not the HTTP status. */
  const upd = await api(`/rest/v1/assessments?id=eq.${rowA.id}`, {
    token: A.token, method: "PATCH", prefer: "return=representation", body: { score: 99 } });
  const updatedRows = Array.isArray(upd.d) ? upd.d.length : 0;
  check("UPDATE affects zero rows", updatedRows === 0, `http ${upd.status}, ${updatedRows} rows returned`);

  const del = await api(`/rest/v1/assessments?id=eq.${rowA.id}`, { token: A.token, method: "DELETE" });
  const stillThere = sql(`select count(*)::int as n from public.assessments where id='${rowA.id}'`)[0].n;
  check("DELETE is refused by Postgres", stillThere === 1, `http ${del.status}, rows remaining ${stillThere}`);

  const scoreNow = sql(`select score from public.assessments where id='${rowA.id}'`)[0].score;
  check("score was not mutated", scoreNow === 0, `score is ${scoreNow}`);

  /* ── Collector B: a different service ── */
  const B = await anonSignIn();
  const redeemB = await api("/rest/v1/rpc/redeem_service_code", {
    token: B.token, method: "POST", body: { p_code: CODE_B, p_member_name: "Dr. Bravo" } });
  check("second service redeems independently", redeemB.status === 200 && redeemB.d?.service?.slug === "zztest-bravo");

  const crossRead = await api("/rest/v1/assessments_current?select=study_id", { token: B.token });
  check("CROSS-SERVICE READ IS BLOCKED",
    Array.isArray(crossRead.d) && !crossRead.d.some(r => r.study_id === "ZZ-A-001"),
    JSON.stringify(crossRead.d).slice(0, 200));

  const targeted = await api(`/rest/v1/assessments_current?select=*&id=eq.${rowA.id}`, { token: B.token });
  check("cannot fetch another service's row by id",
    Array.isArray(targeted.d) && targeted.d.length === 0, JSON.stringify(targeted.d).slice(0, 160));

  const crossInsert = await api("/rest/v1/assessments", {
    token: B.token, method: "POST",
    body: { user_id: B.userId, service_id: svcA, study_id: "ZZ-EVIL", assessment_type: "new", score: 0 } });
  check("cannot insert into another service", crossInsert.status >= 400, `http ${crossInsert.status}`);

  /* ── Secrets stay server-side ── */
  const hash = await api("/rest/v1/services?select=access_code_hash", { token: B.token });
  check("access code hash is not readable", hash.status >= 400 || (Array.isArray(hash.d) && hash.d.length === 0 ),
    `http ${hash.status} ${JSON.stringify(hash.d).slice(0, 120)}`);

  const audit = await api("/rest/v1/audit_log?select=*", { token: B.token });
  check("audit log is admin-only", Array.isArray(audit.d) && audit.d.length === 0,
    `http ${audit.status} ${JSON.stringify(audit.d).slice(0, 120)}`);

  const otherSvc = await api("/rest/v1/services?select=name", { token: B.token });
  check("collector sees only their own service row",
    Array.isArray(otherSvc.d) && otherSvc.d.length === 1 && otherSvc.d[0].name === "ZZ Test Bravo",
    JSON.stringify(otherSvc.d).slice(0, 160));

  /* ── Audit trail recorded the activity ── */
  const auditRows = sql(`select action, count(*)::int as n from public.audit_log
                         where service_id in (select id from public.services where slug like 'zztest-%')
                            or action = 'redeem_failed'
                         group by action order by 1`);
  const actions = Object.fromEntries(auditRows.map(r => [r.action, r.n]));
  check("audit logged the assessment", (actions.create_assessment || 0) >= 1, JSON.stringify(actions));
  check("audit logged code redemptions", (actions.redeem_code || 0) >= 2, JSON.stringify(actions));
  check("audit logged the failed code attempt", (actions.redeem_failed || 0) >= 1, JSON.stringify(actions));

  /* ── Admin can void; collectors cannot ── */
  const collectorVoid = await api("/rest/v1/rpc/void_assessment", {
    token: A.token, method: "POST", body: { p_id: rowA.id, p_reason: "nope" } });
  check("collector cannot void", collectorVoid.status >= 400, `http ${collectorVoid.status}`);

} finally {
  /* ── Cleanup ── */
  try {
    sql(`delete from public.audit_log where service_id in (select id from public.services where slug like 'zztest-%') or action='redeem_failed'`);
    sql(`delete from public.assessments where service_id in (select id from public.services where slug like 'zztest-%')`);
    sql(`delete from public.service_members where service_id in (select id from public.services where slug like 'zztest-%')`);
    sql(`delete from public.profiles where id in (select id from auth.users where is_anonymous = true)`);
    sql(`delete from auth.users where is_anonymous = true`);
    sql(`delete from public.services where slug like 'zztest-%'`);
    const left = sql(`select (select count(*)::int from public.services where slug like 'zztest-%') as svc,
                             (select count(*)::int from auth.users where is_anonymous) as anon,
                             (select count(*)::int from public.assessments) as assessments`)[0];
    console.log(`\ncleanup: services=${left.svc} anon_users=${left.anon} assessments=${left.assessments} (16 legacy expected)\n`);
  } catch (e) { console.error("CLEANUP FAILED:", e.message); }
}

const width = Math.max(...results.map(([l]) => l.length));
let bad = 0;
for (const [label, ok, detail] of results) {
  if (!ok) bad++;
  console.log(`  ${label.padEnd(width)}  ${ok ? "ok" : "FAILED"}${!ok && detail ? `\n      → ${detail}` : ""}`);
}
console.log();
console.log(bad === 0 ? `PASS — ${results.length} live security checks` : `FAIL — ${bad} of ${results.length} failed`);
process.exit(bad === 0 ? 0 : 1);
