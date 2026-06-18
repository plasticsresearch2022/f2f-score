import { useState, useMemo, useEffect } from "react";
import { motion, AnimatePresence, animate, useReducedMotion } from "framer-motion";
import { supabase, isSupabaseConfigured } from "./lib/supabase";
import { saveAssessment, fetchAssessments } from "./lib/db";

/* ═══════════════════════════════════════════════
   HOSPITALS
═══════════════════════════════════════════════ */
const HOSPITALS = [
  { id:"LCH", name:"Larkin Community Hospital",             short:"Larkin"   },
  { id:"PGH", name:"Palmetto General Hospital",             short:"Palmetto" },
  { id:"DMC", name:"Delray Medical Center",                 short:"Delray"   },
  { id:"NLN", name:"Nemours Lake Nona Children's Hospital", short:"Nemours"  },
  { id:"OTH", name:"Other",                                 short:"Other"    },
];

/* ═══════════════════════════════════════════════
   LOCALSTORAGE UTILITIES
   All data persists across sessions.
   Keys prefixed with f2f_ to avoid conflicts.
═══════════════════════════════════════════════ */
function lsGet(key) {
  try { return localStorage.getItem(key); } catch(e) { return null; }
}
function lsSet(key, val) {
  try { localStorage.setItem(key, String(val)); return true; } catch(e) { return false; }
}
function lsKeys(prefix) {
  try { return Object.keys(localStorage).filter(k => k.startsWith(prefix)); } catch(e) { return []; }
}
function lsDel(key) {
  try { localStorage.removeItem(key); return true; } catch(e) { return false; }
}

function generateStudyId(hospitalId) {
  const key = `f2f_counter_${hospitalId}`;
  let count = parseInt(lsGet(key) || "0");
  count++;
  lsSet(key, String(count));
  return `${hospitalId}-${String(count).padStart(3, "0")}`;
}

function persistCase(data) {
  // Key includes studyId + timestamp so multiple assessments per patient are stored separately
  const key = `f2f_case_${data.studyId}_${Date.now()}`;
  lsSet(key, JSON.stringify(data));
}

function fetchAllCases() {
  const keys = lsKeys("f2f_case_");
  const cases = keys.map(k => {
    try { return JSON.parse(lsGet(k)); } catch(e) { return null; }
  }).filter(Boolean);
  return cases.sort((a, b) => new Date(b.savedAt) - new Date(a.savedAt));
}

function groupCasesByStudyId(cases) {
  const groups = {};
  cases.forEach(c => {
    if (!groups[c.studyId]) groups[c.studyId] = [];
    groups[c.studyId].push(c);
  });
  Object.values(groups).forEach(g =>
    g.sort((a, b) => new Date(a.savedAt) - new Date(b.savedAt))
  );
  return Object.entries(groups).sort((a, b) => {
    const aLatest = Math.max(...a[1].map(c => new Date(c.savedAt)));
    const bLatest = Math.max(...b[1].map(c => new Date(c.savedAt)));
    return bLatest - aLatest;
  });
}

async function callWebhook(webhookUrl, studyId, hospital, date) {
  if (!webhookUrl) return "no_url";
  try {
    const resp = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        study_id: studyId,
        hospital: hospital,
        enrollment_date: date,
        timestamp: new Date().toISOString(),
      }),
    });
    return resp.ok ? "success" : "failed";
  } catch(e) { return "failed"; }
}

function buildCSV(cases) {
  const H = ["Study ID","Assessment Type","Hospital","Enrollment Date",
    "Albumin","Prealbumin","BMI/Weight Loss","PCT","Inflammatory Markers",
    "PI Location","Wound Size","Osteomyelitis","Prior Flap","Soiling","Irradiated Bed",
    "Diabetes HbA1c","Smoking","Cardiopulmonary/Renal","Chronic Steroids",
    "Self-Repositioning","No Pressure Surface","Social Support",
    "D1 Total","D2 Total","D3 Total","D4 Total","F2F Total Score","Risk Tier","Timestamp"];
  const rows = cases.map(c => {
    const a = c.answers||{}; const d = c.domainScores||{};
    const typeLabel = {new:"New Patient",reassessment:"Re-Assessment",preop:"Pre-Operative"}[c.assessmentType]||"New Patient";
    return [c.studyId, typeLabel, c.hospital, c.enrollmentDate,
      a.albumin||"",a.prealbumin||"",a.bmi||"",a.pct||"",a.inflammation?"Y":"N",
      a.location||"",a.woundSize||"",a.osteomyelitis||"",a.priorFlap||"",a.soiling||"",a.irradiated?"Y":"N",
      a.diabetes||"",a.smoking||"",a.cardio||"",a.steroids?"Y":"N",
      a.selfReposition||"",a.pressureSurface?"Y":"N",a.socialSupport||"",
      d.bio??0,d.wound??0,d.comorbidities??0,d.functional??0,c.score,c.tierLabel,c.savedAt];
  });
  return [H,...rows].map(r=>r.map(v=>`"${String(v||"").replace(/"/g,'""')}"`).join(",")).join("\n");
}

function buildCopyText(studyId, hospital, enrollDate, answers, score, tier, domainScores, assessType="New Patient") {
  const a = answers;
  const csvRow = [
    studyId, assessType, hospital, enrollDate,
    a.albumin||"",a.prealbumin||"",a.bmi||"",a.pct||"",a.inflammation?"Y":"N",
    a.location||"",a.woundSize||"",a.osteomyelitis||"",a.priorFlap||"",a.soiling||"",a.irradiated?"Y":"N",
    a.diabetes||"",a.smoking||"",a.cardio||"",a.steroids?"Y":"N",
    a.selfReposition||"",a.pressureSurface?"Y":"N",a.socialSupport||"",
    domainScores.bio??0,domainScores.wound??0,domainScores.comorbidities??0,domainScores.functional??0,
    score,tier.label,new Date().toISOString()
  ].map(v=>`"${String(v||"").replace(/"/g,'""')}"`).join(",");

  return [
    "=== F2F SCORE RESULT ===",
    `Study ID:        ${studyId}`,
    `Assessment Type: ${assessType}`,
    `Hospital:        ${hospital}`,
    `Date:            ${enrollDate}`,
    `Score:           ${score} / 30 pts`,
    `Risk Tier:       ${tier.label}`,
    "",
    "Domain Scores:",
    `  Biomarkers & Nutrition:  ${domainScores.bio??0} / 9`,
    `  Wound Factors:           ${domainScores.wound??0} / 9`,
    `  Comorbidities:           ${domainScores.comorbidities??0} / 6`,
    `  Functional & Social:     ${domainScores.functional??0} / 6`,
    "",
    `Recommendation: ${tier.headline}`,
    tier.timing ? `Optimization window: ${tier.timing}` : "",
    "",
    "--- CSV ROW FOR RESEARCH SPREADSHEET ---",
    csvRow,
  ].filter(Boolean).join("\n");
}

/* ═══════════════════════════════════════════════
   SURGICAL RISK RED FLAGS
═══════════════════════════════════════════════ */
const RISK_FLAGS = [
  { id:"asa",        label:"Unstable ASA IV–V patient" },
  { id:"sepsis",     label:"Uncontrolled sepsis (PCT > 2 ng/mL + clinical signs)" },
  { id:"coag",       label:"Uncorrectable coagulopathy — INR > 2, platelets < 20,000, or DIC" },
  { id:"mi",         label:"Recent MI or unstable cardiac event (< 3 months) without cardiac clearance" },
  { id:"metabolic",  label:"Uncorrectable severe metabolic derangements — hyperkalemia, severe acidosis, renal failure without support" },
  { id:"wound_inf",  label:"Active uncontrolled wound infection — purulence, spreading cellulitis, or necrosis" },
  { id:"pvd_abs",    label:"Severe PVD with no viable revascularization options (lower extremities)" },
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
        {v:"ci",label:"< 2.5",pts:0,isCI:true,ciLabel:"Red Flag"},
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
        {v:"a",label:"< 0.5",pts:0},{v:"b",label:"0.5 – 2.0",pts:1},
        {v:"ci",label:"> 2.0  or  clinical sepsis",pts:0,isCI:true,ciLabel:"Red Flag"},
        {v:"no",label:"Not ordered — clean wound / no infection concern",pts:0},
      ]},
    { id:"inflammation", type:"toggle", pts:1, label:"Elevated inflammatory markers",
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
        {v:"ci",label:"No support system available",pts:0,isCI:true,ciLabel:"Red Flag"},
      ]},
  ]},
];

const TIERS = [
  {id:"low",      min:0,  max:5,        label:"LOW RISK",               headline:"Proceed with flap reconstruction.",                                                 timing:null},
  {id:"moderate", min:6,  max:12,       label:"MODERATE RISK",          headline:"Proceed with flap after targeted optimization.",                                    timing:"1–2 weeks"},
  {id:"high",     min:13, max:19,       label:"HIGH RISK",              headline:"Delay flap. Aggressive multidisciplinary optimization required.",                   timing:"2–4 weeks"},
  {id:"not_ideal",min:20, max:Infinity, label:"NOT AN IDEAL CANDIDATE", headline:"Avoid major flap reconstruction. Prioritize palliative and wound care strategies.", timing:null},
];

