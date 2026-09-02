/* ═══════════════════════════════════════════════
   LIVE RLS VERIFICATION

   Runs against the real project as two collectors on two different
   services, plus one unaffiliated and one blocked. Proves the claims
   the design rests on:
     - a collector sees only their own service
     - append-only is enforced by Postgres, not by the app
     - service and role are not self-assignable
     - blocking an account revokes read and write everywhere
     - the access-code hash and the audit log stay server-side

   Sign-in here is anonymous rather than Google, because OAuth cannot be
   driven headlessly. RLS never sees the difference — every policy keys
   off auth.uid(), profiles.service_id and profiles.blocked, which are
   identical whichever provider issued the session.

   Creates two throwaway services and deletes them, and everything they
   produced, at the end.
═══════════════════════════════════════════════ */
import fs from "fs";
import { execFileSync } from "child_process";

const envText = fs.readFileSync(new URL("../../.env.local", import.meta.url), "utf8");
const env = Object.fromEntries(envText.split(/\r?\n/).filter(l => l && !l.startsWith("#") && l.includes("="))
  .map(l => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));
const URL_ = env.VITE_SUPABASE_URL, KEY = env.VITE_SUPABASE_ANON_KEY;

const results = [];
const check = (label, ok, detail = "") => { results.push([label, ok, detail]); };

function sql(q) {
  return JSON.parse(execFileSync("node", ["sql-bridge.mjs", "-q", q], { encoding: "utf8", cwd: import.meta.dirname }));
}

