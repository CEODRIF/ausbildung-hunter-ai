/**
 * AUTO BEWERB — deterministic tailored-CV → PDF renderer (pdf-lib).
 *
 * The tailored CVs are stored as structured CvDocument JSON (user-reviewed).
 * This module renders that SAME document to a professional German
 * Lebenslauf PDF — a clean white A4 document in an elegant serif:
 *
 *   - centered, bold serif name + centered italic professional title
 *   - one balanced contact row (location · email · phone · linkedin) with
 *     small monochrome icons; extra facts (website, Geburtsdatum, …)
 *     appended as plain text
 *   - the candidate's photograph (when available) in the header's
 *     upper-right, aspect preserved, never stretched
 *   - strong uppercase serif section headings with a thin black rule
 *   - experience/education entries: bold title left, italic institution
 *     under it, dates + location right-aligned (overlap-safe)
 *   - skills, certificates and languages as balanced TWO-COLUMN bullets
 *   - proper multi-page flow: consistent margins, no orphan headings,
 *     entry headers kept together, subtle "Seite i von N" page numbers
 *
 * It is the CV counterpart of the existing letter renderer
 * (src/lib/bew-letter-pdf.ts): zero external services, zero cost, and the
 * ONLY output the email send path and the A4 document preview ever use —
 * so the preview and the exported PDF are byte-identical by construction.
 * Nothing is invented here — empty sections are simply not rendered.
 *
 * Fonts: the PDF standard-14 Times family (Times-Roman / -Bold / -Italic).
 * Standard fonts use WinAnsiEncoding — reliable ä ö ü ß support in every
 * PDF viewer (PDFium, Acrobat, Preview) with no binary font files to ship.
 *
 * Photo contract: `options.photoDataUrl` (resolved, ownership-checked data
 * URL from the platform — the server ALWAYS passes this for generated CVs)
 * wins; otherwise a LEGACY inline data URL in `personal.photo` (CV Builder
 * documents) is used. The `abphoto:` reference token in `personal.photo`
 * is NEVER interpreted here directly — it is the server's job to resolve
 * it (renderer stays deterministic + owner-agnostic).
 */
import { PDFDocument, PDFFont, PDFPage, PDFImage, StandardFonts, rgb, type Color } from "pdf-lib";
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
const MARGIN_X = 48; // ≈16.9 mm — generous, consistent on every page
const MARGIN_TOP = 50;
const MARGIN_BOTTOM = 46;
const CONTENT_WIDTH = A4_WIDTH - 2 * MARGIN_X;
const RIGHT = A4_WIDTH - MARGIN_X;
/** Usable height of one page (for "fits on one page" decisions). */
const PAGE_CONTENT_HEIGHT = A4_HEIGHT - MARGIN_TOP - MARGIN_BOTTOM;

const INK: Color = rgb(0.1, 0.11, 0.13); // near-black charcoal
const MUTED: Color = rgb(0.36, 0.39, 0.43); // dates, locations, page numbers
const BLACK_RULE: Color = rgb(0.08, 0.09, 0.11); // header + section rules

/* Type scale (design targets from the reference) ------------------------- */
const SIZE_NAME = 24;
const SIZE_TITLE = 15;
const SIZE_CONTACT = 9.5;
const SIZE_HEADING = 13.5;
const SIZE_LEAD = 11; // job title / degree (bold)
const SIZE_SUB = 10.5; // employer / institution (italic)
const SIZE_META = 10; // right-aligned dates / locations
const SIZE_BODY = 10; // summary, bullets, columns
const SIZE_PAGE_NO = 8.5;

const LH_LEAD = 14.5;
const LH_SUB = 14;
const LH_BODY = 13.8;
const LH_COL = 15.5; // two-column bullet rows

const PHOTO_W_MAX = 90; // ≈31.8 mm wide  (header box, aspect preserved)
const PHOTO_H_MAX = 116; // ≈41 mm tall
const PHOTO_GAP = 20; // between the text block and the photo
const COL_GUTTER = 26; // between the two bullet columns

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
/* Small monochrome contact icons (vector, baseline-anchored)          */
/* ------------------------------------------------------------------ */