function computeScore(answers) {
  let total=0; const ciFlags=[]; const domainScores={};
  for (const domain of DOMAINS) {
    let ds=0;
    for (const f of domain.fields) {
      const val=answers[f.id];
      if(f.type==="toggle"){ ds+=val===true?f.pts:0; }
      else {
        const opt=f.options?.find(o=>o.v===val);
        if(opt){ if(opt.isCI) ciFlags.push({field:f.label,label:opt.ciLabel}); else ds+=opt.pts; }
      }
    }
    domainScores[domain.id]=ds; total+=ds;
  }
  return {total,ciFlags,domainScores};
}

function getTier(score){ return TIERS.find(t=>score>=t.min&&score<=t.max)??TIERS[0]; }

function buildRecs(answers,tierId){
  const recs=[]; const mod=tierId==="moderate"; const hi=tierId==="high";
  const ni=tierId==="not_ideal"; const low=tierId==="low";
  const loc=answers.location; const isch=loc==="ischial";
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
    if(answers.soiling==="c") add({p:2,cat:"Wound Contamination Management",text:"Constant fecal soiling is contributing to wound odor, skin breakdown, and patient discomfort. A diverting colostomy or rectal tube may improve quality of life — the primary intent is comfort and dignity."});
    else if(answers.soiling==="b") add({p:3,cat:"Wound Contamination Management",text:"Intermittent soiling is present. Optimize bowel regimen and use barrier creams and high-absorbency protective dressings to minimize skin breakdown and discomfort."});
    if(answers.osteomyelitis!=="a") add({p:3,cat:"Bone Involvement",text:"Osteomyelitis is present. In the palliative context, focus on pain control and odor management. Limited palliative-intent debridement may be appropriate if consistent with goals of care."});
    add({p:4,cat:"Advanced Wound Care",text:"Long-term management with advanced dressings, moisture control, and scheduled limited debridements as tolerated. NPWT may be considered as an adjunct if consistent with patient goals — not mandatory."});
    add({p:3,cat:"Social Work & Disposition",text:"Social work and case management focused on safe disposition, caregiver education, and quality-of-life optimization."});
    return recs.sort((a,b)=>a.p-b.p);
  }

  if(answers.pressureSurface===true) add({p:1,cat:"Pressure-Redistributing Surface — Immediate Action Required",text:`No appropriate pressure-redistributing surface is in place — immediately correctable. Place a specialty low-air-loss or alternating-pressure mattress without delay. ${hi?"Document placement as a formal pre-operative action item. ":""}Confirm in place before scheduling surgery.`});
  if(answers.selfReposition==="d") add({p:hi?1:2,cat:"Fully Dependent Repositioning — High Wound Recurrence Risk",text:`This patient cannot independently reposition or signal discomfort (quadriplegia, advanced dementia, severe stroke, severe contractures, or severe brain injury). ${hi?"A verified caregiver-executed 2-hour repositioning protocol must be documented before surgery is scheduled — mandatory pre-operative prerequisite.":"Establish a strict 2-hour caregiver-driven repositioning schedule immediately and educate caregivers on post-operative positioning restrictions."}`});
  else if(answers.selfReposition==="c") add({p:3,cat:"Partial Repositioning Dependence",text:`Patient requires assistance for repositioning but can communicate discomfort. ${hi?"Confirm reliable caregiver availability for post-operative repositioning before scheduling.":"Establish assisted repositioning schedule and educate caregivers on positioning restrictions."}`});
  if(answers.osteomyelitis==="c") add({p:1,cat:"Acute Osteomyelitis",text:"Acute osteomyelitis (≤ 4 weeks, purulent, no sequestrum) identified. MRI is indicated to define bony extent. Aggressive surgical debridement with intraoperative bone biopsy for culture-directed therapy is required before flap. Plan a 4–6 week course of organism-specific antibiotics. Bone margins must be viable and culture-negative at time of reconstruction."});
  if(answers.soiling==="c") add({p:isch?1:2,cat:`Fecal / Urinary Diversion${isch?" — Critical at Ischial Site":""}`,text:mod?`Constant daily soiling poses a direct threat to flap integrity${isch?", particularly at the ischial site":""}. A temporary rectal tube should be placed immediately. Escalate to diverting sigmoid colostomy if contamination cannot be reliably controlled. Address urinary soiling with Foley or external collection device.`:`Constant daily fecal soiling is a primary modifiable risk factor${isch?" and carries especially high stakes at the ischial location":""}. A temporary diverting sigmoid colostomy is strongly recommended before definitive flap. Foley or suprapubic catheter required to eliminate urinary contamination during healing.`});
  const pctEl=answers.pct==="b"; const inflam=answers.inflammation===true;
  if(pctEl||inflam){ const markers=[pctEl&&"PCT 0.5–2.0 ng/mL",inflam&&"CRP > 100 mg/L or WBC ≥ 12,000/mm³"].filter(Boolean).join(", "); add({p:hi?1:2,cat:"Infection & Inflammation Control",text:mod?`Elevated inflammatory markers: ${markers}. Obtain wound cultures at next debridement. Initiate culture-directed antibiotic therapy. NPWT or NPWTi-d may be considered as an adjunct. Reassess markers at day 7–10 and confirm downtrend before finalizing flap timing.`:`Significant systemic inflammation: ${markers}. Must normalize before surgery proceeds. Formal Infectious Disease consultation required. Serial debridements every 48–72 hours. Flap timing guided by marker normalization.`});}
  const alb=answers.albumin; const preal=answers.prealbumin; const bmi=answers.bmi;
  const nutItems=[alb==="b"&&"albumin 3.0–3.49 g/dL",alb==="c"&&"albumin 2.5–2.99 g/dL",preal==="b"&&"prealbumin 12–17.9 mg/dL",preal==="c"&&"prealbumin < 12 mg/dL",bmi==="b"&&"borderline BMI or 10–20% weight loss",bmi==="c"&&"BMI < 18.5 or > 20% weight loss"].filter(Boolean);
  const sevMal=preal==="c"||bmi==="c";
  if(nutItems.length>0){ const albNote="Albumin has an 18–20 day half-life — reflects chronic nutritional status and will not change meaningfully over a 1–2 week window. Do not use as a short-term response marker."; const prealNote=preal!=="a"?" Use prealbumin (half-life 2–3 days) to track response — target ≥ 18 mg/dL before proceeding.":""; add({p:sevMal?(hi?1:2):3,cat:"Nutritional Optimization",text:mod?`Nutritional deficits: ${nutItems.join("; ")}. Initiate high-protein diet (≥ 1.5 g/kg/day) with arginine/glutamine-enriched supplementation. ${sevMal?"NG tube indicated if oral targets not met within 48–72 hours. ":"Monitor and escalate to NG if targets not met. "}${albNote}${prealNote}`:`Malnutrition is a primary driver of high-risk status: ${nutItems.join("; ")}. Formal registered dietitian consultation required. ${sevMal?"PEG tube should be strongly considered. ":"Structured nutritional plan with defined re-assessment targets is mandatory. "}${albNote}${prealNote}`});}
  if(answers.diabetes==="c") add({p:hi?1:2,cat:"Glycemic Control — HbA1c ≥ 8.0%",text:mod?"HbA1c ≥ 8.0% substantially increases infection and wound healing failure risk. Optimize regimen with primary care or endocrinology. Perioperative glucose target 140–180 mg/dL.":"HbA1c ≥ 8.0% must be formally addressed before scheduling. Endocrinology consultation required. Delay scheduling until glycemic control improves."});
  else if(answers.diabetes==="b") add({p:3,cat:"Glycemic Control — HbA1c 7.0–7.9%",text:"HbA1c 7.0–7.9% represents moderate glycemic control. Tighten regimen in coordination with managing physician. Establish perioperative glucose protocol targeting 140–180 mg/dL."});
  if(answers.smoking==="b") add({p:hi?1:3,cat:`Smoking Cessation${hi?" — Mandatory":""}`,text:mod?"Active or recent smoking significantly increases risk of flap necrosis, dehiscence, and deep infection. Prescribe varenicline or nicotine replacement. Target ≥ 4 weeks confirmed abstinence. Confirm with urinary cotinine level.":"Nicotine abstinence ≥ 4 weeks is a mandatory prerequisite before surgery. Prescribe varenicline (preferred). Confirm with urinary cotinine — document as surgical prerequisite."});
  if(answers.osteomyelitis==="b") add({p:2,cat:"Chronic Osteomyelitis",text:"Chronic osteomyelitis with sequestrum or sinus tract documented. Complete sequestrectomy and aggressive bony debridement required as staged procedure before flap. Plan 6-week culture-directed antibiotics. Confirm clean surgical margins."});
  if(answers.priorFlap==="c") add({p:2,cat:"Multiple Prior Flap Failures at Site",text:"Two or more prior flap failures indicate local tissue options are likely exhausted. CT angiography or Doppler perforator mapping essential. Free flap from distant donor site should be primary strategy. Microsurgical team input required."});
  else if(answers.priorFlap==="b") add({p:3,cat:"Prior Flap at Site",text:"One prior flap failure documented. Preoperative perforator mapping (Doppler ± CTA) recommended. Consider rotating to adjacent or previously unused donor site. Review operative notes to clarify failure mechanism."});
  if(isch) add({p:3,cat:"Ischial Location — Highest Recurrence Site",text:`Ischial location carries the highest complication and recurrence rates. ${hi?"Fecal diversion must be secured before reconstruction. ":"Fecal diversion should be strongly considered before or at time of flap. "}Strict no-sitting protocol on operative side for minimum 4–6 weeks post-operatively is mandatory. Pre-operative patient and caregiver education on positioning adherence is critical.`});
  if(loc==="multiple") add({p:3,cat:"Multiple Pressure Injury Sites",text:"Multiple sites present — ischial not involved. Prioritize highest-risk site for reconstruction first. Staged reconstruction generally preferable. Each site should be independently assessed. If any site is ischial, re-score using the Ischial location category."});
  if(answers.woundSize==="c") add({p:3,cat:"Large Wound — > 100 cm²",text:"Wound area exceeds 100 cm². Flap design must ensure adequate volume and reach. CT angiography or Doppler perforator mapping recommended. Donor site morbidity planning particularly important."});
  if(answers.irradiated===true) add({p:3,cat:"Irradiated Wound Bed",text:`Prior radiation significantly impairs local tissue healing. ${hi?"HBO therapy consultation should be obtained as part of the pre-operative plan. ":"Consider HBO therapy consultation. "}Flap design must include margins extending beyond irradiated tissue. Pedicle-based flaps originating outside radiation field preferred.`});
  if(answers.steroids===true) add({p:3,cat:"Chronic Steroid Use",text:`Chronic steroid use impairs collagen synthesis and wound healing. Initiate Vitamin A supplementation (10,000–25,000 IU/day) per institutional protocol. ${hi?"Coordinate with prescribing physician on peri-operative taper. ":"Discuss peri-operative management with managing physician. "}Document Vitamin A start date in optimization plan.`});
  if(answers.cardio==="c") add({p:hi?2:3,cat:"Cardiopulmonary / Renal Optimization",text:mod?"Multiple or symptomatic cardiopulmonary/renal conditions present. Formal specialist consultation required for clearance. Mandatory anesthesia pre-assessment before scheduling.":"Multiple or symptomatic conditions represent major perioperative risk. Cardiology and/or nephrology consultations required. Dedicated multi-specialty optimization plan must be documented."});
  else if(answers.cardio==="b") add({p:4,cat:"Cardiopulmonary Clearance",text:"One stable major cardiopulmonary/renal condition documented. Obtain formal clearance from managing specialist. Communicate anticipated surgical demands to anesthesia team."});
  if(answers.socialSupport==="b") add({p:hi?2:4,cat:"Social Work & Caregiver Planning",text:mod?"Inconsistent social support noted. Social work consultation recommended to strengthen home care plan. Confirm reliable caregiver availability for post-operative period.":"Inconsistent social support is a significant barrier. Social work and case management consultation mandatory before scheduling. Verified 24/7 caregiver plan is a formal pre-operative prerequisite."});
  if(answers.soiling==="b") add({p:mod?4:3,cat:"Bowel Management",text:mod?"Intermittent soiling noted. Implement scheduled bowel management regimen. Escalate to rectal tube and reassess diversion if soiling cannot be reliably controlled.":"Intermittent soiling in high-risk patient warrants strong consideration of diverting ostomy. Foley or suprapubic catheter recommended to eliminate urinary contamination."});
  if(hi) add({p:4,cat:"Re-Assessment Plan",text:"After completing optimization actions above, re-score this patient with the F2F tool. Target: score below 13 before scheduling flap. Document optimization start date and set defined re-assessment date."});
  return recs.sort((a,b)=>a.p-b.p);
}

