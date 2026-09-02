# CLAUDE.md

## Purpose

This repository is **F2F — Fitness-to-Flap Score**, a web-based **preoperative risk stratification tool for plastic surgery flap reconstruction** (Pressure Injury module). It helps **residents and clinicians**:
- screen patients for surgical red flags
- score flap-failure risk across four clinical domains
- get a risk tier + patient-specific optimization action plan
- save, review, and export de-identified assessments

Claude should act like a **senior product engineer** on a live clinical beta with real users. The goal is a tool that is **clinically trustworthy, clean, and pleasant to use** on both desktop and phone — not generic code output.

Author of the clinical model: Pedro Fuenmayor, MD (Larkin Community Hospital, Miami). Presented FSPS 2025. IRB-approved at Larkin, Palmetto General, Delray Medical Center.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | Single-file React — `src/App.jsx` (UI + state + CSS-in-template-string) |
| Build | Vite 5 + `@vitejs/plugin-react` |
| Animation | **Framer Motion** (v12) |
| Backend | **Supabase** — Postgres + Auth + Row-Level Security |
| Auth | **Service access codes** over anonymous sign-in for collectors; email+password (or Google) for admins |
| Persistence | Postgres is the source of truth. `localStorage` (`f2f_*` keys) is an offline cache and outbox — see `src/lib/sync.js` |
| Hosting | Vercel — team `yeai`, auto-deploys on push |

## Source & Access

- **Our repo (canonical):** `yashaefimenko-ai/f2f-score`. Work happens here.
- **Upstream:** `plasticsresearch2022/f2f-score` (Pedro's, **private**, read-only to us). Requires the **`yashaefimenko-ai`** GitHub account, NOT `heliosxloupes`. Get a token without switching accounts: `gh auth token -u yashaefimenko-ai`.
- Local: `c:\Users\IVIso\OneDrive\Desktop\Cursor\f2f-score`
- Live: https://f2f-score-yeai.vercel.app

**Read `UPSTREAM.md` before touching `src/App.jsx`.** The clinical engine is
copied verbatim from Pedro and is guarded by a parity check. We never push to
his repo.

---

## Architecture

`src/App.jsx` is a **deliberately centralized app shell**: scoring engine, all screens, and the CSS string. Do **not** propose a full rewrite or split it apart without a real reason. Backend concerns live in `src/lib/` precisely so the App.jsx diff against upstream stays small.

| File | Role |
|---|---|
| `src/App.jsx` | Clinical engine (Pedro's, verbatim) + all screens + CSS |
| `src/lib/supabase.js` | Client (PKCE, persisted sessions) |
| `src/lib/auth.js` | Service-code redemption, roster, admin sign-in, session context |
| `src/lib/db.js` | Insert-only writes, `*_current` reads, admin reads, void RPCs |
| `src/lib/sync.js` | Offline-first cache + outbox; the seam Pedro's storage calls hook into |
| `supabase/schema.sql` | Tables, RLS, RPCs, audit triggers. Idempotent. |

### Scoring engine — the crown jewel (NEVER edit — it is upstream's)
- `DOMAINS` — 4 clinical domains, each field with point values, each capped at `maxPts`
- `TIERS` — Low (0–5) / Moderate (6–12) / High (13–19) / Not Ideal (20+)
- `FLAG_TIER` / `FLAG_ACTIONS` — an in-domain red flag overrides the numeric tier
- `RISK_FLAGS` — pre-screen surgical red flags
- `OUTCOME_FIELDS` / `CD_OPTIONS` — 30-day endpoints, derived Clavien-Dindo
- `computeScore()`, `getTier()`, `buildRecs()`, `projectScore()`, `buildFullCSV()`, `buildCopyText()`

A change to point values, thresholds, or recommendation logic is a **clinical
decision, not an engineering one** — it happens upstream first, then we re-sync.
`npm run verify:clinical` fails if any of these drift.

### Screens
home · intake · id_confirm · wizard · records · detail · outcomes · settings · about · **admin** (role-gated monitoring)

### Access model
- **Collectors** — anonymous Supabase session + a service access code, then a name from the roster. One step, once per device. Every row carries `service_id` and `entered_by_name`.
- **Admins** — email+password; `profiles.role='admin'` unlocks cross-service reads and the void RPCs.

### Data & privacy
- **De-identified by design**: Study IDs like `LCH-001`, never patient names/MRNs. The de-identification log lives outside the app.
- Keep it de-identified. Do not add PHI fields. Preserve the clinical disclaimer.
- **Append-only.** There is no UPDATE or DELETE policy on `assessments` or `outcomes`. Corrections insert a row with `supersedes_id`; voiding is an admin RPC that requires a reason. Never add a policy that would let a row be rewritten.

### Verification
```bash
npm run check   # clinical parity + render (both modes) + integrity tests + build
```
Run it before every deploy. `npm run test:integrity` covers the tamper detection
that the admin dashboard's credibility rests on.

---

## Design System

Clean, editorial, medical. **Keep the existing color scheme** — enhance, never make it louder.

- **Fonts:** Instrument Serif (display, italic) · DM Sans (body) · DM Mono (data/labels)
- **Palette (monochrome + one accent):** black `--k:#111`, greys `--k2/--k3/--k4`, surfaces `--g1/--g2/--g3`, white `--w`, red accent `--r:#c8102e` (red flags / urgent only)
- **Tokens:** use the CSS variables in the `css` string. **No magic numbers** — never hardcode colors/sizes.
- **Responsive:** mobile-first. <768px full-bleed single column; ≥768px centered editorial card on grey backdrop; ≥1024px wider. Use `100dvh`.
- **Motion (Framer Motion):** subtle and *meaningful* — wizard step transitions, score reveal, staggered recommendation cards. Every animation expresses cause→effect. Durations 150–400ms. **Always respect `prefers-reduced-motion`** (a global reduce rule already exists in the CSS).
- **Accessibility:** visible `:focus-visible` rings, 4.5:1 contrast, 44px touch targets, keyboard nav.

---

## Skills, Plugins & MCP

Use available skills/plugins/MCP when they materially improve speed, correctness, or quality — not performatively.

| Tool | Use for |
|---|---|
| `/ui-ux-pro-max` | any significant UI/UX work (design reasoning, styles, review) |
| `/gsd` | long, complex sessions — context engineering & spec-driven workstreams |
| Framer Motion | all animation/motion work |
| `/obsidian` | notes / vault |
| `magic` MCP (`@21st-dev/magic`) | generating polished new UI components |
| `playwright` / `chrome-devtools` MCP | browser automation & live DOM debugging |
| Plugins: claude-mem, frontend-design | persistent memory; component/layout work |

---

## Conventions

1. **Never change the clinical engine.** It is Pedro's. Re-sync from upstream instead — see `UPSTREAM.md`.
2. Preserve **de-identification** and the clinical disclaimer.
3. **Never make the data tables mutable.** Append-only is a research-integrity property, not a preference.
4. Keep backend work in `src/lib/`. Every line added to `App.jsx` widens the diff we have to re-reconcile on Pedro's next upload.
5. Keep the **single-file** structure for the UI unless there's a real reason to split.
6. Use **design tokens**, match existing spacing/motion/hierarchy.
7. **Run `npm run check`** before deploying — not just `npm run build`.
8. Optimise for the resident at the bedside on a phone with bad wifi. Friction is why data ends up in a spreadsheet instead of the database.

## Communication Style

Concise, direct, high-signal. Confident but honest.
