import { useState, useMemo, useEffect, useCallback } from "react";
import { motion, AnimatePresence, animate, useReducedMotion } from "framer-motion";
import {
  isSupabaseConfigured, redeemServiceCode, signInAdmin, signOut,
  fetchContext, fetchRoster, onAuthChange, deviceIdentity, setDeviceIdentity,
} from "./lib/auth";
import * as sync from "./lib/sync";
import * as adminDb from "./lib/db";

/* ═══════════════════════════════════════════════
   F2F Score — Vercel production build
   Persistent storage via localStorage.
═══════════════════════════════════════════════ */

const HOSPITALS = [
  { id:"LCH", name:"Larkin Community Hospital",             short:"Larkin"   },
  { id:"PGH", name:"Palmetto General Hospital",             short:"Palmetto" },
  { id:"DMC", name:"Delray Medical Center",                 short:"Delray"   },
  { id:"NLN", name:"Nemours Lake Nona Children's Hospital", short:"Nemours"  },
  { id:"OTH", name:"Other",                                 short:"Other"    },
];

/* ═══════════════════════════════════════════════
   LOCALSTORAGE PERSISTENCE
═══════════════════════════════════════════════ */
function lsGet(k){ try{return localStorage.getItem(k);}catch(e){return null;} }
function lsSet(k,v){ try{localStorage.setItem(k,String(v));return true;}catch(e){return false;} }
function lsKeys(p){ try{return Object.keys(localStorage).filter(k=>k.startsWith(p));}catch(e){return [];} }

function persistCase(data){
  const key=`f2f_case_${data.studyId}_${Date.now()}`;
  lsSet(key,JSON.stringify(data));
  sync.enqueue("case", key);   // ← local write is the commit; the cloud catches up
}
function fetchAllCases(){
  return lsKeys("f2f_case_").map(k=>{try{return JSON.parse(lsGet(k));}catch(e){return null;}})
    .filter(Boolean).sort((a,b)=>new Date(b.savedAt)-new Date(a.savedAt));
}
function persistOutcome(studyId, data){
  const key=`f2f_outcome_${studyId}`;
  lsSet(key, JSON.stringify(data));
  sync.enqueue("outcome", key);
}
function fetchOutcome(studyId){
  const r=lsGet(`f2f_outcome_${studyId}`);
  if(!r) return null;
  try{return JSON.parse(r);}catch(e){return null;}
}
function fetchAllOutcomes(){
  return lsKeys("f2f_outcome_").map(k=>{try{return JSON.parse(lsGet(k));}catch(e){return null;}}).filter(Boolean);
}
function knownStudyIds(){
  const ids=new Set();
  fetchAllCases().forEach(c=>ids.add(c.studyId));
  return Array.from(ids).sort();
}

/* ═══════════════════════════════════════════════
   30-DAY OUTCOME FIELDS (blinded entry)
═══════════════════════════════════════════════ */
const OUTCOME_FIELDS = [
  { id:"cfl",  label:"Complete flap failure",                       hint:"Total or near-total (>75%) flap necrosis requiring debridement or reoperation" },
  { id:"pfl",  label:"Partial flap failure",                        hint:"Loss of >25% flap surface area requiring unplanned return to OR" },
  { id:"ssi",  label:"Deep surgical site infection",                hint:"Deep soft tissue/fascia/muscle, culture-confirmed, requiring surgical intervention" },
  { id:"hem",  label:"Hematoma or seroma requiring evacuation",     hint:"Requiring operative evacuation" },
  { id:"deh",  label:"Major wound dehiscence",                      hint:"Full-thickness ≥2cm or fascial-level, requiring operative intervention" },
  { id:"ana",  label:"Free flap anastomotic failure",              hint:"Requiring revision or flap takedown (microsurgical cases only)" },
  { id:"mort", label:"30-day mortality",                            hint:"All-cause mortality within 30 days" },
];

/* ═══════════════════════════════════════════════
   CLAVIEN-DINDO — DERIVED FROM MANAGEMENT LEVEL
   Residents answer what the complication required;
   the grade is computed, not judged by hand.
═══════════════════════════════════════════════ */
const CD_OPTIONS = [
  { id:"none",  label:"No complication occurred",
    detail:"Uncomplicated 30-day course",                                          grade:"None" },
  { id:"g1",    label:"Managed at bedside only — no added medications",
    detail:"Wound care, dressing changes, observation (Grade I)",                  grade:"I" },
  { id:"g2",    label:"Required medication — antibiotics, transfusion, or TPN",
    detail:"Pharmacologic treatment beyond routine (Grade II)",                    grade:"II" },
  { id:"g3a",   label:"Required a procedure WITHOUT general anesthesia",
    detail:"Bedside I&D, aspiration, local intervention (Grade IIIa)",             grade:"IIIa" },
  { id:"g3b",   label:"Required return to OR under general anesthesia",
    detail:"Reoperation, operative debridement, flap revision (Grade IIIb)",       grade:"IIIb" },
  { id:"g4a",   label:"Required ICU management — single organ support",
    detail:"Single-organ dysfunction, ICU-level care (Grade IVa)",                 grade:"IVa" },
  { id:"g4b",   label:"Required ICU management — multi-organ support",
    detail:"Multi-organ dysfunction (Grade IVb)",                                  grade:"IVb" },
  { id:"g5",    label:"Patient died within 30 days",
    detail:"30-day mortality (Grade V)",                                           grade:"V" },
];
function cdGradeFromOption(id){ return CD_OPTIONS.find(o=>o.id===id)?.grade || ""; }

/* ═══════════════════════════════════════════════
   COPY RESULTS UTILITY
═══════════════════════════════════════════════ */
function buildCopyText(studyId, hospital, enrollDate, answers, score, tier, domainScores, assessmentType="New Patient") {
  const a = answers;
  const csvRow = [
    studyId, hospital, enrollDate,
    a.albumin||"", a.prealbumin||"", a.bmi||"", a.pct||"", a.inflammation?"Y":"N",
    a.location||"", a.woundSize||"", a.osteomyelitis||"", a.priorFlap||"",
    a.soiling||"", a.irradiated?"Y":"N",
    a.diabetes||"", a.smoking||"", a.cardio||"", a.steroids?"Y":"N",
    a.selfReposition||"", a.pressureSurface?"Y":"N", a.socialSupport||"",
    domainScores.bio??0, domainScores.wound??0, domainScores.comorbidities??0,
    domainScores.functional??0, score, tier.label, new Date().toISOString()
  ].map(v=>`"${String(v||"").replace(/"/g,'""')}"`).join(",");

  return [
    "=== F2F SCORE RESULT ===",
    `Study ID:        ${studyId}`,
    `Assessment Type: ${assessmentType}`,
    `Hospital:        ${hospital}`,
    `Date:            ${enrollDate}`,
    `Score:           ${score} / 30 pts`,
    `Risk Tier:       ${tier.label}`,
    "",
    "Domain Scores:",
    `  Biomarkers & Nutrition:    ${domainScores.bio??0} / 9`,
    `  Wound Factors:             ${domainScores.wound??0} / 9`,
    `  Comorbidities:             ${domainScores.comorbidities??0} / 6`,
    `  Functional & Social:       ${domainScores.functional??0} / 6`,
    "",
    `Recommendation: ${tier.headline}`,
    tier.timing ? `Optimization window: ${tier.timing}` : "",
    "",
    "--- CSV ROW — PASTE INTO RESEARCH SPREADSHEET ---",
    csvRow,
  ].filter(l=>l!==undefined).join("\n");
}

function buildFullCSV(cases, outcomes) {
  const outMap = {};
  (outcomes||[]).forEach(o=>{ outMap[o.studyId]=o; });
  const typeLabel=(t)=>({new:"New Patient",reassessment:"Re-Assessment",preop:"Pre-Operative"}[t]||"New Patient");
  const H = ["Study ID","Assessment Type","Hospital","Enrollment Date",
    "Albumin","Prealbumin","BMI/Weight Loss","PCT","Inflammatory Markers",
    "PI Location","Wound Size","Osteomyelitis","Prior Flap","Soiling","Irradiated Bed",
    "Diabetes HbA1c","Smoking","Cardiopulmonary/Renal","Chronic Steroids",
    "Self-Repositioning","No Pressure Surface","Social Support",
    "D1 Total","D2 Total","D3 Total","D4 Total","F2F Total Score","Risk Tier","Timestamp",
    // 30-day outcome columns (populated once per Study ID)
    "Complete Flap Failure","Partial Flap Failure","Deep SSI","Hematoma/Seroma","Major Dehiscence",
    "Anastomotic Failure","30d Mortality","PRIMARY ENDPOINT","Clavien-Dindo","Outcome Notes","Outcome Recorded"];
  const rows = cases.map(c=>{
    const a=c.answers||{}; const d=c.domainScores||{}; const o=outMap[c.studyId];
    const oc=o?o.outcomes:{};
    return [c.studyId,typeLabel(c.assessmentType),c.hospital,c.enrollmentDate,
      a.albumin||"",a.prealbumin||"",a.bmi||"",a.pct||"",a.inflammation?"Y":"N",
      a.location||"",a.woundSize||"",a.osteomyelitis||"",a.priorFlap||"",a.soiling||"",a.irradiated?"Y":"N",
      a.diabetes||"",a.smoking||"",a.cardio||"",a.steroids?"Y":"N",
      a.selfReposition||"",a.pressureSurface?"Y":"N",a.socialSupport||"",
      d.bio??0,d.wound??0,d.comorbidities??0,d.functional??0,c.score,c.tierLabel,c.savedAt,
      o?(oc.cfl?"Y":"N"):"",o?(oc.pfl?"Y":"N"):"",o?(oc.ssi?"Y":"N"):"",o?(oc.hem?"Y":"N"):"",o?(oc.deh?"Y":"N"):"",
      o?(oc.ana?"Y":"N"):"",o?(oc.mort?"Y":"N"):"",o?(o.anyEvent?"YES — EVENT":"NO event"):"",
      o?o.clavienDindo:"",o?o.notes:"",o?o.recordedAt:""];
  });
  return [H,...rows].map(r=>r.map(v=>`"${String(v||"").replace(/"/g,'""')}"`).join(",")).join("\n");
}

/* ═══════════════════════════════════════════════
   ADMIN EXPORT

   Wraps Pedro's buildFullCSV rather than reimplementing it, so the
   first 40 columns stay byte-compatible with the sheet the study
   already uses. Provenance columns are appended after them.

   Notes are the one free-text field, so newlines are flattened
   before the wrapped call — a literal newline inside a quoted cell
   would break the line-wise append below (and most spreadsheet
   importers along with it).
═══════════════════════════════════════════════ */
const ADMIN_EXTRA_COLS = ["Service","Hospital ID","Entered By","Record ID","Status","Void Reason"];

export function buildAdminCSV(cases, outcomes, serviceNames={}) {
  const flat = (outcomes||[]).map(o=>({ ...o, notes:String(o.notes||"").replace(/[\r\n]+/g," · ") }));
  const q = v => `"${String(v??"").replace(/"/g,'""')}"`;
  const supersededIds = new Set(cases.map(c=>c.supersedesId).filter(Boolean));

  const lines = buildFullCSV(cases, flat).split("\n");
  return lines.map((line,i)=>{
    if(i===0) return line + "," + ADMIN_EXTRA_COLS.map(q).join(",");
    const c = cases[i-1];
    if(!c) return line;
    const status = c.voidedAt ? "VOIDED"
                 : supersededIds.has(c.remoteId) ? "SUPERSEDED"
                 : c.supersedesId ? "CORRECTION" : "";
    return line + "," + [
      serviceNames[c.serviceId] || "", c.hospitalId || "", c.enteredBy || "",
      c.remoteId || "", status, c.voidReason || "",
    ].map(q).join(",");
  }).join("\n");
}

function downloadCSV(text, name) {
  const a = document.createElement("a");
  a.href = "data:text/csv;charset=utf-8," + encodeURIComponent(text);
  a.download = name;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
}

/* ═══════════════════════════════════════════════
   DATA INTEGRITY

   What an admin actually needs to see is not "all the rows" but
   "the rows something is wrong with". Ordered worst-first.
═══════════════════════════════════════════════ */
const THIRTY_DAYS = 30*24*60*60*1000;

/* Bump whenever upstream changes point values or scoring rules. Stored on
   every assessment, because a score only means something alongside the
   engine that produced it. Between the June build and v1.1, three rules
   changed: the inflammation toggle went 1→2 pts, red-flag options began
   contributing their points instead of only raising a flag, and domains
   became capped at maxPts. */
export const ENGINE_VERSION = "1.1";

export function findIssues(cases, outcomes) {
  const issues = [];
  const live = cases.filter(c=>!c.voidedAt);
  const outByStudy = new Map(outcomes.filter(o=>!o.voidedAt).map(o=>[o.studyId,o]));

  /* Recomputing the score from the stored answers is the real tamper check:
     computeScore is deterministic, so a mismatch means the row did not come
     from this app's scoring path.

     Two exemptions, both because reconciliation would be comparing against
     the wrong thing and would drown the real signal in false alarms:
       - imported rows, where the spreadsheet recorded totals but never the
         per-question answers
       - rows scored by an earlier engine, whose point values differed */
  const staleEngine = new Map();
  for(const c of live){
    if(c.source==="import") continue;
    if(c.engineVersion && c.engineVersion!==ENGINE_VERSION){
      staleEngine.set(c.engineVersion, (staleEngine.get(c.engineVersion)||0)+1);
      continue;
    }
    const { total, domainScores } = computeScore(c.answers||{});
    if(typeof c.score==="number" && total!==c.score){
      issues.push({ sev:"bad", studyId:c.studyId, id:c.remoteId,
        title:`Score does not match the answers — ${c.studyId}`,
        body:`Stored score is ${c.score}, but recomputing from the saved answers gives ${total}. This row did not come from the normal scoring path. Entered by ${c.enteredBy||"unknown"}.` });
      continue;
    }
    for(const d of DOMAINS){
      const stored=(c.domainScores||{})[d.id];
      if(typeof stored==="number" && stored!==domainScores[d.id]){
        issues.push({ sev:"bad", studyId:c.studyId, id:c.remoteId,
          title:`Domain total inconsistent — ${c.studyId}`,
          body:`${d.label}: stored ${stored}, recomputed ${domainScores[d.id]}.` });
        break;
      }
    }
  }

  /* Scores from a superseded engine are not wrong, but they are not
     comparable with current ones — a real problem for a prospective study,
     and one only an admin can decide how to resolve. */
  for(const [ver,n] of staleEngine){
    issues.push({ sev:"warn", studyId:"—", id:null,
      title:`${n} assessment${n===1?"":"s"} scored on engine ${ver}, not ${ENGINE_VERSION}`,
      body:`Point values changed between these versions, so these scores are not directly comparable with ones scored since. Re-score them from their saved answers, or analyse them as a separate cohort — but do not pool them silently.` });
  }

  // Same study scored twice with the same assessment type — likely double entry.
  const byKey = new Map();
  for(const c of live){
    const k = `${c.studyId}::${c.assessmentType||"new"}`;
    byKey.set(k, (byKey.get(k)||[]).concat(c));
  }
  for(const [k,rows] of byKey){
    if(rows.length>1 && !rows.some(r=>r.supersedesId)){
      const [studyId,type]=k.split("::");
      issues.push({ sev:"warn", studyId, id:rows[0].remoteId,
        title:`Duplicate ${type} assessment — ${studyId}`,
        body:`${rows.length} separate ${type} assessments exist for this Study ID, none marked as a correction. Entered by ${[...new Set(rows.map(r=>r.enteredBy||"unknown"))].join(", ")}.` });
    }
  }

  // Enrolled over 30 days ago with no outcome — the primary endpoint is missing.
  const now = Date.now();
  const seen = new Set();
  for(const c of live){
    if(seen.has(c.studyId)) continue;
    seen.add(c.studyId);
    if(outByStudy.has(c.studyId)) continue;
    const when = new Date(c.enrollmentDate||c.savedAt).getTime();
    if(!Number.isNaN(when) && now-when > THIRTY_DAYS){
      const days=Math.floor((now-when)/(24*60*60*1000));
      issues.push({ sev:"warn", studyId:c.studyId, id:c.remoteId,
        title:`No 30-day outcome — ${c.studyId}`,
        body:`Enrolled ${days} days ago with no outcome recorded. The primary endpoint is missing for this patient.` });
    }
  }

  // An outcome with no assessment behind it — orphaned endpoint.
  const studyIds = new Set(live.map(c=>c.studyId));
  for(const o of outByStudy.values()){
    if(!studyIds.has(o.studyId)){
      issues.push({ sev:"warn", studyId:o.studyId, id:o.remoteId,
        title:`Outcome with no assessment — ${o.studyId}`,
        body:`A 30-day outcome exists for this Study ID but no pre-operative assessment does. Recorded by ${o.enteredBy||"unknown"}.` });
    }
  }

  const rank={bad:0,warn:1};
  return issues.sort((a,b)=>rank[a.sev]-rank[b.sev]);
}

/* ═══════════════════════════════════════════════
   SURGICAL RISK RED FLAGS
═══════════════════════════════════════════════ */
const RISK_FLAGS = [
  { id:"asa",        label:"Unstable ASA IV–V patient" },
  { id:"sepsis",     label:"Severe sepsis (PCT > 2 ng/mL + clinical signs) or septic shock" },
  { id:"coag",       label:"Severe coagulopathy — INR > 2, platelets < 20,000, or DIC" },
  { id:"mi",         label:"Recent MI or unstable cardiac event (< 3 months) without cardiac clearance" },
  { id:"metabolic",  label:"Severe metabolic derangement — hyperkalemia, severe acidosis, renal failure without support" },
  { id:"wound_inf",  label:"Active uncontrolled wound infection — purulence, spreading cellulitis, or necrosis" },
  { id:"support",    label:"No realistic 24/7 support or ability to comply with post-operative regimen" },
  { id:"palliative", label:"Very limited life expectancy or palliative goals not aligned with major flap surgery" },
];

