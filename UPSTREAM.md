# Upstream sync

UPSTREAM_SHA: 9e12c31

This repo is a fork of **`plasticsresearch2022/f2f-score`** (Pedro Fuenmayor, MD).
The line above records the exact upstream commit our `src/App.jsx` clinical
content is derived from. Keep it accurate — the parity check reads it.

## Division of ownership

| Owned by Pedro (upstream) | Owned by us |
|---|---|
| The clinical engine — `DOMAINS`, `TIERS`, `FLAG_TIER`, `FLAG_ACTIONS`, `RISK_FLAGS`, `computeScore`, `getTier`, `buildRecs` | Supabase backend, service auth, admin monitoring |
| Outcome definitions — `OUTCOME_FIELDS`, `CD_OPTIONS`, `cdGradeFromOption` | Framer Motion, responsive layout, accessibility |
| Optimization projection — `MODIFIABLE`, `oneLevelBetter`, `projectScore` | Everything in `src/lib/` |
| Export shape — `buildCopyText`, `buildFullCSV`, `HOSPITALS` | |

**We never edit the left column.** Those sections are copied verbatim and
guarded by `scripts/verify-clinical-parity.mjs`. If one of them needs to
change, it changes upstream first — a scoring change is a clinical decision,
not an engineering one.

We never push to Pedro's repo. `upstream` is read-only.

## Re-syncing when Pedro uploads a new version

He works by dragging `App.jsx` into the GitHub web UI, so every upload lands
as a squashed "Add files via upload" commit with no useful history. The diff
between his commits is the only signal.

```bash
# 1. Fetch his latest (the yashaefimenko-ai account has access, not heliosxloupes)
T=$(gh auth token -u yashaefimenko-ai)
git fetch "https://x-access-token:$T@github.com/plasticsresearch2022/f2f-score.git" \
  main:refs/remotes/upstream/main

# 2. See what actually changed in his content since our recorded base
git diff $(grep -oP 'UPSTREAM_SHA:\s*\K\S+' UPSTREAM.md) upstream/main -- src/App.jsx

# 3. Apply only the clinical hunks to our src/App.jsx by hand.
#    Ignore his UI/layout changes — that half is ours.

# 4. Bump UPSTREAM_SHA above to his new SHA, then prove the port was faithful:
npm run verify:clinical
```

Step 4 is the point of the whole arrangement. It compares each clinical
section against upstream byte-for-byte, so a mistyped point value or a
dropped recommendation fails loudly instead of silently changing a score.

## Verification

```bash
npm run verify:clinical   # clinical engine matches UPSTREAM_SHA
npm run build             # compiles
```
