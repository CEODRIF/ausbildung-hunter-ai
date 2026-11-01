/**
 * AUTO BEWERB — deterministic tailored-CV → PDF renderer (pdf-lib).
 *
 * The tailored CVs are stored as structured CvDocument JSON (user-reviewed).
 * This module renders that SAME document to a professional German
 * Lebenslauf PDF, porting 1:1 the visual design of the platform CV
 * builder's "modern" template (src/components/cv-templates/
 * modern-template.tsx, the builder's professional sans-serif design):
 *
 *   - left-aligned header: steel-blue bold name, lighter-steel title,
 *     icon contact line (email, phone, location, website, LinkedIn —
 *     every icon optically centered on the same axis) and an
 *     extra-facts line (nationality | Geburtsdatum | Verfügbarkeit);
 *     when the photo is taller than the text block, the text is centered
 *     against the photo band (no dead space beside the photo), and a
 *     steel-blue divider rule separates header from body
 *   - the candidate's photograph (when available) in the header's
 *     upper-right, aspect preserved, never stretched, with professional
 *     rounded corners and a thin steel-blue frame (the template renders
 *     the same 1px divider border)
 *   - steel-blue section headings (bold, thin blue rule underneath)
 *   - "Position, Unternehmen" entries (bold + italic), dates + location
 *     stacked top-right, bullet lists for responsibilities/achievements
 *   - skills as two columns, languages as up to three columns (level
 *     under the language), certificates as two columns, project entries,
 *     interests as a single paragraph
 *
 * The builder renders its templates as browser CSS (PDF export via the
 * print portal), which cannot run server-side — so this module reuses the
 * template's ACTUAL design system (palette, type scale, spacing, section
 * organization and entry structure) in pdf-lib. The platform's standard-14
 * Helvetica family is the PDF counterpart of the template's web-safe
 * sans-serif stack (WinAnsiEncoding — reliable ä ö ü ß in every viewer,
 * no binary font files to ship).
 *
 * ONE-PAGE POLICY: the document is first fully MEASURED (exact word-wrap +
 * every block's height) and the largest of three density tiers
 * (comfortable → compact → dense) that fits ONE A4 page is chosen.
 * Nothing is ever removed or shortened to save space — only sizes and
 * spacing adapt, and the densest tier stays comfortably readable. A
 * generated (tailored) CV is a one-A4-page document: if even the densest
 * readable tier overflows, `generateCvPdf` throws `CvPdfOverflowError` —
 * an explicit, actionable validation error — instead of silently emitting
 * a multi-page file or shrinking text until it is unreadable. Callers that
 * genuinely need multi-page overflow (legacy/edge workflows) must opt in
 * with `options.allowMultiPage: true` (running header + subtle page
 * numbers, everything still rendered).
 *
 * Section ORDER and VISIBILITY follow the document's customization
 * (sanitizeCvCustomization defaults) — the same organization logic the CV
 * builder applies (CvSectionKeys order, per-section show/hide,
 * showDates/showLocation/showAchievements flags).
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
import { PDFDocument, PDFImage, PDFPage, PDFFont, StandardFonts, rgb, type Color } from "pdf-lib";
import {
  certificateVisible,
  educationVisible,
  experienceVisible,
  languageVisible,
  projectVisible,
  sanitizeCvDocument,
  type CvDocument,
} from "@/lib/templates/cv";
import { sanitizeCvCustomization, type CvSectionKey } from "@/lib/templates/cv-customization";

const A4_WIDTH = 595.28;
const A4_HEIGHT = 841.89;
const MM = 72 / 25.4; // pt per millimetre

/* The modern template's palette (modern-template.tsx IDENTITY) --------- */
const ACCENT: Color = rgb(47 / 255, 92 / 255, 153 / 255); // #2f5c99 name, headings, rules
const TITLE_TONE: Color = rgb(74 / 255, 120 / 255, 176 / 255); // #4a78b0 professional title
const BODY: Color = rgb(31 / 255, 41 / 255, 55 / 255); // #1f2937 text + icons + bullets
const META: Color = rgb(85 / 255, 95 / 255, 107 / 255); // #555f6b dates, locations, contact

/** German section titles — the builder's exact i18n labels
 *  (src/lib/i18n/dictionaries.ts, `templates.doc*`, German). */
const SECTION_LABELS: Record<CvSectionKey, string> = {
  summary: "Profil",
  experience: "Berufserfahrung",
  education: "Ausbildung & Studium",
  skills: "Kenntnisse",
  languages: "Sprachen",
  certificates: "Zertifikate",
  projects: "Projekte",
  interests: "Interessen",
};

/* ------------------------------------------------------------------ */
/* Density tiers — the adaptive one-page fit system                    */
/* ------------------------------------------------------------------ */

/** All values in PDF points. Tier 2 (compact) equals the modern template's
 *  exact px scale (1 CSS px = 0.75 pt); tier 1 adds headroom, tier 3
 *  tightens for very full profiles. Every tier keeps a ≥8.5 pt body. */