/* ═══════════════════════════════════════════════
   DOMAINS
═══════════════════════════════════════════════ */
const DOMAINS = [
  { id:"bio", label:"Biomarkers & Nutrition", maxPts:9, fields:[
    { id:"albumin", type:"radio", label:"Albumin", unit:"g/dL",
      hint:"Chronic nutritional status marker — half-life 18–20 days",
      options:[
        {v:"a",label:"≥ 3.5",pts:0},{v:"b",label:"3.0 – 3.49",pts:1},{v:"c",label:"2.5 – 2.99",pts:3},
        {v:"ci",label:"< 2.5",pts:3,isCI:true,ciLabel:"Red Flag",flagId:"albumin"},
      ]},
    { id:"prealbumin", type:"radio", label:"Prealbumin", unit:"mg/dL",
      hint:"Short-term nutritional response marker — half-life 2–3 days",
      options:[{v:"a",label:"≥ 18",pts:0},{v:"b",label:"12 – 17.9",pts:1},{v:"c",label:"< 12",pts:2}]},
    { id:"bmi", type:"radio", label:"BMI / Recent Weight Loss",
      options:[
        {v:"a",label:"Normal — BMI ≥ 20  or  < 10% UWL in 3 months",pts:0},
        {v:"b",label:"Borderline — BMI 18.5–19.9  or  10–20% UWL in 3 months",pts:1},
        {v:"c",label:"Severe — BMI < 18.5  or  > 20% UWL in 3 months",pts:3},
      ]},
    { id:"pct", type:"radio", label:"Procalcitonin (PCT)", unit:"ng/mL",
      hint:"Select 'Not ordered' for clean wounds without infection concern",
      options:[
        {v:"a",label:"< 0.5",pts:0},{v:"b",label:"0.5 – 2.0",pts:2},
        {v:"ci",label:"> 2.0  or  clinical sepsis",pts:2,isCI:true,ciLabel:"Red Flag",flagId:"pct"},
        {v:"no",label:"Not ordered — clean wound / no infection concern",pts:0},
      ]},
    { id:"inflammation", type:"toggle", pts:2, label:"Elevated inflammatory markers",
      hint:"CRP > 100 mg/L  or  WBC ≥ 12,000/mm³ — without sepsis" },
  ]},
  { id:"wound", label:"Wound Factors", maxPts:9, fields:[
    { id:"location", type:"radio", label:"Pressure Injury Location",
      options:[
        {v:"non_ischial",label:"Any single pressure injury site — non-ischial (sacral, trochanteric, or other)",pts:0},
        {v:"multiple",   label:"Multiple pressure injury sites — ischial not involved",pts:2},
        {v:"ischial",    label:"Ischial — single wound or multiple sites including ischial",pts:3},
      ]},
    { id:"woundSize", type:"radio", label:"Wound Size", unit:"cm²",
      options:[{v:"a",label:"< 50",pts:0},{v:"b",label:"50 – 100",pts:1},{v:"c",label:"> 100",pts:2}]},
    { id:"osteomyelitis", type:"radio", label:"Osteomyelitis",
      options:[
        {v:"a",label:"None",pts:0},
        {v:"b",label:"Chronic (> 4 weeks) — sequestrum or sinus tract",pts:1},
        {v:"c",label:"Acute (≤ 4 weeks) — purulent, no sequestrum",pts:3},
      ]},
    { id:"priorFlap", type:"radio", label:"Prior Flap at This Site",
      options:[{v:"a",label:"None",pts:0},{v:"b",label:"1 prior flap",pts:2},{v:"c",label:"≥ 2 prior flaps",pts:3}]},
    { id:"soiling", type:"radio", label:"Wound Soiling — Fecal / Urinary",
      options:[{v:"a",label:"None",pts:0},{v:"b",label:"Intermittent — not daily",pts:1},{v:"c",label:"Constant — daily soiling",pts:2}]},
    { id:"irradiated", type:"toggle", pts:1, label:"Irradiated Wound Bed",
      hint:"Prior radiation to wound site" },
  ]},
  { id:"comorbidities", label:"Comorbidities", maxPts:6, fields:[
    { id:"diabetes", type:"radio", label:"Diabetes — HbA1c",
      options:[
        {v:"a",label:"No diabetes  or  HbA1c < 7.0%",pts:0},
        {v:"b",label:"HbA1c 7.0 – 7.9%",pts:1},
        {v:"c",label:"HbA1c ≥ 8.0%",pts:2},
      ]},
    { id:"smoking", type:"radio", label:"Smoking Status",
      options:[
        {v:"a",label:"Never smoker or former (> 6 months abstinence)",pts:0},
        {v:"b",label:"Current or quit < 6 months ago",pts:2},
      ]},
    { id:"cardio", type:"radio", label:"Major Cardiopulmonary / Renal Disease",
      options:[
        {v:"a",label:"None",pts:0},{v:"b",label:"One stable condition",pts:1},
        {v:"c",label:"≥ 2 conditions or symptomatic",pts:2},
      ]},
    { id:"steroids", type:"toggle", pts:2, label:"Chronic Steroid Use",
      hint:"≥ 30 days of > 20 mg/day prednisone equivalent" },
  ]},
  { id:"functional", label:"Functional & Social Support", maxPts:6, fields:[
    { id:"selfReposition", type:"radio", label:"Self-Repositioning Capacity",
      hint:"Patient's intrinsic ability to independently relieve pressure — independent of surface quality",
      options:[
        {v:"a",label:"Ambulatory — full independent mobility",pts:0},
        {v:"b",label:"Wheelchair-bound — independently performs weight shifts and pressure relief",pts:1},
        {v:"c",label:"Partially dependent — requires assistance but can communicate discomfort (hemiplegia with functional arm, paraplegia with limited UE)",pts:2},
        {v:"d",label:"Fully dependent — cannot reposition or signal discomfort (quadriplegia, advanced dementia, severe stroke, severe contractures, severe brain injury)",pts:3},
      ]},
    { id:"pressureSurface", type:"toggle", pts:1,
      label:"No appropriate pressure-redistributing surface",
      hint:"Mark Yes if patient lacks a specialty mattress or correct wheelchair cushion — immediately correctable" },
    { id:"socialSupport", type:"radio", label:"Social Support System",
      options:[
        {v:"a", label:"Reliable 24/7 care available",pts:0},
        {v:"b", label:"Some support — inconsistent",pts:2},
        {v:"ci",label:"No support system available",pts:2,isCI:true,ciLabel:"Red Flag",flagId:"support"},
      ]},
  ]},
];

const TIERS = [
  {id:"low",      min:0,  max:5,        label:"LOW RISK",
    verdict:"Strong candidate for reconstruction",
    headline:"Proceed with flap reconstruction.",
    timing:null,
    bg:"#dcfce7", bar:"#16a34a", ink:"#14532d", accent:"#15803d"},
  {id:"moderate", min:6,  max:12,       label:"MODERATE RISK",
    verdict:"Candidate after targeted optimization",
    headline:"Proceed with flap once the items below are addressed.",
    timing:"1–2 weeks",
    bg:"#fef9c3", bar:"#ca8a04", ink:"#713f12", accent:"#a16207"},
  {id:"high",     min:13, max:19,       label:"HIGH RISK",
    verdict:"Not a candidate yet — optimize first",
    headline:"Delay flap. Aggressive multidisciplinary optimization required.",
    timing:"2–4 weeks",
    bg:"#ffedd5", bar:"#ea580c", ink:"#7c2d12", accent:"#c2410c"},
  {id:"not_ideal",min:20, max:Infinity, label:"NOT AN IDEAL CANDIDATE",
    verdict:"Not an ideal candidate for flap reconstruction",
    headline:"Prioritize palliative and advanced wound care rather than major flap reconstruction.",
    timing:null,
    bg:"#fee2e2", bar:"#dc2626", ink:"#7f1d1d", accent:"#b91c1c"},
];

/* ═══════════════════════════════════════════════
   RED FLAG GATE — overrides the numeric tier.
   Any in-domain red flag makes the patient Not an
   Ideal Candidate until corrected, regardless of score.
═══════════════════════════════════════════════ */
const FLAG_TIER = {
  id:"flagged", label:"NOT AN IDEAL CANDIDATE",
  verdict:"Red flag present — reversible. Correct, then re-score.",
  headline:"Do not proceed with flap reconstruction until the flagged condition is addressed. These conditions are reversible — re-score once corrected.",
  timing:null,
  bg:"#fee2e2", bar:"#dc2626", ink:"#7f1d1d", accent:"#b91c1c",
};

const FLAG_ACTIONS = {
  albumin: {
    title:"Albumin < 2.5 g/dL — Severe Hypoalbuminemia",
    kind:"Laboratory value",
    text:"Confirm the laboratory value first — verify it is not a transient or erroneous result. Begin aggressive nutritional optimization (high-protein intake ≥ 1.5 g/kg/day, dietitian involvement, enteral support if needed). Note that albumin has an 18–20 day half-life and will not correct quickly — expect weeks, not days. Track response with prealbumin (2–3 day half-life). Re-score once albumin has meaningfully improved.",
  },
  pct: {
    title:"PCT > 2.0 ng/mL or Clinical Sepsis",
    kind:"Laboratory value / clinical",
    text:"Confirm the result and treat the underlying infection or sepsis before any reconstruction. Obtain cultures and initiate organism-directed antibiotics. Perform serial wound debridements to optimize local infection control and reduce bioburden. NPWT or NPWTi-d may be used as an adjunct between debridements. Re-score once the infection is controlled and markers normalize.",
  },
  support: {
    title:"No Support System Available",
    kind:"Structural / social barrier",
    text:"Reliable post-operative support is essential for flap survival and wound care adherence. Involve case management and social work early to build the full support plan the patient needs — caregiver arrangements, home health, placement, transportation, and follow-up logistics. This is a reversible barrier once a durable 24/7 support structure is secured. Re-score once support is confirmed in place.",
  },
};

function computeScore(answers) {
  let total=0; const ciFlags=[]; const domainScores={};
  for (const domain of DOMAINS) {
    let ds=0;
    for (const f of domain.fields) {
      const val=answers[f.id];
      if(f.type==="toggle"){ ds+=val===true?f.pts:0; }
      else{
        const opt=f.options?.find(o=>o.v===val);
        if(opt){ if(opt.isCI){ ciFlags.push({field:f.label,label:opt.ciLabel,flagId:opt.flagId}); ds+=opt.pts; } else ds+=opt.pts; }
      }
    }
    // Cap each domain at its maximum — raw points above the cap do not carry over
    ds=Math.min(ds, domain.maxPts);
    domainScores[domain.id]=ds; total+=ds;
  }
  return {total,ciFlags,domainScores};
}

function getTier(score){ return TIERS.find(t=>score>=t.min&&score<=t.max)??TIERS[0]; }
const isIschial=(loc)=>loc==="ischial";

function buildRecs(answers,tierId){
  const recs=[]; const mod=tierId==="moderate"; const hi=tierId==="high";
  const ni=tierId==="not_ideal"; const low=tierId==="low";
  const loc=answers.location; const isch=isIschial(loc);
  const add=(r)=>recs.push(r);

  if(low){
    add({p:4,cat:"Perioperative Care",text:"Patient is low risk. Proceed with standard perioperative optimization: DVT prophylaxis, perioperative glucose monitoring, and structured pain management."});
    add({p:4,cat:"Wound Care",text:"Maintain baseline wound care until surgery — appropriate dressings and pressure offloading in place."});
    return recs.sort((a,b)=>a.p-b.p);
  }
  if(ni){
    add({p:1,cat:"Goals of Care — Primary",text:"A formal palliative care consultation is the first priority. A structured goals-of-care discussion should precede any further intervention planning — addressing patient expectations, quality of life, the limits of wound management, and alignment between surgical ambition and realistic outcomes."});
    const hasNut=["b","c"].includes(answers.albumin)||["b","c"].includes(answers.prealbumin)||["b","c"].includes(answers.bmi);
    if(hasNut) add({p:3,cat:"Nutritional Support",text:"Nutritional compromise is present. In the palliative context, the goal shifts from surgical optimization to sustaining meaningful oral intake and patient comfort. PEG or tube feeding is appropriate only if consistent with patient and family goals."});
    if(answers.pressureSurface===true) add({p:2,cat:"Pressure-Redistributing Surface",text:"No appropriate pressure-redistributing surface is in place. Placement of a low-air-loss or alternating-pressure mattress is a low-burden, high-impact comfort measure appropriate regardless of goals of care. Implement immediately."});
    if(answers.selfReposition==="d") add({p:3,cat:"Repositioning & Skin Integrity",text:"Patient is fully dependent for repositioning and cannot signal discomfort. A strict caregiver-driven repositioning schedule (every 2 hours) is essential for wound-related pain control and skin integrity, even in the palliative context."});
    if(answers.soiling==="c") add({p:2,cat:"Wound Contamination Management",text:"Constant fecal soiling is contributing to wound odor, skin breakdown, and patient discomfort. A diverting colostomy or rectal tube may improve quality of life significantly — the primary intent is comfort and dignity."});
    else if(answers.soiling==="b") add({p:3,cat:"Wound Contamination Management",text:"Intermittent soiling is present. Optimize bowel regimen and use barrier creams and high-absorbency protective dressings to minimize skin breakdown and discomfort."});
    if(answers.osteomyelitis!=="a") add({p:3,cat:"Bone Involvement",text:"Osteomyelitis is present. In the palliative context, focus on pain control and odor management. Limited palliative-intent debridement for symptom relief may be appropriate if consistent with goals of care."});
    add({p:4,cat:"Advanced Wound Care",text:"Long-term management with advanced dressings, moisture control, and scheduled limited debridements as tolerated. NPWT may be considered as an adjunct if consistent with patient goals and tolerance — not mandatory."});
    add({p:3,cat:"Social Work & Disposition",text:"Social work and case management focused on safe disposition, caregiver education and support, and quality-of-life optimization."});
    return recs.sort((a,b)=>a.p-b.p);
  }
  if(answers.pressureSurface===true) add({p:1,cat:"Pressure-Redistributing Surface — Immediate Action Required",text:`No appropriate pressure-redistributing surface is in place — immediately correctable and directly affects wound progression. Place a specialty low-air-loss or alternating-pressure mattress without delay. ${hi?"Document surface placement as a formal pre-operative action item. ":""}Confirm in place before scheduling surgery.`});
  if(answers.selfReposition==="d") add({p:hi?1:2,cat:"Fully Dependent Repositioning — High Wound Recurrence Risk",text:`This patient cannot independently reposition or signal discomfort (quadriplegia, advanced dementia, severe stroke, severe contractures, or severe brain injury). ${hi?"A verified, caregiver-executed 2-hour repositioning protocol must be documented before surgery is scheduled — mandatory pre-operative prerequisite.":"Establish a strict 2-hour caregiver-driven repositioning schedule immediately and educate caregivers on post-operative positioning restrictions."}`});
  else if(answers.selfReposition==="c") add({p:3,cat:"Partial Repositioning Dependence",text:`Patient requires assistance for repositioning but can communicate discomfort. ${hi?"Confirm reliable caregiver availability for post-operative repositioning before scheduling.":"Establish assisted repositioning schedule and educate caregivers on post-operative positioning restrictions."}`});
  if(answers.osteomyelitis==="c") add({p:1,cat:"Acute Osteomyelitis",text:"Acute osteomyelitis (≤ 4 weeks, purulent, no sequestrum) is identified. MRI is indicated to define bony extent. Aggressive surgical debridement with intraoperative bone biopsy for culture-directed therapy is required before flap. Plan a 4–6 week course of organism-specific antibiotics. Bone margins must be viable and culture-negative at time of reconstruction."});
  if(answers.soiling==="c") add({p:isch?1:2,cat:`Fecal / Urinary Diversion${isch?" — Critical at Ischial Site":""}`,text:mod?`Constant daily soiling poses a direct threat to flap integrity${isch?", particularly at the ischial site":""}. A temporary rectal tube should be placed immediately. Escalate to diverting sigmoid colostomy if contamination cannot be reliably controlled. Address urinary soiling with Foley catheter or external collection device.`:`Constant daily fecal soiling is a primary modifiable risk factor${isch?" and carries especially high stakes at the ischial location":""}. A temporary diverting sigmoid colostomy is strongly recommended before definitive flap. Foley or suprapubic catheter required to eliminate urinary contamination during healing.`});
  const pctEl=answers.pct==="b"; const inflam=answers.inflammation===true;
  if(pctEl||inflam){ const markers=[pctEl&&"PCT 0.5–2.0 ng/mL",inflam&&"CRP > 100 mg/L or WBC ≥ 12,000/mm³"].filter(Boolean).join(", "); add({p:hi?1:2,cat:"Infection & Inflammation Control",text:mod?`Elevated inflammatory markers: ${markers}. Obtain wound cultures at next debridement. Initiate culture-directed antibiotic therapy. NPWT or NPWTi-d may be considered as an adjunct. Reassess markers at day 7–10 and confirm downtrend before finalizing flap timing.`:`Significant systemic inflammation: ${markers}. Must normalize before surgery proceeds. Formal Infectious Disease consultation required. Serial debridements every 48–72 hours — NPWTi-d may be considered as adjunct. Flap timing guided by marker normalization, not a fixed calendar date.`});}
  const alb=answers.albumin; const preal=answers.prealbumin; const bmi=answers.bmi;
  const nutItems=[alb==="b"&&"albumin 3.0–3.49 g/dL (mild hypoalbuminemia)",alb==="c"&&"albumin 2.5–2.99 g/dL (moderate hypoalbuminemia)",preal==="b"&&"prealbumin 12–17.9 mg/dL (subclinical depletion)",preal==="c"&&"prealbumin < 12 mg/dL (severe depletion)",bmi==="b"&&"borderline BMI or 10–20% weight loss in 3 months",bmi==="c"&&"BMI < 18.5 or > 20% weight loss — severe malnutrition"].filter(Boolean);
  const sevMal=preal==="c"||bmi==="c";
  if(nutItems.length>0){ const albNote="Albumin has an 18–20 day half-life — reflects chronic nutritional status and will not change meaningfully over a 1–2 week window. Do not use as a short-term response marker."; const prealNote=preal!=="a"?" Use prealbumin (half-life 2–3 days) to track response — target ≥ 18 mg/dL before proceeding.":""; add({p:sevMal?(hi?1:2):3,cat:"Nutritional Optimization",text:mod?`Nutritional deficits: ${nutItems.join("; ")}. Initiate high-protein diet (≥ 1.5 g/kg/day) with arginine/glutamine-enriched oral supplementation. ${sevMal?"Given severity, short-term NG tube indicated if oral intake targets not met within 48–72 hours. ":"Monitor and escalate to NG if targets not met. "}${albNote}${prealNote}`:`Malnutrition is a primary driver of high-risk status: ${nutItems.join("; ")}. Formal registered dietitian consultation required. ${sevMal?"PEG tube should be strongly considered — protein rehabilitation requires weeks, not days. ":"Structured nutritional plan with defined re-assessment targets is mandatory. "}${albNote}${prealNote}`});}
  if(answers.diabetes==="c") add({p:hi?1:2,cat:"Glycemic Control — HbA1c ≥ 8.0%",text:mod?"HbA1c ≥ 8.0% substantially increases infection and wound healing failure risk. Optimize insulin or oral agent regimen with primary care or endocrinology. Perioperative glucose target 140–180 mg/dL.":"HbA1c ≥ 8.0% is a primary contributor to high-risk designation — must be formally addressed before scheduling. Endocrinology consultation required. Delay scheduling until glycemic control improves."});
  else if(answers.diabetes==="b") add({p:3,cat:"Glycemic Control — HbA1c 7.0–7.9%",text:"HbA1c 7.0–7.9% represents moderate glycemic control. Tighten regimen in coordination with managing physician. Establish perioperative glucose protocol targeting 140–180 mg/dL."});
  if(answers.smoking==="b") add({p:hi?1:3,cat:`Smoking Cessation${hi?" — Mandatory":""}`,text:mod?"Active or recent smoking significantly increases risk of flap necrosis, dehiscence, and deep infection. Prescribe varenicline or nicotine replacement immediately. Target ≥ 4 weeks confirmed abstinence before scheduling. Confirm with urinary cotinine level.":"Active or recent smoking is a non-negotiable optimization target. Nicotine abstinence ≥ 4 weeks is a mandatory prerequisite before surgery. Prescribe varenicline (preferred). Confirm abstinence with urinary cotinine — document as surgical prerequisite."});
  if(answers.osteomyelitis==="b") add({p:2,cat:"Chronic Osteomyelitis",text:"Chronic osteomyelitis with sequestrum or sinus tract documented. Complete sequestrectomy and aggressive bony debridement required as staged procedure before flap. Plan 6-week culture-directed antibiotics. Confirm clean surgical margins — consider intraoperative bone biopsy."});
  if(answers.priorFlap==="c") add({p:2,cat:"Multiple Prior Flap Failures at Site",text:"Two or more prior flap failures indicate local tissue options are likely exhausted. CT angiography or Doppler perforator mapping essential before further planning. Free flap from distant donor site should be primary strategy. Microsurgical team input required."});
  else if(answers.priorFlap==="b") add({p:3,cat:"Prior Flap at Site",text:"One prior flap failure documented. Preoperative perforator mapping (Doppler ± CTA) recommended. Consider rotating to adjacent or previously unused donor site. Review operative notes from prior attempt to clarify failure mechanism."});
  if(isch) add({p:3,cat:"Ischial Location — Highest Recurrence Site",text:`Ischial location carries the highest complication and recurrence rates among pressure injury sites. ${hi?"Fecal diversion must be secured before reconstruction. ":"Fecal diversion should be strongly considered before or at time of flap. "}Strict no-sitting protocol on operative side for minimum 4–6 weeks post-operatively is mandatory. Pre-operative patient and caregiver education on positioning adherence is critical.`});
  if(loc==="multiple") add({p:3,cat:"Multiple Pressure Injury Sites",text:"Multiple sites present — ischial not involved. Prioritize highest-risk site for reconstruction first. Staged reconstruction generally preferable to simultaneous repair. Each site should be independently assessed for flap candidacy. If any site is ischial, re-score using the Ischial location category."});
  if(answers.woundSize==="c") add({p:3,cat:"Large Wound — > 100 cm²",text:"Wound area exceeds 100 cm². Flap design must ensure adequate volume and reach. CT angiography or Doppler perforator mapping recommended to optimize design. Donor site morbidity planning particularly important at this size."});
  if(answers.irradiated===true) add({p:3,cat:"Irradiated Wound Bed",text:`Prior radiation significantly impairs local tissue healing. ${hi?"Hyperbaric oxygen (HBO) therapy consultation should be obtained as part of the pre-operative plan. ":"Consider hyperbaric oxygen therapy consultation. "}Flap design must include margins extending beyond irradiated tissue boundary. Pedicle-based flaps originating outside radiation field preferred.`});
  if(answers.steroids===true) add({p:3,cat:"Chronic Steroid Use",text:`Chronic steroid use impairs collagen synthesis, immune function, and wound healing. Initiate Vitamin A supplementation (10,000–25,000 IU/day) per institutional protocol. ${hi?"Coordinate with prescribing physician on peri-operative taper. ":"Discuss peri-operative management with managing physician. "}Document Vitamin A start date in optimization plan.`});
  if(answers.cardio==="c") add({p:hi?2:3,cat:"Cardiopulmonary / Renal Optimization",text:mod?"Multiple or symptomatic cardiopulmonary/renal conditions present. Formal specialist consultation required for clearance. Mandatory anesthesia pre-assessment before scheduling.":"Multiple or symptomatic conditions represent major perioperative risk. Cardiology and/or nephrology consultations required before any surgical date. Dedicated multi-specialty optimization plan must be documented."});
  else if(answers.cardio==="b") add({p:4,cat:"Cardiopulmonary Clearance",text:"One stable major cardiopulmonary/renal condition documented. Obtain formal clearance from managing specialist. Communicate anticipated surgical demands to anesthesia team."});
  if(answers.socialSupport==="b") add({p:hi?2:4,cat:"Social Work & Caregiver Planning",text:mod?"Inconsistent social support noted. Social work consultation recommended to strengthen home care plan. Confirm reliable caregiver availability for immediate post-operative period.":"Inconsistent social support is a significant barrier to safe recovery. Social work and case management consultation mandatory before scheduling. Verified 24/7 caregiver plan is a formal pre-operative prerequisite."});
  if(answers.soiling==="b") add({p:mod?4:3,cat:"Bowel Management",text:mod?"Intermittent soiling noted. Implement scheduled bowel management regimen. Escalate to rectal tube and reassess diversion if soiling frequency increases or cannot be reliably controlled.":"Intermittent soiling in high-risk patient warrants strong consideration of diverting ostomy. Foley or suprapubic catheter recommended to eliminate urinary contamination."});
  if(hi) add({p:4,cat:"Re-Assessment Plan",text:"After completing optimization actions above, re-score this patient with the F2F tool. Target: score below 13 before scheduling flap reconstruction. Document optimization start date and set defined re-assessment date."});
  return recs.sort((a,b)=>a.p-b.p);
}