/** Scale every number in a simple SVG path (M/L/H/V/C/Z, absolute) by k. */
function scalePath(d: string, k: number): string {
  return d.replace(/-?\d*\.?\d+/g, (n) => {
    const v = Number(n) * k;
    return Number.isInteger(v) ? String(v) : v.toFixed(2);
  });
}

/** Material "call" handset, 24px → ≈6.9pt. */
const ICON_PHONE_PATH = scalePath(
  "M6.62 10.79c1.44 2.83 3.76 5.14 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1-9.39 0-17-7.61-17-17 0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z",
  0.29,
);

function drawPinIcon(page: PDFPage, x: number, y: number): void {
  const cx = x + 3.5;
  page.drawCircle({ x: cx, y: y + 4.1, size: 3.1, color: INK });
  page.drawSvgPath("M1.2 2.6 L5.8 2.6 L3.5 -0.1 Z", { x, y, color: INK });
  page.drawCircle({ x: cx, y: y + 4.1, size: 1.3, color: rgb(1, 1, 1) });
}

function drawMailIcon(page: PDFPage, x: number, y: number): void {
  page.drawRectangle({ x, y, width: 8.4, height: 5.8, color: INK });
  page.drawLine({ start: { x: x + 0.7, y: y + 5.1 }, end: { x: x + 4.2, y: y + 2.4 }, thickness: 0.9, color: rgb(1, 1, 1) });
  page.drawLine({ start: { x: x + 4.2, y: y + 2.4 }, end: { x: x + 7.7, y: y + 5.1 }, thickness: 0.9, color: rgb(1, 1, 1) });
}

function drawPhoneIcon(page: PDFPage, x: number, y: number): void {
  page.drawSvgPath(ICON_PHONE_PATH, { x, y, color: INK });
}

function drawLinkedInIcon(page: PDFPage, x: number, y: number, inFont: PDFFont): void {
  page.drawRectangle({ x, y, width: 7.4, height: 7.4, color: INK });
  const w = inFont.widthOfTextAtSize("in", 5.4);
  page.drawText("in", { x: x + (7.4 - w) / 2, y: y + 1.7, size: 5.4, font: inFont, color: rgb(1, 1, 1) });
}

type ContactIconKind = "pin" | "mail" | "phone" | "linkedin" | null;
const ICON_W = 10.5; // icon box + gap to the following text