interface Tier {
  ml: number;
  mt: number;
  mb: number;
  name: number;
  title: number;
  contact: number;
  heading: number;
  entry: number;
  base: number;
  nameLh: number;
  titleLh: number;
  contactLh: number;
  baseLh: number;
  entryLh: number;
  metaLh: number; // right-stacked dates/location line step
  headerTitleGap: number;
  headerContactGap: number;
  otherGap: number;
  sectionGap: number;
  headingLh: number;
  headingPadB: number;
  sectionPadT: number;
  ruleTh: number;
  spaceBetween: number;
  bulletTop: number;
  iconSize: number;
  iconTextGap: number;
  contactItemGap: number;
  photoW: number;
  photoH: number;
  photoGap: number;
  photoRadius: number;
  /** Space between the header band and its divider rule. */
  headerRuleGap: number;
  skillsGap: number;
  langGap: number;
  descGap: number;
  techGap: number;
}

const COMFORTABLE: Tier = {
  ml: 10 * MM, mt: 12 * MM, mb: 10 * MM,
  name: 21, title: 13, contact: 9.5, heading: 10, entry: 10, base: 9.5,
  nameLh: 1.15, titleLh: 1.3, contactLh: 1.5, baseLh: 1.5, entryLh: 1.35, metaLh: 1.4,
  headerTitleGap: 3, headerContactGap: 9, otherGap: 3,
  sectionGap: 13, headingLh: 1.2, headingPadB: 3, sectionPadT: 6, ruleTh: 1.2,
  spaceBetween: 9, bulletTop: 1.5,
  iconSize: 8.25, iconTextGap: 3.75, contactItemGap: 12,
  photoW: 96, photoH: 128, photoGap: 19.5, photoRadius: 6.5, headerRuleGap: 8,
  skillsGap: 21, langGap: 18, descGap: 2, techGap: 1.5,
};

const COMPACT: Tier = {
  ml: 10 * MM, mt: 11 * MM, mb: 10 * MM,
  name: 19, title: 12, contact: 8.6, heading: 9.75, entry: 9.75, base: 9,
  nameLh: 1.12, titleLh: 1.25, contactLh: 1.4, baseLh: 1.4, entryLh: 1.3, metaLh: 1.35,
  headerTitleGap: 2.5, headerContactGap: 7.5, otherGap: 2.5,
  sectionGap: 11, headingLh: 1.15, headingPadB: 2.5, sectionPadT: 5, ruleTh: 1.1,
  spaceBetween: 7, bulletTop: 1.2,
  iconSize: 7.5, iconTextGap: 3.5, contactItemGap: 10,
  photoW: 90, photoH: 120, photoGap: 18, photoRadius: 6, headerRuleGap: 7,
  skillsGap: 21, langGap: 18, descGap: 1.5, techGap: 1.5,
};

const DENSE: Tier = {
  ml: 9 * MM, mt: 10 * MM, mb: 9 * MM,
  name: 17.5, title: 11, contact: 8, heading: 9.25, entry: 9.25, base: 8.5,
  nameLh: 1.1, titleLh: 1.2, contactLh: 1.35, baseLh: 1.32, entryLh: 1.26, metaLh: 1.3,
  headerTitleGap: 2, headerContactGap: 6, otherGap: 2,
  sectionGap: 9, headingLh: 1.12, headingPadB: 2, sectionPadT: 4, ruleTh: 1,
  spaceBetween: 5.5, bulletTop: 1,
  iconSize: 7, iconTextGap: 3, contactItemGap: 9,
  photoW: 84, photoH: 112, photoGap: 16, photoRadius: 5.5, headerRuleGap: 6,
  skillsGap: 16, langGap: 14, descGap: 1.5, techGap: 1,
};

const TIERS: readonly Tier[] = [COMFORTABLE, COMPACT, DENSE];

/* ------------------------------------------------------------------ */
/* Layout plan (measure-then-draw)                                     */
/* ------------------------------------------------------------------ */

interface Fonts {
  reg: PDFFont;
  bold: PDFFont;
  obi: PDFFont;
}

type IconKind = "mail" | "phone" | "pin" | "globe" | "linkedin";

type PlanItem =
  | { kind: "text"; x: number; y: number; font: PDFFont; size: number; color: Color; text: string; keepThrough?: number }
  | { kind: "icon"; icon: IconKind; x: number; y: number; size: number }
  | { kind: "rule"; y: number; thickness: number; color: Color; x0: number; x1: number }
  | { kind: "photo"; x: number; y: number; w: number; h: number; img: PDFImage };

interface Layout {
  tier: Tier;
  plan: PlanItem[];
  /** Total content height (from the content top). */
  totalH: number;
  /** True when the content fits one A4 page of this tier. */
  fits: boolean;
}

interface PhotoBox {
  img: PDFImage;
  w: number;
  h: number;
}

/** Helvetica ascent ≈ 0.72 em — the baseline offset inside a line box. */
const firstBaseline = (lineTop: number, size: number, lh: number): number =>
  lineTop + ((size * lh - size) / 2 + size * 0.72);

/** The line-box height of one text line. */
const lineH = (size: number, lh: number): number => size * lh;

/* ------------------------------------------------------------------ */
/* Word wrapping (greedy, exact font metrics)                          */
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

interface Chunk {
  text: string;
  font: PDFFont;
}

/** Wrap a line built of styled segments (bold lead + italic company) with
 *  exact per-segment metrics; consecutive same-font words merge. */
