/**
 * Deckblatt design system — PURE, isomorphic (no server/browser imports).
 *
 * One source of truth for both the AI prompt and the local renderer:
 * each style defines (a) the visual direction asked from the image model
 * (GPT Image 2 — composition with the applicant's portrait as image
 * input, NO readable text of any kind) and (b) exact layout constants
 * (design pixels on the 1240×1754 A4 canvas) used by the HTML preview
 * AND the canvas PNG renderer, so the preview and the download can never
 * drift apart. The exact personal text is rendered locally afterwards.
 */

/** A4 portrait at ~150 dpi (210:297 ≈ 1240:1754). */
export const DECKBLATT_WIDTH = 1240;
export const DECKBLATT_HEIGHT = 1754;

export type DeckblattStyleId =
  | "modern"
  | "classic"
  | "digital"
  | "technical"
  | "corporate"
  | "minimal";

export interface DeckblattLayout {
  accent: string;
  ink: string;
  muted: string;
  nameFont: string;
  bodyFont: string;
  name: { x: number; y: number; size: number; weight: number; color: string };
  profession: {
    x: number;
    y: number;
    size: number;
    weight: number;
    color: string;
  };
  /** Contact lines (email, phone, address) — drawn top-to-bottom. */
  contact: { x: number; y: number; size: number; lineGap: number; color: string };
  photo: {
    x: number;
    y: number;
    w: number;
    h: number;
    shape: "circle" | "rect";
    radius: number;
  };
  divider: { x: number; y: number; w: number; h: number; color: string };
  /** Vertical band or frame decoration (drawn under all text). */
  band: { x: number; y: number; w: number; h: number; color: string } | null;
}

export interface DeckblattStyle {
  id: DeckblattStyleId;
  /** i18n key (deckblatt.style.<id>) for the visible style label. */
  labelKey: string;
  /** Visual composition direction for the image model (no personal data,
   *  no readable text — the exact text is rendered locally afterwards). */
  designPrompt: string;
  layout: DeckblattLayout;
}

const SANS = "Arial, Helvetica, sans-serif";
const SERIF = "Georgia, 'Times New Roman', serif";

function layout(partial: {
  accent: string;
  ink: string;
  muted: string;
  nameFont?: string;
  name?: Partial<DeckblattLayout["name"]>;
  profession?: Partial<DeckblattLayout["profession"]>;
  contact?: Partial<DeckblattLayout["contact"]>;
  photo?: Partial<DeckblattLayout["photo"]>;
  divider?: Partial<DeckblattLayout["divider"]>;
  band?: DeckblattLayout["band"];
}): DeckblattLayout {
  return {
    accent: partial.accent,
    ink: partial.ink,
    muted: partial.muted,
    nameFont: partial.nameFont ?? SANS,
    bodyFont: SANS,
    name: {
      x: 96,
      y: 250,
      size: 92,
      weight: 700,
      color: partial.ink,
      ...partial.name,
    },
    profession: {
      x: 96,
      y: 360,
      size: 44,
      weight: 600,
      color: partial.accent,
      ...partial.profession,
    },
    contact: {
      x: 96,
      y: 1330,
      size: 34,
      lineGap: 56,
      color: partial.muted,
      ...partial.contact,
    },
    photo: {
      x: 920,
      y: 210,
      w: 224,
      h: 296,
      shape: "rect",
      radius: 24,
      ...partial.photo,
    },
    divider: {
      x: 96,
      y: 420,
      w: 420,
      h: 6,
      color: partial.accent,
      ...partial.divider,
    },
    band: partial.band ?? null,
  };
}

export const DECKBLATT_STYLES: Record<DeckblattStyleId, DeckblattStyle> = {
  modern: {
    id: "modern",
    labelKey: "deckblatt.style.modern",
    designPrompt:
      "modern German corporate design: clean minimal layout on a soft light background, one large subtle geometric shape in muted violet, generous white space, premium editorial aesthetic, the applicant portrait in a rounded rectangle frame in the upper right, A4 portrait",
    layout: layout({
      accent: "#6d5bd0",
      ink: "#17171f",
      muted: "#4b4b57",
      band: { x: 0, y: 0, w: 26, h: DECKBLATT_HEIGHT, color: "#6d5bd0" },
    }),
  },
  classic: {
    id: "classic",
    labelKey: "deckblatt.style.classic",
    designPrompt:
      "traditional German Bewerbung cover page: elegant paper white background, thin refined dark navy border frame, restrained classic serif elegance, very subtle, the applicant portrait in a classic rectangular frame in the upper right, A4 portrait",
    layout: layout({
      accent: "#1f3a5f",
      ink: "#14181f",
      muted: "#444b55",
      nameFont: SERIF,
      photo: { shape: "rect", radius: 8 },
      divider: { x: 96, y: 420, w: 1048, h: 3 },
    }),
  },
  digital: {
    id: "digital",
    labelKey: "deckblatt.style.digital",
    designPrompt:
      "digital tech startup aesthetic: dark navy background with subtle gradient glow in cyan and violet, abstract circuit-like thin lines, modern IT and e-commerce feel, high contrast, the applicant portrait in a circle frame in the upper right, A4 portrait",
    layout: layout({
      accent: "#22d3ee",
      ink: "#f4f7fb",
      muted: "#b9c4d4",
      name: { color: "#f4f7fb" },
      photo: { x: 908, y: 220, w: 236, h: 236, shape: "circle", radius: 118 },
    }),
  },
  technical: {
    id: "technical",
    labelKey: "deckblatt.style.technical",
    designPrompt:
      "industrial engineering aesthetic: light grey technical grid background, precise thin lines, subtle isometric geometric details in steel blue, clean Mechatronik and engineering feel, the applicant portrait in a rounded rectangle frame in the upper right, A4 portrait",
    layout: layout({
      accent: "#2563eb",
      ink: "#101820",
      muted: "#46525f",
      band: { x: 0, y: 1754 - 26, w: DECKBLATT_WIDTH, h: 26, color: "#2563eb" },
    }),
  },
  corporate: {
    id: "corporate",
    labelKey: "deckblatt.style.corporate",
    designPrompt:
      "premium corporate business design: deep charcoal and white split composition, one elegant gold accent line, executive minimalist layout, subtle paper texture, the applicant portrait in a rectangular frame in the upper right, A4 portrait",
    layout: layout({
      accent: "#b08d3e",
      ink: "#14161a",
      muted: "#4a4d53",
      divider: { x: 96, y: 420, w: 300, h: 8 },
    }),
  },
  minimal: {
    id: "minimal",
    labelKey: "deckblatt.style.minimal",
    designPrompt:
      "ultra minimal Scandinavian design: pure white background, one small soft pastel accent shape near the top, maximum white space, calm and airy, the applicant portrait in a circle frame on the right side, A4 portrait",
    layout: layout({
      accent: "#9a8f80",
      ink: "#1c1c1e",
      muted: "#5c5c60",
      name: { size: 100 },
      photo: { shape: "circle", radius: 112, w: 224, h: 224, x: 932, y: 224 },
    }),
  },
};