/* ═══════════════════════════════════════════════
   CSS
═══════════════════════════════════════════════ */
const css = `
@import url('https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=DM+Sans:opsz,wght@9..40,300;9..40,400;9..40,500;9..40,600;9..40,700&family=DM+Mono:wght@400;500&display=swap');
*{box-sizing:border-box;margin:0;padding:0}
:root{--k:#111;--k2:#333;--k3:#666;--k4:#999;--g1:#f0f0f0;--g2:#e4e4e4;--g3:#ccc;--w:#fff;--r:#c8102e;--serif:'Instrument Serif',serif;--sans:'DM Sans',sans-serif;--mono:'DM Mono',monospace}
html,body,#root{height:100%}
body{font-family:var(--sans);background:var(--w);color:var(--k);-webkit-font-smoothing:antialiased}
.app{min-height:100dvh;max-width:460px;width:100%;margin:0 auto;display:flex;flex-direction:column;background:var(--w)}
.hdr{background:var(--k);padding:14px 20px;position:sticky;top:0;z-index:50}
.hdr-row{display:flex;align-items:baseline;justify-content:space-between}
.hdr-brand{font-family:var(--serif);font-size:18px;color:var(--w);font-style:italic}
.hdr-step{font-family:var(--mono);font-size:10px;color:#888;letter-spacing:.05em}
.hdr-sub{font-size:10px;color:#888;letter-spacing:.1em;text-transform:uppercase;margin-top:2px}
.prog-track{height:1px;background:#333;margin-top:12px}
.prog-fill{height:100%;background:var(--w);transition:width .35s ease}
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
.score-denom{font-family:var(--mono);font-size:13px;color:var(--k4);margin-top:2px}
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
.home-hero{padding:32px 0 28px;text-align:center}
.home-title{font-family:var(--serif);font-size:38px;font-style:italic;letter-spacing:-.025em;color:var(--k);margin-bottom:6px}
.home-sub{font-size:13px;color:var(--k4);line-height:1.6;max-width:280px;margin:0 auto}
.home-btns{display:flex;flex-direction:column;gap:10px;margin-bottom:24px}
.home-btn-new{padding:16px 20px;background:var(--k);color:var(--w);border:none;font-family:var(--sans);font-size:15px;font-weight:700;cursor:pointer;letter-spacing:.02em}
.home-btn-sec{padding:13px 20px;background:var(--w);color:var(--k);border:1px solid var(--g2);font-family:var(--sans);font-size:14px;font-weight:500;cursor:pointer}
.home-btn-sec:hover{background:var(--g1)}.home-links{display:flex;justify-content:center;gap:20px}
.home-link{font-size:12px;color:var(--k4);background:none;border:none;cursor:pointer;font-family:var(--sans);text-decoration:underline;text-underline-offset:3px}
.hosp-card{display:flex;align-items:center;gap:12px;width:100%;text-align:left;padding:12px 14px;border:1px solid var(--g2);background:var(--w);cursor:pointer;font-family:var(--sans);margin-bottom:6px;transition:all .1s}
.hosp-card.selected{border-color:var(--k);background:var(--g1)}
.hosp-radio{width:16px;height:16px;border:1.5px solid var(--g3);border-radius:50%;flex-shrink:0;display:flex;align-items:center;justify-content:center;transition:all .1s}.hosp-radio.selected{border-color:var(--k)}
.hosp-dot{width:8px;height:8px;background:var(--k);border-radius:50%}
.hosp-name{font-size:13.5px;font-weight:500;color:var(--k)}.hosp-id{font-family:var(--mono);font-size:10px;color:var(--k4);margin-top:1px}
.id-display{text-align:center;padding:32px 0 24px;border-bottom:1px solid var(--g2);margin-bottom:20px}
.id-label{font-size:10px;font-weight:700;letter-spacing:.2em;text-transform:uppercase;color:var(--k4);margin-bottom:8px}
.id-number{font-family:var(--serif);font-size:64px;font-style:italic;letter-spacing:-.03em;color:var(--k);line-height:1}
.id-hospital{font-size:13px;color:var(--k4);margin-top:6px}.id-date{font-family:var(--mono);font-size:11px;color:var(--k4);margin-top:3px}
.confirm-check-row{display:flex;align-items:flex-start;gap:12px;padding:14px;border:1.5px solid var(--r);background:#fff8f8;cursor:pointer;width:100%;text-align:left;font-family:var(--sans);margin-bottom:16px}
.confirm-check-row.done{border-color:#16a34a;background:#f0fdf4}
.confirm-chkbox{width:18px;height:18px;border:2px solid var(--r);flex-shrink:0;margin-top:1px;display:flex;align-items:center;justify-content:center;transition:all .12s}.confirm-chkbox.done{background:#16a34a;border-color:#16a34a}
.confirm-chk-text{font-size:13px;line-height:1.5;color:var(--r);font-weight:500}.confirm-chk-text.done{color:#15803d}
.copy-btn{width:100%;padding:13px 20px;background:var(--w);color:var(--k);border:1.5px solid var(--k);font-family:var(--sans);font-size:13.5px;font-weight:600;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:8px;transition:all .12s;margin-bottom:8px}
.copy-btn:hover{background:var(--g1)}.copy-btn.copied{background:#f0fdf4;border-color:#16a34a;color:#15803d}
.copy-fallback{width:100%;padding:10px;border:1px solid var(--g2);font-family:var(--mono);font-size:10px;color:var(--k3);background:var(--g1);resize:none;margin-bottom:8px}
.records-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:16px}
.records-count{font-family:var(--mono);font-size:11px;color:var(--k4)}
.export-btn{font-size:11px;font-weight:600;color:var(--k);background:var(--g1);border:1px solid var(--g2);padding:5px 12px;cursor:pointer;font-family:var(--sans)}
.patient-group{margin-bottom:20px}
.patient-group-header{display:flex;align-items:center;justify-content:space-between;padding-bottom:6px;border-bottom:1.5px solid var(--k);margin-bottom:6px}
.patient-group-id{font-family:var(--mono);font-size:13px;font-weight:700;color:var(--k)}
.patient-group-hosp{font-size:11px;color:var(--k4)}
.record-item{display:flex;align-items:center;justify-content:space-between;padding:9px 0 9px 12px;border-bottom:1px solid var(--g1);cursor:pointer;gap:12px}
.record-item:hover .record-type{text-decoration:underline}
.record-item:last-child{border-bottom:none}
.record-type{font-size:12.5px;color:var(--k);font-weight:500}
.record-date{font-size:11px;color:var(--k4);margin-top:1px}
.record-right{display:flex;align-items:center;gap:8px;flex-shrink:0}
.record-score{font-family:var(--mono);font-size:14px;font-weight:500;color:var(--k)}
.type-icon{font-family:var(--mono);font-size:11px;color:var(--k4);width:14px}
.tier-chip{font-size:9px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;padding:3px 7px;border-radius:2px}
.tier-chip.low{background:#dcfce7;color:#166534}.tier-chip.moderate{background:#fef9c3;color:#854d0e}.tier-chip.high{background:#ffedd5;color:#7c2d12}.tier-chip.not_ideal{background:#fee2e2;color:#991b1b}
.empty-state{text-align:center;padding:48px 0;color:var(--k4)}.empty-icon{font-size:32px;margin-bottom:12px}.empty-text{font-size:14px;margin-bottom:4px;color:var(--k3)}.empty-sub{font-size:12px}
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
.wh-status{font-size:11px;margin-top:6px;font-family:var(--mono)}
.wh-ok{color:#16a34a}.wh-fail{color:var(--r)}.wh-none{color:var(--k4)}

/* ═══════════════════════════════════════════════
   RESPONSIVE — Desktop / Tablet web view
   Mobile-first above; the column becomes a centered
   editorial panel on larger screens (line length stays
   readable — correct UX for a clinical form).
═══════════════════════════════════════════════ */
@media (min-width:768px){
  body{background:var(--g1)}
  .app{max-width:600px;min-height:calc(100dvh - 64px);margin:32px auto;
       border:1px solid var(--g2);box-shadow:0 1px 3px rgba(0,0,0,.06),0 10px 30px rgba(0,0,0,.05)}
  .hdr{position:static}
  .main{padding:40px 48px 56px}
  .home-hero{padding:40px 0 32px}
  .home-title{font-size:44px}
  .home-sub{max-width:320px}
  .display{font-size:34px}
  .domain-title{font-size:32px}
}
@media (min-width:1024px){
  .app{max-width:640px;margin:48px auto;min-height:calc(100dvh - 96px)}
  .main{padding:48px 56px 64px}
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
   AUTH + PROFILE
═══════════════════════════════════════════════ */
.hdr-acct{width:30px;height:30px;border-radius:50%;border:1px solid #555;background:transparent;color:var(--w);font-family:var(--sans);font-size:13px;font-weight:600;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:border-color .12s,background .12s}
.hdr-acct:hover{border-color:var(--w);background:#222}
.hdr-acct-link{background:none;border:none;color:#bbb;font-family:var(--sans);font-size:12px;font-weight:500;cursor:pointer;letter-spacing:.02em;padding:6px 4px}
.hdr-acct-link:hover{color:var(--w)}
.auth-title{font-family:var(--serif);font-style:italic;font-size:34px;letter-spacing:-.02em;color:var(--k);margin-bottom:6px}
.auth-sub{font-size:13px;color:var(--k4);line-height:1.6;margin-bottom:24px}
.auth-field{margin-bottom:14px}
.auth-label{font-size:11px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--k4);margin-bottom:6px;display:block}
.auth-input{width:100%;padding:12px 13px;border:1px solid var(--g2);font-family:var(--sans);font-size:15px;color:var(--k);background:var(--w);outline:none;transition:border-color .12s}
.auth-input:focus{border-color:var(--k)}
.google-btn{width:100%;padding:12px 16px;background:var(--w);border:1px solid var(--g3);font-family:var(--sans);font-size:14px;font-weight:600;color:var(--k);cursor:pointer;display:flex;align-items:center;justify-content:center;gap:10px;transition:background .12s,border-color .12s}
.google-btn:hover{background:var(--g1);border-color:var(--k4)}
.auth-divider{display:flex;align-items:center;gap:12px;margin:18px 0;color:var(--k4);font-size:11px;letter-spacing:.1em;text-transform:uppercase}
.auth-divider::before,.auth-divider::after{content:"";flex:1;height:1px;background:var(--g2)}
.auth-toggle{text-align:center;font-size:13px;color:var(--k4);margin-top:18px}
.auth-toggle button{background:none;border:none;color:var(--k);font-family:var(--sans);font-size:13px;font-weight:600;cursor:pointer;text-decoration:underline;text-underline-offset:3px;padding:0}
.otp-input{width:100%;padding:16px;border:1.5px solid var(--g2);font-family:var(--mono);font-size:30px;font-weight:500;letter-spacing:.45em;text-align:center;color:var(--k);background:var(--w);outline:none;text-indent:.45em}
.otp-input:focus{border-color:var(--k)}
.profile-card{border:1px solid var(--g2);padding:18px;margin-bottom:20px;display:flex;align-items:center;gap:14px}
.profile-avatar{width:48px;height:48px;border-radius:50%;background:var(--k);color:var(--w);font-family:var(--serif);font-style:italic;font-size:22px;display:flex;align-items:center;justify-content:center;flex-shrink:0}
.profile-name{font-size:16px;font-weight:600;color:var(--k)}
.profile-email{font-size:12.5px;color:var(--k4);margin-top:2px}
.profile-stat{display:flex;justify-content:space-between;padding:11px 0;border-bottom:1px solid var(--g1);font-size:13px;color:var(--k2)}
.profile-stat-val{font-family:var(--mono);color:var(--k)}

/* ── Sign-in landing ── */
.auth-screen{padding-top:6px}
.auth-hero{text-align:center;margin-bottom:26px}
.auth-brand{font-family:var(--serif);font-style:italic;font-size:40px;letter-spacing:-.025em;color:var(--k);line-height:1.05}
.auth-tagline{font-size:12.5px;color:var(--k4);margin-top:8px;line-height:1.55;max-width:290px;margin-left:auto;margin-right:auto}
.auth-foot{margin-top:26px;text-align:center}
.auth-guest{background:none;border:none;color:var(--k3);font-family:var(--sans);font-size:13px;font-weight:600;cursor:pointer;text-decoration:underline;text-underline-offset:4px;padding:8px;transition:color .12s}
.auth-guest:hover{color:var(--k)}
.auth-disclaimer{font-size:10.5px;color:var(--g3);margin-top:16px;line-height:1.6}

/* ── One-field-at-a-time domain progress dots ── */
.field-dots{display:flex;gap:6px;margin:14px 0 22px}
.field-dot{width:6px;height:6px;border-radius:50%;background:var(--g3);transition:background .2s ease,transform .2s ease}
.field-dot.done{background:var(--k3)}
.field-dot.active{background:var(--k);transform:scale(1.35)}

/* ── Boot splash ── */
.boot{min-height:50vh;display:flex;align-items:center;justify-content:center}
.boot-mark{font-family:var(--serif);font-style:italic;font-size:40px;color:var(--g3);animation:bootpulse 1.2s ease-in-out infinite}
@keyframes bootpulse{0%,100%{opacity:.4}50%{opacity:.9}}
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
            <span className={`opt-pts ${cls}`}>{ci?opt.ciLabel:`+${opt.pts}`}</span>
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
  const labels={low:"Low",moderate:"Moderate",high:"High",not_ideal:"Not Ideal"};
  return <span className={`tier-chip ${tierId}`}>{labels[tierId]||tierId}</span>;
}

/* ═══════════════════════════════════════════════
   MAIN APP
═══════════════════════════════════════════════ */
const TOTAL_WIZ=6;
const TYPE_LABELS={new:"New Patient",reassessment:"Re-Assessment",preop:"Pre-Operative"};
const TYPE_ICONS={new:"✦",reassessment:"↺",preop:"✓"};

export default function F2FApp(){
  const [screen,       setScreen]       = useState("home");
  const [wizStep,      setWizStep]      = useState(1);
  const [ciChecked,    setCiChecked]    = useState({});
  const [answers,      setAnswers]      = useState({});
  const [hospital,     setHospital]     = useState(null);
  const [studyId,      setStudyId]      = useState(null);
  const [enrollDate,   setEnrollDate]   = useState(null);
  const [deIdDone,     setDeIdDone]     = useState(false);
  const [selectedHosp, setSelectedHosp]= useState(null);
  const [assessType,   setAssessType]   = useState(null);
  const [existingId,   setExistingId]   = useState("");
  const [cases,        setCases]        = useState([]);
  const [selCase,      setSelCase]      = useState(null);
  const [copied,       setCopied]       = useState(false);
  const [copyFallback, setCopyFallback] = useState(false);
  const [copyText,     setCopyText]     = useState("");
  const [webhookUrl,   setWebhookUrl]   = useState("");
  const [webhookInput, setWebhookInput] = useState("");
  const [webhookStatus,setWebhookStatus]= useState(null);
  const [savingWh,     setSavingWh]     = useState(false);
  // Auth / session
  const [session,      setSession]      = useState(null);
  const [authReady,    setAuthReady]    = useState(false);
  const [authMode,     setAuthMode]     = useState("signin"); // signin | signup | otp
  const [authName,     setAuthName]     = useState("");
  const [authEmail,    setAuthEmail]    = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authCode,     setAuthCode]     = useState("");
  const [authLoading,  setAuthLoading]  = useState(false);
  const [authError,    setAuthError]    = useState("");
  const [authNotice,   setAuthNotice]   = useState("");
  const [guest,        setGuest]        = useState(false); // chose "continue as guest"
  const [fieldIdx,     setFieldIdx]     = useState(0);     // one-field-at-a-time within a domain

  // Load settings on mount (assessments are loaded by the [user] effect below)
  useEffect(()=>{
    const url = lsGet("f2f_setting_webhook")||"";
    setWebhookUrl(url); setWebhookInput(url);
  },[]);

  // Subscribe to Supabase auth session (authReady is made bulletproof:
  // resolves via finally + a hard timeout so the UI can never hang on boot)
  useEffect(()=>{
    if(!supabase){ setAuthReady(true); return; }
    let settled=false;
    const finish=()=>{ if(!settled){ settled=true; setAuthReady(true); } };
    supabase.auth.getSession()
      .then(({data})=>{ setSession(data.session); })
      .catch((e)=>{ console.warn("[F2F] getSession failed:",e?.message); })
      .finally(finish);
    const t=setTimeout(finish,2500); // never block the app on auth more than 2.5s
    const {data:sub}=supabase.auth.onAuthStateChange((_evt,s)=>{ setSession(s); finish(); });
    return ()=>{ clearTimeout(t); sub.subscription.unsubscribe(); };
  },[]);

  const user     = session?.user ?? null;
  const userName = user?.user_metadata?.full_name || user?.email || "";
  const userInitial = (userName||"?").trim().charAt(0).toUpperCase();

  // Load assessments from cloud (signed in) or localStorage (guest)
  async function refreshCases(){
    if(user && supabase){
      try{ setCases(await fetchAssessments()); }
      catch(e){ console.warn("[F2F] load assessments failed:",e?.message); setCases([]); }
    } else {
      setCases(fetchAllCases());
    }
  }
  useEffect(()=>{
    let cancelled=false;
    (async()=>{
      if(user && supabase){
        try{ const rows=await fetchAssessments(); if(!cancelled) setCases(rows); }
        catch(e){ if(!cancelled){ console.warn("[F2F] load assessments failed:",e?.message); setCases([]); } }
      } else if(!cancelled){
        setCases(fetchAllCases());
      }
    })();
    return ()=>{cancelled=true;};
  },[user]); // eslint-disable-line react-hooks/exhaustive-deps

  const reduce     = useReducedMotion();
  const hasRedFlag = Object.values(ciChecked).some(Boolean);
  const domain     = DOMAINS[wizStep-2]??null;
  const updateAnswer=(id,val)=>setAnswers(p=>({...p,[id]:val}));
  const toggleFlag=(id)=>setCiChecked(p=>({...p,[id]:!p[id]}));

  const isDomainComplete=useMemo(()=>{
    if(!domain) return true;
    return domain.fields.filter(f=>f.type==="radio").every(f=>answers[f.id]!==undefined);
  },[domain,answers]);

  const {total,ciFlags,domainScores}=useMemo(()=>computeScore(answers),[answers]);
  const tier=getTier(total);
  const recs=useMemo(()=>buildRecs(answers,tier.id),[answers,tier.id]);
  // Field-aware progress: smooth advance per question within each domain
  const pct=useMemo(()=>{
    if(wizStep===1) return 6;
    if(wizStep>=6) return 100;
    const nf=domain?domain.fields.length:1;
    const frac=((wizStep-2)+(fieldIdx/nf))/4; // 0..1 across 4 domains
    return Math.round(10+frac*86);
  },[wizStep,fieldIdx,domain]);
  const assessLabel=TYPE_LABELS[assessType]||"New Patient";

  // Reset to first question whenever we enter/leave a domain step
  useEffect(()=>{ setFieldIdx(0); },[wizStep]);

  /* ── HANDLERS ── */
  async function handleGenerateId(){
    if(!selectedHosp) return;
    const id=generateStudyId(selectedHosp.id);
    const now=new Date().toISOString().split("T")[0];
    setStudyId(id); setHospital(selectedHosp); setEnrollDate(now); setDeIdDone(false);
    // Auto-call webhook if configured
    if(webhookUrl){
      setWebhookStatus("sending");
      const status=await callWebhook(webhookUrl,id,selectedHosp.name,now);
      setWebhookStatus(status);
    }
    setScreen("id_confirm");
  }

  function handleBeginAssessment(){
    if(!deIdDone) return;
    setWizStep(1); setCiChecked({}); setAnswers({}); setFieldIdx(0);
    setCopied(false); setCopyFallback(false); setScreen("wizard");
  }

  function continueAsGuest(){ setGuest(true); setScreen("home"); }

  // One-field-at-a-time navigation within a domain
  function nextField(){
    if(!domain) return;
    const f=domain.fields[fieldIdx];
    if(!f || answers[f.id]===undefined) return;       // require an answer
    if(fieldIdx < domain.fields.length-1) setFieldIdx(i=>i+1);
    else goNextWiz();                                  // last field → next section (effect resets fieldIdx)
  }
  function prevField(){
    if(fieldIdx>0) setFieldIdx(i=>i-1);
    else goPrevWiz();
  }

  function goNextWiz(){
    if(wizStep===1&&hasRedFlag) return;
    if(wizStep>=2&&wizStep<=5&&!isDomainComplete) return;
    if(wizStep===5){
      setWizStep(6);
      const caseData={
        studyId, hospital:hospital.name, hospitalId:hospital.id, enrollmentDate:enrollDate,
        assessmentType:assessType||"new",
        savedAt:new Date().toISOString(), answers:{...answers}, score:total,
        tierId:tier.id, tierLabel:tier.label, domainScores:{...domainScores},
      };
      if(user && supabase){
        // signed in → save to cloud profile
        saveAssessment(caseData, user.id).then(refreshCases).catch(e=>console.warn("[F2F] save failed:",e?.message));
      } else {
        // guest → keep local
        persistCase(caseData); refreshCases();
      }
    } else {
      setWizStep(s=>Math.min(s+1,TOTAL_WIZ));
    }
  }

  function goPrevWiz(){
    if(wizStep===1){setScreen("home");return;}
    setWizStep(s=>Math.max(s-1,1));
  }

  /* ── AUTH HANDLERS ── */
  function openAuth(mode="signin"){
    setAuthMode(mode); setAuthError(""); setAuthNotice("");
    setAuthName(""); setAuthEmail(""); setAuthPassword(""); setAuthCode("");
    setScreen("auth");
  }
  async function handleEmailAuth(){
    if(!supabase) return;
    setAuthError(""); setAuthLoading(true);
    try{
      const email=authEmail.trim().toLowerCase();
      if(authMode==="signup"){
        const {error}=await supabase.auth.signUp({
          email, password:authPassword,
          options:{ data:{ full_name:authName.trim() } },
        });
        if(error) throw error;
        setAuthMode("otp");
        setAuthNotice(`We emailed a 6-digit code to ${email}. Enter it below to finish creating your account.`);
      } else {
        const {error}=await supabase.auth.signInWithPassword({ email, password:authPassword });
        if(error) throw error;
        setScreen("home");
      }
    }catch(e){ setAuthError(e?.message||"Something went wrong. Please try again."); }
    finally{ setAuthLoading(false); }
  }
  async function handleVerifyOtp(){
    if(!supabase) return;
    setAuthError(""); setAuthLoading(true);
    try{
      const {error}=await supabase.auth.verifyOtp({
        email:authEmail.trim().toLowerCase(), token:authCode.trim(), type:"email",
      });
      if(error) throw error;
      setScreen("home");
    }catch(e){ setAuthError(e?.message||"That code didn't work. Check it and try again."); }
    finally{ setAuthLoading(false); }
  }
  async function handleResendCode(){
    if(!supabase) return;
    setAuthError(""); setAuthNotice("");
    try{
      const {error}=await supabase.auth.resend({ type:"signup", email:authEmail.trim().toLowerCase() });
      if(error) throw error;
      setAuthNotice("A new code is on its way.");
    }catch(e){ setAuthError(e?.message||"Couldn't resend the code."); }
  }
  async function handleGoogle(){
    if(!supabase) return;
    setAuthError("");
    try{
      const {error}=await supabase.auth.signInWithOAuth({
        provider:"google", options:{ redirectTo: window.location.origin },
      });
      if(error) throw error;
    }catch(e){ setAuthError(e?.message||"Google sign-in failed."); }
  }
  async function handleSignOut(){
    if(supabase) await supabase.auth.signOut();
    setScreen("home");
  }

  function handleCopy(){
    const text=buildCopyText(studyId,hospital.name,enrollDate,answers,total,tier,domainScores,assessLabel);
    setCopyText(text);
    if(navigator.clipboard?.writeText){
      navigator.clipboard.writeText(text)
        .then(()=>{setCopied(true);setTimeout(()=>setCopied(false),3000);})
        .catch(()=>setCopyFallback(true));
    } else { setCopyFallback(true); }
  }

  function exportCSV(){
    const allCases=cases;
    if(allCases.length===0) return;
    const csv=buildCSV(allCases);
    const a=document.createElement("a");
    a.href="data:text/csv;charset=utf-8,"+encodeURIComponent(csv);
    a.download=`F2F_Data_${new Date().toISOString().split("T")[0]}.csv`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
  }

  async function saveWebhook(){
    setSavingWh(true);
    lsSet("f2f_setting_webhook",webhookInput);
    setWebhookUrl(webhookInput);
    setSavingWh(false);
  }

  function resetAll(){
    setScreen("home"); setWizStep(1); setCiChecked({}); setAnswers({});
    setHospital(null); setStudyId(null); setEnrollDate(null); setDeIdDone(false);
    setSelectedHosp(null); setAssessType(null); setExistingId("");
    setCopied(false); setCopyFallback(false); setSelCase(null); setWebhookStatus(null);
  }

  const grouped = useMemo(()=>groupCasesByStudyId(cases),[cases]);
  const showProg=screen==="wizard"&&wizStep<6;
  // Sign-in is the primary landing screen until the user signs in OR chooses guest
  const booting     = isSupabaseConfigured && !authReady;
  const showLanding = isSupabaseConfigured && authReady && !user && !guest;

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
        <button className="home-btn-new" onClick={()=>setScreen("intake")}>New Assessment</button>
        <button className="home-btn-sec" onClick={()=>{refreshCases();setScreen("records");}}>
          Patient Records {cases.length>0&&`(${cases.length})`}
        </button>
      </div>
      <div className="alert al-dark">
        <div className="al-title" style={{color:"var(--k)"}}>Clinical Disclaimer</div>
        <div className="al-body">For research and educational purposes only. Not a substitute for clinical judgment.</div>
      </div>
      <div style={{marginTop:16}} className="home-links">
        <button className="home-link" onClick={()=>setScreen("settings")}>⚙ Settings</button>
        <button className="home-link" onClick={()=>setScreen("about")}>About F2F</button>
      </div>
    </div>
  );

  const ASSESS_TYPES=[
    {id:"new",          label:"New Patient",        sub:"First assessment — generates a new Study ID",           icon:"✦"},
    {id:"reassessment", label:"Re-Assessment",       sub:"Patient previously scored — optimization complete",     icon:"↺"},
    {id:"preop",        label:"Pre-Operative Score", sub:"Final score before scheduling surgery",                 icon:"✓"},
  ];

  const renderIntake=()=>(
    <div>
      <button className="back-link" onClick={()=>{setScreen("home");setAssessType(null);setSelectedHosp(null);setExistingId("");}}>← Back</button>

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

      {assessType==="new"&&(
        <>
          <div className="eyebrow">New Patient</div>
          <div className="display" style={{marginBottom:4}}>Select Hospital</div>
          <div className="caption" style={{marginBottom:20}}>Select the hospital where this patient is being evaluated.</div>
          {HOSPITALS.map(h=>(
            <button key={h.id} className={`hosp-card ${selectedHosp?.id===h.id?"selected":""}`}
              onClick={()=>setSelectedHosp(h)}>
              <div className={`hosp-radio ${selectedHosp?.id===h.id?"selected":""}`}>
                {selectedHosp?.id===h.id&&<div className="hosp-dot"/>}
              </div>
              <div><div className="hosp-name">{h.name}</div><div className="hosp-id">{h.id}</div></div>
            </button>
          ))}
          {webhookUrl&&(
            <div style={{fontSize:11,color:"#16a34a",fontFamily:"var(--mono)",margin:"8px 0"}}>
              ✓ Study ID will be auto-logged to OneDrive via Make.com
            </div>
          )}
          <div style={{display:"flex",gap:8,marginTop:8}}>
            <button className="btn-s" onClick={()=>setAssessType(null)}>← Back</button>
            <button className="btn-p" style={{flex:2}} disabled={!selectedHosp} onClick={handleGenerateId}>
              Generate Study ID →
            </button>
          </div>
        </>
      )}

      {(assessType==="reassessment"||assessType==="preop")&&(
        <>
          <div className="eyebrow">{assessType==="preop"?"Pre-Operative Score":"Re-Assessment"}</div>
          <div className="display" style={{marginBottom:4}}>Enter Study ID</div>
          <div className="caption" style={{marginBottom:20}}>Enter the existing Study ID from your de-identification log.</div>
          <div className="alert al-dark" style={{marginBottom:16}}>
            <div className="al-body">
              {assessType==="reassessment"
                ?"This will be saved as a re-assessment linked to the original Study ID. No new de-identification log entry is needed."
                :"This is the final score before surgical scheduling — saved under the original Study ID as the pre-operative assessment."}
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
                const prefix=existingId.trim().split("-")[0];
                const hosp=HOSPITALS.find(h=>h.id===prefix)||{id:prefix,name:prefix,short:prefix};
                setStudyId(existingId.trim()); setHospital(hosp);
                setEnrollDate(new Date().toISOString().split("T")[0]);
                setDeIdDone(true); setWizStep(1); setCiChecked({}); setAnswers({});
                setCopied(false); setCopyFallback(false); setScreen("wizard");
              }}>
              Begin {assessType==="preop"?"Pre-Op Score":"Re-Assessment"} →
            </button>
          </div>
        </>
      )}
    </div>
  );

  const renderIdConfirm=()=>(
    <div>
      <div className="id-display">
        <div className="id-label">New Study ID — {hospital?.name}</div>
        <div className="id-number">{studyId}</div>
        <div className="id-date">{enrollDate}</div>
      </div>

      {webhookStatus==="sending"&&<div className="alert al-neutral"><div className="al-body">Logging to OneDrive via Make.com…</div></div>}
      {webhookStatus==="success"&&<div className="alert al-green"><div className="al-body">✓ Study ID logged to OneDrive de-identification file automatically.</div></div>}
      {webhookStatus==="failed"&&<div className="alert al-red"><div className="al-body" style={{color:"var(--r)"}}>⚠ OneDrive log failed. Record this Study ID manually in your de-identification log.</div></div>}
      {webhookStatus==="no_url"&&null}

      <div className="alert al-dark" style={{marginBottom:16}}>
        <div className="al-title" style={{color:"var(--k)"}}>De-Identification Log — Required Action</div>
        <div className="al-body">Record <strong>{studyId}</strong> in your de-identification log alongside the patient's MRN. The app stores no PHI.</div>
      </div>

      <button className={`confirm-check-row ${deIdDone?"done":""}`} onClick={()=>setDeIdDone(d=>!d)}>
        <div className={`confirm-chkbox ${deIdDone?"done":""}`}>
          {deIdDone&&<span style={{color:"var(--w)",fontSize:10,fontWeight:900}}>✓</span>}
        </div>
        <span className={`confirm-chk-text ${deIdDone?"done":""}`}>
          {deIdDone?`Confirmed — ${studyId} has been recorded in the de-identification log`:`I have recorded ${studyId} in my de-identification log alongside the patient's MRN`}
        </span>
      </button>

      <button className="btn-p" disabled={!deIdDone} onClick={handleBeginAssessment}>
        Begin F2F Assessment →
      </button>
    </div>
  );

  const renderWizard=()=>(
    <div>
      <div className="study-id-badge">
        {studyId} · {hospital?.short}
        {assessType&&assessType!=="new"&&<span style={{marginLeft:8,color:"var(--r)",fontWeight:700}}>· {assessLabel}</span>}
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

      {wizStep>=2&&wizStep<=5&&domain&&(()=>{
        const safeIdx=Math.min(fieldIdx,domain.fields.length-1);
        const field=domain.fields[safeIdx];
        const nFields=domain.fields.length;
        const answered=field?answers[field.id]!==undefined:false;
        const isLast=safeIdx>=nFields-1;
        return (
          <div>
            <div className="domain-tag">Domain {wizStep-1} of 4 · {domain.label}</div>
            <div className="domain-title">{domain.label}</div>
            <div className="domain-meta">Question {safeIdx+1} of {nFields} · Max {domain.maxPts} pts</div>
            <div className="field-dots">
              {domain.fields.map((f,i)=>(
                <span key={f.id} className={`field-dot ${i===safeIdx?"active":""} ${answers[f.id]!==undefined?"done":""}`}/>
              ))}
            </div>
            <AnimatePresence mode="wait" initial={false}>
              <motion.div key={`${wizStep}-${safeIdx}`}
                initial={reduce?{opacity:0}:{opacity:0,x:26}}
                animate={{opacity:1,x:0}}
                exit={reduce?{opacity:0}:{opacity:0,x:-26}}
                transition={{duration:reduce?0.12:0.3,ease:[0.22,0.61,0.36,1]}}>
                {field.type==="radio"
                  ?<RadioField field={field} value={answers[field.id]} onChange={updateAnswer}/>
                  :<ToggleField field={field} value={answers[field.id]} onChange={updateAnswer}/>}
              </motion.div>
            </AnimatePresence>
            <div className="btn-row">
              <button className="btn-s" onClick={prevField}>← Back</button>
              <button className="btn-p" style={{flex:2,background:answered?"var(--k)":"#94a3b8"}}
                disabled={!answered} onClick={nextField}>
                {isLast?(wizStep===5?"Calculate Score →":"Next Section →"):"Next →"}
              </button>
            </div>
            {!answered&&<div style={{textAlign:"center",fontSize:12,color:"#94a3b8",marginTop:8}}>Select an option to continue</div>}
          </div>
        );
      })()}

      {wizStep===6&&(
        <div>
          <div style={{textAlign:"center",marginBottom:6}}>
            <div style={{fontSize:11,fontWeight:700,textTransform:"uppercase",letterSpacing:"0.1em",color:"#94a3b8"}}>F2F Score Result</div>
            <div style={{fontFamily:"var(--mono)",fontSize:11,color:"var(--k4)",marginTop:2}}>{studyId} · {hospital?.short} · {assessLabel}</div>
          </div>

          <div className="score-wrap">
            <div className="score-big"><AnimatedNumber value={total} reduce={reduce}/></div>
            <div className="score-denom">/ 30 pts</div>
            <motion.div className="tier-lbl"
              initial={reduce?false:{opacity:0,y:6}} animate={{opacity:1,y:0}} transition={{delay:0.55,duration:0.4}}>
              {tier.label}
            </motion.div>
            <motion.div className="tier-headline"
              initial={reduce?false:{opacity:0,y:6}} animate={{opacity:1,y:0}} transition={{delay:0.65,duration:0.4}}>
              {tier.headline}
            </motion.div>
            {tier.timing&&<motion.div className="timing"
              initial={reduce?false:{opacity:0}} animate={{opacity:1}} transition={{delay:0.78,duration:0.4}}>
              Optimization window · {tier.timing}</motion.div>}
          </div>

          <div style={{marginBottom:20}}>
            <button className={`copy-btn ${copied?"copied":""}`} onClick={handleCopy}>
              {copied?"✓ Copied to clipboard":"📋 Copy Results to Clipboard"}
            </button>
            {copyFallback&&(
              <div>
                <div style={{fontSize:11,color:"var(--k4)",marginBottom:4}}>Select all and copy manually:</div>
                <textarea className="copy-fallback" rows={6} readOnly value={copyText} onClick={e=>e.target.select()}/>
              </div>
            )}
          </div>

          {ciFlags.length>0&&(
            <div className="alert al-red" style={{marginBottom:20}}>
              <div className="al-title" style={{color:"var(--r)"}}>Surgical Risk Red Flags — Identified During Scoring</div>
              {ciFlags.map((c,i)=><div key={i} className="al-body" style={{color:"var(--r)",marginBottom:2}}>• {c.field} — {c.label}</div>)}
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
            {recs.map((r,i)=><RecCard key={i} rec={r} index={i} reduce={reduce}/>)}
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

          {isSupabaseConfigured && !user && (
            <div className="alert al-dark" style={{marginBottom:12}}>
              <div className="al-title" style={{color:"var(--k)"}}>Sign in to save</div>
              <div className="al-body">Create an account to save this assessment to your profile and access it from any device. <button onClick={()=>openAuth("signup")} style={{background:"none",border:"none",color:"var(--k)",fontWeight:600,textDecoration:"underline",textUnderlineOffset:"3px",cursor:"pointer",fontFamily:"var(--sans)",fontSize:"inherit",padding:0}}>Create account →</button></div>
            </div>
          )}
          <button className="btn-s" style={{width:"100%",marginBottom:8}} onClick={resetAll}>New Assessment</button>
          <div className="footnote">Research & educational use only · Not a substitute for clinical judgment<br/><strong style={{color:"#b0bec5"}}>Beta v1.1</strong> · Fuenmayor PJ, MD · FSPS 2025</div>
        </div>
      )}
    </div>
  );

  const renderRecords=()=>(
    <div>
      <button className="back-link" onClick={()=>setScreen("home")}>← Home</button>
      <div className="records-header">
        <div>
          <div className="display" style={{fontSize:24,marginBottom:2}}>Patient Records</div>
          <div className="records-count">{cases.length} record{cases.length!==1?"s":""} · persistent · no PHI</div>
        </div>
        {cases.length>0&&<button className="export-btn" onClick={exportCSV}>Export CSV</button>}
      </div>

      {cases.length===0&&(
        <div className="empty-state">
          <div className="empty-icon">📋</div>
          <div className="empty-text">No records yet</div>
          <div className="empty-sub">Complete a patient assessment to see it here</div>
        </div>
      )}

      {grouped.map(([sid, sCases])=>(
        <div key={sid} className="patient-group">
          <div className="patient-group-header">
            <span className="patient-group-id">{sid}</span>
            <span className="patient-group-hosp">{sCases[0]?.hospital}</span>
          </div>
          {sCases.map((c,i)=>(
            <div key={i} className="record-item" onClick={()=>{setSelCase(c);setScreen("detail");}}>
              <div style={{display:"flex",alignItems:"center",gap:8,flex:1}}>
                <span className="type-icon">{TYPE_ICONS[c.assessmentType]||"✦"}</span>
                <div>
                  <div className="record-type">{TYPE_LABELS[c.assessmentType]||"New Patient"}</div>
                  <div className="record-date">{c.enrollmentDate}</div>
                </div>
              </div>
              <div className="record-right">
                <span className="record-score">{c.score}</span>
                <TierChip tierId={c.tierId}/>
              </div>
            </div>
          ))}
        </div>
      ))}
    </div>
  );

  const renderDetail=()=>{
    if(!selCase) return null;
    const t=TIERS.find(t=>t.id===selCase.tierId)||TIERS[0];
    const d=selCase.domainScores||{};
    const detailRecs=buildRecs(selCase.answers||{},selCase.tierId);
    const typeLabel=TYPE_LABELS[selCase.assessmentType]||"New Patient";
    return(
      <div>
        <button className="back-link" onClick={()=>setScreen("records")}>← Records</button>
        <div className="eyebrow">{selCase.hospital}</div>
        <div className="display" style={{marginBottom:2}}>{selCase.studyId}</div>
        <div className="caption" style={{marginBottom:4}}>{typeLabel} · {selCase.enrollmentDate}</div>
        <div style={{marginBottom:20}}/> 
        <div className="score-wrap">
          <div className="score-big"><AnimatedNumber value={selCase.score} reduce={reduce}/></div>
          <div className="score-denom">/ 30 pts</div>
          <div className="tier-lbl">{t.label}</div>
          <div className="tier-headline">{t.headline}</div>
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

  const renderSettings=()=>(
    <div>
      <button className="back-link" onClick={()=>setScreen("home")}>← Home</button>
      <div className="eyebrow">Configuration</div>
      <div className="display" style={{marginBottom:4,fontSize:24}}>Settings</div>
      <div className="rule"/>
      <div style={{marginBottom:24}}>
        <div className="settings-label">Make.com Webhook URL</div>
        <div className="alert al-neutral" style={{marginBottom:12}}>
          <div className="al-body">Paste your Make.com webhook URL here to automatically log Study ID + hospital + date to your OneDrive Excel file when a new patient is enrolled. No PHI is transmitted.</div>
        </div>
        <input className="settings-input" type="url" placeholder="https://hook.eu1.make.com/…"
          value={webhookInput} onChange={e=>setWebhookInput(e.target.value)}/>
        <button className="btn-p" disabled={savingWh} onClick={saveWebhook}>
          {savingWh?"Saving…":"Save Webhook URL"}
        </button>
        {webhookUrl&&<div className="wh-status wh-ok">✓ Webhook configured — active on next new patient enrollment</div>}
      </div>
      <div className="rule"/>
      <div style={{marginBottom:24}}>
        <div className="settings-label">About</div>
        <div className="settings-note">
          F2F Score — Pressure Injury Module v1.1<br/>
          Fuenmayor PJ, MD · Larkin Community Hospital · Miami<br/>
          FSPS Annual Meeting · December 2025<br/><br/>
          IRB approved: Larkin Community Hospital, Palmetto General Hospital, Delray Medical Center<br/><br/>
          Data stored locally via localStorage — no PHI retained. Data persists across sessions on this device.
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

  const GoogleG=()=>(
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.71-1.57 2.68-3.89 2.68-6.62z"/>
      <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.81.54-1.85.86-3.04.86-2.34 0-4.32-1.58-5.03-3.71H.96v2.33A9 9 0 0 0 9 18z"/>
      <path fill="#FBBC05" d="M3.96 10.71A5.41 5.41 0 0 1 3.68 9c0-.59.1-1.17.29-1.71V4.96H.96A9 9 0 0 0 0 9c0 1.45.35 2.82.96 4.04l3-2.33z"/>
      <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.59C13.46.89 11.43 0 9 0A9 9 0 0 0 .96 4.96l3 2.33C4.68 5.16 6.66 3.58 9 3.58z"/>
    </svg>
  );

  const renderAuth=()=>{
    const landing = !user && !guest;
    const fade=(d=0)=> reduce
      ? {}
      : {initial:{opacity:0,y:14},animate:{opacity:1,y:0},transition:{duration:0.5,delay:d,ease:[0.22,0.61,0.36,1]}};
    if(!isSupabaseConfigured){
      return (
        <div>
          <button className="back-link" onClick={()=>setScreen("home")}>← Back</button>
          <div className="alert al-red"><div className="al-body" style={{color:"var(--r)"}}>Sign-in isn't configured yet — Supabase keys are missing.</div></div>
        </div>
      );
    }
    return (
      <div className="auth-screen">
        <motion.div className="auth-hero" {...fade(0)}>
          <div className="auth-brand">Fitness-to-Flap</div>
          <div className="auth-tagline">Pre-operative risk stratification for flap reconstruction</div>
        </motion.div>

        <AnimatePresence mode="wait" initial={false}>
          <motion.div key={authMode==="otp"?"otp":"form"}
            initial={reduce?{opacity:0}:{opacity:0,y:10}}
            animate={{opacity:1,y:0}}
            exit={reduce?{opacity:0}:{opacity:0,y:-10}}
            transition={{duration:reduce?0.12:0.26,ease:[0.22,0.61,0.36,1]}}>
            {authMode==="otp" ? (
              <div>
                <div className="auth-title" style={{fontSize:26}}>Check your email</div>
                <div className="auth-sub">{authNotice||`We emailed a 6-digit code to ${authEmail}.`}</div>
                <input className="otp-input" inputMode="numeric" autoComplete="one-time-code" maxLength={6}
                  placeholder="------" value={authCode}
                  onChange={e=>setAuthCode(e.target.value.replace(/\D/g,"").slice(0,6))}
                  onKeyDown={e=>{if(e.key==="Enter"&&authCode.length===6)handleVerifyOtp();}}/>
                {authError&&<div className="alert al-red" style={{marginTop:12}}><div className="al-body" style={{color:"var(--r)"}}>{authError}</div></div>}
                <button className="btn-p" style={{marginTop:14}} disabled={authLoading||authCode.length<6} onClick={handleVerifyOtp}>
                  {authLoading?"Verifying…":"Verify & Continue →"}
                </button>
                <div className="auth-toggle">
                  Didn't get it? <button onClick={handleResendCode}>Resend code</button>
                  {" · "}<button onClick={()=>{setAuthMode("signup");setAuthError("");setAuthNotice("");}}>Different email</button>
                </div>
              </div>
            ) : (
              <div>
                <button className="google-btn" onClick={handleGoogle}><GoogleG/> Continue with Google</button>
                <div className="auth-divider">or {authMode==="signup"?"sign up":"sign in"} with email</div>
                {authMode==="signup"&&(
                  <div className="auth-field">
                    <label className="auth-label">Full name</label>
                    <input className="auth-input" type="text" autoComplete="name" placeholder="Dr. Jane Smith"
                      value={authName} onChange={e=>setAuthName(e.target.value)}/>
                  </div>
                )}
                <div className="auth-field">
                  <label className="auth-label">Email</label>
                  <input className="auth-input" type="email" autoComplete="email" placeholder="you@hospital.org"
                    value={authEmail} onChange={e=>setAuthEmail(e.target.value)}/>
                </div>
                <div className="auth-field">
                  <label className="auth-label">Password</label>
                  <input className="auth-input" type="password" autoComplete={authMode==="signup"?"new-password":"current-password"}
                    placeholder="••••••••" value={authPassword} onChange={e=>setAuthPassword(e.target.value)}
                    onKeyDown={e=>{if(e.key==="Enter")handleEmailAuth();}}/>
                </div>
                {authError&&<div className="alert al-red" style={{marginTop:4,marginBottom:12}}><div className="al-body" style={{color:"var(--r)"}}>{authError}</div></div>}
                <button className="btn-p"
                  disabled={authLoading||!authEmail||!authPassword||(authMode==="signup"&&!authName)}
                  onClick={handleEmailAuth}>
                  {authLoading?"Please wait…":authMode==="signup"?"Create Account →":"Sign In →"}
                </button>
                <div className="auth-toggle">
                  {authMode==="signup"?"Already have an account? ":"New here? "}
                  <button onClick={()=>{setAuthMode(authMode==="signup"?"signin":"signup");setAuthError("");}}>
                    {authMode==="signup"?"Sign in":"Create one"}
                  </button>
                </div>
              </div>
            )}
          </motion.div>
        </AnimatePresence>

        <motion.div className="auth-foot" {...fade(0.22)}>
          {landing
            ? <button className="auth-guest" onClick={continueAsGuest}>Continue as guest →</button>
            : <button className="back-link" style={{margin:0,justifyContent:"center"}} onClick={()=>setScreen("home")}>← Back</button>}
          <div className="auth-disclaimer">For research &amp; educational use only · Not a substitute for clinical judgment</div>
        </motion.div>
      </div>
    );
  };

  const renderProfile=()=>{
    if(!user) return(
      <div>
        <button className="back-link" onClick={()=>setScreen("home")}>← Home</button>
        <div className="empty-state"><div className="empty-text">Not signed in</div></div>
        <button className="btn-p" onClick={()=>openAuth("signin")}>Sign In</button>
      </div>
    );
    return(
      <div>
        <button className="back-link" onClick={()=>setScreen("home")}>← Home</button>
        <div className="eyebrow">Account</div>
        <div className="display" style={{marginBottom:16,fontSize:24}}>Profile</div>
        <div className="profile-card">
          <div className="profile-avatar">{userInitial}</div>
          <div>
            <div className="profile-name">{userName}</div>
            <div className="profile-email">{user.email}</div>
          </div>
        </div>
        <div style={{marginBottom:20}}>
          <div className="profile-stat"><span>Saved assessments</span><span className="profile-stat-val">{cases.length}</span></div>
          <div className="profile-stat"><span>Sign-in method</span><span className="profile-stat-val">{user.app_metadata?.provider||"email"}</span></div>
        </div>
        <button className="btn-s" style={{width:"100%",marginBottom:8}} onClick={()=>{refreshCases();setScreen("records");}}>View My Assessments</button>
        <button className="btn-s" style={{width:"100%"}} onClick={handleSignOut}>Sign Out</button>
      </div>
    );
  };

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
            {screen==="wizard"&&wizStep<6
              ? <div className="hdr-step">{wizStep} / {TOTAL_WIZ-1}</div>
              : (!showLanding && !booting && isSupabaseConfigured && authReady && (user
                  ? <button className="hdr-acct" onClick={()=>setScreen("profile")} aria-label="Account">{userInitial}</button>
                  : <button className="hdr-acct-link" onClick={()=>openAuth("signin")}>Sign in</button>))}
          </div>
          {showProg&&!showLanding&&<div className="prog-track"><div className="prog-fill" style={{width:`${pct}%`}}/></div>}
        </header>
        <main className="main">
          {booting ? (
            <div className="boot"><div className="boot-mark">F2F</div></div>
          ) : (
            <AnimatePresence mode="wait" initial={false}>
              {showLanding ? (
                <motion.div key="landing"
                  initial={reduce?{opacity:0}:{opacity:0,y:10}} animate={{opacity:1,y:0}} exit={{opacity:0}}
                  transition={{duration:reduce?0.15:0.35,ease:[0.22,0.61,0.36,1]}}>
                  {renderAuth()}
                </motion.div>
              ) : (
                <motion.div
                  key={screen==="wizard"?`wizard-${wizStep}`:screen}
                  initial={reduce?{opacity:0}:{opacity:0,y:10}}
                  animate={{opacity:1,y:0}}
                  exit={reduce?{opacity:0}:{opacity:0,y:-8}}
                  transition={{duration:reduce?0.15:0.3,ease:[0.22,0.61,0.36,1]}}>
                  {screen==="home"       && renderHome()}
                  {screen==="intake"     && renderIntake()}
                  {screen==="id_confirm" && renderIdConfirm()}
                  {screen==="wizard"     && renderWizard()}
                  {screen==="records"    && renderRecords()}
                  {screen==="detail"     && renderDetail()}
                  {screen==="settings"   && renderSettings()}
                  {screen==="about"      && renderAbout()}
                  {screen==="auth"       && renderAuth()}
                  {screen==="profile"    && renderProfile()}
                </motion.div>
              )}
            </AnimatePresence>
          )}
        </main>
      </div>
    </>
  );
}
