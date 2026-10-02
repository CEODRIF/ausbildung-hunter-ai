/**
 * CV customization settings — the appearance/style configuration for the
 * single CV template.
 *
 * Pure & isomorphic (client + tests, no DOM/network). Stored as an OPTIONAL
 * field on the persisted `CvDocument` (see cv.ts) so it lives in the SAME
 * per-user localStorage key as the CV content — there is deliberately NO
 * second persistence store. `sanitizeCvCustomization` merges untrusted or
 * legacy data onto `defaultCvCustomization()` so every stored document always
 * resolves to a fully-valid settings object (defaults match the current
 * "Editorial Serif" design exactly).
 */

// ---------------------------------------------------------------------------
// Enums / unions
// ---------------------------------------------------------------------------

export type CvColumns = "one" | "two" | "mix";

export type CvFontId = "serif-classic" | "serif-modern" | "sans-classic" | "sans-modern";

export type CvPhotoShape = "portrait" | "rounded-portrait" | "square" | "rounded" | "circle";

export type CvHeadingCase = "uppercase" | "title" | "none";

export type CvAlign = "left" | "center";

export type CvPhotoPlacement = "right" | "left";

export type CvTitleStyle = "normal" | "italic";

/** Section keys that can be shown, hidden and reordered in the document. */
export const CvSectionKeys = [
  "summary",
  "experience",
  "education",
  "skills",
  "languages",
  "certificates",
  "projects",
  "interests",
] as const;

export type CvSectionKey = (typeof CvSectionKeys)[number];

// ---------------------------------------------------------------------------
// Font registry — web-safe stacks only (no @font-face, no external loading).
// Both the live preview and the print/PDF export are painted by the SAME
// browser, so a web-safe stack renders identically in both.
// ---------------------------------------------------------------------------

export interface CvFontOption {
  id: CvFontId;
  /** i18n key for the human-readable name (templates.customFont*). */
  labelKey: string;
  category: "serif" | "sans";
  stack: string;
}

export const CV_FONTS: CvFontOption[] = [
  {
    id: "serif-classic",
    labelKey: "templates.customFontClassicSerif",
    category: "serif",
    stack: '"Times New Roman", Times, "Liberation Serif", "DejaVu Serif", Georgia, serif',
  },
  {
    id: "serif-modern",
    labelKey: "templates.customFontModernSerif",
    category: "serif",
    stack: 'Georgia, Cambria, "Times New Roman", serif',
  },
  {
    id: "sans-classic",
    labelKey: "templates.customFontClassicSans",
    category: "sans",
    stack: '"Helvetica Neue", Arial, "Liberation Sans", "DejaVu Sans", sans-serif',
  },
  {
    id: "sans-modern",
    labelKey: "templates.customFontModernSans",
    category: "sans",
    stack: 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  },
];

export function cvFontStack(id: CvFontId): string {
  return CV_FONTS.find((f) => f.id === id)?.stack ?? CV_FONTS[0].stack;
}

/** Color presets for the Colors panel (professional, restrained set). */
export const CV_COLOR_PRESETS = [
  { id: "classic", labelKey: "templates.customPresetClassic", value: "#141414" },
  { id: "charcoal", labelKey: "templates.customPresetCharcoal", value: "#2b2b2b" },
  { id: "darkGray", labelKey: "templates.customPresetDarkGray", value: "#3a3a3a" },
  { id: "navy", labelKey: "templates.customPresetNavy", value: "#1f3a5f" },
] as const;

// ---------------------------------------------------------------------------
// Settings shape
// ---------------------------------------------------------------------------

