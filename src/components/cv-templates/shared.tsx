/**
 * Shared building blocks for the CV template renderers.
 *
 * Every template renders the SAME CvDocument + CvLabels into the SAME A4
 * sheet (identical width / min-height / print hooks). Only the presentation
 * differs. `CvDocument` (cv-document.tsx) is a thin dispatcher over this
 * registry; the preview and the print portal both go through it, so the
 * exported PDF is always the selected template.
 */
import type { CSSProperties, ReactNode } from "react";
import type { CvDocument } from "@/lib/templates/cv";
import {
  defaultCvCustomization,
  photoAspect,
  photoRadius,
  type CvCustomizationSettings,
  type CvFontId,
} from "@/lib/templates/cv-customization";

export const CV_SHEET_WIDTH = 794; // 210mm @ 96dpi
export const CV_SHEET_MIN_HEIGHT = 1123; // 297mm @ 96dpi

export interface CvLabels {
  summary: string;
  experience: string;
  education: string;
  skills: string;
  languages: string;
  certificates: string;
  projects: string;
  interests: string;
  /** "present"-style label for open-ended experience dates. */
  present: string;
  /** Accessible document title. */
  documentTitle: string;
}

export interface TemplateProps {
  cv: CvDocument;
  labels: CvLabels;
}

// ---------------------------------------------------------------------------
// Template palettes + color resolution
// ---------------------------------------------------------------------------

/** The built-in palette of one template (used while the user has NOT
 *  explicitly customized colors away from the classic defaults). */
export interface TemplatePalette {
  /** Name + main accent (headings, rules). */
  accent: string;
  /** Secondary accent (professional title, sub-values). */
  title: string;
  /** Body text. */
  body: string;
  /** Muted meta text (dates, locations, issuer). */
  meta: string;
  /** Bullet / list markers. */
  bullet: string;
  /** Links. */
  link: string;
}

export interface ResolvedTemplateColors {
  primary: string;
  secondary: string;
  heading: string;
  accent: string;
  divider: string;
  link: string;
  /** Title/sub-value tone derived from the template (only used while the
   *  user has not customized the secondary color). */
  title: string;
}

const CLASSIC_COLORS = defaultCvCustomization().colors;

/**
 * Template identity vs. user customization: each template has a built-in
 * palette (its visual design). When the user has explicitly changed a color
 * setting away from the classic defaults, the user's choice wins — so
 * customization carries over templates predictably, and a fresh template
 * selection shows its reference design exactly.
 */
export function resolveTemplateColors(
  s: CvCustomizationSettings,
  palette: TemplatePalette,
): ResolvedTemplateColors {
  const c = s.colors;
  const pick = (user: string, classic: string, tpl: string) =>
    user !== classic ? user : tpl;
  return {
    primary: pick(c.primary, CLASSIC_COLORS.primary, palette.body),
    secondary: pick(c.secondary, CLASSIC_COLORS.secondary, palette.meta),
    heading: pick(c.heading, CLASSIC_COLORS.heading, palette.accent),
    accent: pick(c.accent, CLASSIC_COLORS.accent, palette.bullet),
    divider: pick(c.divider, CLASSIC_COLORS.divider, palette.accent),
    link: pick(c.link, CLASSIC_COLORS.link, palette.link),
    title: pick(c.secondary, CLASSIC_COLORS.secondary, palette.title),
  };
}

/**
 * A template's built-in visual identity — its palette PLUS the typography
 * and spacing of its reference design (type scale, leading, margins, section
 * rhythm). The SAME override rule as colors applies, per field: while the
 * user has NOT explicitly changed a setting away from the classic defaults,
 * the template's built-in value is used; the user's choice always wins once
 * set. Classic never calls this — it IS the classic defaults.
 */
export interface TemplateIdentity extends TemplatePalette {
  font: CvFontId;
  baseSize: number;
  fullNameSize: number;
  sectionHeadingSize: number;
  entryHeaderSize: number;
  titleSize: number;
  contactSize: number;
  lineHeight: number;
  spaceBetween: number;
  leftRightMarginMm: number;
  topBottomMarginMm: number;
  sectionSpacing: number;
}

