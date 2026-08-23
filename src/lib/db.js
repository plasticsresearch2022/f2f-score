import { supabase } from "./supabase";

/* ═══════════════════════════════════════════════
   CLOUD DATA LAYER

   Rows are mapped to and from the exact case/outcome shapes
   the UI already uses, so Pedro's render, CSV, and outcome
   code work unchanged.

   Nothing here updates or deletes. Corrections insert a row
   that supersedes its predecessor; voiding goes through an
   admin RPC. RLS enforces the same rules server-side, so a
   bug in this file cannot widen access.
═══════════════════════════════════════════════ */

/* ── Mapping ─────────────────────────────────── */

function rowToCase(row) {
  return {
    id:             row.id,
    remoteId:       row.id,
    studyId:        row.study_id,
    hospital:       row.hospital,
    hospitalId:     row.hospital_id,
    enrollmentDate: row.enrollment_date,
    assessmentType: row.assessment_type,
    answers:        row.answers || {},
    domainScores:   row.domain_scores || {},
    score:          row.score,
    tierId:         row.tier_id,
    tierLabel:      row.tier_label,
    flagged:        row.flagged,
    flagIds:        row.flag_ids || [],
    savedAt:        row.created_at,
    enteredBy:      row.entered_by_name,
    serviceId:      row.service_id,
    supersedesId:   row.supersedes_id,
    source:         row.source,
    engineVersion:  row.engine_version,
    voidedAt:       row.voided_at,
    voidReason:     row.void_reason,
  };
}

function rowToOutcome(row) {
  return {
    id:           row.id,
    remoteId:     row.id,
    studyId:      row.study_id,
    outcomes:     row.outcomes || {},
    clavienDindo: row.clavien_dindo,
    cdOption:     row.cd_option,
    notes:        row.notes,
    anyEvent:     row.any_event,
    recordedAt:   row.recorded_at,
    enteredBy:    row.entered_by_name,
    serviceId:    row.service_id,
    supersedesId: row.supersedes_id,
    source:       row.source,
    secondary:    row.secondary || {},
    voidedAt:     row.voided_at,
    voidReason:   row.void_reason,
  };
}

function caseToRow(record, ctx) {
  return {
    user_id:              ctx.userId,
    service_id:           ctx.serviceId,
    entered_by_member_id: ctx.memberId || null,
    entered_by_name:      ctx.displayName || null,
    study_id:             record.studyId,
    hospital:             record.hospital,
    hospital_id:          record.hospitalId,
    enrollment_date:      record.enrollmentDate,
    assessment_type:      record.assessmentType,
    answers:              record.answers || {},
    domain_scores:        record.domainScores || {},
    score:                record.score,
    tier_id:              record.tierId,
    tier_label:           record.tierLabel,
    flagged:              Boolean(record.flagged),
    flag_ids:             record.flagIds || [],
    supersedes_id:        record.supersedesId || null,
    engine_version:       record.engineVersion || undefined,
  };
}

function outcomeToRow(record, ctx) {
  return {
    user_id:              ctx.userId,
    service_id:           ctx.serviceId,
    entered_by_member_id: ctx.memberId || null,
    entered_by_name:      ctx.displayName || null,
    study_id:             record.studyId,
    outcomes:             record.outcomes || {},
    clavien_dindo:        record.clavienDindo || null,
    cd_option:            record.cdOption || null,
    notes:                record.notes || null,
    any_event:            Boolean(record.anyEvent),
    secondary:            record.secondary || {},
    supersedes_id:        record.supersedesId || null,
  };
}

/* ── Writes (insert-only) ────────────────────── */

export async function insertAssessment(record, ctx) {
  if (!supabase) throw new Error("Supabase is not configured");
  const { data, error } = await supabase
    .from("assessments").insert(caseToRow(record, ctx)).select().single();
  if (error) throw error;
  return rowToCase(data);
}

export async function insertOutcome(record, ctx) {
  if (!supabase) throw new Error("Supabase is not configured");
  const { data, error } = await supabase
    .from("outcomes").insert(outcomeToRow(record, ctx)).select().single();
  if (error) throw error;
  return rowToOutcome(data);
}

/* ── Reads ───────────────────────────────────── */

/** Live rows only: not voided, nothing supersedes them. RLS scopes to service. */
export async function fetchAssessments() {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from("assessments_current").select("*").order("created_at", { ascending: false });
  if (error) throw error;
  return (data || []).map(rowToCase);
}

export async function fetchOutcomes() {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from("outcomes_current").select("*").order("recorded_at", { ascending: false });
  if (error) throw error;
  return (data || []).map(rowToOutcome);
}

/* ── Admin ───────────────────────────────────── */

/** Everything, including voided and superseded rows — the monitoring view. */
export async function fetchAllAssessmentsAdmin() {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from("assessments").select("*").order("created_at", { ascending: false });
  if (error) throw error;
  return (data || []).map(rowToCase);
}

export async function fetchAllOutcomesAdmin() {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from("outcomes").select("*").order("recorded_at", { ascending: false });
  if (error) throw error;
  return (data || []).map(rowToOutcome);
}

export async function fetchServices() {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from("services").select("id, name, slug, hospital_id, hospital_name, active").order("name");
  if (error) throw error;
  return data || [];
}

export async function fetchAuditLog(limit = 200) {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from("audit_log").select("*").order("at", { ascending: false }).limit(limit);
  if (error) throw error;
  return data || [];
}

export async function voidAssessment(id, reason) {
  if (!supabase) throw new Error("Supabase is not configured");
  const { error } = await supabase.rpc("void_assessment", { p_id: id, p_reason: reason });
  if (error) throw error;
}

export async function voidOutcome(id, reason) {
  if (!supabase) throw new Error("Supabase is not configured");
  const { error } = await supabase.rpc("void_outcome", { p_id: id, p_reason: reason });
  if (error) throw error;
}

export async function createService({ name, slug, code, hospitalId, hospitalName }) {
  if (!supabase) throw new Error("Supabase is not configured");
  const { data, error } = await supabase.rpc("create_service", {
    p_name: name, p_slug: slug, p_code: code,
    p_hospital_id: hospitalId || null, p_hospital_name: hospitalName || null,
  });
  if (error) throw error;
  return data;
}