export interface CvCustomizationSettings {
  layout: {
    columns: CvColumns;
    /** Vertical order of the content sections (only ones with data render). */
    sectionOrder: CvSectionKey[];
  };
  typography: {
    font: CvFontId;
    /** Body / list / bullet size, px. */
    baseSize: number;
    /** Full name size, px. */
    fullNameSize: number;
    /** Section heading size, px. */
    sectionHeadingSize: number;
    /** Entry (job title / degree) header size, px. */
    entryHeaderSize: number;
  };
  spacing: {
    /** Line height (unitless). */
    lineHeight: number;
    /** Vertical gap between list/entry items, px. */
    spaceBetween: number;
    /** Left & right page margin, mm. */
    leftRightMarginMm: number;
    /** Top & bottom page margin, mm. */
    topBottomMarginMm: number;
  };
  entries: {
    /** Whether dates are shown on the right of entries. */
    showDates: boolean;
    /** Whether location is shown on the right of entries. */
    showLocation: boolean;
    /** Whether achievement bullets are shown under experience. */
    showAchievements: boolean;
  };
  headings: {
    headingCase: CvHeadingCase;
    /** Font weight (400 | 600 | 700). */
    weight: number;
    /** Show the thin rule under each heading. */
    rule: boolean;
    /** Letter spacing, em. */
    letterSpacing: number;
  };
  colors: {
    primary: string; // body / name / titles
    secondary: string; // company / institution / contact
    heading: string; // section heading text
    accent: string; // bullet dots
    divider: string; // heading rule / footer divider
    link: string; // hyperlinks
  };
  header: {
    /** Name font weight (400 | 500 | 600 | 700 | 800). */
    nameWeight: number;
    /** Professional title size, px. */
    titleSize: number;
    titleStyle: CvTitleStyle;
    /** Contact line size, px. */
    contactSize: number;
    /** Extra spacing below the header, px. */
    headerSpacing: number;
    alignment: CvAlign;
    /** Which side the photo column sits on. */
    photoPlacement: CvPhotoPlacement;
  };
  photo: {
    /** Zoom (1 = fit, > 1 crops in). */
    zoom: number;
    /** Crop origin, 0–100 (%). */
    posX: number;
    posY: number;
    shape: CvPhotoShape;
    /** Photo width, px (height derived from the shape's aspect). */
    size: number;
  };
  links: {
    underline: boolean;
    /** Show a small leading icon on links (where supported). */
    icon: boolean;
  };
  footer: {
    visible: boolean;
    text: string;
    alignment: CvAlign;
  };
  sections: {
    visibility: Record<CvSectionKey, boolean>;
    /** Vertical gap between sections, px. */
    spacing: number;
  };
}

// ---------------------------------------------------------------------------
// Defaults — mirror the current "Editorial Serif" template exactly.
// ---------------------------------------------------------------------------

export const DEFAULT_SECTION_ORDER: CvSectionKey[] = [
  "summary",
  "experience",
  "education",
  "skills",
  "languages",
  "certificates",
  "projects",
  "interests",
];

function defaultVisibility(): Record<CvSectionKey, boolean> {
  return {
    summary: true,
    experience: true,
    education: true,
    skills: true,
    languages: true,
    certificates: true,
    projects: true,
    interests: true,
  };
}

export function defaultCvCustomization(): CvCustomizationSettings {
  return {
    layout: { columns: "one", sectionOrder: [...DEFAULT_SECTION_ORDER] },
    typography: {
      font: "serif-classic",
      baseSize: 12,
      fullNameSize: 30,
      sectionHeadingSize: 13,
      entryHeaderSize: 13,
    },
    spacing: {
      lineHeight: 1.5,
      spaceBetween: 12,
      leftRightMarginMm: 15,
      topBottomMarginMm: 14,
    },
    entries: { showDates: true, showLocation: true, showAchievements: true },
    headings: { headingCase: "uppercase", weight: 700, rule: true, letterSpacing: 0.05 },
    colors: {
      primary: "#141414",
      secondary: "#3a3a3a",
      heading: "#141414",
      accent: "#2a2a2a",
      divider: "#141414",
      link: "#3a3a3a",
    },
    header: {
      nameWeight: 700,
      titleSize: 19,
      titleStyle: "normal",
      contactSize: 11.5,
      headerSpacing: 0,
      alignment: "left",
      photoPlacement: "right",
    },
    photo: { zoom: 1, posX: 50, posY: 20, shape: "portrait", size: 128 },
    links: { underline: false, icon: false },
    footer: { visible: false, text: "", alignment: "center" },
    sections: { visibility: defaultVisibility(), spacing: 16 },
  };
}

