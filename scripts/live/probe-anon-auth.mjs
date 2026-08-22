/* Functional probe: is anonymous sign-in actually enabled?
   Reads the client keys from the project's own .env.local and asks the
   auth endpoint directly. More reliable than reading dashboard config,
   and it tests the exact path the app will take. */
import fs from "fs";

const env = Object.fromEntries(
  fs.readFileSync(new URL("../../.env.local", import.meta.url), "utf8")
    .split(/\r?\n/).filter(l => l && !l.startsWith("#") && l.includes("="))
    .map(l => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
);

const url = env.VITE_SUPABASE_URL;
const key = env.VITE_SUPABASE_ANON_KEY;
if (!url || !key) { console.error("missing env"); process.exit(2); }

const r = await fetch(`${url}/auth/v1/signup`, {
  method: "POST",
  headers: { "Content-Type": "application/json", apikey: key, Authorization: `Bearer ${key}` },
  body: JSON.stringify({}),   // empty body == anonymous sign-in
});
const t = await r.text();
let d; try { d = JSON.parse(t); } catch { d = t.slice(0, 300); }

if (r.ok && d.access_token) {
  console.log("ANONYMOUS SIGN-IN: ENABLED");
  console.log("  created throwaway user:", d.user?.id, "is_anonymous:", d.user?.is_anonymous);
} else {
  console.log("ANONYMOUS SIGN-IN: NOT WORKING");
  console.log("  http", r.status, "-", d.msg || d.error_description || d.message || JSON.stringify(d).slice(0, 200));
}
