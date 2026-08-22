import { supabase, isSupabaseConfigured } from "./supabase";

/* ═══════════════════════════════════════════════
   AUTH

   Two very different doors into the same app:

   COLLECTORS (residents, attendings on a rotation)
     Anonymous Supabase session + a service access code.
     No email, no password, no reset flow. One step, once
     per device. Friction here is the whole reason data
     ends up in a spreadsheet instead of a database.

   ADMINS (research oversight)
     Real email + password. Few enough to provision by hand,
     and they need an identity that survives a cleared browser.
═══════════════════════════════════════════════ */

const DEVICE_KEY = "f2f_device_identity";  // remembered roster choice

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
  clearDeviceIdentity();
  if (supabase) await supabase.auth.signOut();
}

/* ── Collector: service access code ──────────── */

/**
 * Redeem a service access code.
 * Signs in anonymously first if there is no session yet, then calls the
 * redeem RPC, which verifies the code server-side and stamps the profile
 * with its service. Returns { service, member, roster }.
 */
export async function redeemServiceCode(code, memberName) {
  if (!supabase) throw new Error("Supabase is not configured");
  const trimmed = (code || "").trim();
  if (!trimmed) throw new Error("Enter your service access code");

  let session = await getSession();
  if (!session) {
    const { data, error } = await supabase.auth.signInAnonymously();
    if (error) throw friendlyAuthError(error);
    session = data.session;
  }

  const { data, error } = await supabase.rpc("redeem_service_code", {
    p_code: trimmed,
    p_member_name: memberName ? String(memberName).trim() : null,
  });

  if (error) throw friendlyAuthError(error);

  /* A wrong code comes back as a normal response with ok:false, not an
     exception — the RPC has to commit its audit row, and raising would roll
     that back. */
  if (!data || data.ok === false) {
    throw new Error("That access code was not recognised. Check with your service lead.");
  }

  if (data?.member?.display_name) setDeviceIdentity(data.member);
  return data;
}

/* ── Admin: email + password ─────────────────── */

export async function signInAdmin(email, password) {
  if (!supabase) throw new Error("Supabase is not configured");
  const { error } = await supabase.auth.signInWithPassword({
    email: (email || "").trim().toLowerCase(),
    password,
  });
  if (error) throw friendlyAuthError(error);
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
    .select("id, role, service_id, member_id, full_name, email")
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

  return {
    userId:      session.user.id,
    isAnonymous: Boolean(session.user.is_anonymous),
    role:        profile.role || "collector",
    isAdmin:     profile.role === "admin",
    serviceId:   profile.service_id,
    memberId:    profile.member_id,
    displayName: profile.full_name || profile.email || deviceIdentity()?.display_name || "",
    email:       profile.email || session.user.email || null,
    service,
    /* An admin without a service, or a collector who has not redeemed a
       code yet, cannot write — the RLS insert check requires a service. */
    canCollect:  Boolean(profile.service_id),
  };
}

export async function fetchRoster(serviceId) {
  if (!supabase || !serviceId) return [];
  const { data, error } = await supabase
    .from("service_members")
    .select("id, display_name, role")
    .eq("service_id", serviceId)
    .eq("active", true)
    .order("display_name");
  if (error) throw error;
  return data || [];
}

/* ── Device identity (roster choice, remembered) ── */

export function deviceIdentity() {
  try { return JSON.parse(localStorage.getItem(DEVICE_KEY) || "null"); }
  catch { return null; }
}

export function setDeviceIdentity(member) {
  try { localStorage.setItem(DEVICE_KEY, JSON.stringify(member)); } catch { /* private mode */ }
}

export function clearDeviceIdentity() {
  try { localStorage.removeItem(DEVICE_KEY); } catch { /* private mode */ }
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
