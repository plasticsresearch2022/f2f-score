import { useState, useMemo, useEffect } from "react";

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
}
function fetchAllCases(){
  return lsKeys("f2f_case_").map(k=>{try{return JSON.parse(lsGet(k));}catch(e){return null;}})
    .filter(Boolean).sort((a,b)=>new Date(b.savedAt)-new Date(a.savedAt));
}
function persistOutcome(studyId, data){
  lsSet(`f2f_outcome_${studyId}`, JSON.stringify(data));
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
    verdict:"Not a surgical candidate at this time",
    headline:"Prioritize palliative and advanced wound care rather than major flap reconstruction.",
    timing:null,
    bg:"#fee2e2", bar:"#dc2626", ink:"#7f1d1d", accent:"#b91c1c"},
];

function computeScore(answers) {
  let total=0; const ciFlags=[]; const domainScores={};
  for (const domain of DOMAINS) {
    let ds=0;
    for (const f of domain.fields) {
      const val=answers[f.id];
      if(f.type==="toggle"){ ds+=val===true?f.pts:0; }
      else{
        const opt=f.options?.find(o=>o.v===val);
        if(opt){ if(opt.isCI) ciFlags.push({field:f.label,label:opt.ciLabel}); else ds+=opt.pts; }
      }
    }
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

function RecCard({rec,index}){
  const urgent=rec.p===1;
  return(
    <div className="rec-item">
      <div className="rec-meta">
        <span className={`rec-index ${urgent?"urg":""}`}>{String(index+1).padStart(2,"0")}</span>
        {urgent&&<span className="rec-dot"/>}
        <span className={`rec-cat ${urgent?"urg":""}`}>{rec.cat}</span>
      </div>
      <div className="rec-body">{rec.text}</div>
    </div>
  );
}

function TierChip({tierId}){
  const labels={low:"Low",moderate:"Moderate",high:"High",not_ideal:"Not Ideal"};
  return <span className={`tier-chip ${tierId}`}>{labels[tierId]||tierId}</span>;
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
  const tier=getTier(total);
  const recs=useMemo(()=>buildRecs(answers,tier.id),[answers,tier.id]);

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
            savedAt:new Date().toISOString(), answers:{...answers}, score:total,
            tierId:tier.id, tierLabel:tier.label, domainScores:{...domainScores},
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
          <div style={{fontSize:11,fontFamily:"var(--mono)",color:"var(--k4)",marginBottom:20}}>
            Question {fieldStep+1} of {domainPages.length}
          </div>

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
          <div style={{background:tier.bg,borderRadius:14,padding:"28px 22px 24px",marginBottom:20,textAlign:"center",border:`1px solid ${tier.bar}22`}}>
            {/* Score number + denom */}
            <div style={{display:"flex",alignItems:"baseline",justifyContent:"center",gap:6,marginBottom:4}}>
              <span style={{fontFamily:"var(--serif)",fontSize:72,fontStyle:"italic",lineHeight:1,letterSpacing:"-.04em",color:tier.ink}}>{total}</span>
              <span style={{fontFamily:"var(--mono)",fontSize:15,color:tier.accent}}>/ 30</span>
            </div>

            {/* Tier label — large and bold */}
            <div style={{fontSize:38,fontWeight:800,lineHeight:1.05,letterSpacing:"-.02em",color:tier.ink,marginTop:12,marginBottom:6}}>
              {tier.label}
            </div>

            {/* Plain-language verdict — states good or not */}
            <div style={{fontSize:16,fontWeight:700,color:tier.accent,marginBottom:14,lineHeight:1.3}}>
              {tier.verdict}
            </div>

            {/* Primary recommendation — bold, high contrast */}
            <div style={{background:"#fff",borderRadius:10,padding:"14px 16px",marginTop:4}}>
              <div style={{fontSize:9,fontWeight:800,letterSpacing:".14em",textTransform:"uppercase",color:tier.accent,marginBottom:5}}>Recommendation</div>
              <div style={{fontSize:15,fontWeight:600,color:"#111",lineHeight:1.45}}>{tier.headline}</div>
              {tier.timing&&(
                <div style={{marginTop:10,paddingTop:10,borderTop:"1px solid #eee",fontFamily:"var(--mono)",fontSize:12,color:tier.accent,fontWeight:600,letterSpacing:".04em"}}>
                  ⏱ OPTIMIZATION WINDOW · {tier.timing}
                </div>
              )}
            </div>
          </div>

          {!isQuick&&(
            <div className="alert al-green" style={{marginBottom:16}}>
              <div className="al-body" style={{color:"#15803d"}}>✓ Saved to Patient Records as <strong>{studyId}</strong> ({assessLabel}). Persists on this device.</div>
            </div>
          )}

          <div style={{marginBottom:20}}>
            <button className={`copy-btn ${copied?"copied":""}`} onClick={handleCopy}>
              {copied?"✓ Copied to clipboard":"📋 Copy Results to Clipboard"}
            </button>
            {copyFallback&&(
              <div>
                <div style={{fontSize:11,color:"var(--k4)",marginBottom:4}}>Clipboard unavailable — select all and copy manually:</div>
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
                    <div className="b-bar-wrap"><div className="b-bar-fill" style={{width:`${Math.min((ds/d.maxPts)*100,100)}%`}}/></div>
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
                        <div key={i} style={{border:"1px solid var(--r)",borderLeft:"3px solid var(--r)",borderRadius:8,padding:"14px 16px",marginBottom:8,background:"#fff8f8"}}>
                          <div style={{fontSize:12.5,fontWeight:700,color:"var(--r)",marginBottom:6,lineHeight:1.3}}>{r.cat}</div>
                          <div style={{fontSize:13,color:"var(--k2)",lineHeight:1.7}}>{r.text}</div>
                        </div>
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
    const t=TIERS.find(t=>t.id===selCase.tierId)||TIERS[0];
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
            return(<div className="b-row" key={dom.id}><span className="b-name">{dom.label}</span><div className="b-right"><div className="b-bar-wrap"><div className="b-bar-fill" style={{width:`${Math.min((ds/dom.maxPts)*100,100)}%`}}/></div><span className="b-pts">{ds}<span style={{color:"var(--k4)",fontWeight:400}}>/{dom.maxPts}</span></span></div></div>);
          })}
          <div className="b-total" style={{marginTop:12}}><span className="b-total-lbl">Total F2F Score</span><span className="b-total-pts">{selCase.score} pts</span></div>
        </div>
        <div style={{marginBottom:24}}>
          <div style={{fontSize:10,fontWeight:700,letterSpacing:"0.15em",textTransform:"uppercase",color:"var(--k4)",marginBottom:16}}>Patient-Specific Action Plan</div>
          {detailRecs.map((r,i)=><RecCard key={i} rec={r} index={i}/>)}
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
      <div style={{marginBottom:24}}>
        <div className="settings-label">Research Data</div>
        <div className="settings-note" style={{marginBottom:12}}>
          All scored assessments and 30-day outcomes are stored locally on this device. Export the full dataset as a CSV to merge into your master research spreadsheet.
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
          {screen==="home"        && renderHome()}
          {screen==="intake"      && renderIntake()}
          {screen==="id_confirm"  && renderIdConfirm()}
          {screen==="wizard"      && renderWizard()}
          {screen==="records"     && renderRecords()}
          {screen==="detail"      && renderDetail()}
          {screen==="settings"    && renderSettings()}
          {screen==="outcomes"    && renderOutcomes()}
          {screen==="about"       && renderAbout()}
        </main>
      </div>
    </>
  );
}