function wrapSegments(segs: Chunk[], size: number, maxWidth: number): Chunk[][] {
  if (maxWidth <= 0) maxWidth = 10;
  const words: Chunk[] = [];
  for (const seg of segs) {
    for (const w of seg.text.split(/\s+/).filter(Boolean)) {
      words.push({ text: w, font: seg.font });
    }
  }
  const lines: Chunk[][] = [];
  let line: Chunk[] = [];
  let lineW = 0;
  for (const { text: word, font } of words) {
    if (font.widthOfTextAtSize(word, size) > maxWidth && line.length === 0) {
      for (const piece of breakLongWord(font, word, size, maxWidth)) {
        lines.push([{ text: piece, font }]);
      }
      continue;
    }
    const withSpace = line.length ? ` ${word}` : word;
    const ww = font.widthOfTextAtSize(withSpace, size);
    if (line.length && lineW + ww > maxWidth) {
      lines.push(line);
      line = [{ text: word, font }];
      lineW = font.widthOfTextAtSize(word, size);
    } else if (line.length === 0) {
      line = [{ text: word, font }];
      lineW = font.widthOfTextAtSize(word, size);
    } else {
      const last = line[line.length - 1];
      if (last.font === font) last.text += withSpace;
      else line.push({ text: withSpace, font });
      lineW += ww;
    }
  }
  if (line.length) lines.push(line);
  return lines;
}

/* ------------------------------------------------------------------ */
/* Contact items + icons (the modern template's header contact line)   */
/* ------------------------------------------------------------------ */

interface ContactItem {
  kind: IconKind;
  text: string;
}

/** email / phone / location / website / linkedin — the same order and the
 *  same "only what the candidate provided" rule as the builder. */
function buildContactItems(cv: CvDocument): ContactItem[] {
  const { personal } = cv;
  const items: ContactItem[] = [];
  if (personal.email.trim()) items.push({ kind: "mail", text: personal.email.trim() });
  if (personal.phone.trim()) items.push({ kind: "phone", text: personal.phone.trim() });
  if (personal.location.trim()) items.push({ kind: "pin", text: personal.location.trim() });
  if (personal.website.trim()) items.push({ kind: "globe", text: personal.website.trim() });
  if (personal.linkedin.trim()) items.push({ kind: "linkedin", text: personal.linkedin.trim() });
  return items;
}

/** nationality | date of birth | availability (may be empty). */
function buildOtherText(cv: CvDocument): string {
  const { personal } = cv;
  return [personal.nationality, personal.dateOfBirth, personal.availability]
    .map((v) => v.trim())
    .filter(Boolean)
    .join("  |  ");
}

const dateRange = (start: string, end: string, isCurrent?: boolean): string => {
  const s = (start ?? "").trim();
  const e = (end ?? "").trim();
  const endShown = isCurrent ? (e || "heute") : e;
  if (!s && !endShown) return "";
  if (!s) return endShown;
  if (!endShown) return s;
  return `${s} – ${endShown}`;
};

/* ------------------------------------------------------------------ */
/* The layout builder — measures EVERYTHING before anything is drawn   */
/* ------------------------------------------------------------------ */

