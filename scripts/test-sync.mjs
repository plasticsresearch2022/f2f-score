#!/usr/bin/env node
/* ═══════════════════════════════════════════════
   SYNC SAFETY TESTS

   The outbox shipped with a bug that mattered more than any other:
   a permanently-rejected record was dequeued, so the pending count
   fell to zero, the indicator went green, and the entry still showed
   in Records. A resident would have believed a lost assessment was
   recorded.

   These tests pin down the two rules that came out of it:
     1. "saved" is only ever true when the server confirmed it
     2. an entry uploads under the identity it was ENTERED with,
        never whoever happens to be signed in when it drains

   Usage:  npm run test:sync
═══════════════════════════════════════════════ */
import { build } from "esbuild";
import { pathToFileURL } from "url";
import { mkdtempSync, rmSync } from "fs";
import path from "path";

const results = [];
const check = (label, ok, detail = "") => results.push([label, ok, detail]);

const dir = mkdtempSync(path.join("node_modules", ".f2f-sync-"));
let syncMod = null;
try {
  /* In-memory localStorage so the module's persistence is real. */
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    key: (i) => [...store.keys()][i] ?? null,
    get length() { return store.size; },
  };
  /* navigator is a getter-only global in Node, so it has to be redefined. */
  Object.defineProperty(globalThis, "navigator", { value: { onLine: true }, configurable: true, writable: true });
  globalThis.window = { addEventListener() {}, removeEventListener() {} };

  /* Stub the db layer so we control exactly how the server responds. */
  const calls = [];
  let mode = "ok";
  const stub = `
    export const insertAssessment = async (rec, ctx) => {
      globalThis.__calls.push({ rec, ctx });
      if (globalThis.__mode === "reject") { const e = new Error("new row violates row-level security policy"); e.code = "42501"; throw e; }
      if (globalThis.__mode === "offline") throw new Error("Failed to fetch");
      return { ...rec, remoteId: "srv-" + globalThis.__calls.length, studyId: rec.studyId };
    };
    export const insertOutcome = insertAssessment;
    export const fetchAssessments = async () => [];
    export const fetchOutcomes = async () => [];
  `;
  const stubFile = path.join(dir, "db-stub.js");
  (await import("fs")).writeFileSync(stubFile, stub);
  globalThis.__calls = calls;

  const sbFile = path.join(dir, "sb-stub.js");
  (await import("fs")).writeFileSync(sbFile,
    "export const supabase = { __stub: true };\nexport const isSupabaseConfigured = true;\n");

  /* `alias` only accepts bare package names, so relative imports need a
     resolve plugin to be swapped for the stubs. */
  const swap = {
    name: "swap-deps",
    setup(b) {
      b.onResolve({ filter: /^\.\/db$/ }, () => ({ path: path.resolve(stubFile) }));
      b.onResolve({ filter: /^\.\/supabase$/ }, () => ({ path: path.resolve(sbFile) }));
    },
  };

  const out = path.join(dir, "sync.mjs");
  await build({
    entryPoints: ["src/lib/sync.js"], bundle: true, format: "esm", outfile: out, platform: "node",
    plugins: [swap], logLevel: "silent",
  });
  const sync = await import(pathToFileURL(out).href);
  syncMod = sync;

  const CTX_A = { userId: "u1", serviceId: "svc-A", memberId: "m1", displayName: "Dr. Alpha", canCollect: true };
  const CTX_B = { userId: "u2", serviceId: "svc-B", memberId: "m2", displayName: "Dr. Bravo", canCollect: true };
  const put = (key, rec) => localStorage.setItem(key, JSON.stringify(rec));

  /* ── 1. Happy path ── */
  globalThis.__mode = "ok";
  await sync.start(CTX_A);
  put("f2f_case_LCH-001_1", { studyId: "LCH-001", score: 5 });
  sync.enqueue("case", "f2f_case_LCH-001_1");
  await sync.flush();
  check("a confirmed save reports allSaved", sync.status().allSaved === true, JSON.stringify(sync.status()));
  check("confirmed record is re-keyed to the server id",
    [...store.keys()].some(k => k.includes("_r_srv-")), [...store.keys()].join(", "));

  /* ── 2. THE BUG: a rejected save must never look saved ── */
  globalThis.__mode = "reject";
  put("f2f_case_LCH-002_1", { studyId: "LCH-002", score: 9 });
  sync.enqueue("case", "f2f_case_LCH-002_1");
  await sync.flush();
  const s = sync.status();
  check("a rejected save does NOT report allSaved", s.allSaved === false, JSON.stringify(s));
  check("a rejected save is counted as failed", s.failed === 1, JSON.stringify(s));
  check("a rejected save is not counted as merely pending", s.pending === 0, JSON.stringify(s));
  check("the failed record is named for the user",
    sync.failedRecords().some(f => f.studyId === "LCH-002"), JSON.stringify(sync.failedRecords()));
  check("the failed record is still on the device",
    JSON.parse(localStorage.getItem("f2f_case_LCH-002_1")).score === 9);
  check("the failed record carries a reason",
    /row-level security/.test(sync.failedRecords()[0]?.reason || ""), sync.failedRecords()[0]?.reason);

  /* ── 3. Failures do not block later entries ── */
  globalThis.__mode = "ok";
  put("f2f_case_LCH-003_1", { studyId: "LCH-003", score: 3 });
  sync.enqueue("case", "f2f_case_LCH-003_1");
  await sync.flush();
  check("a later entry still uploads past a failure",
    calls.some(c => c.rec.studyId === "LCH-003"), calls.map(c => c.rec.studyId).join(","));
  check("still not allSaved while one remains failed", sync.status().allSaved === false);

  /* ── 4. Retry recovers it ── */
  await sync.retryFailed();
  check("retry clears the failure once the server accepts", sync.status().failed === 0, JSON.stringify(sync.status()));
  check("retry actually uploaded the held record",
    calls.filter(c => c.rec.studyId === "LCH-002").length >= 2,
    `${calls.filter(c => c.rec.studyId === "LCH-002").length} attempts`);

  /* ── 5. Transient failures stay pending, not failed ── */
  globalThis.__mode = "offline";
  put("f2f_case_LCH-004_1", { studyId: "LCH-004", score: 1 });
  sync.enqueue("case", "f2f_case_LCH-004_1");
  await sync.flush();
  const t = sync.status();
  check("a network error stays pending for retry", t.pending === 1 && t.failed === 0, JSON.stringify(t));
  check("a network error does not report allSaved", t.allSaved === false);

  /* ── 6. Cross-service attribution ── */
  globalThis.__mode = "ok";
  calls.length = 0;
  await sync.start(CTX_B);                     // same device, different service
  await sync.flush();
  const wrote = calls.find(c => c.rec.studyId === "LCH-004");
  check("an entry from service A is not written under service B",
    !wrote || wrote.ctx.serviceId === "svc-A",
    wrote ? `written under ${wrote.ctx.serviceId}` : "held, not written");
  check("the mis-matched entry is surfaced rather than dropped",
    sync.status().failed === 1 && sync.failedRecords().some(f => f.studyId === "LCH-004"),
    JSON.stringify(sync.status()));

  const width = Math.max(...results.map(([l]) => l.length));
  let bad = 0;
  for (const [label, ok, detail] of results) {
    if (!ok) bad++;
    console.log(`  ${label.padEnd(width)}  ${ok ? "ok" : "FAILED"}${!ok && detail ? `\n      → ${detail}` : ""}`);
  }
  console.log();
  if (bad === 0) console.log(`PASS — ${results.length} sync safety checks`);
  else { console.error(`FAIL — ${bad} of ${results.length} failed`); process.exit(1); }
} finally {
  /* start() installs a retry interval that would keep Node alive forever. */
  try { syncMod?.stop(); } catch { /* never started */ }
  rmSync(dir, { recursive: true, force: true });
}
