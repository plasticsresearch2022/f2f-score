import { supabase } from "./supabase";

/* ═══════════════════════════════════════════════
   CLOUD DATA LAYER — assessments
   Rows are mapped to/from the same case-object shape
   the UI already uses (studyId, savedAt, answers, …)
   so existing render/CSV code works unchanged.
   RLS enforces per-user isolation server-side.
═══════════════════════════════════════════════ */

// DB row → UI case object
function rowToCase(row) {
  return {
    id:             row.id,
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
    savedAt:        row.created_at,
  };
}

// Save one assessment for the signed-in user. Returns the saved case.
export async function saveAssessment(record, userId) {
  if (!supabase) throw new Error("Supabase not configured");
  const { data, error } = await supabase
    .from("assessments")
    .insert({
      user_id:         userId,
      study_id:        record.studyId,
      hospital:        record.hospital,
      hospital_id:     record.hospitalId,
      enrollment_date: record.enrollmentDate,
      assessment_type: record.assessmentType,
      answers:         record.answers,
      domain_scores:   record.domainScores,
      score:           record.score,
      tier_id:         record.tierId,
      tier_label:      record.tierLabel,
    })
    .select()
    .single();
  if (error) throw error;
  return rowToCase(data);
}

// Fetch all of the signed-in user's assessments (RLS scopes to them).
export async function fetchAssessments() {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from("assessments")
    .select("*")
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data || []).map(rowToCase);
}

// Delete one assessment by id (RLS ensures it's the user's own).
export async function deleteAssessment(id) {
  if (!supabase) throw new Error("Supabase not configured");
  const { error } = await supabase.from("assessments").delete().eq("id", id);
  if (error) throw error;
}