/* ═══════════════════════════════════════════════
   CSS
═══════════════════════════════════════════════ */
const css = `
@import url('https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=DM+Sans:opsz,wght@9..40,300;9..40,400;9..40,500;9..40,600;9..40,700&family=DM+Mono:wght@400;500&display=swap');
:root{color-scheme:light only;--k:#111;--k2:#333;--k3:#666;--k4:#999;--g1:#f0f0f0;--g2:#e4e4e4;--g3:#ccc;--w:#fff;--r:#c8102e;--serif:'Instrument Serif',serif;--sans:'DM Sans',sans-serif;--mono:'DM Mono',monospace}
*{box-sizing:border-box;margin:0;padding:0}
html{background:#fff;color-scheme:light only}
body{font-family:var(--sans);background:#fff;color:#111;-webkit-font-smoothing:antialiased}
/* Force inputs to stay light — some mobile browsers dark-invert form controls */
input,textarea,button,select{color-scheme:light only}
input,textarea{background:#fff !important;color:#111 !important;-webkit-text-fill-color:#111}
input::placeholder,textarea::placeholder{color:#999 !important;-webkit-text-fill-color:#999}
.app{min-height:100vh;max-width:460px;margin:0 auto;display:flex;flex-direction:column;background:#fff}
.hdr{background:var(--k);padding:14px 20px;position:sticky;top:0;z-index:50}
.hdr-row{display:flex;align-items:baseline;justify-content:space-between}
.hdr-brand{font-family:var(--serif);font-size:18px;color:var(--w);font-style:italic}
.hdr-step{font-family:var(--mono);font-size:10px;color:#888;letter-spacing:.05em}
.hdr-sub{font-size:10px;color:#888;letter-spacing:.1em;text-transform:uppercase;margin-top:2px}
.prog-track{height:6px;background:#333;margin-top:2px;border-radius:3px;overflow:hidden}
.prog-fill{height:100%;background:linear-gradient(90deg,#fff,#ddd);transition:width .4s cubic-bezier(.4,0,.2,1);border-radius:3px}
.main{flex:1;padding:24px 20px 48px}
.eyebrow{font-size:10px;font-weight:600;letter-spacing:.15em;text-transform:uppercase;color:var(--k4);margin-bottom:6px}
.display{font-family:var(--serif);font-size:30px;color:var(--k);letter-spacing:-.02em;line-height:1.1;margin-bottom:4px;font-style:italic}
.caption{font-size:12px;color:var(--k4);line-height:1.5}
.rule{height:1px;background:var(--g2);margin:20px 0}
.qblock{margin-bottom:24px}
.qlabel{font-size:13.5px;font-weight:600;color:var(--k);line-height:1.35;margin-bottom:2px}
.qunit{font-weight:400;color:var(--k4);font-size:12px}
.qhint{font-size:11.5px;color:var(--k4);margin-top:3px;margin-bottom:10px;line-height:1.5}
.opts{margin-top:8px}
.opt{display:flex;align-items:center;justify-content:space-between;gap:10px;width:100%;text-align:left;padding:10px 12px;border:1px solid var(--g2);background:var(--w);cursor:pointer;font-family:var(--sans);margin-bottom:5px;transition:border-color .1s}
.opt:hover{border-color:var(--g3)}.opt.sel{border-color:var(--k);background:var(--g1)}.opt.sel-ci{border-color:var(--r);background:#fff8f8}
.opt-lbl{font-size:13px;color:var(--k);flex:1;line-height:1.4}.opt-lbl.sel{font-weight:500}.opt-lbl.sel-ci{color:var(--r);font-weight:500}
.opt-pts{font-family:var(--mono);font-size:10.5px;color:var(--k4);flex-shrink:0;white-space:nowrap}.opt-pts.sel{color:var(--k);font-weight:500}.opt-pts.sel-ci{color:var(--r)}
.tog{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;padding:11px 12px;border:1px solid var(--g2);margin-bottom:6px}
.tog-lbl{font-size:13px;font-weight:600;color:var(--k);margin-bottom:2px}.tog-hint{font-size:11.5px;color:var(--k4);line-height:1.45}.tog-pts{font-size:10.5px;color:var(--g3);margin-top:4px;font-family:var(--mono)}
.tog-btns{display:flex;gap:4px;flex-shrink:0;padding-top:2px}
.tbtn{padding:5px 13px;border:1px solid var(--g2);background:var(--w);font-family:var(--sans);font-size:11.5px;font-weight:500;cursor:pointer;color:var(--k3);transition:all .1s}
.tbtn.on-no{background:var(--k);color:var(--w);border-color:var(--k)}.tbtn.on-yes{background:var(--r);color:var(--w);border-color:var(--r)}
.ci-row{display:flex;align-items:flex-start;gap:10px;width:100%;text-align:left;padding:10px 12px;border:1px solid var(--g2);background:var(--w);cursor:pointer;font-family:var(--sans);margin-bottom:5px;transition:all .1s}
.ci-row.chk{border-color:var(--r);background:#fff8f8}
.ci-box{width:15px;height:15px;border:1.5px solid var(--g3);flex-shrink:0;margin-top:2px;display:flex;align-items:center;justify-content:center;transition:all .1s}.ci-box.chk{background:var(--r);border-color:var(--r)}
.ci-txt{font-size:12.5px;color:var(--k);line-height:1.5}.ci-txt.chk{color:var(--r)}
.btn-p{width:100%;padding:13px 20px;background:var(--k);color:var(--w);border:1px solid var(--k);font-family:var(--sans);font-size:13.5px;font-weight:600;cursor:pointer;letter-spacing:.02em;transition:opacity .12s}
.btn-p:hover:not(:disabled){opacity:.8}.btn-p:disabled{opacity:.25;cursor:not-allowed}
.btn-s{flex:1;padding:12px 20px;background:var(--w);color:var(--k);border:1px solid var(--g2);font-family:var(--sans);font-size:13.5px;font-weight:500;cursor:pointer;transition:background .1s}
.btn-s:hover{background:var(--g1)}.btn-row{display:flex;gap:8px;margin-top:8px}
.alert{padding:12px 14px;margin-bottom:16px;border-left:2px solid}
.al-red{border-color:var(--r);background:#fff8f8}.al-dark{border-color:var(--k);background:var(--g1)}.al-neutral{border-color:var(--g3);background:var(--g1)}.al-amber{border-color:#ca8a04;background:#fefce8}.al-green{border-color:#16a34a;background:#f0fdf4}
.al-title{font-size:10px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;margin-bottom:4px}.al-body{font-size:12.5px;line-height:1.6;color:var(--k2)}
.score-wrap{text-align:center;padding:32px 0 24px;border-bottom:1px solid var(--g2);margin-bottom:24px}
.score-big{font-family:var(--serif);font-size:96px;line-height:1;letter-spacing:-.04em;color:var(--k);font-style:italic}
.score-denom{font-family:var(--mono);font-size:13px;color:var(--k4);margin-top:2px;letter-spacing:.05em}
.tier-lbl{font-size:11px;font-weight:700;letter-spacing:.2em;text-transform:uppercase;color:var(--k);margin-top:18px}
.tier-headline{font-size:13.5px;color:var(--k3);margin-top:6px;line-height:1.55;max-width:300px;margin-left:auto;margin-right:auto}
.timing{font-family:var(--mono);font-size:11px;color:var(--k4);margin-top:8px;letter-spacing:.06em}
.b-row{display:flex;align-items:center;justify-content:space-between;padding:9px 0;border-bottom:1px solid var(--g1)}.b-row:last-of-type{border-bottom:none}
.b-name{font-size:12.5px;color:var(--k2)}.b-right{display:flex;align-items:center;gap:10px}
.b-bar-wrap{width:48px;height:2px;background:var(--g2)}.b-bar-fill{height:100%;background:var(--k)}
.b-pts{font-family:var(--mono);font-size:12px;color:var(--k3);min-width:36px;text-align:right}
.b-total{display:flex;justify-content:space-between;padding-top:10px;border-top:1.5px solid var(--k)}
.b-total-lbl{font-size:13px;font-weight:700;color:var(--k)}.b-total-pts{font-family:var(--mono);font-size:15px;font-weight:500;color:var(--k)}
.rec-item{padding:16px 0;border-bottom:1px solid var(--g1)}.rec-item:last-child{border-bottom:none}
.rec-meta{display:flex;align-items:flex-start;gap:8px;margin-bottom:7px}
.rec-index{font-family:var(--mono);font-size:11px;color:var(--k4);flex-shrink:0;width:20px;padding-top:1px}.rec-index.urg{color:var(--r)}
.rec-dot{width:5px;height:5px;background:var(--r);border-radius:50%;flex-shrink:0;margin-top:5px}
.rec-cat{font-size:12px;font-weight:700;color:var(--k);line-height:1.3;letter-spacing:.02em}.rec-cat.urg{color:var(--r)}
.rec-body{font-size:13px;color:var(--k3);line-height:1.72;padding-left:28px}
.tier-ref-row{display:flex;justify-content:space-between;align-items:center;padding:9px 0;border-bottom:1px solid var(--g1)}.tier-ref-row:last-child{border-bottom:none}
/* Home */
.home-hero{padding:32px 0 28px;text-align:center}
.home-title{font-family:var(--serif);font-size:38px;font-style:italic;letter-spacing:-.025em;color:var(--k);margin-bottom:6px}
.home-sub{font-size:13px;color:var(--k4);line-height:1.6;max-width:280px;margin:0 auto}
.home-btns{display:flex;flex-direction:column;gap:10px;margin-bottom:24px}
.home-btn-new{padding:16px 20px;background:var(--k);color:var(--w);border:none;font-family:var(--sans);font-size:15px;font-weight:700;cursor:pointer;letter-spacing:.02em}
.home-btn-sec{padding:13px 20px;background:var(--w);color:var(--k);border:1px solid var(--g2);font-family:var(--sans);font-size:14px;font-weight:500;cursor:pointer}
.home-btn-sec:hover{background:var(--g1)}.home-links{display:flex;justify-content:center;gap:20px}
.home-link{font-size:12px;color:var(--k4);background:none;border:none;cursor:pointer;font-family:var(--sans);text-decoration:underline;text-underline-offset:3px}
/* Hospital */
.hosp-card{display:flex;align-items:center;gap:12px;width:100%;text-align:left;padding:12px 14px;border:1px solid var(--g2);background:var(--w);cursor:pointer;font-family:var(--sans);margin-bottom:6px;transition:all .1s}
.hosp-card.selected{border-color:var(--k);background:var(--g1)}
.hosp-radio{width:16px;height:16px;border:1.5px solid var(--g3);border-radius:50%;flex-shrink:0;display:flex;align-items:center;justify-content:center;transition:all .1s}.hosp-radio.selected{border-color:var(--k)}
.hosp-dot{width:8px;height:8px;background:var(--k);border-radius:50%}
.hosp-name{font-size:13.5px;font-weight:500;color:var(--k)}.hosp-id{font-family:var(--mono);font-size:10px;color:var(--k4);margin-top:1px}
/* ID confirm */
.id-display{text-align:center;padding:32px 0 24px;border-bottom:1px solid var(--g2);margin-bottom:20px}
.id-label{font-size:10px;font-weight:700;letter-spacing:.2em;text-transform:uppercase;color:var(--k4);margin-bottom:8px}
.id-number{font-family:var(--serif);font-size:64px;font-style:italic;letter-spacing:-.03em;color:var(--k);line-height:1}
.id-hospital{font-size:13px;color:var(--k4);margin-top:6px}.id-date{font-family:var(--mono);font-size:11px;color:var(--k4);margin-top:3px}
.confirm-check-row{display:flex;align-items:flex-start;gap:12px;padding:14px;border:1.5px solid var(--r);background:#fff8f8;cursor:pointer;width:100%;text-align:left;font-family:var(--sans);margin-bottom:16px}
.confirm-check-row.done{border-color:#16a34a;background:#f0fdf4}
.confirm-chkbox{width:18px;height:18px;border:2px solid var(--r);flex-shrink:0;margin-top:1px;display:flex;align-items:center;justify-content:center;transition:all .12s}.confirm-chkbox.done{background:#16a34a;border-color:#16a34a}
.confirm-chk-text{font-size:13px;line-height:1.5;color:var(--r);font-weight:500}.confirm-chk-text.done{color:#15803d}
/* Copy button */
.copy-btn{width:100%;padding:13px 20px;background:var(--w);color:var(--k);border:1.5px solid var(--k);font-family:var(--sans);font-size:13.5px;font-weight:600;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:8px;transition:all .12s;margin-bottom:8px}
.copy-btn:hover{background:var(--g1)}.copy-btn.copied{background:#f0fdf4;border-color:#16a34a;color:#15803d}
.copy-fallback{width:100%;padding:10px;border:1px solid var(--g2);font-family:var(--mono);font-size:10px;color:var(--k3);background:var(--g1);resize:none;margin-bottom:8px}
/* Records */
.records-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:16px}
.records-count{font-family:var(--mono);font-size:11px;color:var(--k4)}
.export-btn{font-size:11px;font-weight:600;color:var(--k);background:var(--g1);border:1px solid var(--g2);padding:5px 12px;cursor:pointer;font-family:var(--sans)}
.record-item{display:flex;align-items:center;justify-content:space-between;padding:12px 0;border-bottom:1px solid var(--g1);cursor:pointer;gap:12px}
.record-left{display:flex;flex-direction:column;gap:3px}.record-id{font-family:var(--mono);font-size:13px;font-weight:500;color:var(--k)}.record-meta{font-size:11.5px;color:var(--k4)}
.record-right{display:flex;align-items:center;gap:8px;flex-shrink:0}.record-score{font-family:var(--mono);font-size:14px;font-weight:500;color:var(--k)}
.tier-chip{font-size:9px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;padding:3px 7px;border-radius:2px}
.tier-chip.low{background:#dcfce7;color:#166534}.tier-chip.moderate{background:#fef9c3;color:#854d0e}.tier-chip.high{background:#ffedd5;color:#7c2d12}.tier-chip.not_ideal{background:#fee2e2;color:#991b1b}
.empty-state{text-align:center;padding:48px 0;color:var(--k4)}.empty-icon{font-size:32px;margin-bottom:12px}.empty-text{font-size:14px;margin-bottom:4px;color:var(--k3)}.empty-sub{font-size:12px}
/* Domain */
.domain-tag{font-size:10px;font-weight:600;letter-spacing:.15em;text-transform:uppercase;color:var(--k4);margin-bottom:5px}
.domain-title{font-family:var(--serif);font-size:28px;letter-spacing:-.01em;color:var(--k);font-style:italic}
.domain-meta{font-size:12px;color:var(--k4);margin-top:3px;margin-bottom:22px}
.domain-preview{padding:10px 12px;background:var(--g1);display:flex;justify-content:space-between;align-items:center;margin-bottom:16px}
.dp-label{font-size:11.5px;color:var(--k4)}.dp-score{font-family:var(--mono);font-size:14px;color:var(--k);font-weight:500}
.study-id-badge{font-family:var(--mono);font-size:11px;color:var(--k4);background:var(--g1);padding:3px 8px;display:inline-block;margin-bottom:16px}
.back-link{background:none;border:none;font-family:var(--sans);font-size:12px;color:var(--k4);cursor:pointer;padding:0;margin-bottom:16px;display:flex;align-items:center;gap:4px}
.footnote{font-size:11px;color:var(--g3);text-align:center;line-height:1.7;padding:16px 0 4px;border-top:1px solid var(--g1);margin-top:4px}
.settings-label{font-size:11px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:var(--k4);margin-bottom:10px}
.settings-input{width:100%;padding:11px 12px;border:1px solid var(--g2);font-family:var(--mono);font-size:12px;color:var(--k);background:var(--w);margin-bottom:8px;outline:none}
.settings-input:focus{border-color:var(--k)}.settings-note{font-size:12px;color:var(--k4);line-height:1.6}

/* On mobile the sheet is a transparent pass-through (padding lives on .main) */
.sheet{width:100%}

/* ═══════════════════════════════════════════════
   RESPONSIVE — Desktop / Tablet web view
   Full-width top bar + a white content card centered
   in the viewport (vertically when short, scrolls when
   tall) on a soft grey backdrop. Single column keeps
   line length readable — correct UX for a clinical form.
═══════════════════════════════════════════════ */
@media (min-width:768px){
  html,body{background:var(--g1)}
  /* full-viewport shell — no floating card on .app */
  .app{max-width:none;width:100%;min-height:100dvh;margin:0;border:none;box-shadow:none;background:var(--g1)}
  /* full-width black top bar; its content capped + centered */
  .hdr{position:sticky;top:0;padding:16px 32px}
  .hdr-row{max-width:1080px;margin:0 auto;width:100%}
  /* grey region that centers the white card */
  .main{flex:1;display:flex;flex-direction:column;align-items:center;padding:32px 24px;background:var(--g1)}
  /* the centered content card — margin:auto centers it vertically when short,
     scrolls without clipping when tall */
  .sheet{max-width:520px;margin:auto;background:var(--w);border:1px solid var(--g2);
         box-shadow:0 1px 3px rgba(0,0,0,.06),0 10px 30px rgba(0,0,0,.05);padding:40px 44px}
  .sheet-wide{max-width:680px}
  /* size bumps */
  .home-hero{padding:36px 0 30px}
  .home-title{font-size:44px}
  .home-sub{max-width:320px}
  .display{font-size:34px}
  .domain-title{font-size:32px}
}
@media (min-width:1024px){
  .main{padding:40px 32px}
  .sheet{max-width:540px;padding:44px 48px}
  .sheet-wide{max-width:700px}
}
@media (min-width:1440px){
  .main{padding:52px 32px}
  .sheet{max-width:560px;padding:48px 52px}
  .sheet-wide{max-width:760px}
  .home-title{font-size:48px}
  .display{font-size:36px}
  .domain-title{font-size:34px}
}

/* ═══════════════════════════════════════════════
   ACCESSIBILITY — focus visibility + reduced motion
═══════════════════════════════════════════════ */
button:focus-visible,input:focus-visible,textarea:focus-visible{outline:2px solid var(--k);outline-offset:2px}
.opt:focus-visible,.ci-row:focus-visible,.hosp-card:focus-visible,.confirm-check-row:focus-visible{outline:2px solid var(--k);outline-offset:1px}
.copy-btn:focus-visible,.btn-p:focus-visible{outline:2px solid var(--w);outline-offset:-4px}
@media (prefers-reduced-motion:reduce){
  *,*::before,*::after{transition-duration:.01ms!important;animation-duration:.01ms!important;scroll-behavior:auto!important}
}

/* ── Tactile press feedback (instant for reduced-motion via rule above) ── */
.btn-p,.btn-s,.home-btn-new,.home-btn-sec,.copy-btn,.opt,.ci-row,.hosp-card,.record-item,.tbtn,.export-btn,.confirm-check-row{transition:transform .1s ease,border-color .12s ease,background .12s ease,opacity .12s ease,box-shadow .12s ease}
.btn-p:active,.home-btn-new:active{transform:scale(.985)}
.btn-s:active,.home-btn-sec:active,.copy-btn:active,.opt:active,.ci-row:active,.hosp-card:active,.record-item:active,.tbtn:active,.export-btn:active,.confirm-check-row:active{transform:scale(.99)}

/* ═══════════════════════════════════════════════
   ACCESS SCREEN — service code + roster
═══════════════════════════════════════════════ */
.gate{min-height:100dvh;display:flex;flex-direction:column;justify-content:center;padding:32px 24px;max-width:460px;margin:0 auto}
.gate-hero{text-align:center;margin-bottom:34px}
.gate-brand{font-family:var(--serif);font-style:italic;font-size:42px;letter-spacing:-.03em;color:var(--k);line-height:1.05}
.gate-tagline{font-size:12.5px;color:var(--k4);margin-top:8px;line-height:1.6}
.gate-label{font-size:10px;font-weight:700;letter-spacing:.15em;text-transform:uppercase;color:var(--k4);margin-bottom:8px}
.gate-input{width:100%;padding:15px 16px;border:1.5px solid var(--g2);font-family:var(--mono);font-size:16px;letter-spacing:.08em;color:var(--k);background:var(--w);outline:none;text-transform:uppercase}
.gate-input:focus{border-color:var(--k)}
.gate-input.plain{font-family:var(--sans);letter-spacing:normal;text-transform:none}
.gate-err{font-size:12.5px;color:var(--r);margin-top:10px;line-height:1.5}
.gate-foot{margin-top:26px;text-align:center}
.gate-link{background:none;border:none;color:var(--k3);font-family:var(--sans);font-size:12.5px;font-weight:600;cursor:pointer;text-decoration:underline;text-underline-offset:4px;padding:8px}
.gate-link:hover{color:var(--k)}
.gate-note{font-size:11px;color:var(--g3);line-height:1.7;margin-top:18px;text-align:center}
.gate-service{font-size:13px;color:var(--k3);text-align:center;margin-bottom:20px}
.gate-service strong{color:var(--k);font-weight:700}
.roster-btn{display:flex;align-items:center;gap:11px;width:100%;text-align:left;padding:13px 14px;border:1px solid var(--g2);background:var(--w);cursor:pointer;font-family:var(--sans);margin-bottom:6px}
.roster-btn.sel{border-color:var(--k);background:var(--g1)}
.roster-radio{width:16px;height:16px;border:1.5px solid var(--g3);border-radius:50%;flex-shrink:0;display:flex;align-items:center;justify-content:center}
.roster-btn.sel .roster-radio{border-color:var(--k)}
.roster-dot{width:8px;height:8px;background:var(--k);border-radius:50%}
.roster-name{font-size:13.5px;font-weight:500;color:var(--k)}
.roster-role{font-family:var(--mono);font-size:10px;color:var(--k4);margin-top:1px;text-transform:uppercase;letter-spacing:.06em}

/* ── Header account + sync chips ── */
.hdr-acct{display:flex;align-items:center;gap:7px;background:none;border:1px solid #333;color:#bbb;font-family:var(--sans);font-size:10.5px;font-weight:600;padding:4px 9px;border-radius:4px;cursor:pointer;max-width:150px}
.hdr-acct:hover{border-color:#666;color:#fff}
.hdr-acct-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sync-dot{width:6px;height:6px;border-radius:50%;flex-shrink:0}
.sync-dot.ok{background:#16a34a}
.sync-dot.pending{background:#ca8a04}
.sync-dot.off{background:#666}
.sync-banner{display:flex;align-items:center;gap:8px;padding:9px 14px;background:#fefce8;border-left:2px solid #ca8a04;font-size:12px;color:#713f12;margin-bottom:16px;line-height:1.5}
.sync-banner.offline{background:var(--g1);border-color:var(--g3);color:var(--k3)}

/* ═══════════════════════════════════════════════
   ADMIN — monitoring across every service
═══════════════════════════════════════════════ */
.adm-tabs{display:flex;gap:4px;border-bottom:1px solid var(--g2);margin-bottom:18px;overflow-x:auto}
.adm-tab{background:none;border:none;border-bottom:2px solid transparent;font-family:var(--sans);font-size:12.5px;font-weight:600;color:var(--k4);padding:9px 12px;cursor:pointer;white-space:nowrap}
.adm-tab.on{color:var(--k);border-bottom-color:var(--k)}
.adm-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(88px,1fr));gap:8px;margin-bottom:20px}
.adm-stat{border:1px solid var(--g2);padding:11px 12px}
.adm-stat-n{font-family:var(--serif);font-style:italic;font-size:26px;line-height:1;color:var(--k)}
.adm-stat-n.warn{color:#b45309}.adm-stat-n.bad{color:var(--r)}
.adm-stat-l{font-size:10px;color:var(--k4);margin-top:5px;line-height:1.35;letter-spacing:.02em}
.adm-filters{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:14px}
.adm-chip{font-size:11.5px;font-family:var(--sans);font-weight:500;padding:5px 11px;border:1px solid var(--g2);background:var(--w);color:var(--k3);cursor:pointer;border-radius:14px}
.adm-chip.on{background:var(--k);border-color:var(--k);color:var(--w)}
.adm-search{width:100%;padding:10px 12px;border:1px solid var(--g2);font-family:var(--mono);font-size:12px;color:var(--k);background:var(--w);outline:none;margin-bottom:12px}
.adm-search:focus{border-color:var(--k)}
.adm-scroll{overflow-x:auto;-webkit-overflow-scrolling:touch;margin:0 -2px}
.adm-table{width:100%;border-collapse:collapse;font-size:12px;min-width:620px}
.adm-table th{text-align:left;font-size:9.5px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--k4);padding:7px 9px;border-bottom:1px solid var(--g2);white-space:nowrap}
.adm-table td{padding:9px;border-bottom:1px solid var(--g1);vertical-align:top}
.adm-table tbody tr:hover{background:var(--g1)}
.adm-table tr.voided td{opacity:.45;text-decoration:line-through}
.adm-mono{font-family:var(--mono);font-size:11.5px}
.adm-flagpill{display:inline-block;font-size:9px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;padding:2px 6px;border-radius:2px;background:#fee2e2;color:#991b1b;margin-left:5px}
.adm-flagpill.warn{background:#fef9c3;color:#854d0e}
.adm-flagpill.info{background:var(--g1);color:var(--k3)}
.adm-void{background:none;border:1px solid var(--g2);color:var(--k4);font-family:var(--sans);font-size:10.5px;font-weight:600;padding:3px 8px;cursor:pointer;white-space:nowrap}
.adm-void:hover{border-color:var(--r);color:var(--r)}
.adm-issue{border-left:2px solid #ca8a04;background:#fefce8;padding:11px 13px;margin-bottom:7px}
.adm-issue.bad{border-color:var(--r);background:#fff8f8}
.adm-issue-t{font-size:12px;font-weight:700;color:var(--k);margin-bottom:3px}
.adm-issue-b{font-size:11.5px;color:var(--k3);line-height:1.55}
.adm-audit{display:flex;gap:10px;padding:9px 0;border-bottom:1px solid var(--g1);font-size:11.5px}
.adm-audit-when{font-family:var(--mono);font-size:10.5px;color:var(--k4);flex-shrink:0;width:96px}
.adm-audit-what{color:var(--k2);line-height:1.5}
.adm-audit-who{color:var(--k4)}

/* ── Boot splash ── */
.boot{min-height:100dvh;display:flex;align-items:center;justify-content:center;background:var(--w)}
.boot-mark{font-family:var(--serif);font-style:italic;font-size:40px;color:var(--g3);animation:bootpulse 1.2s ease-in-out infinite}
@keyframes bootpulse{0%,100%{opacity:.4}50%{opacity:.9}}

/* ── One-question-at-a-time domain progress dots ── */
.field-dots{display:flex;gap:6px;margin:14px 0 22px}
.field-dot{width:6px;height:6px;border-radius:50%;background:var(--g3);transition:background .2s ease,transform .2s ease}
.field-dot.done{background:var(--k3)}
.field-dot.active{background:var(--k);transform:scale(1.35)}
`;