function buildLayout(cv: CvDocument, fonts: Fonts, photo: PhotoBox | null, tier: Tier): Layout {
  const left = tier.ml;
  const right = A4_WIDTH - tier.ml;
  const contentW = right - left;
  const headerW = photo ? contentW - photo.w - tier.photoGap : contentW;
  const plan: PlanItem[] = [];
  const s = sanitizeCvCustomization(cv.customization);
  let y = 0; // offset below the content top

  const pushText = (
    x: number,
    yTop: number,
    font: PDFFont,
    size: number,
    color: Color,
    text: string,
    lh: number,
  ): number => {
    plan.push({ kind: "text", x, y: firstBaseline(yTop, size, lh), font, size, color, text });
    return lineH(size, lh);
  };

  // ------------------------------------------------------------------
  // Header — left text block (name / title / contact / other) + photo
  // ------------------------------------------------------------------
  const name = cv.personal.fullName.trim();
  const title = cv.personal.professionalTitle.trim();
  let yTop = 0;
  if (name) {
    for (const line of wrapLine(fonts.bold, name, tier.name, headerW)) {
      yTop += pushText(left, yTop, fonts.bold, tier.name, ACCENT, line, tier.nameLh);
    }
  }
  if (title) {
    yTop += tier.headerTitleGap;
    for (const line of wrapLine(fonts.reg, title, tier.title, headerW)) {
      yTop += pushText(left, yTop, fonts.reg, tier.title, TITLE_TONE, line, tier.titleLh);
    }
  }
  const contact = buildContactItems(cv);
  if (contact.length) {
    yTop += tier.headerContactGap;
    // Pack the icon items into lines (an icon never splits from its text).
    const itemW = (it: ContactItem) =>
      tier.iconSize + tier.iconTextGap + fonts.reg.widthOfTextAtSize(it.text, tier.contact);
    const lines: ContactItem[][] = [];
    let line: ContactItem[] = [];
    let lineW = 0;
    for (const it of contact) {
      const w = itemW(it);
      if (line.length && lineW + tier.contactItemGap + w > headerW) {
        lines.push(line);
        line = [];
        lineW = 0;
      }
      line.push(it);
      lineW += (line.length > 1 ? tier.contactItemGap : 0) + w;
    }
    if (line.length) lines.push(line);
    for (const items of lines) {
      const h = lineH(tier.contact, tier.contactLh);
      let x = left;
      const baseline = firstBaseline(yTop, tier.contact, tier.contactLh);
      for (const it of items) {
        // The icon item carries the contact line's baseline; drawContactIcon
        // centers the glyph on the line's shared optical axis from it.
        plan.push({ kind: "icon", icon: it.kind, x, y: baseline, size: tier.iconSize });
        x += tier.iconSize + tier.iconTextGap;
        pushText(x, yTop, fonts.reg, tier.contact, META, it.text, tier.contactLh);
        x += fonts.reg.widthOfTextAtSize(it.text, tier.contact) + tier.contactItemGap;
      }
      yTop += h;
    }
  }
  const other = buildOtherText(cv);
  if (other) {
    if (contact.length) yTop += tier.otherGap;
    for (const line of wrapLine(fonts.reg, other, tier.contact, headerW)) {
      yTop += pushText(left, yTop, fonts.reg, tier.contact, META, line, tier.contactLh);
    }
  }
  // USE THE SPACE BESIDE THE PHOTO: when the photo is taller than the
  // header text block, the text is centered against the photo band
  // (the modern template's `align-items: center` grid behavior) — no
  // dead space accumulates under the text beside the photo. The plan
  // holds ONLY header items at this point, so every one gets the shift.
  const photoH = photo?.h ?? 0;
  const headerShift = photo ? Math.max(0, (photoH - yTop) / 2) : 0;
  if (headerShift > 0) {
    for (const item of plan) item.y += headerShift;
  }
  if (photo) {
    plan.push({ kind: "photo", x: right - photo.w, y: 0, w: photo.w, h: photo.h, img: photo.img });
  }
  y = Math.max(yTop + 2 * headerShift, photoH);
  // Header divider rule — the header→body hierarchy line (the template's
  // header carries the same 1.5px divider).
  y += tier.headerRuleGap;
  plan.push({ kind: "rule", y, thickness: 0.75, color: ACCENT, x0: left, x1: right });
  y += 0.75;

  // ------------------------------------------------------------------
  // Sections — in the document's customization order & visibility
  // ------------------------------------------------------------------
  const exp = cv.experience.filter(experienceVisible);
  const edu = cv.education.filter(educationVisible);
  const skills = cv.skills.map((x) => x.trim()).filter(Boolean);
  const langs = cv.languages.filter(languageVisible);
  const certs = cv.certificates.filter(certificateVisible);
  const projects = cv.projects.filter(projectVisible);
  const interests = cv.interests.map((x) => x.trim()).filter(Boolean);

  const sectionContent: Record<CvSectionKey, boolean> = {
    summary: Boolean(cv.summary.trim()),
    experience: exp.length > 0,
    education: edu.length > 0,
    skills: skills.length > 0,
    languages: langs.length > 0,
    certificates: certs.length > 0,
    projects: projects.length > 0,
    interests: interests.length > 0,
  };

  /** One entry. `origin` = the current content offset (plan items are
   *  absolute); returns the entry's height (the caller advances `y`). */
  const entry = (
    bold: string,
    italic: string | undefined,
    dates: string | undefined,
    meta: string | undefined,
    bullets: string[],
    origin: number,
  ): number => {
    let h = 0;
    const segs: Chunk[] = [{ text: bold, font: fonts.bold }];
    if (italic) segs.push({ text: ` , ${italic}`, font: fonts.obi });
    const datesW = dates ? fonts.reg.widthOfTextAtSize(dates, tier.contact) : 0;
    const metaW = meta ? fonts.reg.widthOfTextAtSize(meta, tier.contact) : 0;
    const reserve = Math.max(datesW, metaW);
    const leadLines = wrapSegments(segs, tier.entry, contentW - (reserve ? reserve + 12 : 0));
    for (const line of leadLines) {
      let x = left;
      for (const chunk of line) {
        pushText(x, origin + h, chunk.font, tier.entry, chunk.font === fonts.obi ? META : BODY, chunk.text, tier.entryLh);
        x += chunk.font.widthOfTextAtSize(chunk.text, tier.entry);
      }
      h += lineH(tier.entry, tier.entryLh);
    }
    // Dates + location stacked top-right (modern template entry header).
    const leadBaseline = firstBaseline(0, tier.entry, tier.entryLh);
    if (dates) {
      plan.push({
        kind: "text",
        x: right - datesW,
        y: origin + leadBaseline,
        font: fonts.reg,
        size: tier.contact,
        color: META,
        text: dates,
      });
    }
    if (meta) {
      plan.push({
        kind: "text",
        x: right - metaW,
        y: origin + leadBaseline + lineH(tier.contact, tier.metaLh),
        font: fonts.reg,
        size: tier.contact,
        color: META,
        text: meta,
      });
    }
    const rightH = ((dates ? 1 : 0) + (meta ? 1 : 0)) * lineH(tier.contact, tier.metaLh);
    h = Math.max(h, rightH);
    for (const b of bullets.filter((b) => b.trim())) {
      const lines = wrapLine(fonts.reg, b, tier.base, contentW - 10.5);
      for (let i = 0; i < lines.length; i += 1) {
        const lt = origin + h + tier.bulletTop + i * lineH(tier.base, tier.baseLh);
        plan.push({ kind: "text", x: left + 1, y: firstBaseline(lt, tier.base, tier.baseLh), font: fonts.reg, size: tier.base, color: BODY, text: "•" });
        plan.push({ kind: "text", x: left + 10.5, y: firstBaseline(lt, tier.base, tier.baseLh), font: fonts.reg, size: tier.base, color: BODY, text: lines[i] });
      }
      h += tier.bulletTop + lines.length * lineH(tier.base, tier.baseLh);
    }
    return h;
  };

  const columnBullets = (items: string[], gap: number, origin: number): number => {
    const cols = Math.min(2, items.length);
    const colW = (contentW - (cols - 1) * gap) / cols;
    const perCol: string[][] = Array.from({ length: cols }, () => []);
    items.forEach((it, i) => perCol[i % cols].push(it)); // CSS grid: row-first
    let maxH = 0;
    perCol.forEach((colItems, ci) => {
      const x0 = left + ci * (colW + gap);
      let ch = 0;
      for (const it of colItems) {
        const lines = wrapLine(fonts.reg, it, tier.base, colW - 10.5);
        for (let i = 0; i < lines.length; i += 1) {
          const lt = origin + ch + tier.bulletTop + i * lineH(tier.base, tier.baseLh);
          plan.push({ kind: "text", x: x0 + 1, y: firstBaseline(lt, tier.base, tier.baseLh), font: fonts.reg, size: tier.base, color: BODY, text: "•" });
          plan.push({ kind: "text", x: x0 + 10.5, y: firstBaseline(lt, tier.base, tier.baseLh), font: fonts.reg, size: tier.base, color: BODY, text: lines[i] });
        }
        ch += tier.bulletTop + lines.length * lineH(tier.base, tier.baseLh);
      }
      maxH = Math.max(maxH, ch);
    });
    return maxH;
  };

  const languageGrid = (items: typeof langs, origin: number): number => {
    const cols = Math.min(3, items.length);
    const colW = (contentW - (cols - 1) * tier.langGap) / cols;
    const perCol: Array<(typeof langs)[number][]> = Array.from({ length: cols }, () => []);
    items.forEach((l, i) => perCol[i % cols].push(l));
    let maxH = 0;
    perCol.forEach((colItems, ci) => {
      const x0 = left + ci * (colW + tier.langGap);
      let ch = 0;
      for (const l of colItems) {
        ch += pushText(x0, origin + ch, fonts.bold, tier.base, BODY, l.language.trim(), tier.baseLh);
        if (l.level.trim()) ch += pushText(x0, origin + ch, fonts.reg, tier.contact, META, l.level.trim(), 1.3);
      }
      maxH = Math.max(maxH, ch);
    });
    return maxH;
  };

  /** Description/tech line under an entry (full content width, like the
   *  modern template's entry paragraphs). */
  const desc = (text: string, size: number, font: PDFFont, color: Color, lh: number, gap: number, origin: number): number => {
    let h = gap;
    for (const line of wrapLine(font, text, size, contentW)) {
      h += pushText(left, origin + h, font, size, color, line, lh);
    }
    return h;
  };

  for (const key of s.layout.sectionOrder) {
    if (!s.sections.visibility[key] || !sectionContent[key]) continue;
    const startIdx = plan.length;
    y += tier.sectionGap;
    const headingTop = y;
    plan.push({
      kind: "text",
      x: left,
      y: firstBaseline(headingTop, tier.heading, tier.headingLh),
      font: fonts.bold,
      size: tier.heading,
      color: ACCENT,
      text: SECTION_LABELS[key],
    });
    const ruleY = headingTop + lineH(tier.heading, tier.headingLh) + tier.headingPadB;
    plan.push({ kind: "rule", y: ruleY, thickness: tier.ruleTh, color: ACCENT, x0: left, x1: right });
    y = ruleY + tier.ruleTh + tier.sectionPadT;

    switch (key) {
      case "summary": {
        const lines = wrapLine(fonts.reg, cv.summary.trim(), tier.base, contentW);
        for (const line of lines) y += pushText(left, y, fonts.reg, tier.base, BODY, line, tier.baseLh);
        break;
      }
      case "experience": {
        exp.forEach((x, i) => {
          const job = x.jobTitle.trim();
          const company = x.company.trim();
          const bullets = [
            ...x.responsibilities,
            ...(s.entries.showAchievements ? x.achievements : []),
          ];
          y += entry(job || company || "Erfahrung", job && company ? company : undefined,
            s.entries.showDates ? dateRange(x.start, x.end, x.isCurrent) || undefined : undefined,
            s.entries.showLocation ? x.location.trim() || undefined : undefined, bullets, y);
          if (i < exp.length - 1) y += tier.spaceBetween;
        });
        break;
      }
      case "education": {
        edu.forEach((e, i) => {
          const degree = e.degree.trim();
          const institution = e.institution.trim();
          let h = entry(
            degree || institution || "Bildung",
            degree && institution ? institution : undefined,
            s.entries.showDates ? dateRange(e.start, e.end) || undefined : undefined,
            s.entries.showLocation ? e.location.trim() || undefined : undefined,
            [],
            y,
          );
          if (e.description.trim()) h += desc(e.description.trim(), tier.base, fonts.reg, META, tier.baseLh, tier.descGap, y + h);
          y += h;
          if (i < edu.length - 1) y += tier.spaceBetween;
        });
        break;
      }
      case "skills":
        y += columnBullets(skills, tier.skillsGap, y);
        break;
      case "languages":
        y += languageGrid(langs, y);
        break;
      case "certificates": {
        // The full verified fact set per certificate (name + issuer + date)
        // stays in the document — nothing is dropped for the two-column
        // presentation.
        y += columnBullets(
          certs.map((c) => [c.name.trim(), c.issuer.trim(), c.date.trim()].filter(Boolean).join(" — ") || "—"),
          tier.skillsGap,
          y,
        );
        break;
      }
      case "projects": {
        projects.forEach((p, i) => {
          const nameP = p.name.trim();
          let h = entry(
            nameP || "Projekt",
            p.role.trim() || undefined,
            s.entries.showDates ? p.date.trim() || undefined : undefined,
            undefined,
            [],
            y,
          );
          if (p.description.trim()) h += desc(p.description.trim(), tier.base, fonts.reg, META, tier.baseLh, tier.descGap, y + h);
          if (p.technologies.trim()) h += desc(p.technologies.trim(), tier.contact, fonts.obi, META, 1.3, tier.techGap, y + h);
          y += h;
          if (i < projects.length - 1) y += tier.spaceBetween;
        });
        break;
      }
      case "interests": {
        const lines = wrapLine(fonts.reg, interests.join(", "), tier.base, contentW);
        for (const line of lines) y += pushText(left, y, fonts.reg, tier.base, BODY, line, tier.baseLh);
        break;
      }
    }

    // Keep heading + rule + the first content line(s) together (no orphan
    // headings across page breaks). Item count of one first content row:
    const firstRowItems =
      key === "experience" || key === "education" || key === "projects"
        ? 4 // lead chunks (≤2) + dates + location
        : key === "languages"
          ? Math.min(3, langs.length) * 2 // language + level per column
          : key === "skills" || key === "certificates"
            ? 4 // bullet dot + text per column (2 columns)
            : 1; // summary / interests line
    const head = plan[startIdx];
    if (head.kind === "text") head.keepThrough = Math.min(plan.length, startIdx + 2 + firstRowItems);
  }

  const available = A4_HEIGHT - tier.mt - tier.mb;
  return { tier, plan, totalH: y, fits: y <= available };
}

