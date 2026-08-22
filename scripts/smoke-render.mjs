#!/usr/bin/env node
/* ═══════════════════════════════════════════════
   RENDER SMOKE TEST

   `vite build` only proves the file compiles. This proves
   the component tree actually renders — catching bad hook
   order, undefined references, and broken JSX before they
   reach a clinician mid-assessment.

   Usage:  npm run smoke
═══════════════════════════════════════════════ */
import { build } from "esbuild";
import { pathToFileURL } from "url";
import { mkdtempSync, rmSync } from "fs";
import path from "path";

/* The bundle must live inside the project so its `react` / `framer-motion`
   externals resolve against node_modules — a system temp dir cannot see them. */
const dir = mkdtempSync(path.join("node_modules", ".f2f-smoke-"));
const out = path.join(dir, "App.ssr.mjs");

try {
  await build({
    entryPoints: ["src/App.jsx"],
    bundle: true, format: "esm", outfile: out,
    jsx: "automatic", platform: "node",
    external: ["react", "react-dom", "react/jsx-runtime", "framer-motion", "@supabase/supabase-js"],
    loader: { ".jsx": "jsx" }, logLevel: "silent",
  });

  /* Minimal browser shims. The app guards localStorage itself, but the
     shim keeps the guards on their happy path so we test real behaviour. */
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    key: (i) => [...store.keys()][i] ?? null,
    get length() { return store.size; },
  };

  const { renderToString } = await import("react-dom/server");
  const React = (await import("react")).default;
  const App = (await import(pathToFileURL(out).href)).default;

  const html = renderToString(React.createElement(App));

  const checks = [
    ["renders a non-trivial tree",  html.length > 500],
    ["header brand present",        html.includes("Fitness-to-Flap Score")],
    ["sheet wrapper present",       html.includes('class="sheet')],
    ["a landing screen rendered",   /Begin F2F Assessment|New Patient Assessment|Enter 30-Day Outcomes/.test(html)],
    ["clinical disclaimer intact",  /research and educational/i.test(html)],
    ["responsive css shipped",      html.includes("min-width:768px")],
    ["reduced-motion guard shipped",html.includes("prefers-reduced-motion")],
  ];

  let bad = 0;
  const width = Math.max(...checks.map(([l]) => l.length));
  for (const [label, ok] of checks) {
    if (!ok) bad++;
    console.log(`  ${label.padEnd(width)}  ${ok ? "ok" : "FAILED"}`);
  }

  console.log();
  if (bad === 0) {
    console.log(`PASS — renders cleanly (${html.length} chars of HTML)`);
  } else {
    console.error(`FAIL — ${bad} check(s) failed`);
    process.exit(1);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
