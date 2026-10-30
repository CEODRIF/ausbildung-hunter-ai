/**
 * AUTO BEWERB — deterministic tailored-CV → PDF renderer (pdf-lib).
 *
 * The tailored CVs are stored as structured CvDocument JSON (user-reviewed).
 * This module renders that SAME document to a professional German
 * Lebenslauf PDF: A4 on pure white, Helvetica, black/dark-grey text with a
 * subtle brand-purple accent, a name/title header with the candidate's
 * photograph (when available) at the standard top-right position (aspect
 * ratio preserved, consistent sizing, never stretched), clean section
 * hierarchy with rules, right-aligned date ranges that can never overlap
 * the entry lead line, hanging-indent bullets, and multi-page continuation
 * with a running header.
 *
 * It is the CV counterpart of the existing letter renderer
 * (src/lib/bew-letter-pdf.ts): zero external services, zero cost, and the
 * ONLY output the email send path and the A4 document preview ever use —
 * so the preview and the exported PDF are byte-identical by construction.
 * Nothing is invented here — empty sections are simply not rendered.
 *
 * Photo contract: `options.photoDataUrl` (resolved, ownership-checked data
 * URL from the platform — the server ALWAYS passes this for generated CVs)
 * wins; otherwise a LEGACY inline data URL in `personal.photo` (CV Builder
 * documents) is used. The `abphoto:` reference token in `personal.photo`
 * is NEVER interpreted here directly — it is the server's job to resolve
 * it (renderer stays deterministic + owner-agnostic).
 */
import { PDFDocument, PDFFont, PDFImage, StandardFonts, rgb, type Color } from "pdf-lib";
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
/** Usable height of one page (for "fits on one page" decisions). */
const PAGE_CONTENT_HEIGHT = A4_HEIGHT - MARGIN_TOP - MARGIN_BOTTOM;

const INK: Color = rgb(0.11, 0.13, 0.18);
const MUTED: Color = rgb(0.42, 0.45, 0.52);
const RULE: Color = rgb(0.78, 0.8, 0.85);
/** Subtle brand purple (#6D5DF6) — accent only, text stays black/grey. */
const ACCENT: Color = rgb(109 / 255, 93 / 255, 246 / 255);

/* ------------------------------------------------------------------ */
/* Layout helpers (greedy word wrap; long-word breaker)                */
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
  if (maxWidth <= 0) maxWidth = 10;
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

export interface GenerateCvPdfOptions {
  /**
   * The candidate's photograph as a data URL (PNG/JPEG), already resolved
   * and ownership-verified by the caller (export route / send preparation).
   * `null` = render without a photo. Legacy documents without this option
   * fall back to an inline data URL stored in `personal.photo`.
   */
  photoDataUrl?: string | null;
}