/* ------------------------------------------------------------------ */
/* Icon drawing (carried over from the previous renderer, re-coloured) */
/* ------------------------------------------------------------------ */

/** Material "call" handset, 24px design box → scaled to the icon size. */
function scalePath(d: string, k: number): string {
  return d.replace(/-?\d*\.?\d+/g, (n) => {
    const v = Number(n) * k;
    return Number.isInteger(v) ? String(v) : v.toFixed(2);
  });
}
/** 0.36 → the handset renders at ~7 × 7 icon units (the other icons are
 *  6.2–8.4 wide), drawn with `scale: k` so it tracks the tier like the rest. */
const ICON_PHONE_PATH = scalePath(
  "M6.62 10.79c1.44 2.83 3.76 5.14 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1-9.39 0-17-7.61-17-17 0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z",
  0.36,
);
/** Vertical extent of ICON_PHONE_PATH in icon units (handset top/bottom). */
const ICON_PHONE_TOP = 2.1 * 0.36; // ≈ 0.76
const ICON_PHONE_BOTTOM = 21.4 * 0.36; // ≈ 7.7
const ICON_PHONE_CENTER = (ICON_PHONE_TOP + ICON_PHONE_BOTTOM) / 2;

/**
 * The optical center of a contact line: where EVERY icon is centered.
 * The modern template centers its icons with flex `align-items: center`
 * on a 1.5 em line box — for a 0.72-em ascent font that line-box center
 * sits at baseline + 0.22 · contactSize (independent of the line height).
 */
