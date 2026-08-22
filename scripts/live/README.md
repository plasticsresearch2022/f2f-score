# Live tests — run against the real Supabase project

These hit the actual database. The unit-ish tests in `scripts/` (parity,
render, integrity) run anywhere; these need credentials, so they are not
part of `npm run check`.

## Why they exist

RLS is the only thing standing between one surgical service and another's
data, and between a resident and a rewritten score. Reading the policies
does not prove they work — a view without `security_invoker`, a policy that
matches more than intended, or an `UPDATE` that quietly succeeds all look
fine in the SQL. These tests act as two real anonymous collectors on two
real services and try the attacks.

## Running them

`sql-bridge.mjs` executes admin SQL by borrowing the session of a logged-in
Supabase dashboard tab, via the local Kimi WebBridge daemon. That avoids
keeping a service-role key on disk.

```bash
# 1. Daemon healthy and a Supabase dashboard tab open and logged in
~/.kimi-webbridge/bin/kimi-webbridge status

# 2. From this directory
cd scripts/live
node probe-anon-auth.mjs     # is anonymous sign-in enabled?
node rls-test.mjs            # 21 security checks
node sql-bridge.mjs -q "select count(*) from public.assessments"
node sql-bridge.mjs -f ../../supabase/schema.sql
```

`rls-test.mjs` creates two throwaway services (`zztest-*`), exercises them,
and deletes them plus every row and anonymous user they produced. It prints
the surviving assessment count so an accidental deletion of real data is
immediately visible.

If you would rather not use the browser bridge, replace the `sql()` helper in
`rls-test.mjs` with a direct `postgres://` connection or a service-role key —
nothing else depends on the bridge.

## What is covered

| Area | Checks |
|---|---|
| Access codes | valid accepted, wrong rejected, wrong grants nothing, failure is audited |
| Isolation | unaffiliated sees nothing, cross-service read blocked, targeted fetch by id blocked, cross-service insert blocked |
| Append-only | `UPDATE` affects zero rows, `DELETE` refused, stored score unchanged |
| Secrets | bcrypt hash not client-readable, audit log admin-only, only own service row visible |
| Audit | assessment creation, code redemptions, and failed attempts all logged |
| Privilege | a collector cannot call the void RPC |

## Gotchas found the hard way

- **`security_invoker = true` on the `*_current` views is load-bearing.** Views
  run as their owner (`postgres`) by default and would bypass RLS entirely.
- **`RAISE` rolls back the audit insert.** `redeem_service_code` returns
  `{ok:false}` instead of raising, or a failed code attempt leaves no trace.
- **pgcrypto lives in `extensions`, not `public`.** Any `SECURITY DEFINER`
  function calling `crypt()` needs `set search_path = public, extensions`.
- **A blocked `UPDATE` returns 204, not an error.** With no UPDATE policy RLS
  simply makes zero rows visible, so assert on the stored value, not the status.