/**
 * Keyword map — substring-friendly on purpose: German occupation names are
 * compounds ("Fachinformatiker", "Bankkaufmann"), so a strict left word
 * boundary would miss them. Order matters (first match wins):
 * digital → technical → corporate → classic → minimal, else "modern".
 */
const STYLE_BY_KEYWORDS: Array<[DeckblattStyleId, RegExp]> = [
  [
    "digital",
    /informatik|entwickl|software|\bdigital|\bdata|(^|\b)it[-\s]|e-?commerce|ecommerce|\bweb\b|\bonline\b|marketing/i,
  ],
  [
    "technical",
    /mechatronik|technik|elektro|elektrik|mechanik|anlagen|automation|\bkfw|k[äa]lte|industrial|ingenieur|zahnrad|vermessung/i,
  ],
  [
    "corporate",
    /kaufmann|kauffrau|b[üu]ro|verwaltung|management|controlling|personal|\bhr\b|logistik|vertrieb|handelsvertreter/i,
  ],
  [
    "classic",
    /bank|versicher|finanz|steuer|\brecht\b|hotellerie|gastronomie|pflege/i,
  ],
  ["minimal", /design|kreativ|medien|kunst|fotograf|grafik/i],
];

/**
 * Deterministic style selection from the profession (no extra model call,
 * no random UI behavior): first keyword match wins, else "modern".
 */
export function selectDeckblattStyle(profession: string): DeckblattStyle {
  const p = profession.trim();
  for (const [id, re] of STYLE_BY_KEYWORDS) {
    if (re.test(p)) return DECKBLATT_STYLES[id];
  }
  return DECKBLATT_STYLES.modern;
}

/**
 * The full GPT Image 2 prompt for the Deckblatt composition.
 *
 * What enters the prompt: the profession (sanitized) and the style
 * direction. What NEVER enters: name, email, phone, address — the model
 * is explicitly told not to invent them, and the exact personal text is
 * rendered locally afterwards (render.ts / deckblatt-sheet.tsx). The
 * uploaded portrait is NOT in the prompt — it is the model's image input
 * (see pollinations.ts), and the prompt below binds the model to using it
 * as the SAME person, identity-preserving.
 */
export function buildDeckblattPrompt(
  style: DeckblattStyle,
  profession: string,
): string {
  const safeProfession = profession.replace(/[^\p{L}\p{N}&'-]/gu, " ").trim();
  return [
    "Create a premium professional German Bewerbung Deckblatt for an Ausbildung application.",
    "Use the provided applicant portrait as the SAME person in the composition (realistic professional portrait integration).",
    "",
    `Profession:\n${safeProfession || "general Ausbildung"}`,
    "",
    `Design style:\n${style.designPrompt}`,
    "",
    "Requirements:",
    "- A4 portrait composition",
    "- professional German Bewerbung aesthetic",
    "- premium but restrained",
    "- modern editorial composition",
    "- strong visual hierarchy",
    "- elegant typography areas, kept completely clean and empty",
    "- professional whitespace",
    "- subtle geometric or corporate design elements",
    "- clean composition",
    "- suitable for a German Ausbildung application",
    "- suitable for printing",
    "- no gaming aesthetic",
    "- no excessive decorative elements",
    "",
    "CRITICAL:",
    "Do not invent applicant information.",
    "Do not invent contact information.",
    "Do not invent names.",
    "Do not invent phone numbers.",
    "Do not invent email addresses.",
    "Do not invent addresses.",
    "The exact applicant text will be rendered separately by the application.",
    "Do not render any readable text, letters, words, numbers or contact details anywhere in the image.",
    "Do not transform the person's identity.",
    "Do not create a different person.",
    "Do not add unrelated people.",
    "The uploaded portrait should remain recognizable and natural.",
    "Do not add watermarks.",
    "Do not add logos unless explicitly provided by the application.",
    "Do not generate fake contact information.",
  ].join("\n");
}