export function contactIconAxis(baseline: number, contactSize: number): number {
  return baseline + contactSize * 0.22;
}

/**
 * Draw a contact icon at (x, baseline), scaled to `size`, with its
 * optical center EXACTLY on the shared contact-line axis
 * (contactIconAxis) — the previous renderer anchored each icon to a
 * different point (and the handset did not scale with the tier at all),
 * which is what made the icon row look misaligned.
 */
function drawContactIcon(page: PDFPage, kind: IconKind, x: number, baseline: number, size: number, inFont: PDFFont, contactSize: number): void {
  const k = size / 8.25;
  const axis = contactIconAxis(baseline, contactSize);
  const white = rgb(1, 1, 1);
  switch (kind) {
    case "pin":
      // Circle sits slightly above the axis; the tip extends below, so
      // the whole glyph (circle + tip) is centered on the axis.
      // (drawCircle's `size` is the RADIUS, not the diameter.)
      page.drawCircle({ x: x + 3.5 * k, y: axis + 0.7 * k, size: 3.1 * k, color: BODY });
      page.drawSvgPath("M1.2 0 L5.8 0 L3.5 3.2 Z", { x, y: axis - 2.4 * k, scale: k, color: BODY });
      page.drawCircle({ x: x + 3.5 * k, y: axis + 0.7 * k, size: 1.3 * k, color: white });
      break;
    case "mail":
      page.drawRectangle({ x, y: axis - 2.9 * k, width: 8.4 * k, height: 5.8 * k, color: BODY });
      page.drawLine({ start: { x: x + 0.7 * k, y: axis + 2.2 * k }, end: { x: x + 4.2 * k, y: axis - 0.5 * k }, thickness: 0.9 * k, color: white });
      page.drawLine({ start: { x: x + 4.2 * k, y: axis - 0.5 * k }, end: { x: x + 7.7 * k, y: axis + 2.2 * k }, thickness: 0.9 * k, color: white });
      break;
    case "phone":
      // The anchor is the icon's TOP edge: the (scaled, y-flipped) path
      // spans anchor − (0.76…7.7)·k, so centering on the axis puts the
      // anchor at axis + center·k.
      page.drawSvgPath(ICON_PHONE_PATH, { x, y: axis + ICON_PHONE_CENTER * k, scale: k, color: BODY });
      break;
    case "linkedin":
      page.drawRectangle({ x, y: axis - 3.7 * k, width: 7.4 * k, height: 7.4 * k, color: BODY });
      const w = inFont.widthOfTextAtSize("in", 5.4 * k);
      page.drawText("in", { x: x + ((7.4 * k - w) / 2), y: axis - 1.9 * k, size: 5.4 * k, font: inFont, color: white });
      break;
    case "globe": {
      const c = 3.7 * k;
      const cx = x + c;
      const cy = axis;
      page.drawCircle({ x: cx, y: cy, size: c, color: BODY });
      page.drawCircle({ x: cx, y: cy, size: c * 0.62, color: white });
      page.drawCircle({ x: cx, y: cy, size: c * 0.3, color: BODY });
      break;
    }
  }
}