export function applyTemplateIdentity(
  s: CvCustomizationSettings,
  identity: TemplateIdentity,
): CvCustomizationSettings {
  const d = defaultCvCustomization();
  const keep = <T,>(user: T, def: T, tpl: T): T => (user !== def ? user : tpl);
  return {
    ...s,
    typography: {
      ...s.typography,
      font: keep(s.typography.font, d.typography.font, identity.font),
      baseSize: keep(s.typography.baseSize, d.typography.baseSize, identity.baseSize),
      fullNameSize: keep(s.typography.fullNameSize, d.typography.fullNameSize, identity.fullNameSize),
      sectionHeadingSize: keep(s.typography.sectionHeadingSize, d.typography.sectionHeadingSize, identity.sectionHeadingSize),
      entryHeaderSize: keep(s.typography.entryHeaderSize, d.typography.entryHeaderSize, identity.entryHeaderSize),
    },
    spacing: {
      ...s.spacing,
      lineHeight: keep(s.spacing.lineHeight, d.spacing.lineHeight, identity.lineHeight),
      spaceBetween: keep(s.spacing.spaceBetween, d.spacing.spaceBetween, identity.spaceBetween),
      leftRightMarginMm: keep(s.spacing.leftRightMarginMm, d.spacing.leftRightMarginMm, identity.leftRightMarginMm),
      topBottomMarginMm: keep(s.spacing.topBottomMarginMm, d.spacing.topBottomMarginMm, identity.topBottomMarginMm),
    },
    header: {
      ...s.header,
      titleSize: keep(s.header.titleSize, d.header.titleSize, identity.titleSize),
      contactSize: keep(s.header.contactSize, d.header.contactSize, identity.contactSize),
    },
    sections: {
      ...s.sections,
      spacing: keep(s.sections.spacing, d.sections.spacing, identity.sectionSpacing),
    },
  };
}

// ---------------------------------------------------------------------------
// Shared content helpers
// ---------------------------------------------------------------------------

export function formatDates(
  start: string,
  end: string,
  isCurrent: boolean,
  presentLabel: string,
): string {
  const s0 = start.trim();
  let e = end.trim();
  if (isCurrent) e = presentLabel;
  if (!s0 && !e) return "";
  if (!s0) return e;
  if (!e) return s0;
  return `${s0} – ${e}`;
}

export interface ContactItem {
  text: string;
  href?: string;
}

/** email / phone / location (+ website & linkedin as anchors) — same order
 *  and same rules in every template. */
export function buildContactItems(cv: CvDocument): ContactItem[] {
  const { personal } = cv;
  const items: ContactItem[] = [];
  for (const v of [personal.email, personal.phone, personal.location]) {
    const t = v.trim();
    if (t) items.push({ text: t });
  }
  const website = personal.website.trim();
  const linkedin = personal.linkedin.trim();
  if (website) items.push({ text: website, href: hrefFrom(website) });
  if (linkedin) items.push({ text: linkedin, href: hrefFrom(linkedin) });
  return items;
}

/** nationality | date of birth | availability (may be empty). */
export function buildOtherText(cv: CvDocument): string {
  const { personal } = cv;
  return [personal.nationality, personal.dateOfBirth, personal.availability]
    .map((v) => v.trim())
    .filter(Boolean)
    .join("  |  ");
}

export function hrefFrom(value: string): string {
  return /^https?:\/\//i.test(value) ? value : `https://${value}`;
}

/**
 * The A4 sheet frame — IDENTICAL in every template (same width, min-height,
 * white background, configurable mm margins exposed as the --cv-pad-* vars
 * that the @media print rules in globals.css consume).
 */
export function sheetStyle(
  s: CvCustomizationSettings,
  font: string,
  base: number,
  lineHeight: number,
  color: string,
): CSSProperties {
  const style: CSSProperties = {
    width: CV_SHEET_WIDTH,
    minHeight: CV_SHEET_MIN_HEIGHT,
    backgroundColor: "#ffffff",
    color,
    padding: `${s.spacing.topBottomMarginMm}mm ${s.spacing.leftRightMarginMm}mm`,
    fontFamily: font,
    fontSize: base,
    lineHeight,
  };
  (style as Record<string, string | number>)["--cv-pad-block"] = `${s.spacing.topBottomMarginMm}mm`;
  (style as Record<string, string | number>)["--cv-pad-inline"] = `${s.spacing.leftRightMarginMm}mm`;
  return style;
}

/** The photo box (shape/size/zoom/crop come from the shared customization,
 *  so photo settings carry over templates). Renders nothing without a photo. */
export function renderPhoto(
  cv: CvDocument,
  s: CvCustomizationSettings,
  border: string,
  documentTitle: string,
): ReactNode {
  const { personal } = cv;
  if (!personal.photo) return null;
  const photoW = s.photo.size;
  const photoH = Math.round(photoW * photoAspect(s.photo.shape));
  return (
    <div
      style={{
        width: photoW,
        height: photoH,
        overflow: "hidden",
        borderRadius: photoRadius(s.photo.shape),
        border: `1px solid ${border}`,
        flexShrink: 0,
      }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- user-uploaded data URL */}
      <img
        src={personal.photo}
        alt={personal.fullName.trim() ? documentTitle : ""}
        style={{
          width: "100%",
          height: "100%",
          objectFit: "cover",
          objectPosition: `${s.photo.posX}% ${s.photo.posY}%`,
          transform: `scale(${s.photo.zoom})`,
          display: "block",
        }}
      />
    </div>
  );
}
