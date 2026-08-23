import { supabase } from "./supabase";
import {
  insertAssessment, insertOutcome, fetchAssessments, fetchOutcomes,
} from "./db";

/* ═══════════════════════════════════════════════
   OFFLINE-FIRST SYNC

   Postgres is the source of truth. localStorage is a cache
   and an outbox.

   Why this shape: hospital wifi at the bedside drops, and an
   assessment takes several minutes to complete. A failed save
   must never lose an entry, and a resident must never have to
   think about connectivity. So writes always land locally and
   synchronously first, then drain to the server when they can.

   It also keeps the seam into App.jsx tiny — Pedro's synchronous
   persistCase / fetchAllCases / persistOutcome keep working
   untouched, which is what makes re-syncing his next upload cheap.

   Local key scheme (unchanged from upstream, so his readers work):
     f2f_case_<studyId>_<timestamp>     pending, written by the app
     f2f_case_<studyId>_r_<remoteId>    confirmed, mirrored from server
     f2f_outcome_<studyId>              one per study, latest wins
═══════════════════════════════════════════════ */

const QUEUE_KEY = "f2f_sync_queue";
const CASE_PREFIX = "f2f_case_";
const OUTCOME_PREFIX = "f2f_outcome_";
const RETRY_MS = 30_000;

/* ── localStorage helpers (private-mode safe) ── */
const ls = {
  get(k)      { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v)   { try { localStorage.setItem(k, String(v)); return true; } catch { return false; } },
  del(k)      { try { localStorage.removeItem(k); } catch { /* ignore */ } },
  keys(p)     { try { return Object.keys(localStorage).filter(k => k.startsWith(p)); } catch { return []; } },
  json(k)     { const r = ls.get(k); if (!r) return null; try { return JSON.parse(r); } catch { return null; } },
};

/* ── Outbox ──────────────────────────────────── */

function queue() { return ls.json(QUEUE_KEY) || []; }
function setQueue(q) { ls.set(QUEUE_KEY, JSON.stringify(q)); }

/**
 * Mark a locally-written record as needing a push.
 *
 * The identity is captured HERE, not at upload time. Otherwise an entry
 * still sitting in the outbox when someone redeems a different service
 * code would upload stamped with the new service — silently attributing
 * one service's patient to another.
 */
export function enqueue(kind, key) {
  const q = queue();
  if (!q.some(e => e.key === key)) {
    q.push({
      kind, key, at: Date.now(), state: "pending",
      ctx: ctx ? { userId: ctx.userId, serviceId: ctx.serviceId,
                   memberId: ctx.memberId, displayName: ctx.displayName } : null,
    });
    setQueue(q);
  }
  if (canPush() && navigator.onLine !== false) flush().catch(() => {});
}

function dequeue(key) { setQueue(queue().filter(e => e.key !== key)); }

/** Move an entry out of the retry loop but keep it visible and recoverable. */
function markFailed(key, reason) {
  setQueue(queue().map(e => (e.key === key ? { ...e, state: "failed", reason, failedAt: Date.now() } : e)));
}

const pendingEntries = () => queue().filter(e => e.state !== "failed");
const failedEntries  = () => queue().filter(e => e.state === "failed");

export function pendingCount() { return pendingEntries().length; }
export function failedCount()  { return failedEntries().length; }

/** Study IDs of everything that did not make it, for the warning banner. */
export function failedRecords() {
  return failedEntries().map(e => {
    const rec = ls.json(e.key) || {};
    return { key: e.key, kind: e.kind, studyId: rec.studyId || "(unknown)", reason: e.reason || "unknown error" };
  });
}

/** Put failed entries back in the queue — used by the Retry button. */
export function retryFailed() {
  setQueue(queue().map(e => (e.state === "failed" ? { ...e, state: "pending", reason: undefined } : e)));
  notify(status());
  return flush();
}

/* ── Context ─────────────────────────────────── */

let ctx = null;          // { userId, serviceId, memberId, displayName, canCollect }
let listeners = new Set();
let timer = null;
let flushing = false;

/* Pulling and pushing are separate rights. An admin has no service of their
   own, so they can read everything RLS exposes but must not queue writes —
   an insert without a service_id would be rejected and churn the outbox. */
function canPull() { return Boolean(supabase && ctx); }
function canPush() { return Boolean(supabase && ctx && ctx.canCollect); }

function notify(state) { for (const fn of listeners) { try { fn(state); } catch { /* ignore */ } } }

export function onSyncChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

export function status() {
  const failed = failedCount();
  return {
    online:  typeof navigator === "undefined" ? true : navigator.onLine !== false,
    cloud:   canPush(),
    pending: pendingCount(),
    failed,
    /* The single flag the UI trusts. Only true when the server has confirmed
       everything — never merely because the retry loop gave up. */
    allSaved: failed === 0 && pendingCount() === 0,
  };
}