/**
 * Professional rounded corners for a drawn photo rectangle: four white
 * corner notches (the CV page is white) + a 0.75pt steel-blue frame
 * (the modern template renders the photo with the same 1px divider
 * border). Each notch arc is a quarter circle of radius `rr` centered at
 * the INSET corner — the arc midpoint therefore sits at
 * rr · (1 − 1/√2) ≈ 0.293 · rr from each edge (the tests verify the
 * emitted bezier midpoints, so an inverted sweep flag can never ship).
 */
function drawRoundedPhoto(page: PDFPage, x: number, bottomY: number, w: number, h: number, radius: number): void {
  const rr = Math.min(radius, w / 2, h / 2);
  const topY = bottomY + h;
  // drawSvgPath anchors the SVG path's TOP-LEFT at (x, y) and draws it
  // with y growing DOWNWARD on the page — each notch is anchored at its
  // photo corner, so its arc data lives in the photo half of the plane.
  // (Every sweep flag was verified numerically: an arc's bezier midpoint
  // must sit rr·(1−1/√2) ≈ 0.293·rr from BOTH edges of the corner
  // square, i.e. the arc is centered at the INSET corner.)
  page.drawSvgPath(`M0 0 L${rr} 0 A${rr} ${rr} 0 0 0 0 ${rr} Z`, { x, y: topY, color: rgb(1, 1, 1) });
  page.drawSvgPath(`M0 0 L${-rr} 0 A${rr} ${rr} 0 0 1 0 ${rr} Z`, { x: x + w, y: topY, color: rgb(1, 1, 1) });
  page.drawSvgPath(`M0 0 L${rr} 0 A${rr} ${rr} 0 0 1 0 ${-rr} Z`, { x, y: bottomY, color: rgb(1, 1, 1) });
  page.drawSvgPath(`M0 0 L${-rr} 0 A${rr} ${rr} 0 0 0 0 ${-rr} Z`, { x: x + w, y: bottomY, color: rgb(1, 1, 1) });
  // The frame's path data spans the WHOLE photo rect in top-left-anchored
  // coordinates — so it is anchored at the photo's TOP, not its bottom.
  const frame =
    `M${rr} 0 L${w - rr} 0 A${rr} ${rr} 0 0 1 ${w} ${rr} ` +
    `L${w} ${h - rr} A${rr} ${rr} 0 0 1 ${w - rr} ${h} ` +
    `L${rr} ${h} A${rr} ${rr} 0 0 1 0 ${h - rr} ` +
    `L0 ${rr} A${rr} ${rr} 0 0 1 ${rr} 0 Z`;
  page.drawSvgPath(frame, { x, y: topY, borderColor: ACCENT, borderWidth: 0.75 });
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

export interface GenerateCvPdfOptions {
  /**
   * The candidate's photograph as a data URL (PNG/JPEG), already resolved
   * and ownership-verified by the caller (export route / send preparation).
   * `null` = render without a photo. Legacy documents without this option
   * fall back to an inline data URL stored in `personal.photo`.
   */
  photoDataUrl?: string | null;
  /**
   * ONE-PAGE POLICY escape hatch: when the densest readable tier still
   * overflows, the render throws `CvPdfOverflowError` (the default,
   * required for generated CVs). Opt in explicitly to fall back to
   * multi-page overflow rendering instead.
   */
  allowMultiPage?: boolean;
}

/**
 * The document cannot fit ONE A4 page even at the densest readable tier.
 * The caller must surface this (actionable message + code `cv_overflow`)
 * — a generated CV is never silently emitted as multiple pages.
 */
export class CvPdfOverflowError extends Error {
  readonly code = "cv_overflow" as const;
  constructor() {
    super(
      "Der Lebenslauf ist zu umfangreich für eine A4-Seite (selbst im kompaktesten, gut lesbaren Layout). " +
        "Bitte kürzen Sie ältere Tätigkeiten oder einzelne Angaben in Ihrem Lebenslauf und erzeugen Sie das Dokument neu.",
    );
    this.name = "CvPdfOverflowError";
  }
}

/**
 * Render the given (already user-reviewed) CV document to A4 PDF bytes.
 * ONE A4 page by policy: overflow throws `CvPdfOverflowError` unless
 * `options.allowMultiPage` is explicitly set.
 */
export async function generateCvPdf(cv: CvDocument, options: GenerateCvPdfOptions = {}): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle("Lebenslauf");
  if (cv.personal.fullName) doc.setAuthor(cv.personal.fullName);

  const fonts: Fonts = {
    reg: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
    obi: await doc.embedFont(StandardFonts.HelveticaOblique),
  };

  // Defensive re-sanitization (documents arrive from the DB; a valid
  // document is unchanged — idempotent).
  const clean = sanitizeCvDocument(cv) ?? cv;

  // Optional candidate photograph — the standard German-CV position
  // (header's upper-right, aspect preserved, never stretched). An
  // unreadable image never fails the render; the CV simply appears
  // without it.
  const photoSource =
    options.photoDataUrl ??
    (clean.personal.photo?.startsWith("data:image/") ? clean.personal.photo : null);
  let img: PDFImage | null = null;
  const photoMatch = (photoSource ?? "").match(/^data:image\/(png|jpe?g);base64,([A-Za-z0-9+/=]+)$/);
  if (photoMatch) {
    try {
      const bytes = Uint8Array.from(atob(photoMatch[2]), (c) => c.charCodeAt(0));
      img = photoMatch[1] === "png" ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
    } catch {
      img = null;
    }
  }

  // Measure every tier, then draw the largest one that fits a single page.
  let layout: Layout | null = null;
  for (const tier of TIERS) {
    const box = img
      ? (() => {
          let w = tier.photoW;
          let h = (w * img.height) / img.width;
          if (h > tier.photoH) {
            h = tier.photoH;
            w = (h * img.width) / img.height;
          }
          return { img, w, h };
        })()
      : null;
    layout = buildLayout(clean, fonts, box, tier);
    if (layout.fits) break; // the most comfortable tier that fits one page
  }
  const chosen = layout!;

  // ONE-PAGE POLICY: an overflowing document is a validation error, not a
  // silent multi-page file (nothing is deleted, nothing clipped, nothing
  // shrunk unreadable — the content must be trimmed at the source instead).
  if (!chosen.fits && !options.allowMultiPage) throw new CvPdfOverflowError();

  // ------------------------------------------------------------------
  // Draw the plan (page 1 = the header page; further pages only when
  // `allowMultiPage` was explicitly opted in, with a running header +
  // subtle page numbers).
  // ------------------------------------------------------------------
  let page = doc.addPage([A4_WIDTH, A4_HEIGHT]);
  const t = chosen.tier;
  const runningLabel = clean.personal.fullName ? `${clean.personal.fullName} — Lebenslauf` : "Lebenslauf";

  // Plan items carry `y` as an absolute offset from PAGE-1's content top.
  // On continuation pages we re-baseline against `pageStartY` (the offset of
  // the first item drawn on the page) so every item lands at the right place.
  let contentTop = A4_HEIGHT - t.mt; // page coordinate the current origin maps to
  let pageStartY = 0;

  const startNewPage = (originY: number): void => {
    page = doc.addPage([A4_WIDTH, A4_HEIGHT]);
    contentTop = A4_HEIGHT - t.mt;
    page.drawText(runningLabel, { x: t.ml, y: contentTop - 10, size: 8.5, font: fonts.reg, color: META });
    page.drawLine({
      start: { x: t.ml, y: contentTop - 16 },
      end: { x: A4_WIDTH - t.ml, y: contentTop - 16 },
      thickness: 0.7,
      color: ACCENT,
    });
    contentTop -= 26; // leave room for the running header
    pageStartY = originY;
  };

  /** Map a plan offset (from page-1 top) to the current page's baseline. */
  const yOf = (itemY: number): number => contentTop - (itemY - pageStartY);

  const descentOf = (item: PlanItem): number =>
    item.kind === "text" ? item.size * 0.28 : item.kind === "photo" ? item.h : item.kind === "rule" ? item.thickness : item.size;

  // Keep-together chunks (heading + rule + first content line) are checked
  // as a unit at their head; items inside a checked chunk only draw.
  let checkedChunkUntil = -1;
  for (let idx = 0; idx < chosen.plan.length; idx += 1) {
    const item = chosen.plan[idx];
    if (idx >= checkedChunkUntil) {
      if (item.kind === "text" && typeof item.keepThrough === "number") {
        const last = chosen.plan[Math.min(item.keepThrough, chosen.plan.length - 1)];
        if (yOf(last.y) - descentOf(last) < t.mb) startNewPage(item.y);
        checkedChunkUntil = Math.min(item.keepThrough, chosen.plan.length - 1) + 1;
      } else if (yOf(item.y) - descentOf(item) < t.mb) {
        startNewPage(item.y);
      }
    }
    const Y = yOf(item.y);
    switch (item.kind) {
      case "text":
        page.drawText(item.text, { x: item.x, y: Y, size: item.size, font: item.font, color: item.color });
        break;
      case "icon":
        drawContactIcon(page, item.icon, item.x, Y, item.size, fonts.bold, t.contact);
        break;
      case "rule":
        page.drawLine({ start: { x: item.x0, y: Y }, end: { x: item.x1, y: Y }, thickness: item.thickness, color: item.color });
        break;
      case "photo":
        page.drawImage(item.img, { x: item.x, y: Y - item.h, width: item.w, height: item.h });
        drawRoundedPhoto(page, item.x, Y - item.h, item.w, item.h, t.photoRadius);
        break;
    }
  }

  // Subtle page numbers (multi-page documents only).
  const pageCount = doc.getPageCount();
  if (pageCount > 1) {
    for (let i = 0; i < pageCount; i += 1) {
      const pg = doc.getPage(i);
      const label = `Seite ${i + 1} von ${pageCount}`;
      const w = fonts.reg.widthOfTextAtSize(label, 8.5);
      pg.drawText(label, { x: (A4_WIDTH - w) / 2, y: t.mb - 10, size: 8.5, font: fonts.reg, color: META });
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
