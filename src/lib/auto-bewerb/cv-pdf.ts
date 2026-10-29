/**
 * AUTO BEWERB — deterministic tailored-CV → PDF renderer (pdf-lib).
 *
 * The tailored CVs are stored as structured CvDocument JSON (user-reviewed,
 * fact-guarded). This module renders that SAME document to a professional
 * German Lebenslauf PDF: A4, Helvetica, section rules, right-aligned date
 * ranges, bullet responsibilities, multi-page continuation.
 *
 * It is the CV counterpart of the existing letter renderer
 * (src/lib/bew-letter-pdf.ts): zero external services, zero cost, and the
 * only output the email send path ever attaches. Nothing is invented here —
 * empty sections are simply not rendered.
 */
import { PDFDocument, PDFFont, StandardFonts, rgb, type Color } from "pdf-lib";
import {
  certificateVisible,
  educationVisible,
  experienceVisible,
  languageVisible,
  projectVisible,
  type CvDocument,
} from "@/lib/templates/cv";

const A4_WIDTH = 595.28;
const A4_HEIGHT = 841.89;
const MARGIN_X = 65;
const MARGIN_TOP = 64;
const MARGIN_BOTTOM = 56;
const CONTENT_WIDTH = A4_WIDTH - 2 * MARGIN_X;
const RIGHT = A4_WIDTH - MARGIN_X;

const INK: Color = rgb(0.11, 0.13, 0.18);
const MUTED: Color = rgb(0.42, 0.45, 0.52);
const RULE: Color = rgb(0.75, 0.78, 0.84);
const ACCENT: Color = rgb(0.13, 0.35, 0.6);

/* ------------------------------------------------------------------ */
/* Layout helpers (same greedy-wrap approach as bew-letter-pdf.ts)      */
/* ------------------------------------------------------------------ */

function breakLongWord(font: PDFFont, word: string, size: number, maxWidth: number): string[] {
  const out: string[] = [];
  let current = "";
  for (const ch of word) {
    if (current && font.widthOfTextAtSize(current + ch, size) > maxWidth) {
      out.push(current);
      current = ch;
    } else {
      current += ch;
    }
  }
  if (current) out.push(current);
  return out;
}