async function api(pathname, { token, method = "GET", body, prefer } = {}) {
  const h = { apikey: KEY, Authorization: `Bearer ${token || KEY}`, "Content-Type": "application/json" };
  if (prefer) h.Prefer = prefer;
  const r = await fetch(`${URL_}${pathname}`, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  let d; try { d = JSON.parse(t); } catch { d = t.slice(0, 300); }
  return { status: r.status, d };
}

async function signIn() {
  const r = await fetch(`${URL_}/auth/v1/signup`, {
    method: "POST", headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  const d = await r.json();
  if (!d.access_token) throw new Error("sign-in failed: " + JSON.stringify(d).slice(0, 200));
  return { token: d.access_token, userId: d.user.id };
}

try {
  /* ── Setup: two throwaway services, no codes needed any more ── */
  sql(`insert into public.services (name, slug, hospital_id, hospital_name)
       values ('ZZ Test Alpha','zztest-alpha','LCH','Larkin Community Hospital'),
              ('ZZ Test Bravo','zztest-bravo','PGH','Palmetto General Hospital')`);
  const SVC_A = sql(`select id from public.services where slug = 'zztest-alpha'`)[0].id;
  const SVC_B = sql(`select id from public.services where slug = 'zztest-bravo'`)[0].id;

  /* ── Collector A ── */
  const A = await signIn();
  const before = await api("/rest/v1/assessments_current?select=id", { token: A.token });
  check("a user with no service sees nothing",
    Array.isArray(before.d) && before.d.length === 0, JSON.stringify(before).slice(0, 160));

  const insBefore = await api("/rest/v1/assessments", {
    token: A.token, method: "POST",
    body: { user_id: A.userId, service_id: SVC_A, study_id: "ZZ-EARLY", assessment_type: "new", score: 0 } });
  check("a user with no service cannot write", insBefore.status >= 400, `http ${insBefore.status}`);

  const joinA = await api("/rest/v1/rpc/set_my_service", {
    token: A.token, method: "POST", body: { p_service_id: SVC_A } });
  check("picking a service works", joinA.d?.ok === true && joinA.d?.service?.slug === "zztest-alpha",
    JSON.stringify(joinA).slice(0, 200));

  const bogus = await api("/rest/v1/rpc/set_my_service", {
    token: A.token, method: "POST", body: { p_service_id: "00000000-0000-0000-0000-000000000000" } });
  check("an unknown service is rejected", bogus.status >= 400, `http ${bogus.status}`);

  const insA = await api("/rest/v1/assessments", {
    token: A.token, method: "POST", prefer: "return=representation",
    body: { user_id: A.userId, service_id: SVC_A, study_id: "ZZ-A-001", hospital: "Larkin Community Hospital",
            hospital_id: "LCH", enrollment_date: "2026-08-23", assessment_type: "new",
            answers: {}, domain_scores: { bio: 0, wound: 0, comorbidities: 0, functional: 0 },
            score: 0, tier_id: "low", tier_label: "LOW RISK", entered_by_name: "Dr. Alpha" } });
  check("a collector can write to their own service", insA.status === 201, JSON.stringify(insA).slice(0, 220));
  const rowA = Array.isArray(insA.d) ? insA.d[0] : insA.d;

  const readA = await api("/rest/v1/assessments_current?select=study_id", { token: A.token });
  check("a collector sees their service's rows",
    Array.isArray(readA.d) && readA.d.some(r => r.study_id === "ZZ-A-001"), JSON.stringify(readA).slice(0, 160));
  check("other services' rows stay hidden",
    Array.isArray(readA.d) && !readA.d.some(r => String(r.study_id || "").startsWith("PGH-")),
    JSON.stringify(readA.d).slice(0, 160));

  /* ── Append-only ── */
  const upd = await api(`/rest/v1/assessments?id=eq.${rowA.id}`, {
    token: A.token, method: "PATCH", prefer: "return=representation", body: { score: 99 } });
  check("UPDATE affects zero rows", (Array.isArray(upd.d) ? upd.d.length : 0) === 0,
    `http ${upd.status}, ${JSON.stringify(upd.d).slice(0, 100)}`);

  await api(`/rest/v1/assessments?id=eq.${rowA.id}`, { token: A.token, method: "DELETE" });
  const stillThere = sql(`select count(*)::int as n from public.assessments where id = '${rowA.id}'`)[0].n;
  check("DELETE is refused by Postgres", stillThere === 1, `rows remaining ${stillThere}`);
  check("the stored score was not mutated",
    sql(`select score from public.assessments where id = '${rowA.id}'`)[0].score === 0);

  /* ── Collector B on a different service ── */
  const B = await signIn();
  await api("/rest/v1/rpc/set_my_service", { token: B.token, method: "POST", body: { p_service_id: SVC_B } });

  const cross = await api("/rest/v1/assessments_current?select=study_id", { token: B.token });
  check("CROSS-SERVICE READ IS BLOCKED",
    Array.isArray(cross.d) && !cross.d.some(r => r.study_id === "ZZ-A-001"), JSON.stringify(cross.d).slice(0, 200));

  const byId = await api(`/rest/v1/assessments_current?select=*&id=eq.${rowA.id}`, { token: B.token });
  check("another service's row cannot be fetched by id",
    Array.isArray(byId.d) && byId.d.length === 0, JSON.stringify(byId.d).slice(0, 160));

  const crossIns = await api("/rest/v1/assessments", {
    token: B.token, method: "POST",
    body: { user_id: B.userId, service_id: SVC_A, study_id: "ZZ-EVIL", assessment_type: "new", score: 0 } });
  check("cannot write into another service", crossIns.status >= 400, `http ${crossIns.status}`);

  /* ── Privilege escalation through the profile row ── */
  await api(`/rest/v1/profiles?id=eq.${B.userId}`, { token: B.token, method: "PATCH", body: { role: "admin" } });
  check("cannot self-promote to admin",
    sql(`select role from public.profiles where id = '${B.userId}'`)[0].role !== "admin");

  const beforeHop = sql(`select service_id from public.profiles where id = '${B.userId}'`)[0].service_id;
  await api(`/rest/v1/profiles?id=eq.${B.userId}`, { token: B.token, method: "PATCH", body: { service_id: SVC_A } });
  check("cannot set service_id directly — only the RPC may",
    sql(`select service_id from public.profiles where id = '${B.userId}'`)[0].service_id === beforeHop);

  await api(`/rest/v1/profiles?id=eq.${B.userId}`, {
    token: B.token, method: "PATCH", body: { email: "yasha.efimenko@gmail.com" } });
  sql(`update public.profiles set full_name = full_name where id = '${B.userId}'`);
  check("spoofing an allowlisted email does not grant admin",
    sql(`select role from public.profiles where id = '${B.userId}'`)[0].role !== "admin");

  /* ── Secrets stay server-side ── */
  const hash = await api("/rest/v1/services?select=access_code_hash", { token: B.token });
  check("the access-code hash is not readable",
    hash.status >= 400 || (Array.isArray(hash.d) && hash.d.length === 0), `http ${hash.status}`);

  const audit = await api("/rest/v1/audit_log?select=*", { token: B.token });
  check("the audit log is admin-only", Array.isArray(audit.d) && audit.d.length === 0,
    JSON.stringify(audit.d).slice(0, 120));

  const allow = await api("/rest/v1/admin_allowlist?select=email", { token: B.token });
  check("collectors cannot read the allowlist", Array.isArray(allow.d) && allow.d.length === 0,
    JSON.stringify(allow.d).slice(0, 120));

  const users = await api("/rest/v1/rpc/list_users", { token: B.token, method: "POST", body: {} });
  check("collectors cannot list users", !Array.isArray(users.d) || users.d.length === 0,
    JSON.stringify(users.d).slice(0, 120));

  /* ── Everyone can see the service list, because the picker needs it ── */
  const svcList = await api("/rest/v1/services?select=name", { token: B.token });
  check("the service list is visible to signed-in users",
    Array.isArray(svcList.d) && svcList.d.length >= 2, JSON.stringify(svcList.d).slice(0, 160));

  /* ── Privileged actions ── */
  const cVoid = await api("/rest/v1/rpc/void_assessment", {
    token: A.token, method: "POST", body: { p_id: rowA.id, p_reason: "nope" } });
  check("a collector cannot void", cVoid.status >= 400, `http ${cVoid.status}`);

  const cBlock = await api("/rest/v1/rpc/set_user_blocked", {
    token: A.token, method: "POST", body: { p_user_id: B.userId, p_blocked: true } });
  check("a collector cannot block anyone", cBlock.status >= 400, `http ${cBlock.status}`);

  /* ── Blocking revokes everything ── */
  sql(`update public.profiles set blocked = true where id = '${A.userId}'`);
  const blockedRead = await api("/rest/v1/assessments_current?select=study_id", { token: A.token });
  check("a blocked account reads nothing",
    Array.isArray(blockedRead.d) && blockedRead.d.length === 0, JSON.stringify(blockedRead.d).slice(0, 160));

  const blockedWrite = await api("/rest/v1/assessments", {
    token: A.token, method: "POST",
    body: { user_id: A.userId, service_id: SVC_A, study_id: "ZZ-BLOCKED", assessment_type: "new", score: 0 } });
  check("a blocked account cannot write", blockedWrite.status >= 400, `http ${blockedWrite.status}`);

  const blockedJoin = await api("/rest/v1/rpc/set_my_service", {
    token: A.token, method: "POST", body: { p_service_id: SVC_B } });
  check("a blocked account cannot switch service to escape", blockedJoin.status >= 400, `http ${blockedJoin.status}`);

  sql(`update public.profiles set blocked = false where id = '${A.userId}'`);
  const restored = await api("/rest/v1/assessments_current?select=study_id", { token: A.token });
  check("unblocking restores access",
    Array.isArray(restored.d) && restored.d.some(r => r.study_id === "ZZ-A-001"),
    JSON.stringify(restored.d).slice(0, 160));

  /* ── Audit trail ── */
  const acts = Object.fromEntries(sql(`select action, count(*)::int as n from public.audit_log
       where service_id in (select id from public.services where slug like 'zztest-%')
       group by action`).map(r => [r.action, r.n]));
  check("joining a service is audited", (acts.join_service || 0) >= 2, JSON.stringify(acts));
  check("creating an assessment is audited", (acts.create_assessment || 0) >= 1, JSON.stringify(acts));

} finally {
  try {
    sql(`delete from public.audit_log where service_id in (select id from public.services where slug like 'zztest-%')`);
    sql(`delete from public.assessments where service_id in (select id from public.services where slug like 'zztest-%')`);
    sql(`update public.profiles set service_id = null, member_id = null
          where service_id in (select id from public.services where slug like 'zztest-%')`);
    sql(`delete from public.service_members where service_id in (select id from public.services where slug like 'zztest-%')`);
    sql(`delete from public.profiles where id in (select id from auth.users where is_anonymous)`);
    sql(`delete from auth.users where is_anonymous`);
    sql(`delete from public.services where slug like 'zztest-%'`);
    const left = sql(`select (select count(*)::int from public.services where slug like 'zztest-%') as svc,
                             (select count(*)::int from auth.users where is_anonymous) as anon,
                             (select count(*)::int from public.assessments) as assessments`)[0];
    console.log(`\ncleanup: services=${left.svc} test_users=${left.anon} assessments=${left.assessments} (24 expected)\n`);
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