// ---------------------------------------------------------------------------
// Defensive sanitization (untrusted persisted JSON → valid settings)
// ---------------------------------------------------------------------------

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function num(v: unknown, def: number, min: number, max: number): number {
  const n = typeof v === "number" && Number.isFinite(v) ? v : def;
  return Math.min(max, Math.max(min, n));
}

function int(v: unknown, def: number, min: number, max: number): number {
  return Math.round(num(v, def, min, max));
}

function bool(v: unknown, def: boolean): boolean {
  return typeof v === "boolean" ? v : def;
}

function str(v: unknown, def: string): string {
  return typeof v === "string" ? v : def;
}

function hexColor(v: unknown, def: string): string {
  return typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v.trim()) ? v.trim() : def;
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], def: T): T {
  return typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : def;
}

/**
 * Merge a (possibly partial/corrupt) persisted settings object onto the
 * defaults, clamping every numeric value and validating every enum. Returns a
 * brand-new object (idempotent: sanitizing an already-valid object yields an
 * equal one).
 */
export function sanitizeCvCustomization(raw: unknown): CvCustomizationSettings {
  const d = defaultCvCustomization();
  const r = isRecord(raw) ? raw : {};

  const layoutRaw = isRecord(r.layout) ? r.layout : {};
  const orderRaw = Array.isArray(layoutRaw.sectionOrder)
    ? layoutRaw.sectionOrder
    : d.layout.sectionOrder;
  const seen = new Set<CvSectionKey>();
  const sectionOrder = orderRaw
    .filter((k): k is CvSectionKey => CvSectionKeys.includes(k as CvSectionKey))
    .filter((k) => (seen.has(k) ? false : (seen.add(k), true)));
  // Append any sections that were missing (e.g. older data) at the end.
  for (const key of d.layout.sectionOrder) if (!seen.has(key)) sectionOrder.push(key);

  const typoRaw = isRecord(r.typography) ? r.typography : {};
  const spacingRaw = isRecord(r.spacing) ? r.spacing : {};
  const entriesRaw = isRecord(r.entries) ? r.entries : {};
  const headingsRaw = isRecord(r.headings) ? r.headings : {};
  const colorsRaw = isRecord(r.colors) ? r.colors : {};
  const headerRaw = isRecord(r.header) ? r.header : {};
  const photoRaw = isRecord(r.photo) ? r.photo : {};
  const linksRaw = isRecord(r.links) ? r.links : {};
  const footerRaw = isRecord(r.footer) ? r.footer : {};
  const sectionsRaw = isRecord(r.sections) ? r.sections : {};
  const visRaw = isRecord(sectionsRaw.visibility) ? sectionsRaw.visibility : {};

  return {
    layout: {
      columns: oneOf(layoutRaw.columns, ["one", "two", "mix"], d.layout.columns),
      sectionOrder,
    },
    typography: {
      font: oneOf(typoRaw.font, CV_FONTS.map((f) => f.id), d.typography.font),
      baseSize: num(typoRaw.baseSize, d.typography.baseSize, 9, 20),
      fullNameSize: num(typoRaw.fullNameSize, d.typography.fullNameSize, 16, 60),
      sectionHeadingSize: num(typoRaw.sectionHeadingSize, d.typography.sectionHeadingSize, 10, 24),
      entryHeaderSize: num(typoRaw.entryHeaderSize, d.typography.entryHeaderSize, 10, 24),
    },
    spacing: {
      lineHeight: num(spacingRaw.lineHeight, d.spacing.lineHeight, 1.05, 2.2),
      spaceBetween: int(spacingRaw.spaceBetween, d.spacing.spaceBetween, 0, 40),
      leftRightMarginMm: num(spacingRaw.leftRightMarginMm, d.spacing.leftRightMarginMm, 8, 30),
      topBottomMarginMm: num(spacingRaw.topBottomMarginMm, d.spacing.topBottomMarginMm, 8, 30),
    },
    entries: {
      showDates: bool(entriesRaw.showDates, d.entries.showDates),
      showLocation: bool(entriesRaw.showLocation, d.entries.showLocation),
      showAchievements: bool(entriesRaw.showAchievements, d.entries.showAchievements),
    },
    headings: {
      headingCase: oneOf(headingsRaw.headingCase, ["uppercase", "title", "none"], d.headings.headingCase),
      weight: int(headingsRaw.weight, d.headings.weight, 400, 800),
      rule: bool(headingsRaw.rule, d.headings.rule),
      letterSpacing: num(headingsRaw.letterSpacing, d.headings.letterSpacing, 0, 0.3),
    },
    colors: {
      primary: hexColor(colorsRaw.primary, d.colors.primary),
      secondary: hexColor(colorsRaw.secondary, d.colors.secondary),
      heading: hexColor(colorsRaw.heading, d.colors.heading),
      accent: hexColor(colorsRaw.accent, d.colors.accent),
      divider: hexColor(colorsRaw.divider, d.colors.divider),
      link: hexColor(colorsRaw.link, d.colors.link),
    },
    header: {
      nameWeight: int(headerRaw.nameWeight, d.header.nameWeight, 400, 800),
      titleSize: num(headerRaw.titleSize, d.header.titleSize, 12, 30),
      titleStyle: oneOf(headerRaw.titleStyle, ["normal", "italic"], d.header.titleStyle),
      contactSize: num(headerRaw.contactSize, d.header.contactSize, 9, 16),
      headerSpacing: int(headerRaw.headerSpacing, d.header.headerSpacing, 0, 40),
      alignment: oneOf(headerRaw.alignment, ["left", "center"], d.header.alignment),
      photoPlacement: oneOf(headerRaw.photoPlacement, ["right", "left"], d.header.photoPlacement),
    },
    photo: {
      zoom: num(photoRaw.zoom, d.photo.zoom, 1, 2.5),
      posX: int(photoRaw.posX, d.photo.posX, 0, 100),
      posY: int(photoRaw.posY, d.photo.posY, 0, 100),
      shape: oneOf(photoRaw.shape, ["portrait", "rounded-portrait", "square", "rounded", "circle"], d.photo.shape),
      size: int(photoRaw.size, d.photo.size, 72, 220),
    },
    links: {
      underline: bool(linksRaw.underline, d.links.underline),
      icon: bool(linksRaw.icon, d.links.icon),
    },
    footer: {
      visible: bool(footerRaw.visible, d.footer.visible),
      text: str(footerRaw.text, d.footer.text).slice(0, 200),
      alignment: oneOf(footerRaw.alignment, ["left", "center"], d.footer.alignment),
    },
    sections: {
      visibility: {
        summary: bool(visRaw.summary, d.sections.visibility.summary),
        experience: bool(visRaw.experience, d.sections.visibility.experience),
        education: bool(visRaw.education, d.sections.visibility.education),
        skills: bool(visRaw.skills, d.sections.visibility.skills),
        languages: bool(visRaw.languages, d.sections.visibility.languages),
        certificates: bool(visRaw.certificates, d.sections.visibility.certificates),
        projects: bool(visRaw.projects, d.sections.visibility.projects),
        interests: bool(visRaw.interests, d.sections.visibility.interests),
      },
      spacing: int(sectionsRaw.spacing, d.sections.spacing, 0, 48),
    },
  };
}

/** Aspect ratio (height / width) for each photo shape. */
export function photoAspect(shape: CvPhotoShape): number {
  switch (shape) {
    case "portrait":
      return 1.333; // ~3:4
    case "rounded-portrait":
      return 1.28;
    case "square":
    case "rounded":
    case "circle":
      return 1;
  }
}

/** border-radius for each photo shape. */
export function photoRadius(shape: CvPhotoShape): string {
  switch (shape) {
    case "circle":
      return "50%";
    case "rounded":
    case "rounded-portrait":
      return "10px";
    case "portrait":
    case "square":
      return "0";
  }
}
