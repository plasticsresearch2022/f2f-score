import { supabase, isSupabaseConfigured } from "./supabase";

/* ═══════════════════════════════════════════════
   AUTH

   One door: Google. The Gmail account IS the identity, which is
   the point — a resident's patients follow them to whatever
   device they pick up, and "who entered this" survives a cleared
   browser. Nothing is remembered per device.

   First sign-in ends on "which service are you on?". After that
   it goes straight through. Admin is decided server-side by
   admin_allowlist, never by anything the client sends.
═══════════════════════════════════════════════ */

/* ── Session ─────────────────────────────────── */

export async function getSession() {
  if (!supabase) return null;
  const { data } = await supabase.auth.getSession();
  return data.session ?? null;
}

export function onAuthChange(cb) {
  if (!supabase) return () => {};
  const { data } = supabase.auth.onAuthStateChange((_evt, session) => cb(session));
  return () => data.subscription.unsubscribe();
}

export async function signOut() {
  if (supabase) await supabase.auth.signOut();
}

/* ── Service selection ───────────────────────── */

/** The rotations a new user can choose from. */
export async function fetchServices() {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from("services")
    .select("id, name, hospital_id, hospital_name")
    .eq("active", true)
    .order("name");
  if (error) throw error;
  return data || [];
}

/**
 * Join or switch rotation.
 * Goes through an RPC rather than writing profiles.service_id directly —
 * that column is deliberately not client-writable, because letting anyone
 * point themselves at another service was a real escalation. The RPC
 * validates the target and audits the change.
 */
export async function setMyService(serviceId) {
  if (!supabase) throw new Error("Supabase is not configured");
  const { data, error } = await supabase.rpc("set_my_service", { p_service_id: serviceId });
  if (error) throw friendlyAuthError(error);
  return data;
}

export async function signInWithGoogle() {
  if (!supabase) throw new Error("Supabase is not configured");
  const { error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: window.location.origin },
  });
  if (error) throw friendlyAuthError(error);
}

/* ── Profile / context ───────────────────────── */

/**
 * Who is this session, and what may it see?
 * Returns null when there is no session or no profile row yet.
 */
export async function fetchContext() {
  if (!supabase) return null;
  const session = await getSession();
  if (!session) return null;

  const { data: profile, error } = await supabase
    .from("profiles")
    .select("id, role, service_id, member_id, full_name, email, blocked")
    .eq("id", session.user.id)
    .maybeSingle();
  if (error) throw error;
  if (!profile) return null;

  let service = null;
  if (profile.service_id) {
    const { data } = await supabase
      .from("services")
      .select("id, name, slug, hospital_id, hospital_name")
      .eq("id", profile.service_id)
      .maybeSingle();
    service = data ?? null;
  }

  const meta = session.user.user_metadata || {};
  return {
    userId:      session.user.id,
    blocked:     Boolean(profile.blocked),
    role:        profile.role || "collector",
    isAdmin:     profile.role === "admin" && !profile.blocked,
    serviceId:   profile.service_id,
    memberId:    profile.member_id,
    /* Google gives a real name; fall back to the address so nobody is
       ever recorded as "unknown". */
    displayName: profile.full_name || meta.full_name || meta.name || profile.email || session.user.email || "",
    email:       profile.email || session.user.email || null,
    avatar:      meta.avatar_url || meta.picture || null,
    service,
    /* No service picked yet, or blocked — either way the RLS insert check
       will refuse, so the UI must not offer to collect. */
    canCollect:  Boolean(profile.service_id) && !profile.blocked,
  };
}

/* ── Errors ──────────────────────────────────── */

function friendlyAuthError(error) {
  const msg = error?.message || "Something went wrong";
  if (/anonymous.*disabled|signups not allowed for otp/i.test(msg)) {
    return new Error(
      "Anonymous sign-in is turned off for this project. Enable it in " +
      "Supabase → Authentication → Sign In / Providers → Anonymous."
    );
  }
  if (/invalid login credentials/i.test(msg)) return new Error("Wrong email or password.");
  if (/failed to fetch|networkerror/i.test(msg)) return new Error("No connection. Check your network and try again.");
  return new Error(msg);
}

export { isSupabaseConfigured };