/** Render the given (already user-reviewed) CV document to A4 PDF bytes. */
export async function generateCvPdf(cv: CvDocument, options: GenerateCvPdfOptions = {}): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle("Lebenslauf");
  if (cv.personal.fullName) doc.setAuthor(cv.personal.fullName);

  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const oblique = await doc.embedFont(StandardFonts.HelveticaOblique);

  // Optional candidate photograph — standard German-CV position, top-right,
  // aspect preserved inside a FIXED box (consistent sizing across all
  // companies, never stretched). An unreadable image never fails the
  // render; the CV simply appears without it.
  const PHOTO_W = 64; // ≈22.6 mm wide
  const PHOTO_H_MAX = 90; // ≈31.8 mm tall
  const photoSource =
    options.photoDataUrl ??
    (cv.personal.photo?.startsWith("data:image/") ? cv.personal.photo : null);
  let photo: { img: PDFImage; w: number; h: number } | null = null;
  const photoMatch = (photoSource ?? "").match(/^data:image\/(png|jpe?g);base64,([A-Za-z0-9+/=]+)$/);
  if (photoMatch) {
    try {
      const bytes = Uint8Array.from(atob(photoMatch[2]), (c) => c.charCodeAt(0));
      const img = photoMatch[1] === "png" ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
      photo = { img, w: img.width, h: img.height };
    } catch {
      photo = null;
    }
  }
  let photoW = 0;
  let photoH = 0;
  if (photo) {
    photoW = PHOTO_W;
    photoH = (photoW * photo.h) / photo.w;
    if (photoH > PHOTO_H_MAX) {
      photoH = PHOTO_H_MAX;
      photoW = (photoH * photo.w) / photo.h;
    }
  }

  let page = doc.addPage([A4_WIDTH, A4_HEIGHT]);
  const TOP = A4_HEIGHT - MARGIN_TOP;
  let y = TOP;
  /** Running header on continuation pages (name + document type + rule). */
  const runningHeader = () => {
    const label = cv.personal.fullName ? `${cv.personal.fullName} — Lebenslauf` : "Lebenslauf";
    page.drawText(label, { x: MARGIN_X, y: y - 10, size: 9, font: regular, color: MUTED });
    page.drawLine({
      start: { x: MARGIN_X, y: y - 16 },
      end: { x: RIGHT, y: y - 16 },
      thickness: 0.8,
      color: RULE,
    });
    y -= 24;
  };
  const newPage = () => {
    page = doc.addPage([A4_WIDTH, A4_HEIGHT]);
    y = TOP;
    runningHeader();
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
    if (!text) return;
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

  // ---- header: name / title / contact block (photo-aware) -----------------
  const headerWidth = photo ? CONTENT_WIDTH - photoW - 24 : CONTENT_WIDTH;
  const nameLines = cv.personal.fullName
    ? wrapLine(bold, cv.personal.fullName.toUpperCase(), 20, headerWidth)
    : [];
  const titleLines = cv.personal.professionalTitle
    ? wrapLine(regular, cv.personal.professionalTitle, 11.5, headerWidth)
    : [];
  const contact = [
    cv.personal.email,
    cv.personal.phone,
    cv.personal.location,
    cv.personal.linkedin,
    cv.personal.website,
  ]
    .filter(Boolean)
    .join("   ·   ");
  const contactLines = contact ? wrapLine(regular, contact, 9.5, headerWidth) : [];
  const facts = [
    cv.personal.dateOfBirth ? `Geburtsdatum: ${cv.personal.dateOfBirth}` : "",
    cv.personal.nationality ? `Staatsangehörigkeit: ${cv.personal.nationality}` : "",
    cv.personal.availability ? `Verfügbar: ${cv.personal.availability}` : "",
  ]
    .filter(Boolean)
    .join("   ·   ");
  const factLines = facts ? wrapLine(regular, facts, 9.5, headerWidth) : [];

  const headerTextHeight =
    nameLines.length * 24 +
    (titleLines.length ? titleLines.length * 15.5 + 5 : 0) +
    (contactLines.length ? contactLines.length * 13.5 + 3 : 0) +
    (factLines.length ? factLines.length * 13.5 : 0);

  for (const line of nameLines) draw(line, bold, 20, { spaceAfter: 0 });
  for (const line of titleLines) draw(line, regular, 11.5, { color: ACCENT, spaceAfter: 0 });
  if (titleLines.length && (contactLines.length || factLines.length)) y -= 5;
  for (const line of contactLines) draw(line, regular, 9.5, { color: MUTED });
  if (contactLines.length && factLines.length) y -= 3;
  for (const line of factLines) draw(line, regular, 9.5, { color: MUTED });

  if (photo) {
    page.drawImage(photo.img, { x: RIGHT - photoW, y: TOP - photoH, width: photoW, height: photoH });
  }

  // Accent rule under the header — placed BELOW the taller of the text
  // block and the photo (never crossing the photograph).
  const headerBottom = TOP - Math.max(headerTextHeight, photoH) - 10;
  ensure(18);
  y = Math.min(y, headerBottom);
  page.drawLine({
    start: { x: MARGIN_X, y: y + 8 },
    end: { x: RIGHT, y: y + 8 },
    thickness: 1.4,
    color: ACCENT,
  });
  y -= 14;

  // ---- section chrome ------------------------------------------------------
  const sectionTitle = (title: string) => {
    y -= 8;
    // Reserve title + rule + at least one content line (no orphan titles).
    ensure(44);
    const width = bold.widthOfTextAtSize(title.toUpperCase(), 11);
    page.drawText(title.toUpperCase(), { x: MARGIN_X, y, size: 11, font: bold, color: INK });
    y -= 11 + 4;
    page.drawLine({
      start: { x: MARGIN_X, y: y - 1 },
      end: { x: RIGHT, y: y - 1 },
      thickness: 0.8,
      color: RULE,
    });
    y -= 8;
  };

  /** One entry: bold lead line, right-aligned date range (overlap-safe),
   *  muted sub line, hanging-indent bullets. */
  const entry = (lead: string, sub: string, date: string, bullets: string[]) => {
    const bulletLines = bullets
      .filter((b) => b.trim())
      .flatMap((b) => wrapLine(regular, b, 10, CONTENT_WIDTH - 14));
    // The date sits on the FIRST lead line, right-aligned — reserve its
    // width when wrapping so the two can never overlap (a long lead wraps
    // earlier instead of colliding).
    const dateW = date ? regular.widthOfTextAtSize(date, 10) : 0;
    const leadLines = wrapLine(bold, lead, 10.5, dateW ? CONTENT_WIDTH - dateW - 20 : CONTENT_WIDTH);
    const subLines = sub ? wrapLine(regular, sub, 10, CONTENT_WIDTH) : [];
    const blockHeight =
      leadLines.length * 14.5 + subLines.length * 13.5 + bulletLines.length * 13.5 + 6;
    // Entries taller than a full page flow line-by-line (each line pages
    // itself); shorter entries stay atomic.
    if (blockHeight <= PAGE_CONTENT_HEIGHT) ensure(blockHeight);

    draw(leadLines[0] ?? "", bold, 10.5);
    if (date) draw(date, regular, 10, { right: true, color: MUTED });
    for (const extra of leadLines.slice(1)) draw(extra, bold, 10.5);
    for (const line of subLines) draw(line, regular, 10, { color: MUTED });
    for (const line of bulletLines) {
      ensure(13.5);
      page.drawText("–", { x: MARGIN_X + 2, y, size: 10, font: regular, color: INK });
      page.drawText(line, { x: MARGIN_X + 14, y, size: 10, font: regular, color: INK });
      y -= 13.5;
    }
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
    drawWrapped(skills.join("   ·   "), regular, 10, { lineGap: 1 });
  }

  // ---- Sprachen --------------------------------------------------------------------
  const langs = cv.languages.filter(languageVisible);
  if (langs.length) {
    sectionTitle("Sprachen");
    drawWrapped(
      langs.map((l) => [l.language, l.level].filter(Boolean).join(" – ")).join("   ·   "),
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
    drawWrapped(interests.join("   ·   "), oblique, 10, { lineGap: 1 });
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
