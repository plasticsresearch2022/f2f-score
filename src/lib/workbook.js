/* ═══════════════════════════════════════════════
   RESEARCH WORKBOOK EXPORT (.xlsx)

   Writes data into Pedro's actual workbook instead of rebuilding it.
   A CSV loses every part of that file that makes it usable: the
   coloured merged group headers, the green/red conditional format on
   the primary endpoint, the dropdowns, the column widths, and the
   other five sheets (Instructions, Clavien-Dindo Ref, Dashboard,
   F2F Reference, the blank entry form).

   Three columns are left to Excel rather than computed here, because
   they are formulas in his sheet and should stay live:
     D  Age                    DATEDIF(C,F,"Y")     — fills itself once
                                                      DOB is pasted in
     K  Optimization Duration  I-F
     T  PRIMARY ENDPOINT       IF over N:S

   fflate is dynamically imported so it only loads when someone
   actually exports.
═══════════════════════════════════════════════ */

const TEMPLATE_URL = "/F2F-workbook-template.xlsx";
const SHEET = "xl/worksheets/sheet1.xml";
const FIRST_DATA_ROW = 3;

/* Cell style indices lifted from his own data rows, so exported rows are
   visually identical to ones he typed. */
const STYLE = {
  A: 38, B: 39, C: 40, D: 41, E: 41, F: 40, G: 43, H: 38, I: 40, J: 41,
  K: 38, L: 38, M: 38, N: 13, O: 13, P: 13, Q: 13, R: 13, S: 13, T: 14,
  U: 13, V: 13, W: 12, X: 13, Y: 13, Z: 13, AA: 13, AB: 13, AC: 13, AD: 13, AE: 12,
};
const COLS = Object.keys(STYLE);

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/* Excel's epoch is 1899-12-30 (it keeps Lotus's 1900 leap-year bug). */
function serialDate(v) {
  if (!v) return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  return Math.round(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 86400000) + 25569;
}

function cell(col, row, value, kind) {
  const ref = `${col}${row}`;
  const s = ` s="${STYLE[col]}"`;
  if (kind === "formula") return `<c r="${ref}"${s}><f>${esc(value)}</f></c>`;
  if (value === null || value === undefined || value === "") return `<c r="${ref}"${s}/>`;
  if (kind === "number" || kind === "date") return `<c r="${ref}"${s}><v>${value}</v></c>`;
  /* Inline strings avoid touching the shared string table entirely. */
  return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${esc(value)}</t></is></c>`;
}

/**
 * Build the .xlsx as a Blob.
 * @param patients rows from buildResearchRows() — one object per patient
 */
export async function buildWorkbook(patients) {
  const [{ unzipSync, zipSync, strToU8, strFromU8 }, res] = await Promise.all([
    import("fflate"),
    fetch(TEMPLATE_URL),
  ]);
  if (!res.ok) throw new Error(`Could not load the workbook template (${res.status})`);

  const zip = unzipSync(new Uint8Array(await res.arrayBuffer()));
  let sheet = strFromU8(zip[SHEET]);

  const xml = patients.map((p, i) => {
    const r = FIRST_DATA_ROW + i;
    const c = [
      cell("A", r, p.studyId),
      cell("B", r, ""),                                   // Hospital Account # — PHI, from the de-ID log
      cell("C", r, ""),                                   // DOB — PHI, from the de-ID log
      cell("D", r, `DATEDIF(C${r},F${r},"Y")`, "formula"),// self-fills once DOB is pasted
      cell("E", r, ""),                                   // Sex — no field in the app yet
      cell("F", r, serialDate(p.firstDate), "date"),
      cell("G", r, p.firstScore, "number"),
      cell("H", r, p.reassessScore, "number"),
      cell("I", r, serialDate(p.preopDate), "date"),
      cell("J", r, p.preopScore, "number"),
      cell("K", r, `I${r}-F${r}`, "formula"),
      cell("L", r, p.debridements, "number"),
      cell("M", r, p.flapType),
      cell("N", r, p.cfl), cell("O", r, p.pfl), cell("P", r, p.ssi),
      cell("Q", r, p.hem), cell("R", r, p.deh), cell("S", r, p.mort),
      cell("T", r, `IFERROR(IF(COUNTA(N${r}:S${r})=0,"",IF(COUNTIF(N${r}:S${r},"Y")>0,"YES — EVENT","NO event")),"")`, "formula"),
      cell("U", r, p.clavien),
      cell("V", r, p.minorComp), cell("W", r, p.minorDetail),
      cell("X", r, p.readmit30), cell("Y", r, p.reop30),
      cell("Z", r, p.los, "number"), cell("AA", r, p.icu), cell("AB", r, p.recur90),
      cell("AC", r, p.fu30), cell("AD", r, p.fu90), cell("AE", r, p.notes),
    ].join("");
    return `<row r="${r}" spans="1:31" ht="28" x14ac:dyDescent="0.2">${c}</row>`;
  }).join("");

  const lastRow = Math.max(FIRST_DATA_ROW + patients.length - 1, FIRST_DATA_ROW);

  sheet = sheet.replace("</sheetData>", `${xml}</sheetData>`);
  sheet = sheet.replace(/<dimension ref="[^"]*"\/>/, `<dimension ref="A1:AE${lastRow}"/>`);

  /* His ranges stop at row 10-12. Without widening them, every patient past
     the tenth silently loses the endpoint colouring and the dropdowns. */
  sheet = sheet.replace(/sqref="T3:T\d+"/g, `sqref="T3:T${lastRow}"`);
  sheet = sheet.replace(/<formula>LEFT\(T3,3\)/g, `<formula>LEFT(T3,3)`);
  sheet = sheet.replace(/sqref="([^"]+)"/g, (m, refs) =>
    `sqref="${refs.split(/\s+/).map((ref) => ref.replace(/^([A-Z]+)3:([A-Z]+)(\d+)$/, (_, a, b) => `${a}3:${b}${Math.max(lastRow, 100)}`)).join(" ")}"`);

  zip[SHEET] = strToU8(sheet);
  return new Blob([zipSync(zip, { level: 6 })], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
