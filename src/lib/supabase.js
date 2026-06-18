import { createClient } from "@supabase/supabase-js";

/* ═══════════════════════════════════════════════
   SUPABASE CLIENT
   Reads Vite env vars (set in .env.local + Vercel).
   PKCE flow = native-ready for the future Capacitor /
   App Store wrap; sessions persist + auto-refresh.
═══════════════════════════════════════════════ */
const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

// Helps catch a missing/incomplete .env.local during dev.
export const isSupabaseConfigured = Boolean(url && anonKey);

if (!isSupabaseConfigured) {
  console.warn(
    "[F2F] Supabase env vars missing — auth & cloud sync disabled. " +
    "Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in .env.local."
  );
}

export const supabase = isSupabaseConfigured
  ? createClient(url, anonKey, {
      auth: {
        flowType: "pkce",
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    })
  : null;
