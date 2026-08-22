/* Run SQL against the user's Supabase project through the logged-in
   dashboard tab. Base64 in / JSON out, so no shell or JSON quoting can
   corrupt the statement — which it silently did on the first attempts.

   Usage:
     node sql.mjs -f path/to/file.sql       # run a file
     node sql.mjs -q "select 1"             # run a literal
*/
import fs from "fs";

const REF = "ekjubkxdoogexikojzvr";
const DAEMON = "http://127.0.0.1:10086/command";

const args = process.argv.slice(2);
let sql = "";
if (args[0] === "-f") sql = fs.readFileSync(args[1], "utf8");
else if (args[0] === "-q") sql = args.slice(1).join(" ");
else { console.error("usage: sql.mjs -f <file> | -q <sql>"); process.exit(2); }

const b64 = Buffer.from(sql, "utf8").toString("base64");

/* Defines __sql fresh each run (evaluate shares the page realm, but the tab
   may have navigated). Token is read inside the page and never returned. */
const code = `(async()=>{
  const tok = JSON.parse(localStorage.getItem("supabase.dashboard.auth.token")).access_token;
  window.__sql = async (q) => {
    const r = await fetch("https://api.supabase.com/v1/projects/${REF}/database/query", {
      method: "POST", credentials: "include",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + tok },
      body: JSON.stringify({ query: q }),
    });
    const t = await r.text();
    let d; try { d = JSON.parse(t); } catch (e) { d = t.slice(0, 800); }
    return { status: r.status, d };
  };
  const bin = atob("${b64}");
  const sql = new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0)));
  const res = await window.__sql(sql);
  return JSON.stringify(res);
})()`;

const resp = await fetch(DAEMON, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ action: "evaluate", args: { code }, session: "f2f-supabase" }),
});

const out = await resp.json();
if (!out.ok) { console.error("daemon error:", JSON.stringify(out).slice(0, 600)); process.exit(1); }

let payload;
try { payload = JSON.parse(out.data.value); }
catch { console.error("unparseable:", String(out.data?.value).slice(0, 600)); process.exit(1); }

if (payload.status !== 201 && payload.status !== 200) {
  console.error(`SQL ERROR (http ${payload.status}):`);
  console.error(typeof payload.d === "string" ? payload.d : (payload.d?.message || JSON.stringify(payload.d)));
  process.exit(1);
}
console.log(JSON.stringify(payload.d, null, 1));