/* ═══════════════════════════════════════════════
   UI COMPONENTS
═══════════════════════════════════════════════ */
function RadioField({field,value,onChange}){
  return(
    <div className="qblock">
      <div className="qlabel">{field.label}{field.unit&&<span className="qunit"> · {field.unit}</span>}</div>
      {field.hint&&<div className="qhint">{field.hint}</div>}
      <div className="opts">
        {field.options.map(opt=>{
          const s=value===opt.v,ci=opt.isCI,cls=s?(ci?"sel-ci":"sel"):"";
          return(<button key={opt.v} className={`opt ${cls}`} onClick={()=>onChange(field.id,opt.v)}>
            <span className={`opt-lbl ${cls}`}>{opt.label}</span>
            <span className={`opt-pts ${cls}`}>{ci?`+${opt.pts} ⚑`:`+${opt.pts}`}</span>
          </button>);
        })}
      </div>
    </div>
  );
}

function ToggleField({field,value,onChange}){
  return(
    <div className="tog">
      <div style={{flex:1}}>
        <div className="tog-lbl">{field.label}</div>
        {field.hint&&<div className="tog-hint">{field.hint}</div>}
        <div className="tog-pts">+{field.pts} pt{field.pts!==1?"s":""} if present</div>
      </div>
      <div className="tog-btns">
        <button className={`tbtn ${value===false?"on-no":""}`} onClick={()=>onChange(field.id,false)}>No</button>
        <button className={`tbtn ${value===true?"on-yes":""}`} onClick={()=>onChange(field.id,true)}>Yes</button>
      </div>
    </div>
  );
}

function RecCard({rec,index,reduce}){
  const urgent=rec.p===1;
  return(
    <motion.div className="rec-item"
      initial={reduce?false:{opacity:0,y:10}}
      animate={{opacity:1,y:0}}
      transition={{duration:0.3,delay:Math.min(index*0.045,0.55),ease:[0.22,0.61,0.36,1]}}>
      <div className="rec-meta">
        <span className={`rec-index ${urgent?"urg":""}`}>{String(index+1).padStart(2,"0")}</span>
        {urgent&&<span className="rec-dot"/>}
        <span className={`rec-cat ${urgent?"urg":""}`}>{rec.cat}</span>
      </div>
      <div className="rec-body">{rec.text}</div>
    </motion.div>
  );
}

/* Animated count-up for the score; respects reduced motion */
function AnimatedNumber({value,reduce,duration=0.85}){
  const [display,setDisplay]=useState(reduce?value:0);
  useEffect(()=>{
    if(reduce){ setDisplay(value); return; }
    const controls=animate(0,value,{duration,ease:[0.16,1,0.3,1],onUpdate:v=>setDisplay(Math.round(v))});
    return()=>controls.stop();
  },[value,reduce,duration]);
  return <>{display}</>;
}

function TierChip({tierId}){
  const labels={low:"Low",moderate:"Moderate",high:"High",not_ideal:"Not Ideal",flagged:"⚑ Red Flag"};
  return <span className={`tier-chip ${tierId==="flagged"?"not_ideal":tierId}`}>{labels[tierId]||tierId}</span>;
}

/* ═══════════════════════════════════════════════
   MAIN APP
═══════════════════════════════════════════════ */
const TOTAL_WIZ=6;

