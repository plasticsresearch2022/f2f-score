#!/usr/bin/env node
/* ═══════════════════════════════════════════════
   RENDER SMOKE TEST

   `vite build` only proves the file compiles. This proves
   the component tree actually renders — catching bad hook
   order, undefined references, and broken JSX before they
   reach a clinician mid-assessment.

   Two modes, because the app has two very different first paints:
     local-only  — no Supabase env, behaves like upstream
     configured  — Supabase env present, boots into the access gate

   Usage:  npm run smoke
═══════════════════════════════════════════════ */
import { build } from "esbuild";
import { pathToFileURL } from "url";
import { mkdtempSync, rmSync } from "fs";
import path from "path";

/* The bundle must live inside the project so its `react` / `framer-motion`
   externals resolve against node_modules — a system temp dir cannot see them. */
const dir = mkdtempSync(path.join("node_modules", ".f2f-smoke-"));

/* Minimal browser shims. The app guards localStorage itself, but the
   shim keeps the guards on their happy path so we test real behaviour. */
function installShims() {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    key: (i) => [...store.keys()][i] ?? null,
    get length() { return store.size; },
  };
  globalThis.window ??= {
    addEventListener() {}, removeEventListener() {},
    location: { origin: "http://localhost", href: "http://localhost/" },
    localStorage: globalThis.localStorage,
    navigator: { onLine: true, userAgent: "node" },
  };
  globalThis.navigator ??= { onLine: true, userAgent: "node" };

  /* framer-motion's AnimatePresence uses useLayoutEffect, which React warns
     about under renderToString. The app is client-only, so this is pure SSR
     noise — silence it so a real failure is not buried in stack traces. */
  const realError = console.error;
  console.error = (...args) => {
    if (typeof args[0] === "string" && args[0].includes("useLayoutEffect does nothing on the server")) return;
    realError(...args);
  };
}

async function renderWith(env, label) {
  const out = path.join(dir, `App.${label}.mjs`);
  await build({
    entryPoints: ["src/App.jsx"],
    bundle: true, format: "esm", outfile: out,
    jsx: "automatic", platform: "node",
    external: ["react", "react-dom", "react/jsx-runtime", "framer-motion", "@supabase/supabase-js"],
    define: { "import.meta.env": JSON.stringify(env) },
    loader: { ".jsx": "jsx" }, logLevel: "silent",
  });

  const { renderToString } = await import("react-dom/server");
  const React = (await import("react")).default;
  const App = (await import(pathToFileURL(out).href)).default;
  return renderToString(React.createElement(App));
}

const results = [];
function check(label, ok) { results.push([label, ok]); }

try {
  installShims();

  /* ── Mode 1: no Supabase env → upstream behaviour ── */
  const local = await renderWith({}, "local");
  check("local-only: renders a non-trivial tree",   local.length > 500);
  check("local-only: header brand present",         local.includes("Fitness-to-Flap Score"));
  check("local-only: sheet wrapper present",        local.includes('class="sheet'));
  check("local-only: a landing screen rendered",    /Begin F2F Assessment|New Patient Assessment|Enter 30-Day Outcomes/.test(local));
  check("local-only: clinical disclaimer intact",   /research and educational/i.test(local));
  check("local-only: responsive css shipped",       local.includes("min-width:768px"));
  check("local-only: reduced-motion guard shipped", local.includes("prefers-reduced-motion"));
  check("local-only: no access gate",               !local.includes('class="gate"'));

  /* ── Mode 2: Supabase configured → boots into the gate path ── */
  const cloud = await renderWith(
    { VITE_SUPABASE_URL: "https://example.supabase.co", VITE_SUPABASE_ANON_KEY: "test-anon-key" },
    "cloud"
  );
  check("configured: renders without throwing",     cloud.length > 100);
  check("configured: shows boot splash, not app",   cloud.includes('class="boot"'));
  check("configured: gate css shipped",             cloud.includes(".gate-brand"));
  check("configured: no assessment leaks pre-auth", !/Begin F2F Assessment/.test(cloud));

  const width = Math.max(...results.map(([l]) => l.length));
  let bad = 0;
  for (const [label, ok] of results) {
    if (!ok) bad++;
    console.log(`  ${label.padEnd(width)}  ${ok ? "ok" : "FAILED"}`);
  }

  console.log();
  if (bad === 0) {
    console.log(`PASS — both modes render cleanly (${local.length} / ${cloud.length} chars)`);
  } else {
    console.error(`FAIL — ${bad} check(s) failed`);
    process.exit(1);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