function drawContactIcon(page: PDFPage, kind: ContactIconKind, x: number, baselineY: number, inFont: PDFFont): void {
  switch (kind) {
    case "pin":
      drawPinIcon(page, x, baselineY - 0.5);
      break;
    case "mail":
      drawMailIcon(page, x, baselineY + 0.2);
      break;
    case "phone":
      drawPhoneIcon(page, x, baselineY - 0.3);
      break;
    case "linkedin":
      drawLinkedInIcon(page, x, baselineY - 0.4, inFont);
      break;
    default:
      break;
  }
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

interface PhotoBox {
  img: PDFImage;
  w: number;
  h: number;
}

/** Render the given (already user-reviewed) CV document to A4 PDF bytes. */
export async function generateCvPdf(cv: CvDocument, options: GenerateCvPdfOptions = {}): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle("Lebenslauf");
  if (cv.personal.fullName) doc.setAuthor(cv.personal.fullName);

  const serif = await doc.embedFont(StandardFonts.TimesRoman);
  const serifBold = await doc.embedFont(StandardFonts.TimesRomanBold);
  const serifItalic = await doc.embedFont(StandardFonts.TimesRomanItalic);
  const sansBold = await doc.embedFont(StandardFonts.HelveticaBold); // "in" glyph only

  // Optional candidate photograph — standard German-CV position, top-right,
  // aspect preserved inside a fixed box (consistent sizing across all
  // companies, never stretched). An unreadable image never fails the
  // render; the CV simply appears without it.
  const photoSource =
    options.photoDataUrl ??
    (cv.personal.photo?.startsWith("data:image/") ? cv.personal.photo : null);
  let photo: PhotoBox | null = null;
  const photoMatch = (photoSource ?? "").match(/^data:image\/(png|jpe?g);base64,([A-Za-z0-9+/=]+)$/);
  if (photoMatch) {
    try {
      const bytes = Uint8Array.from(atob(photoMatch[2]), (c) => c.charCodeAt(0));
      const img = photoMatch[1] === "png" ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
      let w = PHOTO_W_MAX;
      let h = (w * img.height) / img.width;
      if (h > PHOTO_H_MAX) {
        h = PHOTO_H_MAX;
        w = (h * img.width) / img.height;
      }
      photo = { img, w, h };
    } catch {
      photo = null;
    }
  }

  // ------------------------------------------------------------------
  // Page + cursor state
  // ------------------------------------------------------------------
  let page = doc.addPage([A4_WIDTH, A4_HEIGHT]);
  const TOP = A4_HEIGHT - MARGIN_TOP;
  let y = TOP;

  /** Running header on continuation pages (name + document type + rule). */
  const runningHeader = () => {
    const label = cv.personal.fullName ? `${cv.personal.fullName} — Lebenslauf` : "Lebenslauf";
    page.drawText(label, { x: MARGIN_X, y: y - 10, size: SIZE_PAGE_NO, font: serif, color: MUTED });
    page.drawLine({
      start: { x: MARGIN_X, y: y - 16 },
      end: { x: RIGHT, y: y - 16 },
      thickness: 0.7,
      color: rgb(0.6, 0.62, 0.66),
    });
    y -= 26;
  };
  const newPage = () => {
    page = doc.addPage([A4_WIDTH, A4_HEIGHT]);
    y = TOP;
    runningHeader();
  };
  const ensure = (height: number) => {
    if (y - height < MARGIN_BOTTOM) newPage();
  };

  /** Draw at the CURRENT baseline without advancing the cursor (used for
   *  the right-aligned date/location partners of lead lines). */
  const drawAt = (text: string, font: PDFFont, size: number, opts: { x?: number; right?: boolean; color?: Color } = {}) => {
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
  };

  const draw = (
    text: string,
    font: PDFFont,
    size: number,
    opts: { x?: number; color?: Color; lineGap?: number } = {},
  ): void => {
    if (!text) return;
    drawAt(text, font, size, { x: opts.x, color: opts.color });
    y -= size + 4;
    if (opts.lineGap) y -= opts.lineGap;
  };

  const drawWrapped = (text: string, font: PDFFont, size: number, opts: { color?: Color; indent?: number; lineGap?: number } = {}) => {
    for (const line of wrapLine(font, text, size, CONTENT_WIDTH - (opts.indent ?? 0))) {
      draw(line, font, size, { x: MARGIN_X + (opts.indent ?? 0), color: opts.color, lineGap: opts.lineGap ?? 1 });
    }
  };

  // ------------------------------------------------------------------
  // Header — top-anchored: centered name + italic title + icon contact
  // row (balanced within the width left of the photo), photo top-right.
  // ------------------------------------------------------------------
  const headerWidth = photo ? CONTENT_WIDTH - photo.w - PHOTO_GAP : CONTENT_WIDTH;

  const name = cv.personal.fullName.trim();
  const title = cv.personal.professionalTitle.trim();
  const nameLines = name ? wrapLine(serifBold, name, SIZE_NAME, headerWidth) : [];
  const titleLines = title ? wrapLine(serifItalic, title, SIZE_TITLE, headerWidth) : [];

  // Contact items: the four icon items (reference order), then any extra
  // facts as plain text — only values the candidate already provided.
  const per = cv.personal;
  const iconItems: Array<{ kind: ContactIconKind; text: string }> = [];
  if (per.location.trim()) iconItems.push({ kind: "pin", text: per.location.trim() });
  if (per.email.trim()) iconItems.push({ kind: "mail", text: per.email.trim() });
  if (per.phone.trim()) iconItems.push({ kind: "phone", text: per.phone.trim() });
  if (per.linkedin.trim()) iconItems.push({ kind: "linkedin", text: per.linkedin.trim() });
  const extras = [
    per.website.trim(),
    per.dateOfBirth.trim() ? `Geburtsdatum: ${per.dateOfBirth.trim()}` : "",
    per.nationality.trim() ? `Staatsangehörigkeit: ${per.nationality.trim()}` : "",
    per.availability.trim() ? `Verfügbar: ${per.availability.trim()}` : "",
  ].filter(Boolean);
  if (extras.length) iconItems.push({ kind: null, text: extras.join("   ·   ") });

  // Pack the items into lines (an icon never splits from its text);
  // each line is centered as a group.
  const itemW = (it: { kind: ContactIconKind; text: string }) =>
    (it.kind ? ICON_W : 0) + serif.widthOfTextAtSize(it.text, SIZE_CONTACT);
  const CONTACT_GAP = 16;
  const packedLines: Array<Array<{ kind: ContactIconKind; text: string; w: number }>> = [];
  {
    let line: Array<{ kind: ContactIconKind; text: string; w: number }> = [];
    let lineW = 0;
    for (const it of iconItems) {
      const w = itemW(it);
      if (line.length && lineW + CONTACT_GAP + w > headerWidth) {
        packedLines.push(line);
        line = [];
        lineW = 0;
      }
      line.push({ ...it, w });
      lineW += (line.length > 1 ? CONTACT_GAP : 0) + w;
    }
    if (line.length) packedLines.push(line);
  }

  // Draw top-anchored; `hy` = the current top of the next line.
  let hy = TOP;
  const centerAt = (text: string, font: PDFFont, size: number, baseline: number) => {
    const w = font.widthOfTextAtSize(text, size);
    page.drawText(text, { x: MARGIN_X + (headerWidth - w) / 2, y: baseline, size, font, color: INK });
  };
  for (const line of nameLines) {
    const baseline = hy - 20;
    centerAt(line, serifBold, SIZE_NAME, baseline);
    hy = baseline - 10;
  }
  if (titleLines.length) hy -= 3;
  for (const line of titleLines) {
    const baseline = hy - 13;
    centerAt(line, serifItalic, SIZE_TITLE, baseline);
    hy = baseline - 7;
  }
  if (packedLines.length) hy -= 8;
  for (const items of packedLines) {
    const lineW = items.reduce((s, it) => s + it.w, 0) + (items.length - 1) * CONTACT_GAP;
    let x = MARGIN_X + (headerWidth - lineW) / 2;
    const baseline = hy - 8;
    for (const it of items) {
      if (it.kind) drawContactIcon(page, it.kind, x, baseline, sansBold);
      page.drawText(it.text, { x: x + (it.kind ? ICON_W : 0), y: baseline, size: SIZE_CONTACT, font: serif, color: INK });
      x += it.w + CONTACT_GAP;
    }
    hy = baseline - 6;
  }
  const headerTextBottom = TOP - hy + 4;

  if (photo) {
    page.drawImage(photo.img, { x: RIGHT - photo.w, y: TOP - photo.h, width: photo.w, height: photo.h });
  }

  // Header rule — BELOW the taller of the centered text block and the
  // photo (never crossing the photograph). The body cursor starts below
  // the rule; the whole header always fits on the first page.
  const ruleY = TOP - Math.max(headerTextBottom, photo?.h ?? 0) - 12;
  page.drawLine({ start: { x: MARGIN_X, y: ruleY }, end: { x: RIGHT, y: ruleY }, thickness: 1, color: BLACK_RULE });
  y = ruleY - 12;

  // ------------------------------------------------------------------
  // Section chrome + entry + two-column building blocks
  // ------------------------------------------------------------------
  const sectionTitle = (label: string) => {
    y -= 12;
    // Reserve heading + rule + at least one content line (no orphan titles).
    ensure(44);
    page.drawText(label.toUpperCase(), { x: MARGIN_X, y, size: SIZE_HEADING, font: serifBold, color: INK });
    // The rule sits directly under the heading, as in the reference.
    const ruleY = y - 11;
    page.drawLine({ start: { x: MARGIN_X, y: ruleY }, end: { x: RIGHT, y: ruleY }, thickness: 1, color: BLACK_RULE });
    y = ruleY - 9;
  };

  const dateRange = (start: string, end: string, isCurrent?: boolean): string => {
    const e = isCurrent ? (end || "heute") : end;
    if (!start && !e) return "";
    return [start, e].filter(Boolean).join(" – ");
  };

  /** One entry: bold lead (left) + right-aligned date on the same
   *  baseline; italic sub (left) + right-aligned location on the same
   *  baseline; "•" bullets with hanging indent. The two header lines are
   *  kept together across page breaks. */
  const entry = (lead: string, sub: string, date: string, location: string, bullets: string[]) => {
    const bulletLines = bullets.filter((b) => b.trim()).flatMap((b) => wrapLine(serif, b, SIZE_BODY, CONTENT_WIDTH - 15));
    // Reserve the wider of date / location when wrapping, so the lead and
    // sub lines can never collide with their right-aligned partners.
    const reserve = Math.max(date ? serif.widthOfTextAtSize(date, SIZE_META) : 0, location ? serif.widthOfTextAtSize(location, SIZE_META) : 0);
    const leadW = reserve ? CONTENT_WIDTH - reserve - 20 : CONTENT_WIDTH;
    const leadLines = wrapLine(serifBold, lead, SIZE_LEAD, leadW);
    const subLines = sub ? wrapLine(serifItalic, sub, SIZE_SUB, leadW) : [];

    // Keep the entry header (lead + sub lines) atomic.
    const headerH = leadLines.length * LH_LEAD + subLines.length * LH_SUB;
    if (headerH + LH_BODY <= PAGE_CONTENT_HEIGHT) ensure(headerH + LH_BODY);

    leadLines.forEach((line, i) => {
      drawAt(line, serifBold, SIZE_LEAD, {});
      if (i === 0 && date) drawAt(date, serif, SIZE_META, { right: true, color: MUTED });
      y -= LH_LEAD;
    });
    subLines.forEach((line, i) => {
      drawAt(line, serifItalic, SIZE_SUB, { color: INK });
      if (i === 0 && location) drawAt(location, serif, SIZE_META, { right: true, color: MUTED });
      y -= LH_SUB;
    });
    for (const line of bulletLines) {
      ensure(LH_BODY);
      drawAt("•", serif, SIZE_BODY, { x: MARGIN_X + 1 });
      drawAt(line, serif, SIZE_BODY, { x: MARGIN_X + 14 });
      y -= LH_BODY;
    }
    y -= 9;
  };

  /** Balanced two-column "•" bullet list (first half left, rest right).
   *  Wrapped items occupy as many rows as needed; rows stay aligned. */
  const twoColumnBullets = (leftItems: string[], rightItems: string[]) => {
    const colW = (CONTENT_WIDTH - COL_GUTTER) / 2;
    const wrapItems = (items: string[]) => items.map((it) => wrapLine(serif, it, SIZE_BODY, colW - 15));
    const leftLines = wrapItems(leftItems);
    const rightLines = wrapItems(rightItems);
    const rows = Math.max(
      leftLines.reduce((s, l) => s + l.length, 0),
      rightLines.reduce((s, l) => s + l.length, 0),
    );
    let lIdx = 0;
    let lNo = 0;
    let rIdx = 0;
    let rNo = 0;
    const drawSide = (lines: string[][], x0: number): void => {
      const item = lines[lines === leftLines ? lIdx : rIdx];
      const no = lines === leftLines ? lNo : rNo;
      if (!item || no >= item.length) return;
      const first = no === 0;
      drawAt("•", serif, SIZE_BODY, { x: x0 + 1 });
      drawAt(item[no], serif, SIZE_BODY, { x: x0 + (first ? 14 : 12) });
      let nextNo = no + 1;
      let nextIdx = lines === leftLines ? lIdx : rIdx;
      if (nextNo >= item.length) {
        nextNo = 0;
        nextIdx += 1;
      }
      if (lines === leftLines) {
        lIdx = nextIdx;
        lNo = nextNo;
      } else {
        rIdx = nextIdx;
        rNo = nextNo;
      }
    };
    for (let row = 0; row < rows; row += 1) {
      ensure(LH_COL);
      drawSide(leftLines, MARGIN_X);
      drawSide(rightLines, MARGIN_X + colW + COL_GUTTER);
      y -= LH_COL;
    }
    y -= 4;
  };

  const splitColumns = (items: string[]) => {
    const mid = Math.ceil(items.length / 2);
    return [items.slice(0, mid), items.slice(mid)] as const;
  };

  // ---- 1 · Profil ---------------------------------------------------------
  if (cv.summary.trim()) {
    sectionTitle("Profil");
    drawWrapped(cv.summary.trim(), serif, SIZE_BODY, { lineGap: 1.5 });
  }

  // ---- 2 · Berufserfahrung --------------------------------------------------
  const exp = cv.experience.filter(experienceVisible);
  if (exp.length) {
    sectionTitle("Berufserfahrung & Praktika");
    for (const x of exp) {
      const job = x.jobTitle.trim();
      const company = x.company.trim();
      entry(job || company || "Erfahrung", job && company ? company : "", dateRange(x.start, x.end, x.isCurrent), x.location, [
        ...x.responsibilities,
        ...x.achievements,
      ]);
    }
  }

  // ---- 3 · Ausbildung / Bildung -------------------------------------------------
  const edu = cv.education.filter(educationVisible);
  if (edu.length) {
    sectionTitle("Ausbildung & Bildung");
    for (const e of edu) {
      const degree = e.degree.trim();
      const institution = e.institution.trim();
      entry(degree || institution || "Bildung", degree && institution ? institution : "", dateRange(e.start, e.end), e.location, e.description ? [e.description] : []);
    }
  }

  // ---- 4 · Kenntnisse & Fähigkeiten (two-column bullets) -------------------------
  const skills = cv.skills.map((s) => s.trim()).filter(Boolean);
  if (skills.length) {
    sectionTitle("Kenntnisse & Fähigkeiten");
    const [sl, sr] = splitColumns(skills);
    twoColumnBullets(sl, sr);
  }

  // ---- 5 · Zertifikate & Qualifikationen (two-column bullets) ---------------------
  const certs = cv.certificates.filter(certificateVisible);
  if (certs.length) {
    sectionTitle("Zertifikate & Qualifikationen");
    const certTexts = certs.map((c) => [c.name, c.issuer, c.date].filter(Boolean).join(" — "));
    const [cl, cr] = splitColumns(certTexts);
    twoColumnBullets(cl, cr);
  }

  // ---- 6 · Sprachen (two-column bullets) ---------------------------------------------
  const langs = cv.languages.filter(languageVisible);
  if (langs.length) {
    sectionTitle("Sprachen");
    const langTexts = langs.map((l) => [l.language, l.level].filter(Boolean).join(" – "));
    const [ll, lr] = splitColumns(langTexts);
    twoColumnBullets(ll, lr);
  }

  // ---- Projekte (beyond the reference's six sections — only when present) -----------
  const projects = cv.projects.filter(projectVisible);
  if (projects.length) {
    sectionTitle("Projekte");
    for (const x of projects) {
      const nameP = x.name.trim();
      const roleTech = [x.role.trim(), x.technologies.trim()].filter(Boolean).join(" · ");
      entry(nameP || "Projekt", nameP && roleTech ? roleTech : "", x.date.trim(), "", x.description ? [x.description] : []);
    }
  }

  // ---- Interessen -----------------------------------------------------------------------
  const interests = cv.interests.map((i) => i.trim()).filter(Boolean);
  if (interests.length) {
    sectionTitle("Interessen");
    const [il, ir] = splitColumns(interests);
    twoColumnBullets(il, ir);
  }

  // ---- subtle page numbers (multi-page documents only) ---------------------------------
  const pageCount = doc.getPageCount();
  if (pageCount > 1) {
    for (let i = 0; i < pageCount; i += 1) {
      const pg = doc.getPage(i);
      const label = `Seite ${i + 1} von ${pageCount}`;
      const w = serif.widthOfTextAtSize(label, SIZE_PAGE_NO);
      pg.drawText(label, { x: (A4_WIDTH - w) / 2, y: MARGIN_BOTTOM - 18, size: SIZE_PAGE_NO, font: serif, color: MUTED });
    }
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
    .replace(/\.+/, ".")
    .slice(0, 60)
    .replace(/\.+$/g, "");
  return `Lebenslauf_${part || "Bewerbung"}.pdf`;
}