export default function F2FApp(){
  const [screen,        setScreen]        = useState("home");
  const [wizStep,       setWizStep]       = useState(1);
  const [ciChecked,     setCiChecked]     = useState({});
  const [answers,       setAnswers]       = useState({});
  const [hospital,      setHospital]      = useState(null);
  const [studyId,       setStudyId]       = useState(null);
  const [enrollDate,    setEnrollDate]    = useState(null);
  const [deIdDone,      setDeIdDone]      = useState(false);
  const [selectedHosp,  setSelectedHosp]  = useState(null);
  const [assessType,    setAssessType]    = useState(null);
  const [existingId,    setExistingId]    = useState("");
  const [manualId,      setManualId]      = useState("");
  const [cases,         setCases]         = useState([]);
  const [selCase,       setSelCase]       = useState(null);
  const [copied,        setCopied]        = useState(false);
  const [copyFallback,  setCopyFallback]  = useState(false);
  const [copyText,      setCopyText]      = useState("");
  const [fieldStep,     setFieldStep]     = useState(0);
  const [isQuick,       setIsQuick]       = useState(false);   // Quick Score — not saved
  const [outStudyId,    setOutStudyId]    = useState("");      // Outcomes lookup
  const [outFields,     setOutFields]     = useState({});      // Outcome answers
  const [outCD,         setOutCD]         = useState("");      // Clavien-Dindo (derived grade)
  const [outCDOption,   setOutCDOption]   = useState("");      // selected management-level option id
  const [outNotes,      setOutNotes]      = useState("");
  const [outSaved,      setOutSaved]      = useState(false);
  const [openRecs,      setOpenRecs]      = useState({}); // collapsible non-urgent rec categories
  const [fontLevel,     setFontLevel]     = useState(()=>{ try{return parseInt(localStorage.getItem("f2f_fontlevel"))||2;}catch(e){return 2;} });
  const FONT_SCALE = {1:0.9, 2:1.0, 3:1.15, 4:1.35};
  const setFont=(lvl)=>{ setFontLevel(lvl); try{localStorage.setItem("f2f_fontlevel",String(lvl));}catch(e){} };

  // Honour the OS "reduce motion" setting everywhere we animate
  const reduce = useReducedMotion();

  /* ── Access: service code → roster → app ──────────────
     Collectors never see an email field. One code, one name,
     once per device. Admins take the separate door below. */
  const [authReady,  setAuthReady]  = useState(!isSupabaseConfigured);
  const [ctx,        setCtx]        = useState(null);
  const [gateStep,   setGateStep]   = useState("code");   // code | roster | admin
  const [gateCode,   setGateCode]   = useState("");
  const [gateName,   setGateName]   = useState(()=>deviceIdentity()?.display_name || "");
  const [gateEmail,  setGateEmail]  = useState("");
  const [gatePass,   setGatePass]   = useState("");
  const [gateErr,    setGateErr]    = useState("");
  const [gateBusy,   setGateBusy]   = useState(false);
  const [roster,     setRoster]     = useState([]);
  const [pendingSvc, setPendingSvc] = useState(null);
  const [syncState,  setSyncState]  = useState(sync.status());

  const refreshCtx = useCallback(async()=>{
    try{ setCtx(await fetchContext()); }
    catch(e){ console.warn("[F2F] context load failed:",e?.message); setCtx(null); }
  },[]);

  // Resolve the session once on boot, then follow it.
  useEffect(()=>{
    if(!isSupabaseConfigured) return;
    let alive=true;
    const finish=()=>{ if(alive) setAuthReady(true); };
    refreshCtx().finally(finish);
    // Never let a hung network leave the user staring at the splash.
    const bail=setTimeout(finish,2500);
    const unsub=onAuthChange(()=>{ refreshCtx().finally(finish); });
    return()=>{ alive=false; clearTimeout(bail); unsub(); };
  },[refreshCtx]);

  // Point the sync layer at the current identity whenever it changes.
  useEffect(()=>{
    if(!isSupabaseConfigured) return;
    sync.start(ctx).then(()=>setCases(fetchAllCases())).catch(()=>{});
    return()=>sync.stop();
  },[ctx]);

  useEffect(()=>sync.onSyncChange(setSyncState),[]);

  const signedIn  = !isSupabaseConfigured || Boolean(ctx?.canCollect) || Boolean(ctx?.isAdmin);
  const whoAmI    = ctx?.displayName || deviceIdentity()?.display_name || "";
  const serviceNm = ctx?.service?.name || "";

  async function handleRedeem(){
    setGateErr(""); setGateBusy(true);
    try{
      const res=await redeemServiceCode(gateCode, null);
      setPendingSvc(res.service);
      setRoster(res.roster||[]);
      setGateStep("roster");
    }catch(e){ setGateErr(e.message); }
    finally{ setGateBusy(false); }
  }

  async function handleJoin(name){
    const chosen=(name||gateName||"").trim();
    if(chosen.length<2){ setGateErr("Enter your name so entries can be traced back to you."); return; }
    setGateErr(""); setGateBusy(true);
    try{
      await redeemServiceCode(gateCode, chosen);
      setDeviceIdentity({display_name:chosen});
      await refreshCtx();
      setGateCode("");
    }catch(e){ setGateErr(e.message); }
    finally{ setGateBusy(false); }
  }

  async function handleAdminSignIn(){
    setGateErr(""); setGateBusy(true);
    try{ await signInAdmin(gateEmail,gatePass); await refreshCtx(); setGatePass(""); }
    catch(e){ setGateErr(e.message); }
    finally{ setGateBusy(false); }
  }

  /* ── Admin monitoring ─────────────────────────── */
  const [admTab,     setAdmTab]     = useState("entries");   // entries | issues | audit
  const [admCases,   setAdmCases]   = useState([]);
  const [admOut,     setAdmOut]     = useState([]);
  const [admAudit,   setAdmAudit]   = useState([]);
  const [admServices,setAdmServices]= useState([]);
  const [admSvcId,   setAdmSvcId]   = useState("all");
  const [admQuery,   setAdmQuery]   = useState("");
  const [admBusy,    setAdmBusy]    = useState(false);
  const [admErr,     setAdmErr]     = useState("");

  const loadAdmin=useCallback(async()=>{
    if(!ctx?.isAdmin) return;
    setAdmBusy(true); setAdmErr("");
    try{
      const [c,o,s,a]=await Promise.all([
        adminDb.fetchAllAssessmentsAdmin(), adminDb.fetchAllOutcomesAdmin(),
        adminDb.fetchServices(), adminDb.fetchAuditLog(300),
      ]);
      setAdmCases(c); setAdmOut(o); setAdmServices(s); setAdmAudit(a);
    }catch(e){ setAdmErr(e.message||"Could not load monitoring data"); }
    finally{ setAdmBusy(false); }
  },[ctx]);

  useEffect(()=>{ if(screen==="admin") loadAdmin(); },[screen,loadAdmin]);

  async function handleVoid(kind,id,studyId){
    const reason=window.prompt(
      `Void ${kind} for ${studyId}?\n\nThis does not delete anything — the row stays in the record, marked void with your reason and name. Give a reason:`);
    if(reason===null) return;
    if(!reason.trim()){ setAdmErr("A reason is required to void a record."); return; }
    try{
      if(kind==="assessment") await adminDb.voidAssessment(id,reason);
      else                    await adminDb.voidOutcome(id,reason);
      await loadAdmin();
    }catch(e){ setAdmErr(e.message||"Void failed"); }
  }

  async function handleSignOut(){
    await signOut();
    sync.clearLocalCache();   // shared device — leave nothing behind
    setCtx(null); setCases([]); setGateStep("code"); setGateName(""); setScreen("home");
  }

  // Load persisted cases on mount
  useEffect(()=>{
    setCases(fetchAllCases());
  },[]);

  // ── Per-domain page layout: each radio = own page, all toggles grouped at end
  function getDomainPages(d){
    const radios = d.fields.filter(f=>f.type==="radio");
    const toggles = d.fields.filter(f=>f.type==="toggle");
    const pages = radios.map(f=>({type:"single",field:f}));
    if(toggles.length>0) pages.push({type:"toggles",fields:toggles});
    return pages;
  }

  const hasRedFlag = Object.values(ciChecked).some(Boolean);
  const domain     = wizStep>=2&&wizStep<=5 ? DOMAINS[wizStep-2] : null;
  const domainPages= domain ? getDomainPages(domain) : [];
  const currentPage= domainPages[fieldStep]??null;

  const updateAnswer=(id,val)=>setAnswers(p=>({...p,[id]:val}));
  const toggleFlag=(id)=>setCiChecked(p=>({...p,[id]:!p[id]}));

  const isCurrentPageComplete=useMemo(()=>{
    if(!currentPage) return true;
    if(currentPage.type==="single") return answers[currentPage.field.id]!==undefined;
    return true; // toggles always complete (default No)
  },[currentPage,answers]);

  const {total,ciFlags,domainScores}=useMemo(()=>computeScore(answers),[answers]);
  const hasScoreFlags = ciFlags.length>0;
  const tier = hasScoreFlags ? FLAG_TIER : getTier(total);
  const numericTier = getTier(total);
  const recs=useMemo(()=>buildRecs(answers,numericTier.id),[answers,numericTier.id]);

  // Progress: 5% for flags, 90% spread across all domain pages, 5% buffer
  const totalDomainPages = DOMAINS.reduce((sum,d)=>sum+getDomainPages(d).length,0);
  const completedDomainPages = DOMAINS.slice(0,wizStep-2).reduce((sum,d)=>sum+getDomainPages(d).length,0) + (wizStep>=2&&wizStep<=5?fieldStep:0);
  const pct = wizStep===1?5 : wizStep===6?100 : Math.round(5+(completedDomainPages/totalDomainPages)*90);

  /* ── HANDLERS ── */
  function handleConfirmId(){
    if(!selectedHosp||manualId.trim().length<4) return;
    const id=manualId.trim().toUpperCase();
    const now=new Date().toISOString().split("T")[0];
    setStudyId(id); setHospital(selectedHosp); setEnrollDate(now);
    setDeIdDone(false); setScreen("id_confirm");
  }

  function handleBeginAssessment(){
    if(!deIdDone) return;
    setWizStep(1); setFieldStep(0); setCiChecked({}); setAnswers({});
    setCopied(false); setCopyFallback(false); setScreen("wizard");
  }

  function startQuickScore(){
    // Unsaved teaching/demo mode — no Study ID, no record
    setIsQuick(true); setAssessType(null); setStudyId(null); setHospital(null);
    setEnrollDate(null); setWizStep(1); setFieldStep(0); setCiChecked({}); setAnswers({});
    setCopied(false); setCopyFallback(false); setScreen("wizard");
  }

  function goNextWiz(){
    if(wizStep===1&&hasRedFlag) return;
    if(wizStep>=2&&wizStep<=5){
      if(!isCurrentPageComplete) return;
      if(fieldStep<domainPages.length-1){ setFieldStep(f=>f+1); return; }
      if(wizStep===5){
        setWizStep(6); setFieldStep(0);
        if(!isQuick){
          const caseData={
            studyId, hospital:hospital.name, hospitalId:hospital.id, enrollmentDate:enrollDate,
            assessmentType:assessType||"new",
            savedAt:new Date().toISOString(),engineVersion:ENGINE_VERSION, answers:{...answers}, score:total,
            tierId:tier.id, tierLabel:tier.label, domainScores:{...domainScores},
            flagged:hasScoreFlags, flagIds:ciFlags.map(c=>c.flagId),
          };
          persistCase(caseData);
          setCases(fetchAllCases());
        }
      } else {
        setWizStep(s=>s+1); setFieldStep(0);
      }
      return;
    }
    if(wizStep===1){ setWizStep(2); setFieldStep(0); }
  }

  function goPrevWiz(){
    if(wizStep===1){ setScreen("home"); return; }
    if(wizStep>=2&&wizStep<=5){
      if(fieldStep>0){ setFieldStep(f=>f-1); return; }
      if(wizStep===2){ setWizStep(1); setFieldStep(0); }
      else {
        const prevDomain=DOMAINS[wizStep-3];
        const prevPages=getDomainPages(prevDomain);
        setWizStep(s=>s-1); setFieldStep(prevPages.length-1);
      }
      return;
    }
    if(wizStep===6){
      const lastDomain=DOMAINS[3];
      const lastPages=getDomainPages(lastDomain);
      setWizStep(5); setFieldStep(lastPages.length-1);
    }
  }

  function handleCopy(){
    const aLabel={new:"New Patient",reassessment:"Re-Assessment",preop:"Pre-Operative"}[assessType]||"New Patient";
    const text=buildCopyText(studyId||"QUICK-SCORE",hospital?.name||"—",enrollDate||new Date().toISOString().split("T")[0],answers,total,tier,domainScores,isQuick?"Quick Score (not saved)":aLabel);
    setCopyText(text);
    if(navigator.clipboard?.writeText){
      navigator.clipboard.writeText(text)
        .then(()=>{setCopied(true);setTimeout(()=>setCopied(false),3000);})
        .catch(()=>setCopyFallback(true));
    } else {
      setCopyFallback(true);
    }
  }

  function exportAllCSV(){
    const all=fetchAllCases();
    if(all.length===0) return;
    const outcomes=fetchAllOutcomes();
    const csv=buildFullCSV(all,outcomes);
    const a=document.createElement("a");
    a.href="data:text/csv;charset=utf-8,"+encodeURIComponent(csv);
    a.download=`F2F_Data_${new Date().toISOString().split("T")[0]}.csv`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
  }

  function saveOutcome(){
    const sid=outStudyId.trim().toUpperCase();
    if(sid.length<4) return;
    const derivedGrade=cdGradeFromOption(outCDOption);
    const data={
      studyId:sid,
      outcomes:{...outFields},
      clavienDindo:derivedGrade,
      cdOption:outCDOption,
      notes:outNotes,
      anyEvent:OUTCOME_FIELDS.some(f=>outFields[f.id]===true),
      recordedAt:new Date().toISOString(),
    };
    persistOutcome(sid,data);
    setOutCD(derivedGrade);
    setOutSaved(true);
  }

  function resetOutcome(){
    setOutStudyId(""); setOutFields({}); setOutCD(""); setOutCDOption(""); setOutNotes(""); setOutSaved(false);
  }

  function resetAll(){
    setScreen("home"); setWizStep(1); setFieldStep(0); setCiChecked({}); setAnswers({});
    setHospital(null); setStudyId(null); setEnrollDate(null); setDeIdDone(false);
    setSelectedHosp(null); setAssessType(null); setExistingId(""); setManualId("");
    setCopied(false); setCopyFallback(false); setSelCase(null); setIsQuick(false); setOpenRecs({});
    setCases(fetchAllCases());
  }

  /* ══════════════════════════════════════════
     SCREENS
  ══════════════════════════════════════════ */

  const renderHome=()=>(
    <div>
      <div className="home-hero">
        <div className="home-title">Fitness-to-Flap</div>
        <div className="home-sub">Pre-operative risk stratification · Pressure Injury Module v1.1</div>
      </div>
      <div className="home-btns">
        <button className="home-btn-new" onClick={()=>{setIsQuick(false);setScreen("intake");}}>New Patient Assessment</button>
        <button className="home-btn-sec" onClick={()=>{setCases(fetchAllCases());setScreen("records");}}>
          Patient Records {cases.length>0&&`(${cases.length})`}
        </button>
        <button className="home-btn-sec" onClick={()=>{resetOutcome();setScreen("outcomes");}}>
          Enter 30-Day Outcomes
        </button>
        <button className="home-btn-sec" style={{borderStyle:"dashed"}} onClick={startQuickScore}>
          Quick Score — not saved
        </button>
        {ctx?.isAdmin&&(
          <button className="home-btn-sec" style={{borderColor:"var(--k)",fontWeight:700}}
            onClick={()=>setScreen("admin")}>
            Monitoring — all services
          </button>
        )}
      </div>
      <div className="alert al-dark" style={{marginBottom:20}}>
        <div className="al-title" style={{color:"var(--k)"}}>Clinical Disclaimer</div>
        <div className="al-body">For research and educational purposes only. Not a substitute for clinical judgment.</div>
      </div>
      <div className="home-links">
        <button className="home-link" onClick={()=>setScreen("settings")}>⚙ Settings</button>
        <button className="home-link" onClick={()=>setScreen("about")}>About F2F</button>
      </div>
    </div>
  );

  const ASSESS_TYPES = [
    { id:"new",          label:"New Patient",          sub:"First assessment — generates a new Study ID",            icon:"✦" },
    { id:"reassessment", label:"Re-Assessment",         sub:"Patient was previously scored — optimization complete",  icon:"↺" },
    { id:"preop",        label:"Pre-Operative Score",   sub:"Final score before scheduling surgery",                  icon:"✓" },
  ];

  const renderIntake=()=>(
    <div>
      <button className="back-link" onClick={()=>{setScreen("home");setAssessType(null);setSelectedHosp(null);setExistingId("");}}>← Back</button>

      {/* Step 1: Assessment type */}
      {!assessType&&(
        <>
          <div className="eyebrow">New Assessment</div>
          <div className="display" style={{marginBottom:4}}>Assessment Type</div>
          <div className="caption" style={{marginBottom:20}}>Select the type of assessment for this patient.</div>
          {ASSESS_TYPES.map(t=>(
            <button key={t.id} className="hosp-card" style={{marginBottom:8,alignItems:"flex-start"}}
              onClick={()=>setAssessType(t.id)}>
              <div style={{width:28,height:28,border:"1px solid var(--g2)",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,fontFamily:"var(--mono)",fontSize:13,color:"var(--k)"}}>
                {t.icon}
              </div>
              <div>
                <div className="hosp-name">{t.label}</div>
                <div className="hosp-id" style={{fontSize:11}}>{t.sub}</div>
              </div>
            </button>
          ))}
        </>
      )}

      {/* New Patient: hospital select + manual Study ID */}
      {assessType==="new"&&!studyId&&(
        <>
          <div className="eyebrow">New Patient</div>
          <div className="display" style={{marginBottom:4}}>Select Hospital</div>
          <div className="caption" style={{marginBottom:20}}>Select the hospital, then enter the Study ID from your de-identification log.</div>
          {HOSPITALS.map(h=>(
            <button key={h.id} className={`hosp-card ${selectedHosp?.id===h.id?"selected":""}`}
              onClick={()=>{ setSelectedHosp(h); setManualId(`${h.id}-`); }}>
              <div className={`hosp-radio ${selectedHosp?.id===h.id?"selected":""}`}>
                {selectedHosp?.id===h.id&&<div className="hosp-dot"/>}
              </div>
              <div>
                <div className="hosp-name">{h.name}</div>
                <div className="hosp-id">{h.id}</div>
              </div>
            </button>
          ))}
          {selectedHosp&&(
            <div style={{marginTop:16,marginBottom:8}}>
              <div style={{fontSize:11,fontWeight:700,letterSpacing:"0.12em",textTransform:"uppercase",color:"var(--k4)",marginBottom:6}}>Study ID</div>
              <input
                style={{width:"100%",padding:"12px 14px",border:"1.5px solid var(--k)",fontFamily:"var(--mono)",fontSize:22,fontWeight:700,color:"var(--k)",background:"var(--w)",letterSpacing:".08em",textTransform:"uppercase",outline:"none",marginBottom:4}}
                placeholder={`${selectedHosp.id}-001`}
                value={manualId}
                onChange={e=>setManualId(e.target.value.toUpperCase())}
              />
              <div style={{fontSize:11,color:"var(--k4)"}}>Enter the next Study ID from your de-identification log. Format: {selectedHosp.id}-001, {selectedHosp.id}-002, etc.</div>
            </div>
          )}
          <div style={{marginTop:8,display:"flex",gap:8}}>
            <button className="btn-s" onClick={()=>setAssessType(null)}>← Back</button>
            <button className="btn-p" style={{flex:2}}
              disabled={!selectedHosp||manualId.trim().length<4}
              onClick={handleConfirmId}>
              Confirm & Continue →
            </button>
          </div>
        </>
      )}

      {/* Re-assessment / Pre-op: enter existing Study ID */}
      {(assessType==="reassessment"||assessType==="preop")&&(
        <>
          <div className="eyebrow">{assessType==="preop"?"Pre-Operative Score":"Re-Assessment"}</div>
          <div className="display" style={{marginBottom:4}}>Enter Study ID</div>
          <div className="caption" style={{marginBottom:20}}>
            Enter the existing Study ID for this patient from your de-identification log.
          </div>
          <div className="alert al-dark" style={{marginBottom:16}}>
            <div className="al-body">
              {assessType==="reassessment"
                ?"This will be saved as a re-assessment linked to the original Study ID. No new de-identification log entry is needed."
                :"This is the final score before surgical scheduling. It will be saved under the original Study ID as the pre-operative assessment."}
            </div>
          </div>
          <input
            style={{width:"100%",padding:"12px 14px",border:"1.5px solid var(--g2)",fontFamily:"var(--mono)",fontSize:20,fontWeight:600,color:"var(--k)",background:"var(--w)",marginBottom:8,letterSpacing:".05em",textTransform:"uppercase",outline:"none"}}
            placeholder="e.g. LCH-001"
            value={existingId}
            onChange={e=>setExistingId(e.target.value.toUpperCase())}
          />
          <div style={{display:"flex",gap:8,marginTop:4}}>
            <button className="btn-s" onClick={()=>setAssessType(null)}>← Back</button>
            <button className="btn-p" style={{flex:2}}
              disabled={existingId.trim().length<4}
              onClick={()=>{
                const now=new Date().toISOString().split("T")[0];
                // Infer hospital from study ID prefix
                const prefix=existingId.trim().split("-")[0];
                const hosp=HOSPITALS.find(h=>h.id===prefix)||{id:prefix,name:prefix,short:prefix};
                setStudyId(existingId.trim());
                setHospital(hosp);
                setEnrollDate(now);
                setDeIdDone(true); // no de-ID step needed
                setWizStep(1); setCiChecked({}); setAnswers({});
                setCopied(false); setCopyFallback(false);
                setScreen("wizard");
              }}>
              Begin {assessType==="preop"?"Pre-Op":"Re-Assessment"} →
            </button>
          </div>
        </>
      )}
    </div>
  );

  const renderIdConfirm=()=>(
    <div>
      <div className="id-display">
        <div className="id-label">Study ID — {hospital?.name}</div>
        <div className="id-number">{studyId}</div>
        <div className="id-date">{enrollDate}</div>
      </div>

      <div className="alert al-dark" style={{marginBottom:16}}>
        <div className="al-title" style={{color:"var(--k)"}}>De-Identification Log — Required Action</div>
        <div className="al-body">Before proceeding, record <strong>{studyId}</strong> in your de-identification log alongside the patient's MRN. The app does not store any PHI.</div>
      </div>

      <button className={`confirm-check-row ${deIdDone?"done":""}`} onClick={()=>setDeIdDone(d=>!d)}>
        <div className={`confirm-chkbox ${deIdDone?"done":""}`}>
          {deIdDone&&<span style={{color:"var(--w)",fontSize:10,fontWeight:900}}>✓</span>}
        </div>
        <span className={`confirm-chk-text ${deIdDone?"done":""}`}>
          {deIdDone
            ?`Confirmed — ${studyId} has been recorded in the de-identification log`
            :`I have recorded ${studyId} in my de-identification log alongside the patient's MRN`}
        </span>
      </button>

      <button className="btn-p" disabled={!deIdDone} onClick={handleBeginAssessment}>
        Begin F2F Assessment →
      </button>
      <div style={{textAlign:"center",marginTop:10}}>
        <button className="home-link" onClick={()=>setScreen("intake")}>← Change hospital</button>
      </div>
    </div>
  );

  const assessLabel = {new:"New Patient", reassessment:"Re-Assessment", preop:"Pre-Operative"}[assessType]||"";

  const renderWizard=()=>(
    <div>
      <div className="study-id-badge">
        {isQuick
          ? <span style={{color:"var(--r)",fontWeight:700}}>QUICK SCORE · not saved</span>
          : <>{studyId} · {hospital?.short}{assessType&&assessType!=="new"&&<span style={{marginLeft:8,color:"var(--r)",fontWeight:700}}>· {assessLabel}</span>}</>
        }
      </div>

      {wizStep===1&&(
        <div>
          <div className="eyebrow">Pre-Screen</div>
          <div className="display" style={{marginBottom:4}}>Surgical Risk Red Flags</div>
          <div className="caption" style={{marginBottom:20}}>Presence of any red flag warrants addressing the condition before calculating the F2F Score. Some are reversible with targeted medical optimization — re-screen once the condition is addressed.</div>
          {RISK_FLAGS.map(rf=>{
            const chk=ciChecked[rf.id]||false;
            return(
              <button key={rf.id} className={`ci-row ${chk?"chk":""}`} onClick={()=>toggleFlag(rf.id)}>
                <div className={`ci-box ${chk?"chk":""}`}>{chk&&<span style={{color:"var(--w)",fontSize:9,fontWeight:900}}>✓</span>}</div>
                <span className={`ci-txt ${chk?"chk":""}`}>{rf.label}</span>
              </button>
            );
          })}
          <div style={{marginTop:16}}>
            {hasRedFlag?(
              <div className="alert al-red">
                <div className="al-title" style={{color:"var(--r)"}}>Surgical Risk Red Flag(s) Present</div>
                <div className="al-body" style={{color:"var(--r)"}}>Address the flagged condition(s) before calculating the F2F Score. Some conditions are reversible — re-screen once addressed.</div>
              </div>
            ):(
              <div className="alert al-neutral">
                <div className="al-body">No surgical risk red flags identified. Proceed to F2F scoring.</div>
              </div>
            )}
          </div>
          <div className="btn-row">
            <button className="btn-s" onClick={goPrevWiz}>← Back</button>
            {!hasRedFlag&&<button className="btn-p" style={{flex:2}} onClick={goNextWiz}>Continue →</button>}
          </div>
        </div>
      )}

      {wizStep>=2&&wizStep<=5&&domain&&currentPage&&(
        <div>
          <div className="domain-tag">Domain {wizStep-1} of 4 · {domain.label}</div>
          <div style={{fontSize:11,fontFamily:"var(--mono)",color:"var(--k4)",marginBottom:2}}>
            Question {fieldStep+1} of {domainPages.length}
          </div>
          <div className="field-dots">
            {domainPages.map((p,i)=>{
              const done = p.type==="single"
                ? answers[p.field.id]!==undefined
                : p.fields.every(f=>answers[f.id]!==undefined);
              return <span key={i} className={`field-dot ${i===fieldStep?"active":""} ${done?"done":""}`}/>;
            })}
          </div>

          <AnimatePresence mode="wait" initial={false}>
            <motion.div key={`${wizStep}-${fieldStep}`}
              initial={reduce?{opacity:0}:{opacity:0,x:26}}
              animate={{opacity:1,x:0}}
              exit={reduce?{opacity:0}:{opacity:0,x:-26}}
              transition={{duration:reduce?0.12:0.3,ease:[0.22,0.61,0.36,1]}}>
              {currentPage.type==="single"&&(
                <RadioField field={currentPage.field} value={answers[currentPage.field.id]} onChange={updateAnswer}/>
              )}

              {currentPage.type==="toggles"&&(
                <div>
                  <div className="domain-title" style={{marginBottom:16}}>{domain.label}</div>
                  {currentPage.fields.map(f=>(
                    <ToggleField key={f.id} field={f} value={answers[f.id]} onChange={updateAnswer}/>
                  ))}
                  <div style={{marginTop:12,padding:"10px 12px",background:"var(--g1)",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                    <span style={{fontSize:11.5,color:"var(--k4)"}}>Domain score so far</span>
                    <span style={{fontFamily:"var(--mono)",fontSize:14,color:"var(--k)",fontWeight:500}}>{domainScores[domain.id]??0} / {domain.maxPts} pts</span>
                  </div>
                </div>
              )}
            </motion.div>
          </AnimatePresence>

          <div className="btn-row" style={{marginTop:24}}>
            <button className="btn-s" onClick={goPrevWiz}>← Back</button>
            <button className="btn-p" style={{flex:2,background:isCurrentPageComplete?"var(--k)":"#94a3b8"}}
              disabled={!isCurrentPageComplete} onClick={goNextWiz}>
              {wizStep===5&&fieldStep===domainPages.length-1?"Calculate Score →":"Next →"}
            </button>
          </div>
          {!isCurrentPageComplete&&<div style={{textAlign:"center",fontSize:12,color:"#94a3b8",marginTop:8}}>Make a selection to continue</div>}
        </div>
      )}

      {wizStep===6&&(
        <div>
          <div style={{textAlign:"center",marginBottom:6}}>
            <div style={{fontSize:11,fontWeight:700,textTransform:"uppercase",letterSpacing:"0.1em",color:"#94a3b8"}}>F2F Score Result</div>
            {isQuick
              ? <div style={{fontFamily:"var(--mono)",fontSize:11,color:"var(--r)",marginTop:2,fontWeight:700}}>QUICK SCORE — not saved to study</div>
              : <div style={{fontFamily:"var(--mono)",fontSize:11,color:"var(--k4)",marginTop:2}}>{studyId} · {hospital?.short} · {assessLabel||"New Patient"}</div>
            }
          </div>

          {/* ══ VERDICT PANEL — dramatic, colored by tier ══ */}
          <motion.div style={{background:tier.bg,borderRadius:14,padding:"28px 22px 24px",marginBottom:20,textAlign:"center",border:`1px solid ${tier.bar}22`}}
            initial={reduce?false:{opacity:0,scale:0.97}} animate={{opacity:1,scale:1}}
            transition={{duration:0.45,ease:[0.22,0.61,0.36,1]}}>
            {/* Score number + denom */}
            <div style={{display:"flex",alignItems:"baseline",justifyContent:"center",gap:6,marginBottom:4}}>
              <span style={{fontFamily:"var(--serif)",fontSize:72,fontStyle:"italic",lineHeight:1,letterSpacing:"-.04em",color:tier.ink}}><AnimatedNumber value={total} reduce={reduce}/></span>
              <span style={{fontFamily:"var(--mono)",fontSize:15,color:tier.accent}}>/ 30</span>
            </div>

            {/* Tier label — large and bold */}
            <motion.div style={{fontSize:38,fontWeight:800,lineHeight:1.05,letterSpacing:"-.02em",color:tier.ink,marginTop:12,marginBottom:6}}
              initial={reduce?false:{opacity:0,y:6}} animate={{opacity:1,y:0}} transition={{delay:0.55,duration:0.4}}>
              {tier.label}
            </motion.div>

            {/* Plain-language verdict — states good or not */}
            <motion.div style={{fontSize:16,fontWeight:700,color:tier.accent,marginBottom:14,lineHeight:1.3}}
              initial={reduce?false:{opacity:0,y:6}} animate={{opacity:1,y:0}} transition={{delay:0.65,duration:0.4}}>
              {tier.verdict}
            </motion.div>

            {/* Primary recommendation — shown only for numeric tiers, not when flag-gated */}
            {!hasScoreFlags&&(
              <div style={{background:"#fff",borderRadius:10,padding:"14px 16px",marginTop:4}}>
                <div style={{fontSize:9,fontWeight:800,letterSpacing:".14em",textTransform:"uppercase",color:tier.accent,marginBottom:5}}>Recommendation</div>
                <div style={{fontSize:15,fontWeight:600,color:"#111",lineHeight:1.45}}>{tier.headline}</div>
                {tier.timing&&(
                  <div style={{marginTop:10,paddingTop:10,borderTop:"1px solid #eee",fontFamily:"var(--mono)",fontSize:12,color:tier.accent,fontWeight:600,letterSpacing:".04em"}}>
                    ⏱ OPTIMIZATION WINDOW · {tier.timing}
                  </div>
                )}
              </div>
            )}
          </motion.div>

          {!isQuick&&(
            <div className="alert al-green" style={{marginBottom:16}}>
              <div className="al-body" style={{color:"#15803d"}}>✓ Saved to Patient Records as <strong>{studyId}</strong> ({assessLabel}). Persists on this device.</div>
            </div>
          )}

          <div style={{marginBottom:20}}>
            <button className={`copy-btn ${copied?"copied":""}`} onClick={handleCopy}>
              {copied?"✓ Copied":"📋 Save Results to Clipboard"}
            </button>
            {copyFallback&&(
              <div>
                <div style={{fontSize:11,color:"var(--k4)",marginBottom:4}}>Clipboard unavailable — select all and copy manually:</div>
                <textarea className="copy-fallback" rows={6} readOnly value={copyText} onClick={e=>e.target.select()}/>
              </div>
            )}
          </div>

          {ciFlags.length>0&&(
            <div style={{marginBottom:24}}>
              <div style={{border:"1px solid var(--r)",borderRadius:10,overflow:"hidden"}}>
                <div style={{background:"var(--r)",padding:"11px 16px"}}>
                  <div style={{fontSize:11,fontWeight:800,letterSpacing:".08em",textTransform:"uppercase",color:"#fff"}}>⚑ Correct Before Flap Reconstruction</div>
                </div>
                <div style={{padding:"4px 16px 16px"}}>
                  {ciFlags.map((c,i)=>{
                    const act=FLAG_ACTIONS[c.flagId];
                    if(!act) return (
                      <div key={i} style={{paddingTop:14}}>
                        <div style={{fontSize:12.5,fontWeight:700,color:"var(--r)"}}>{c.field} — {c.label}</div>
                      </div>
                    );
                    return(
                      <div key={i} style={{paddingTop:14,borderTop:i>0?"1px solid #f0dede":"none",marginTop:i>0?14:0}}>
                        <div style={{fontSize:13,fontWeight:700,color:"var(--r)",marginBottom:2}}>{act.title}</div>
                        <div style={{fontSize:10,fontWeight:600,letterSpacing:".06em",textTransform:"uppercase",color:"#c88",marginBottom:6}}>{act.kind}</div>
                        <div style={{fontSize:13,color:"var(--k2)",lineHeight:1.7}}>{act.text}</div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          )}

          <div style={{marginBottom:24}}>
            <div style={{fontSize:10,fontWeight:700,letterSpacing:"0.15em",textTransform:"uppercase",color:"var(--k4)",marginBottom:12}}>Score Breakdown</div>
            {DOMAINS.map(d=>{
              const ds=domainScores[d.id]??0;
              return(
                <div className="b-row" key={d.id}>
                  <span className="b-name">{d.label}</span>
                  <div className="b-right">
                    <div className="b-bar-wrap"><motion.div className="b-bar-fill"
                      initial={reduce?false:{width:0}} animate={{width:`${Math.min((ds/d.maxPts)*100,100)}%`}}
                      transition={{duration:0.6,delay:0.2,ease:"easeOut"}}/></div>
                    <span className="b-pts">{ds}<span style={{color:"var(--k4)",fontWeight:400}}>/{d.maxPts}</span></span>
                  </div>
                </div>
              );
            })}
            <div className="b-total" style={{marginTop:12}}>
              <span className="b-total-lbl">Total F2F Score</span>
              <span className="b-total-pts">{total} pts</span>
            </div>
          </div>

          <div style={{marginBottom:24}}>
            <div style={{fontSize:10,fontWeight:700,letterSpacing:"0.15em",textTransform:"uppercase",color:"var(--k4)",marginBottom:4}}>Patient-Specific Action Plan</div>
            <div style={{fontSize:11.5,color:"var(--k4)",marginBottom:16}}>{recs.length} item{recs.length!==1?"s":""} · sorted by priority · <span style={{color:"var(--r)"}}>● urgent</span></div>

            {(()=>{
              const urgent=recs.filter(r=>r.p===1);
              const rest=recs.filter(r=>r.p!==1);
              return(
                <>
                  {/* Urgent — always visible, prominent */}
                  {urgent.length>0&&(
                    <div style={{marginBottom:rest.length>0?20:0}}>
                      <div style={{fontSize:10,fontWeight:800,letterSpacing:".1em",textTransform:"uppercase",color:"var(--r)",marginBottom:10,display:"flex",alignItems:"center",gap:6}}>
                        <span style={{width:6,height:6,background:"var(--r)",borderRadius:"50%",display:"inline-block"}}/>
                        Urgent — Act Immediately
                      </div>
                      {urgent.map((r,i)=>(
                        <motion.div key={i} style={{border:"1px solid var(--r)",borderLeft:"3px solid var(--r)",borderRadius:8,padding:"14px 16px",marginBottom:8,background:"#fff8f8"}}
                          initial={reduce?false:{opacity:0,y:10}} animate={{opacity:1,y:0}}
                          transition={{duration:0.3,delay:Math.min(0.2+i*0.06,0.6),ease:[0.22,0.61,0.36,1]}}>
                          <div style={{fontSize:12.5,fontWeight:700,color:"var(--r)",marginBottom:6,lineHeight:1.3}}>{r.cat}</div>
                          <div style={{fontSize:13,color:"var(--k2)",lineHeight:1.7}}>{r.text}</div>
                        </motion.div>
                      ))}
                    </div>
                  )}

                  {/* Non-urgent — collapsible category rows */}
                  {rest.length>0&&(
                    <div>
                      {urgent.length>0&&(
                        <div style={{fontSize:10,fontWeight:700,letterSpacing:".1em",textTransform:"uppercase",color:"var(--k4)",marginBottom:10}}>
                          Additional Optimization · tap to expand
                        </div>
                      )}
                      {rest.map((r,i)=>{
                        const isOpen=openRecs[`${r.cat}_${i}`]??false;
                        return(
                          <div key={i} style={{border:"1px solid var(--g2)",borderRadius:8,marginBottom:6,overflow:"hidden"}}>
                            <button onClick={()=>setOpenRecs(p=>({...p,[`${r.cat}_${i}`]:!isOpen}))}
                              style={{width:"100%",display:"flex",alignItems:"center",justifyContent:"space-between",gap:10,padding:"12px 14px",background:isOpen?"var(--g1)":"#fff",border:"none",cursor:"pointer",fontFamily:"var(--sans)",textAlign:"left"}}>
                              <span style={{fontSize:12.5,fontWeight:600,color:"var(--k)",lineHeight:1.3}}>{r.cat}</span>
                              <span style={{fontFamily:"var(--mono)",fontSize:16,color:"var(--k4)",flexShrink:0,transform:isOpen?"rotate(45deg)":"none",transition:"transform .15s"}}>+</span>
                            </button>
                            {isOpen&&(
                              <div style={{padding:"0 14px 14px",fontSize:13,color:"var(--k3)",lineHeight:1.7}}>{r.text}</div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </>
              );
            })()}
          </div>

          <div style={{marginBottom:24}}>
            <div style={{fontSize:10,fontWeight:700,letterSpacing:"0.15em",textTransform:"uppercase",color:"var(--k4)",marginBottom:12}}>Risk Tier Reference</div>
            {TIERS.map(t=>{
              const act=t.id===tier.id;
              return(
                <div key={t.id} className="tier-ref-row" style={{opacity:act?1:0.42}}>
                  <span style={{fontSize:12,color:act?"var(--k)":"var(--k3)",fontWeight:act?700:400}}>{t.label}</span>
                  <span style={{fontSize:11.5,fontFamily:"var(--mono)",color:act?"var(--k)":"var(--k4)",fontWeight:act?700:400}}>{t.min}–{t.max===Infinity?"30":t.max} pts</span>
                </div>
              );
            })}
          </div>

          <button className="btn-s" style={{width:"100%",marginBottom:8}} onClick={resetAll}>New Assessment</button>
          <div className="footnote">Research & educational use only · Not a substitute for clinical judgment<br/><strong style={{color:"#b0bec5"}}>Beta v1.1</strong> · Fuenmayor PJ, MD · FSPS 2025</div>
        </div>
      )}
    </div>
  );

  const renderRecords=()=>{
    const outcomes=fetchAllOutcomes();
    const outSet=new Set(outcomes.map(o=>o.studyId));
    // Group by studyId
    const groups={};
    cases.forEach(c=>{ (groups[c.studyId]=groups[c.studyId]||[]).push(c); });
    const groupList=Object.entries(groups).sort((a,b)=>{
      const al=Math.max(...a[1].map(c=>new Date(c.savedAt)));
      const bl=Math.max(...b[1].map(c=>new Date(c.savedAt)));
      return bl-al;
    });
    const TYPE_ICON={new:"✦",reassessment:"↺",preop:"✓"};
    const TYPE_LABEL={new:"New Patient",reassessment:"Re-Assessment",preop:"Pre-Operative"};
    return(
      <div>
        <button className="back-link" onClick={()=>setScreen("home")}>← Home</button>
        <div className="records-header">
          <div>
            <div className="display" style={{fontSize:24,marginBottom:2}}>Patient Records</div>
            <div className="records-count">{cases.length} record{cases.length!==1?"s":""} · persistent · no PHI</div>
          </div>
          {cases.length>0&&<button className="export-btn" onClick={exportAllCSV}>Export CSV</button>}
        </div>
        {cases.length===0&&(
          <div className="empty-state">
            <div className="empty-icon">📋</div>
            <div className="empty-text">No records yet</div>
            <div className="empty-sub">Complete a patient assessment to see it here</div>
          </div>
        )}
        {groupList.map(([sid,sCases])=>{
          const sorted=[...sCases].sort((a,b)=>new Date(a.savedAt)-new Date(b.savedAt));
          const hasOutcome=outSet.has(sid);
          return(
            <div key={sid} style={{marginBottom:20}}>
              <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",paddingBottom:6,borderBottom:"1.5px solid var(--k)",marginBottom:6}}>
                <span style={{fontFamily:"var(--mono)",fontSize:13,fontWeight:700}}>{sid}</span>
                <span style={{fontSize:11,color:hasOutcome?"#15803d":"var(--k4)",fontWeight:hasOutcome?700:400}}>
                  {hasOutcome?"✓ 30-day outcome recorded":sorted[0]?.hospital}
                </span>
              </div>
              {sorted.map((c,i)=>(
                <div key={i} className="record-item" onClick={()=>{setSelCase(c);setScreen("detail");}}>
                  <div style={{display:"flex",alignItems:"center",gap:8,flex:1}}>
                    <span style={{fontFamily:"var(--mono)",fontSize:11,color:"var(--k4)",width:14}}>{TYPE_ICON[c.assessmentType]||"✦"}</span>
                    <div>
                      <div style={{fontSize:12.5,color:"var(--k)",fontWeight:500}}>{TYPE_LABEL[c.assessmentType]||"New Patient"}</div>
                      <div style={{fontSize:11,color:"var(--k4)",marginTop:1}}>{c.enrollmentDate}</div>
                    </div>
                  </div>
                  <div className="record-right">
                    <span className="record-score">{c.score}</span>
                    <TierChip tierId={c.tierId}/>
                  </div>
                </div>
              ))}
            </div>
          );
        })}
      </div>
    );
  };

  const renderDetail=()=>{
    if(!selCase) return null;
    const t=(selCase.tierId==="flagged"?FLAG_TIER:TIERS.find(t=>t.id===selCase.tierId))||TIERS[0];
    const d=selCase.domainScores||{};
    const detailRecs=buildRecs(selCase.answers||{},selCase.tierId);
    return(
      <div>
        <button className="back-link" onClick={()=>setScreen("records")}>← Records</button>
        <div className="eyebrow">{selCase.hospital}</div>
        <div className="display" style={{marginBottom:2}}>{selCase.studyId}</div>
        <div className="caption" style={{marginBottom:20}}>{selCase.enrollmentDate}</div>
        <div style={{background:t.bg,borderRadius:14,padding:"22px 20px",marginBottom:24,textAlign:"center",border:`1px solid ${t.bar}22`}}>
          <div style={{display:"flex",alignItems:"baseline",justifyContent:"center",gap:6}}>
            <span style={{fontFamily:"var(--serif)",fontSize:56,fontStyle:"italic",lineHeight:1,letterSpacing:"-.04em",color:t.ink}}>{selCase.score}</span>
            <span style={{fontFamily:"var(--mono)",fontSize:13,color:t.accent}}>/ 30</span>
          </div>
          <div style={{fontSize:28,fontWeight:800,letterSpacing:"-.02em",color:t.ink,marginTop:8,marginBottom:4}}>{t.label}</div>
          <div style={{fontSize:14,fontWeight:700,color:t.accent,marginBottom:10}}>{t.verdict}</div>
          <div style={{background:"#fff",borderRadius:8,padding:"12px 14px",fontSize:13.5,fontWeight:600,color:"#111",lineHeight:1.45}}>
            {t.headline}
            {t.timing&&<div style={{marginTop:8,paddingTop:8,borderTop:"1px solid #eee",fontFamily:"var(--mono)",fontSize:11,color:t.accent,fontWeight:600}}>⏱ {t.timing}</div>}
          </div>
        </div>
        <div style={{marginBottom:24}}>
          <div style={{fontSize:10,fontWeight:700,letterSpacing:"0.15em",textTransform:"uppercase",color:"var(--k4)",marginBottom:12}}>Score Breakdown</div>
          {DOMAINS.map(dom=>{
            const ds=d[dom.id]??0;
            return(<div className="b-row" key={dom.id}><span className="b-name">{dom.label}</span><div className="b-right"><div className="b-bar-wrap"><motion.div className="b-bar-fill" initial={reduce?false:{width:0}} animate={{width:`${Math.min((ds/dom.maxPts)*100,100)}%`}} transition={{duration:0.6,delay:0.15,ease:"easeOut"}}/></div><span className="b-pts">{ds}<span style={{color:"var(--k4)",fontWeight:400}}>/{dom.maxPts}</span></span></div></div>);
          })}
          <div className="b-total" style={{marginTop:12}}><span className="b-total-lbl">Total F2F Score</span><span className="b-total-pts">{selCase.score} pts</span></div>
        </div>
        <div style={{marginBottom:24}}>
          <div style={{fontSize:10,fontWeight:700,letterSpacing:"0.15em",textTransform:"uppercase",color:"var(--k4)",marginBottom:16}}>Patient-Specific Action Plan</div>
          {detailRecs.map((r,i)=><RecCard key={i} rec={r} index={i} reduce={reduce}/>)}
        </div>
      </div>
    );
  };

  const renderOutcomes=()=>{
    const sid=outStudyId.trim().toUpperCase();
    const known=knownStudyIds();
    const existing=fetchOutcome(sid);
    return(
      <div>
        <button className="back-link" onClick={()=>{setScreen("home");resetOutcome();}}>← Home</button>
        <div className="eyebrow">30-Day Follow-Up</div>
        <div className="display" style={{marginBottom:4}}>Outcome Entry</div>
        <div className="caption" style={{marginBottom:16}}>Blinded outcome adjudication. Enter the Study ID and record 30-day endpoints. The pre-operative F2F Score is intentionally hidden to preserve blinding.</div>

        {outSaved?(
          <div>
            <div className="alert al-green" style={{marginBottom:16}}>
              <div className="al-title" style={{color:"#15803d"}}>Outcome Recorded</div>
              <div className="al-body" style={{color:"#15803d"}}>30-day outcome for <strong>{sid}</strong> saved. Primary endpoint: <strong>{OUTCOME_FIELDS.some(f=>outFields[f.id]===true)?"YES — EVENT":"NO event"}</strong>.{outCD&&outCD!=="None"&&<> Clavien-Dindo grade: <strong>{outCD}</strong>.</>}</div>
            </div>
            <button className="btn-p" onClick={resetOutcome}>Enter Another Outcome</button>
            <button className="btn-s" style={{width:"100%",marginTop:8}} onClick={()=>{setScreen("home");resetOutcome();}}>Done</button>
          </div>
        ):(
          <div>
            <div style={{fontSize:11,fontWeight:700,letterSpacing:"0.12em",textTransform:"uppercase",color:"var(--k4)",marginBottom:6}}>Study ID</div>
            <input
              style={{width:"100%",padding:"12px 14px",border:"1.5px solid var(--k)",fontFamily:"var(--mono)",fontSize:20,fontWeight:700,color:"var(--k)",background:"var(--w)",letterSpacing:".06em",textTransform:"uppercase",outline:"none",marginBottom:4}}
              placeholder="e.g. LCH-001"
              value={outStudyId}
              onChange={e=>{setOutStudyId(e.target.value.toUpperCase());setOutSaved(false);}}
            />
            {sid.length>=4&&!known.includes(sid)&&(
              <div style={{fontSize:11,color:"#b45309",marginBottom:8}}>⚠ No scored assessment found for this ID on this device. You can still record the outcome — verify the ID is correct.</div>
            )}
            {sid.length>=4&&known.includes(sid)&&(
              <div style={{fontSize:11,color:"#15803d",marginBottom:8}}>✓ Study ID found in records</div>
            )}
            {existing&&(
              <div className="alert al-amber" style={{marginTop:8,marginBottom:8}}>
                <div className="al-body" style={{color:"#78350f"}}>An outcome already exists for {sid} (recorded {existing.recordedAt?.split("T")[0]}). Saving will overwrite it.</div>
              </div>
            )}

            {sid.length>=4&&(
              <>
                <div className="rule"/>
                <div style={{fontSize:11,fontWeight:700,letterSpacing:"0.12em",textTransform:"uppercase",color:"var(--k4)",marginBottom:4}}>30-Day Major Complications</div>
                <div style={{fontSize:11.5,color:"var(--k4)",marginBottom:12}}>Mark any that occurred within 30 days of the index procedure.</div>
                {OUTCOME_FIELDS.map(f=>(
                  <div className="tog" key={f.id}>
                    <div style={{flex:1}}>
                      <div className="tog-lbl">{f.label}</div>
                      <div className="tog-hint">{f.hint}</div>
                    </div>
                    <div className="tog-btns">
                      <button className={`tbtn ${outFields[f.id]===false?"on-no":""}`} onClick={()=>setOutFields(p=>({...p,[f.id]:false}))}>No</button>
                      <button className={`tbtn ${outFields[f.id]===true?"on-yes":""}`} onClick={()=>setOutFields(p=>({...p,[f.id]:true}))}>Yes</button>
                    </div>
                  </div>
                ))}

                <div style={{marginTop:24}}>
                  <div className="qlabel" style={{marginBottom:2}}>Severity — Level of Management Required</div>
                  <div className="qhint" style={{marginBottom:10}}>Select the most intensive treatment the complication required. The Clavien-Dindo grade is calculated automatically — you do not need to know the classification.</div>
                  {CD_OPTIONS.map(o=>{
                    const sel=outCDOption===o.id;
                    return(
                      <button key={o.id} className={`opt ${sel?"sel":""}`} style={{alignItems:"flex-start"}}
                        onClick={()=>setOutCDOption(o.id)}>
                        <span style={{flex:1}}>
                          <span className={`opt-lbl ${sel?"sel":""}`} style={{display:"block"}}>{o.label}</span>
                          <span style={{fontSize:11,color:"var(--k4)",marginTop:2,display:"block"}}>{o.detail}</span>
                        </span>
                        {o.grade!=="None"&&<span className={`opt-pts ${sel?"sel":""}`}>{o.grade}</span>}
                      </button>
                    );
                  })}
                  {outCDOption&&cdGradeFromOption(outCDOption)!=="None"&&(
                    <div style={{marginTop:8,padding:"10px 12px",background:"var(--g1)",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                      <span style={{fontSize:11.5,color:"var(--k4)"}}>Calculated Clavien-Dindo grade</span>
                      <span style={{fontFamily:"var(--mono)",fontSize:15,fontWeight:700,color:"var(--k)"}}>{cdGradeFromOption(outCDOption)}</span>
                    </div>
                  )}
                </div>

                <div style={{marginTop:20}}>
                  <div className="qlabel" style={{marginBottom:8}}>Comments (optional)</div>
                  <textarea rows={3} value={outNotes} onChange={e=>setOutNotes(e.target.value)}
                    placeholder="Any additional detail on complications, readmission, reoperation, or context…"
                    style={{width:"100%",padding:"11px 12px",border:"1px solid var(--g2)",fontFamily:"var(--sans)",fontSize:13,color:"#111",background:"#fff",outline:"none",resize:"vertical"}}/>
                </div>

                <div style={{marginTop:16,padding:"12px 14px",background:"var(--g1)"}}>
                  <div style={{fontSize:11,color:"var(--k4)",marginBottom:2}}>Primary endpoint (auto)</div>
                  <div style={{fontSize:15,fontWeight:700,color:OUTCOME_FIELDS.some(f=>outFields[f.id]===true)?"var(--r)":"var(--k)"}}>
                    {OUTCOME_FIELDS.some(f=>outFields[f.id]===true)?"YES — EVENT":"NO event"}
                  </div>
                </div>

                <button className="btn-p" style={{marginTop:16}} onClick={saveOutcome}>Save 30-Day Outcome</button>
              </>
            )}
          </div>
        )}
      </div>
    );
  };

  const renderSettings=()=>(
    <div>
      <button className="back-link" onClick={()=>setScreen("home")}>← Home</button>
      <div className="eyebrow">Configuration</div>
      <div className="display" style={{marginBottom:4,fontSize:24}}>Settings</div>
      <div className="rule"/>
      {isSupabaseConfigured&&ctx&&(
        <>
          <div style={{marginBottom:24}}>
            <div className="settings-label">Signed in</div>
            <div className="settings-note" style={{marginBottom:12}}>
              <strong style={{color:"var(--k)"}}>{whoAmI||"Unnamed"}</strong>
              {serviceNm&&<><br/>{serviceNm}</>}
              {ctx.service?.hospital_name&&<><br/>{ctx.service.hospital_name}</>}
              {ctx.isAdmin&&<><br/><span style={{fontFamily:"var(--mono)",fontSize:11,color:"var(--r)",fontWeight:700}}>ADMINISTRATOR</span></>}
            </div>
            <div style={{fontSize:11,fontFamily:"var(--mono)",color:"var(--k4)",marginBottom:12}}>
              {!syncState.online
                ? "OFFLINE — entries are saved on this device and will upload automatically"
                : syncState.pending>0
                  ? `SYNCING — ${syncState.pending} entr${syncState.pending===1?"y":"ies"} waiting to upload`
                  : syncState.cloud ? "SYNCED — all entries are saved to the research database"
                                    : "LOCAL ONLY — not connected to the research database"}
            </div>
            <button className="btn-s" style={{width:"100%"}} onClick={handleSignOut}>Sign out</button>
          </div>
          <div className="rule"/>
        </>
      )}
      <div style={{marginBottom:24}}>
        <div className="settings-label">Research Data</div>
        <div className="settings-note" style={{marginBottom:12}}>
          Assessments and 30-day outcomes save automatically to the research database.
          Export a CSV here if you need a local copy or a snapshot for analysis.
        </div>
        <button className="btn-p" onClick={exportAllCSV} disabled={cases.length===0}>
          Export All Data (CSV)
        </button>
        <div style={{marginTop:8,fontSize:11,color:"var(--k4)",fontFamily:"var(--mono)"}}>
          {cases.length} record{cases.length!==1?"s":""} stored · no PHI
        </div>
      </div>
      <div className="rule"/>
      <div style={{marginBottom:24}}>
        <div className="settings-label">Text Size</div>
        <div className="settings-note" style={{marginBottom:10}}>Adjust text size for readability. Also available via the A A A A control in the header.</div>
        <div style={{display:"flex",gap:6}}>
          {[[1,"Small"],[2,"Default"],[3,"Large"],[4,"Largest"]].map(([lvl,lbl])=>(
            <button key={lvl} onClick={()=>setFont(lvl)}
              style={{flex:1,padding:"12px 4px",border:`1px solid ${fontLevel===lvl?"var(--k)":"var(--g2)"}`,background:fontLevel===lvl?"var(--k)":"#fff",color:fontLevel===lvl?"#fff":"#111",fontFamily:"var(--serif)",fontStyle:"italic",fontSize:[13,15,18,22][lvl-1],fontWeight:600,cursor:"pointer",display:"flex",flexDirection:"column",alignItems:"center",gap:4}}>
              A
              <span style={{fontFamily:"var(--sans)",fontStyle:"normal",fontSize:10,fontWeight:500}}>{lbl}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="rule"/>
      <div style={{marginBottom:24}}>
        <div className="settings-label">About</div>
        <div className="settings-note">
          F2F Score — Pressure Injury Module v1.1<br/>
          Fuenmayor PJ, MD · Larkin Community Hospital · Miami<br/>
          FSPS Annual Meeting · December 2025<br/><br/>
          IRB approved: Larkin Community Hospital, Palmetto General Hospital, Delray Medical Center<br/><br/>
          Data stored locally on this device via localStorage — no PHI retained. Records persist across sessions.
        </div>
      </div>
    </div>
  );

  const renderAbout=()=>(
    <div>
      <button className="back-link" onClick={()=>setScreen("home")}>← Home</button>
      <div className="eyebrow">About</div>
      <div className="display" style={{marginBottom:4,fontSize:24}}>Fitness-to-Flap Score</div>
      <div className="caption" style={{marginBottom:20}}>Pressure Injury Reconstruction Module v1.1</div>
      <div className="alert al-dark" style={{marginBottom:20}}>
        <div className="al-title" style={{color:"var(--k)"}}>Clinical Disclaimer</div>
        <div className="al-body">For research and educational purposes only. Not a substitute for clinical judgment. All clinical decisions must be made by a qualified healthcare professional.</div>
      </div>
      <div style={{fontSize:13,color:"var(--k3)",lineHeight:1.7}}>
        <p><strong>Author</strong><br/>Pedro Fuenmayor, MD<br/>Integrated Plastic Surgery Program<br/>Larkin Community Hospital · Miami, Florida</p>
        <br/><p><strong>Presented</strong><br/>FSPS Annual Meeting · December 2025 · Palm Beach, Florida</p>
        <br/><p><strong>IRB Status</strong><br/>Prospective validation approved: Larkin Community Hospital, Palmetto General Hospital, Delray Medical Center.</p>
      </div>
    </div>
  );

  const showProg=screen==="wizard"&&wizStep<6;

  /* ═══════════════════════════════════════════════
     ADMIN — cross-service monitoring
  ═══════════════════════════════════════════════ */
  const renderAdmin=()=>{
    const svcName=Object.fromEntries(admServices.map(s=>[s.id,s.name]));
    const inScope=r=>admSvcId==="all"||r.serviceId===admSvcId;
    const q=admQuery.trim().toLowerCase();
    const matches=r=>!q||[r.studyId,r.enteredBy,svcName[r.serviceId],r.hospital]
      .some(v=>String(v||"").toLowerCase().includes(q));

    const scoped     = admCases.filter(inScope);
    const scopedOut  = admOut.filter(inScope);
    const visible    = scoped.filter(matches);
    const live       = scoped.filter(c=>!c.voidedAt);
    const issues     = findIssues(scoped,scopedOut);
    const supersededIds=new Set(scoped.map(c=>c.supersedesId).filter(Boolean));
    const patients   = new Set(live.map(c=>c.studyId));
    const withOutcome= new Set(scopedOut.filter(o=>!o.voidedAt).map(o=>o.studyId));
    const voided     = scoped.filter(c=>c.voidedAt).length;

    return(
      <div>
        <button className="back-link" onClick={()=>setScreen("home")}>← Home</button>
        <div className="eyebrow">Research oversight</div>
        <div className="display" style={{fontSize:24,marginBottom:4}}>Monitoring</div>
        <div className="caption" style={{marginBottom:16}}>
          Every entry across every service. Nothing here can be deleted — only voided, with a reason and your name attached.
        </div>

        {admErr&&<div className="alert al-red" style={{marginBottom:14}}><div className="al-body" style={{color:"var(--r)"}}>{admErr}</div></div>}

        <div className="adm-stats">
          <div className="adm-stat"><div className="adm-stat-n">{patients.size}</div><div className="adm-stat-l">Patients enrolled</div></div>
          <div className="adm-stat"><div className="adm-stat-n">{live.length}</div><div className="adm-stat-l">Assessments</div></div>
          <div className="adm-stat"><div className="adm-stat-n">{withOutcome.size}</div><div className="adm-stat-l">30-day outcomes</div></div>
          <div className="adm-stat"><div className={`adm-stat-n ${issues.some(i=>i.sev==="bad")?"bad":issues.length?"warn":""}`}>{issues.length}</div><div className="adm-stat-l">Issues to review</div></div>
          <div className="adm-stat"><div className="adm-stat-n">{voided}</div><div className="adm-stat-l">Voided</div></div>
        </div>

        <div className="adm-filters">
          <button className={`adm-chip ${admSvcId==="all"?"on":""}`} onClick={()=>setAdmSvcId("all")}>All services</button>
          {admServices.map(s=>(
            <button key={s.id} className={`adm-chip ${admSvcId===s.id?"on":""}`} onClick={()=>setAdmSvcId(s.id)}>{s.name}</button>
          ))}
        </div>

        <div className="adm-tabs">
          {[["entries",`Entries (${visible.length})`],["issues",`Issues (${issues.length})`],["audit","Audit trail"]].map(([id,lbl])=>(
            <button key={id} className={`adm-tab ${admTab===id?"on":""}`} onClick={()=>setAdmTab(id)}>{lbl}</button>
          ))}
        </div>

        {admBusy&&<div className="caption" style={{padding:"20px 0"}}>Loading…</div>}

        {!admBusy&&admTab==="entries"&&(
          <>
            <input className="adm-search" value={admQuery} placeholder="Filter by Study ID, person, or hospital…"
              onChange={e=>setAdmQuery(e.target.value)}/>
            <button className="btn-s" style={{width:"100%",marginBottom:14}}
              disabled={scoped.length===0}
              onClick={()=>downloadCSV(buildAdminCSV(scoped,scopedOut,svcName),
                `F2F_Research_Export_${new Date().toISOString().split("T")[0]}.csv`)}>
              Export {scoped.length} record{scoped.length!==1?"s":""} (CSV)
            </button>
            {visible.length===0
              ? <div className="empty-state"><div className="empty-text">Nothing matches</div></div>
              : (
                <div className="adm-scroll">
                  <table className="adm-table">
                    <thead><tr>
                      <th>Study ID</th><th>Type</th><th>Score</th><th>Service</th>
                      <th>Entered by</th><th>Date</th><th>Outcome</th><th/>
                    </tr></thead>
                    <tbody>
                      {visible.map(c=>{
                        const hasOut=withOutcome.has(c.studyId);
                        const sup=supersededIds.has(c.remoteId);
                        return(
                          <tr key={c.remoteId} className={c.voidedAt?"voided":""}>
                            <td className="adm-mono">{c.studyId}</td>
                            <td>{({new:"New",reassessment:"Re-assess",preop:"Pre-op"})[c.assessmentType]||"New"}
                              {sup&&<span className="adm-flagpill info">superseded</span>}
                              {c.supersedesId&&<span className="adm-flagpill info">correction</span>}
                              {c.voidedAt&&<span className="adm-flagpill">void</span>}
                            </td>
                            <td className="adm-mono">{c.score}{c.flagged&&<span className="adm-flagpill">⚑</span>}</td>
                            <td>{svcName[c.serviceId]||"—"}</td>
                            <td>{c.enteredBy||"—"}</td>
                            <td className="adm-mono">{(c.enrollmentDate||c.savedAt||"").slice(0,10)}</td>
                            <td>{hasOut?<span style={{color:"#15803d",fontWeight:700}}>✓</span>:<span style={{color:"var(--k4)"}}>—</span>}</td>
                            <td>{!c.voidedAt&&<button className="adm-void" onClick={()=>handleVoid("assessment",c.remoteId,c.studyId)}>Void</button>}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
          </>
        )}

        {!admBusy&&admTab==="issues"&&(
          issues.length===0
            ? <div className="empty-state"><div className="empty-icon">✓</div><div className="empty-text">No issues found</div>
                <div className="empty-sub">Scores reconcile, no duplicates, no missing endpoints.</div></div>
            : issues.map((it,i)=>(
                <div key={i} className={`adm-issue ${it.sev==="bad"?"bad":""}`}>
                  <div className="adm-issue-t">{it.title}</div>
                  <div className="adm-issue-b">{it.body}</div>
                </div>
              ))
        )}

        {!admBusy&&admTab==="audit"&&(
          admAudit.length===0
            ? <div className="empty-state"><div className="empty-text">No activity yet</div></div>
            : admAudit.filter(a=>admSvcId==="all"||a.service_id===admSvcId).map(a=>(
                <div key={a.id} className="adm-audit">
                  <div className="adm-audit-when">{new Date(a.at).toLocaleString(undefined,{month:"short",day:"numeric",hour:"2-digit",minute:"2-digit"})}</div>
                  <div className="adm-audit-what">
                    <strong>{a.action.replace(/_/g," ")}</strong>
                    {a.study_id&&<> · <span className="adm-mono">{a.study_id}</span></>}
                    <div className="adm-audit-who">
                      {a.actor_name||"unknown"}
                      {a.action==="redeem_failed"&&<span className="adm-flagpill warn">bad code</span>}
                      {a.detail?.reason&&<> — “{a.detail.reason}”</>}
                    </div>
                  </div>
                </div>
              ))
        )}
      </div>
    );
  };

  /* ═══════════════════════════════════════════════
     ACCESS GATE
     One code, then one name. No email, no password, no reset
     loop — those are what keep residents out of the database
     and in a spreadsheet.
  ═══════════════════════════════════════════════ */
  const fade=(d=0)=>({
    initial:reduce?false:{opacity:0,y:10}, animate:{opacity:1,y:0},
    transition:{duration:0.4,delay:d,ease:[0.22,0.61,0.36,1]},
  });

  const renderGate=()=>(
    <div className="gate">
      <motion.div className="gate-hero" {...fade(0)}>
        <div className="gate-brand">Fitness-to-Flap</div>
        <div className="gate-tagline">
          Pre-operative risk stratification<br/>Pressure Injury Module · v1.1
        </div>
      </motion.div>

      <AnimatePresence mode="wait" initial={false}>
        <motion.div key={gateStep}
          initial={reduce?{opacity:0}:{opacity:0,x:20}}
          animate={{opacity:1,x:0}}
          exit={reduce?{opacity:0}:{opacity:0,x:-20}}
          transition={{duration:reduce?0.12:0.28,ease:[0.22,0.61,0.36,1]}}>

          {gateStep==="code"&&(
            <div>
              <div className="gate-label">Service access code</div>
              <input className="gate-input" value={gateCode} autoFocus
                autoCapitalize="characters" autoCorrect="off" spellCheck={false}
                placeholder="CASTRELLON-26"
                onChange={e=>{setGateCode(e.target.value);setGateErr("");}}
                onKeyDown={e=>{if(e.key==="Enter"&&gateCode.trim())handleRedeem();}}/>
              {gateErr&&<div className="gate-err">{gateErr}</div>}
              <button className="btn-p" style={{marginTop:14}}
                disabled={gateBusy||!gateCode.trim()} onClick={handleRedeem}>
                {gateBusy?"Checking…":"Continue →"}
              </button>
              <div className="gate-foot">
                <button className="gate-link" onClick={()=>{setGateStep("admin");setGateErr("");}}>
                  Attending / admin login →
                </button>
              </div>
              <div className="gate-note">
                Your service lead has the code for this rotation.<br/>
                You only need to do this once on this device.
              </div>
            </div>
          )}

          {gateStep==="roster"&&(
            <div>
              <div className="gate-service">
                <strong>{pendingSvc?.name}</strong>
                {pendingSvc?.hospital_name&&<><br/>{pendingSvc.hospital_name}</>}
              </div>
              <div className="gate-label">Who are you?</div>
              {roster.map(m=>(
                <button key={m.id} className="roster-btn" disabled={gateBusy}
                  onClick={()=>{setGateName(m.display_name);handleJoin(m.display_name);}}>
                  <span className="roster-radio"/>
                  <span>
                    <span className="roster-name">{m.display_name}</span>
                    <span className="roster-role">{m.role}</span>
                  </span>
                </button>
              ))}
              <div className="gate-label" style={{marginTop:18}}>
                {roster.length>0?"Not listed? Add yourself":"Enter your name"}
              </div>
              <input className="gate-input plain" value={gateName}
                placeholder="Dr. Castrellon  ·  R. Patel"
                onChange={e=>{setGateName(e.target.value);setGateErr("");}}
                onKeyDown={e=>{if(e.key==="Enter")handleJoin();}}/>
              {gateErr&&<div className="gate-err">{gateErr}</div>}
              <button className="btn-p" style={{marginTop:14}}
                disabled={gateBusy||gateName.trim().length<2} onClick={()=>handleJoin()}>
                {gateBusy?"Joining…":"Start →"}
              </button>
              <div className="gate-foot">
                <button className="gate-link" onClick={()=>{setGateStep("code");setGateErr("");}}>
                  ← Different service
                </button>
              </div>
              <div className="gate-note">
                Your name is stamped on every entry you make. It is not a
                password — it is what lets an error be traced and corrected.
              </div>
            </div>
          )}

          {gateStep==="admin"&&(
            <div>
              <div className="gate-label">Email</div>
              <input className="gate-input plain" type="email" value={gateEmail} autoFocus
                autoCapitalize="off" autoCorrect="off" spellCheck={false}
                onChange={e=>{setGateEmail(e.target.value);setGateErr("");}}/>
              <div className="gate-label" style={{marginTop:14}}>Password</div>
              <input className="gate-input plain" type="password" value={gatePass}
                onChange={e=>{setGatePass(e.target.value);setGateErr("");}}
                onKeyDown={e=>{if(e.key==="Enter")handleAdminSignIn();}}/>
              {gateErr&&<div className="gate-err">{gateErr}</div>}
              <button className="btn-p" style={{marginTop:14}}
                disabled={gateBusy||!gateEmail.trim()||!gatePass} onClick={handleAdminSignIn}>
                {gateBusy?"Signing in…":"Sign in →"}
              </button>
              <div className="gate-foot">
                <button className="gate-link" onClick={()=>{setGateStep("code");setGateErr("");}}>
                  ← Use a service code instead
                </button>
              </div>
            </div>
          )}
        </motion.div>
      </AnimatePresence>

      <div className="gate-note" style={{marginTop:28}}>
        De-identified by design · Study IDs only, no PHI<br/>
        Research &amp; educational use only
      </div>
    </div>
  );

  if(!authReady) return(<><style>{css}</style><div className="boot"><div className="boot-mark">F2F</div></div></>);
  if(!signedIn)  return(<><style>{css}</style>{renderGate()}</>);

  return(
    <>
      <style>{css}</style>
      <div className="app">
        <header className="hdr">
          <div className="hdr-row">
            <div>
              <div className="hdr-brand">Fitness-to-Flap Score</div>
              <div className="hdr-sub">Pressure Injury Module · Beta v1.1</div>
            </div>
            <div style={{display:"flex",alignItems:"center",gap:10}}>
              {screen==="wizard"&&wizStep<6&&<div className="hdr-step">{wizStep} / {TOTAL_WIZ-1}</div>}
              {isSupabaseConfigured&&whoAmI&&(
                <button className="hdr-acct" onClick={()=>setScreen("settings")}
                  title={`${whoAmI}${serviceNm?` · ${serviceNm}`:""}`}>
                  <span className={`sync-dot ${!syncState.online?"off":syncState.pending>0?"pending":"ok"}`}/>
                  <span className="hdr-acct-name">{whoAmI}</span>
                </button>
              )}
              <div style={{display:"flex",alignItems:"baseline",gap:1,border:"1px solid #333",borderRadius:4,padding:"2px 3px"}}>
                {[1,2,3,4].map(lvl=>(
                  <button key={lvl} onClick={()=>setFont(lvl)} title={`Text size ${lvl}`}
                    style={{
                      background:fontLevel===lvl?"#fff":"none",
                      color:fontLevel===lvl?"#111":"#888",
                      border:"none",cursor:"pointer",fontFamily:"var(--serif)",fontStyle:"italic",
                      fontSize:[11,13,15,18][lvl-1],lineHeight:1,padding:"3px 5px",borderRadius:2,
                      fontWeight:600,transition:"all .1s",minWidth:20,
                    }}>
                    A
                  </button>
                ))}
              </div>
            </div>
          </div>
          {showProg&&(
            <div style={{marginTop:12}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:5}}>
                <span style={{fontFamily:"var(--mono)",fontSize:9,color:"#888",letterSpacing:".08em",textTransform:"uppercase"}}>
                  {wizStep===1?"Pre-Screen":`Domain ${wizStep-1} of 4`}
                </span>
                <span style={{fontFamily:"var(--mono)",fontSize:9,color:"#bbb",fontWeight:500}}>{pct}% complete</span>
              </div>
              <div className="prog-track"><div className="prog-fill" style={{width:`${pct}%`}}/></div>
            </div>
          )}
        </header>
        <main className="main" style={{zoom:FONT_SCALE[fontLevel]}}>
          {/* .sheet is a pass-through on mobile; ≥768px it becomes the centered white card */}
          <div className={`sheet ${screen==="records"?"sheet-wide":""}`}>
            {isSupabaseConfigured&&(!syncState.online||syncState.pending>0)&&(
              <div className={`sync-banner ${!syncState.online?"offline":""}`}>
                <span className={`sync-dot ${!syncState.online?"off":"pending"}`}/>
                {!syncState.online
                  ? "Offline — your entries are saved on this device and will upload when you reconnect."
                  : `Uploading ${syncState.pending} entr${syncState.pending===1?"y":"ies"}…`}
              </div>
            )}
            <AnimatePresence mode="wait" initial={false}>
              <motion.div key={screen}
                initial={reduce?{opacity:0}:{opacity:0,y:8}}
                animate={{opacity:1,y:0}}
                exit={reduce?{opacity:0}:{opacity:0,y:-8}}
                transition={{duration:reduce?0.12:0.24,ease:[0.22,0.61,0.36,1]}}>
                {screen==="home"        && renderHome()}
                {screen==="intake"      && renderIntake()}
                {screen==="id_confirm"  && renderIdConfirm()}
                {screen==="wizard"      && renderWizard()}
                {screen==="records"     && renderRecords()}
                {screen==="detail"      && renderDetail()}
                {screen==="settings"    && renderSettings()}
                {screen==="outcomes"    && renderOutcomes()}
                {screen==="about"       && renderAbout()}
                {screen==="admin"       && renderAdmin()}
              </motion.div>
            </AnimatePresence>
          </div>
        </main>
      </div>
    </>
  );
}
