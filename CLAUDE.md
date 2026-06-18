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
| Hosting | Vercel — scope `heliosxloupes-projects` |
| Persistence (current) | `localStorage` (`f2f_*` keys) + optional Make.com webhook (Study ID → OneDrive) |
| Backend (planned) | **Supabase** — Postgres + Auth + Row-Level Security |
| Auth (planned) | **Google SSO** for clinicians; multi-user, per-clinician saved assessments |

## Source & Access

- GitHub: `plasticsresearch2022/f2f-score` (**private**). Requires the **`yashaefimenko-ai`** GitHub account (NOT `heliosxloupes`). Use `gh auth switch` + `gh repo clone` (plain `git clone` uses the wrong cached token).
- Local: `c:\Users\IVIso\OneDrive\Desktop\Cursor\HeliosX\f2f-score`
- Deploy: `vercel deploy --prod --yes --scope heliosxloupes-projects`
- Live: https://f2f-score-beige.vercel.app

---

## Architecture

`src/App.jsx` is a **deliberately centralized app shell** (~1100 lines): scoring engine, all screens, and the CSS string. Do **not** propose a full rewrite or split it apart without a real reason.

### Scoring engine — the crown jewel (DO NOT ALTER without explicit instruction)
- `DOMAINS` — 4 clinical domains (Biomarkers & Nutrition, Wound Factors, Comorbidities, Functional & Social), each field with point values
- `TIERS` — Low (0–5) / Moderate (6–12) / High (13–19) / Not Ideal (20+)
- `RISK_FLAGS` — pre-screen surgical red flags
- `computeScore()`, `getTier()`, `buildRecs()` — scoring + patient-specific action plan generation

Any change to point values, thresholds, or recommendation logic is a **clinical change** — confirm before touching.

### Screens
home · intake (assessment type → hospital → study ID) · id_confirm (de-ID log) · wizard (red-flag pre-screen → 4 domains → result) · records · detail · settings · about

### Data & privacy
- **De-identified by design**: Study IDs like `LCH-001`, never patient names/MRNs. The de-identification log lives outside the app.
- Keep it de-identified. Do not add PHI fields. Preserve the clinical disclaimer.

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

1. **Never silently change scoring/clinical logic.** Confirm clinical changes.
2. Preserve **de-identification** and the clinical disclaimer.
3. Keep the **single-file** structure unless there's a real reason to split.
4. Use **design tokens**, match existing spacing/motion/hierarchy.
5. **Sanity-check builds** (`npm run build`) before deploying.
6. Deploy to Vercel after meaningful changes (user's workflow).

## Communication Style

Concise, direct, high-signal. Confident but honest.