function wrapLine(font: PDFFont, text: string, size: number, maxWidth: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (font.widthOfTextAtSize(word, size) > maxWidth) {
      if (current) {
        lines.push(current);
        current = "";
      }
      const pieces = breakLongWord(font, word, size, maxWidth);
      lines.push(...pieces.slice(0, -1));
      current = pieces[pieces.length - 1] ?? "";
      continue;
    }
    const trial = current ? `${current} ${word}` : word;
    if (font.widthOfTextAtSize(trial, size) <= maxWidth) {
      current = trial;
    } else {
      if (current) lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

/* ------------------------------------------------------------------ */
/* Renderer                                                            */
/* ------------------------------------------------------------------ */

/** Render the given (already user-reviewed) CV document to A4 PDF bytes. */
export async function generateCvPdf(cv: CvDocument): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle("Lebenslauf");
  if (cv.personal.fullName) doc.setAuthor(cv.personal.fullName);

  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const oblique = await doc.embedFont(StandardFonts.HelveticaOblique);

  let page = doc.addPage([A4_WIDTH, A4_HEIGHT]);
  let y = A4_HEIGHT - MARGIN_TOP;
  const newPage = () => {
    page = doc.addPage([A4_WIDTH, A4_HEIGHT]);
    y = A4_HEIGHT - MARGIN_TOP;
  };
  const ensure = (height: number) => {
    if (y - height < MARGIN_BOTTOM) newPage();
  };

  const draw = (
    text: string,
    font: PDFFont,
    size: number,
    opts: { x?: number; right?: boolean; color?: Color; spaceAfter?: number } = {},
  ) => {
    ensure(size + 4);
    const width = font.widthOfTextAtSize(text, size);
    page.drawText(text, {
      x: opts.x ?? (opts.right ? RIGHT - width : MARGIN_X),
      y,
      size,
      font,
      color: opts.color ?? INK,
    });
    y -= size + 4;
    if (opts.spaceAfter) y -= opts.spaceAfter;
  };

  const drawWrapped = (
    text: string,
    font: PDFFont,
    size: number,
    opts: { color?: Color; indent?: number; lineGap?: number } = {},
  ) => {
    for (const line of wrapLine(font, text, size, CONTENT_WIDTH - (opts.indent ?? 0))) {
      draw(line, font, size, {
        x: MARGIN_X + (opts.indent ?? 0),
        color: opts.color,
        spaceAfter: opts.lineGap ?? 0,
      });
    }
  };

  // ---- header: name / title / contact line -------------------------------
  if (cv.personal.fullName) draw(cv.personal.fullName.toUpperCase(), bold, 19, { spaceAfter: 3 });
  if (cv.personal.professionalTitle)
    draw(cv.personal.professionalTitle, regular, 11.5, { color: ACCENT, spaceAfter: 6 });
  const contact = [
    cv.personal.email,
    cv.personal.phone,
    cv.personal.location,
    cv.personal.linkedin,
    cv.personal.website,
  ].filter(Boolean);
  for (const line of wrapLine(regular, contact.join("  ·  "), 9.5, CONTENT_WIDTH)) {
    draw(line, regular, 9.5, { color: MUTED });
  }
  // Optional personal facts, one line (only what the user provided).
  const facts = [
    cv.personal.dateOfBirth ? `Geburtsdatum: ${cv.personal.dateOfBirth}` : "",
    cv.personal.nationality ? `Staatsangehörigkeit: ${cv.personal.nationality}` : "",
    cv.personal.availability ? `Verfügbar: ${cv.personal.availability}` : "",
  ].filter(Boolean);
  if (facts.length) draw(facts.join("  ·  "), regular, 9.5, { color: MUTED });
  y -= 10;
  ensure(14);
  page.drawLine({
    start: { x: MARGIN_X, y: y + 6 },
    end: { x: RIGHT, y: y + 6 },
    thickness: 1,
    color: RULE,
  });
  y -= 16;

  // ---- section chrome ------------------------------------------------------
  const sectionTitle = (title: string) => {
    y -= 8;
    ensure(26);
    draw(title.toUpperCase(), bold, 11, { color: INK, spaceAfter: 6 });
  };

  /** One entry: bold lead line, optional right-aligned date range, bullets. */
  const entry = (
    lead: string,
    sub: string,
    date: string,
    bullets: string[],
  ) => {
    const leadLines = wrapLine(bold, lead, 10.5, CONTENT_WIDTH);
    const subLines = sub ? wrapLine(regular, sub, 10, CONTENT_WIDTH) : [];
    const dateLines = date ? wrapLine(regular, date, 10, CONTENT_WIDTH) : [];
    const bulletLines = bullets
      .filter((b) => b.trim())
      .flatMap((b) => wrapLine(regular, b, 10, CONTENT_WIDTH - 12));
    const blockHeight =
      leadLines.length * 14.5 +
      subLines.length * 13.5 +
      bulletLines.length * 13.5 +
      6;
    ensure(blockHeight);
    // Lead + date (date right-aligned on the FIRST lead line only — it wraps
    // below if the lead is long, never overlapping).
    draw(leadLines[0], bold, 10.5, { spaceAfter: 0 });
    if (dateLines.length)
      draw(dateLines[0], regular, 10, { right: true, color: MUTED, spaceAfter: 0 });
    if (dateLines.length > 1) draw(dateLines.slice(1).join(" "), regular, 10, { right: true, color: MUTED });
    for (const extra of leadLines.slice(1)) draw(extra, bold, 10.5);
    for (const line of subLines) draw(line, regular, 10, { color: MUTED });
    for (const line of bulletLines) draw(`–  ${line}`, regular, 10, { color: INK });
    y -= 5;
  };

  const dateRange = (start: string, end: string, isCurrent?: boolean): string => {
    const e = isCurrent ? (end || "heute") : end;
    if (!start && !e) return "";
    return [start, e].filter(Boolean).join(" – ");
  };

  // ---- Kurzprofil -----------------------------------------------------------
  if (cv.summary.trim()) {
    sectionTitle("Profil");
    drawWrapped(cv.summary.trim(), regular, 10, { lineGap: 1 });
  }

  // ---- Berufserfahrung --------------------------------------------------------
  const exp = cv.experience.filter(experienceVisible);
  if (exp.length) {
    sectionTitle("Berufserfahrung & Praktika");
    for (const x of exp) {
      entry(
        [x.jobTitle, x.company].filter(Boolean).join(" — ") || "Erfahrung",
        x.location,
        dateRange(x.start, x.end, x.isCurrent),
        [...x.responsibilities, ...x.achievements],
      );
    }
  }

  // ---- Ausbildung / Bildung ----------------------------------------------------
  const edu = cv.education.filter(educationVisible);
  if (edu.length) {
    sectionTitle("Ausbildung & Bildung");
    for (const e of edu) {
      entry(
        [e.degree, e.institution].filter(Boolean).join(" — ") || "Bildung",
        e.location,
        dateRange(e.start, e.end),
        e.description ? [e.description] : [],
      );
    }
  }

  // ---- Kenntnisse & Fähigkeiten ---------------------------------------------------
  const skills = cv.skills.map((s) => s.trim()).filter(Boolean);
  if (skills.length) {
    sectionTitle("Kenntnisse & Fähigkeiten");
    drawWrapped(skills.join("  ·  "), regular, 10, { lineGap: 1 });
  }

  // ---- Sprachen --------------------------------------------------------------------
  const langs = cv.languages.filter(languageVisible);
  if (langs.length) {
    sectionTitle("Sprachen");
    drawWrapped(
      langs.map((l) => [l.language, l.level].filter(Boolean).join(" – ")).join("  ·  "),
      regular,
      10,
      { lineGap: 1 },
    );
  }

  // ---- Zertifikate & Qualifikationen ---------------------------------------------------
  const certs = cv.certificates.filter(certificateVisible);
  if (certs.length) {
    sectionTitle("Zertifikate & Qualifikationen");
    for (const c of certs) {
      entry([c.name, c.issuer].filter(Boolean).join(" — ") || "Zertifikat", "", c.date, c.description ? [c.description] : []);
    }
  }

  // ---- Projekte ------------------------------------------------------------------------
  const projects = cv.projects.filter(projectVisible);
  if (projects.length) {
    sectionTitle("Projekte");
    for (const p of projects) {
      entry(
        [p.name, p.role ? `(${p.role})` : ""].filter(Boolean).join(" "),
        p.technologies,
        p.date,
        p.description ? [p.description] : [],
      );
    }
  }

  // ---- Interessen ------------------------------------------------------------------------
  const interests = cv.interests.map((i) => i.trim()).filter(Boolean);
  if (interests.length) {
    sectionTitle("Interessen");
    drawWrapped(interests.join("  ·  "), oblique, 10, { lineGap: 1 });
  }

  return doc.save();
}

/** `Lebenslauf_Mustermann.pdf` — ASCII-safe (MIME header), deterministic. */
export function cvPdfFilename(name: string | null | undefined): string {
  const part = (name ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/ß/g, "ss")
    .replace(/[^A-Za-z0-9._ -]+/g, " ")
    .replace(/\s+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/\.+/g, ".")
    .slice(0, 60)
    .replace(/\.+$/g, "");
  return `Lebenslauf_${part || "Bewerbung"}.pdf`;
}