/* ── Push ────────────────────────────────────── */

/**
 * Drain the outbox. Records that fail stay queued and are retried;
 * a record rejected by RLS (a genuine permission problem, not a
 * network blip) is dropped from the queue so it cannot wedge the
 * loop forever — it stays in localStorage either way.
 */
export async function flush() {
  if (!canPush() || flushing) return;
  flushing = true;
  try {
    for (const entry of pendingEntries()) {
      const record = ls.json(entry.key);
      if (!record) { dequeue(entry.key); continue; }
      if (record._sync === "synced") { dequeue(entry.key); continue; }

      /* Upload under the identity the entry was made with. If the session has
         since moved to another service, hold it rather than misattribute it. */
      const stamp = entry.ctx;
      if (stamp && stamp.serviceId && stamp.serviceId !== ctx.serviceId) {
        markFailed(entry.key,
          "Entered under a different service than the one now signed in. Sign back in to that service to upload it.");
        continue;
      }
      const useCtx = stamp && stamp.serviceId ? { ...ctx, ...stamp } : ctx;

      try {
        if (entry.kind === "case") {
          const saved = await insertAssessment(record, useCtx);
          // Re-key to the confirmed id so a later pull does not duplicate it.
          ls.del(entry.key);
          ls.set(`${CASE_PREFIX}${saved.studyId}_r_${saved.remoteId}`,
                 JSON.stringify({ ...record, ...saved, _sync: "synced" }));
        } else {
          const saved = await insertOutcome(record, useCtx);
          ls.set(`${OUTCOME_PREFIX}${saved.studyId}`,
                 JSON.stringify({ ...record, ...saved, _sync: "synced" }));
        }
        dequeue(entry.key);
      } catch (err) {
        if (isPermanent(err)) {
          /* Do NOT dequeue. Dropping it here is what made a lost record look
             saved: the pending count fell to zero, the indicator went green,
             and the row still showed in Records. It stays visible until
             someone deals with it. */
          console.warn("[F2F] sync rejected:", entry.key, err?.message);
          ls.set(entry.key, JSON.stringify({ ...record, _sync: "failed", _error: err?.message }));
          markFailed(entry.key, err?.message || "rejected by the server");
        } else {
          break;   // network/transient — stop, keep order, retry later
        }
      }
    }
  } finally {
    flushing = false;
    notify(status());
  }
}

/* A 4xx from PostgREST means the row will never be accepted as-is;
   retrying it forever would block everything queued behind it. */
function isPermanent(err) {
  const code = err?.code || "";
  return /^(2[0-9]|42|23)/.test(code) || /row-level security|violates|invalid input/i.test(err?.message || "");
}

/* ── Pull ────────────────────────────────────── */

/** Mirror the server's live rows into the local cache. */
export async function pull() {
  if (!canPull()) return { cases: 0, outcomes: 0 };

  const [cases, outcomes] = await Promise.all([fetchAssessments(), fetchOutcomes()]);

  // Drop previously-confirmed mirrors so deletions/voids upstream disappear
  // locally too. Pending local writes (no _r_ marker) are deliberately kept.
  for (const k of ls.keys(CASE_PREFIX)) {
    if (k.includes("_r_")) ls.del(k);
  }
  for (const c of cases) {
    ls.set(`${CASE_PREFIX}${c.studyId}_r_${c.remoteId}`, JSON.stringify({ ...c, _sync: "synced" }));
  }

  // One outcome per study; the view already returns only the live one.
  for (const o of outcomes) {
    ls.set(`${OUTCOME_PREFIX}${o.studyId}`, JSON.stringify({ ...o, _sync: "synced" }));
  }

  notify(status());
  return { cases: cases.length, outcomes: outcomes.length };
}

/* ── Lifecycle ───────────────────────────────── */

/**
 * Point the sync layer at a signed-in context and start draining.
 * Call again whenever the context changes (sign-in, code redeem, sign-out).
 */
export async function start(nextCtx) {
  ctx = nextCtx || null;
  stopTimers();

  if (!canPull()) { notify(status()); return; }

  window.addEventListener("online", onOnline);
  timer = setInterval(() => { flush().catch(() => {}); }, RETRY_MS);

  try { await pull(); } catch (e) { console.warn("[F2F] pull failed:", e?.message); }
  await flush();
}

export function stop() {
  ctx = null;
  stopTimers();
  notify(status());
}

function onOnline() { flush().catch(() => {}); }

function stopTimers() {
  if (timer) { clearInterval(timer); timer = null; }
  window.removeEventListener("online", onOnline);
}

/** Wipe the local cache — used on sign-out so a shared device leaks nothing. */
export function clearLocalCache() {
  for (const k of [...ls.keys(CASE_PREFIX), ...ls.keys(OUTCOME_PREFIX)]) ls.del(k);
  ls.del(QUEUE_KEY);
}
