/**
 * Deckblatt design system — PURE, isomorphic (no server/browser imports).
 *
 * One source of truth for the AI background and the local composition:
 * each style defines (a) the FULL-BLEED abstract design direction asked
 * from the image model (GPT Image 2 — a background with reserved calm
 * zones and ABSOLUTELY NO people; the user's photo never reaches the
 * model) and (b) exact layout constants (design pixels on the
 * 1240×1754 A4 canvas) used by the HTML preview AND the canvas PNG
 * renderer, so the preview, the PDF and the PNG can never drift apart.
 *
 * Composition model (the "designed page" contract):
 *  - PORTRAIT_ZONE  — the user's uploaded Bewerbungsfoto, placed locally
 *    as a MAJOR page element (35–45% of the page width, 30–45% of the
 *    page height). The AI background is asked to keep exactly this area
 *    calm and low-contrast so the photo reads as part of the composition
 *    instead of a sticker pasted on top.
 *  - TITLE_ZONE     — the applicant's name (the strongest text element).
 *  - PROFESSION_ZONE— the target profession (prominent, clearly second).
 *  - CONTACT_ZONE   — a deliberate, high-contrast contact CARD (email,
 *    phone, address) that groups the details into one anchored block.
 *  - DECORATIVE     — accent band / divider drawn under the text.
 *
 * The model never draws any of these: no readable text of any kind, no
 * people, no frames for a portrait — it paints the full-bleed background
 * and the local renderer composites everything else.
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

/** Axis-aligned rectangle in design px (canvas coordinates, top-left origin). */
export interface DeckblattZone {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface DeckblattContactCard {
  x: number;
  y: number;
  w: number;
  h: number;
  radius: number;
  /** Semi-opaque background (rgba) — guarantees text contrast over the
   *  AI design in every style. */
  background: string;
  /** Hairline border (rgba). */
  border: string;
  borderWidth: number;
  /** Optional vertical accent strip on the card's left edge. */
  strip: { w: number; color: string } | null;
}

export interface DeckblattLayout {
  accent: string;
  ink: string;
  muted: string;
  nameFont: string;
  bodyFont: string;
  /** Neutral base gradient (top → bottom): the deterministic image the
   *  model edits (provider base) AND the local underlay behind the AI
   *  background, so the sheet can never fall back to raw white. */
  base: { top: string; bottom: string };
  /** Name block: x / first-line BASELINE y / max width / size / weight / color. */
  name: { x: number; y: number; w: number; size: number; weight: number; color: string };
  /** Profession: x / BASELINE y (single-line name case) / max width / size / weight / color. */
  profession: {
    x: number;
    y: number;
    w: number;
    size: number;
    weight: number;
    color: string;
  };
  /** Contact text lines (email, phone, address) — positioned INSIDE the
   *  contact card, drawn top-to-bottom. */
  contact: { x: number; y: number; w: number; size: number; lineGap: number; color: string };
  /** The portrait photo rect — the PORTRAIT_ZONE itself (cover-cropped,
   *  shape-clipped, ring + soft shadow around it). */
  photo: {
    x: number;
    y: number;
    w: number;
    h: number;
    shape: "circle" | "rect";
    radius: number;
  };
  /** Ring directly around the photo (style-coordinated, integrated look). */
  ring: { color: string; width: number };
  /** Soft drop shadow under the photo (lifts it off the design). */
  photoShadow: { color: string; blur: number; offsetY: number };
  /** The deliberate contact card (CONTACT_ZONE). */
  contactCard: DeckblattContactCard;
  /** Divider under the profession (drawn under all text). */
  divider: { x: number; y: number; w: number; h: number; color: string };
  /** Accent band (drawn under all text, over the background). */
  band: { x: number; y: number; w: number; h: number; color: string } | null;
  /**
   * Explicit composition zones — derived from the draw constants above,
   * used for the AI prompt's reserved areas and the safe-zone invariants:
   *  - title/profession: never overlap the portrait zone;
   *  - portrait: a major element (35–45% page width × 30–45% page height);
   *  - contact: a fully contained, high-contrast card near the bottom.
   */
  zones: {
    title: DeckblattZone;
    profession: DeckblattZone;
    portrait: DeckblattZone;
    contact: DeckblattZone;
  };
}

export interface DeckblattStyle {
  id: DeckblattStyleId;
  /** i18n key (deckblatt.style.<id>) for the visible style label. */
  labelKey: string;
  /** Visual direction of the FULL-BLEED background (no personal data, no
   *  readable text, no people — the model paints the background only). */
  designPrompt: string;
  layout: DeckblattLayout;
}

const SANS = "Arial, Helvetica, sans-serif";
const SERIF = "Georgia, 'Times New Roman', serif";

/** Contact text inset from the card edges (left/right) and first baseline offset. */
const CARD_TEXT_INSET_X = 44;
const CARD_TEXT_BASELINE_OFFSET = 64;

function layout(cfg: {
  accent: string;
  ink: string;
  muted: string;
  nameFont?: string;
  base: { top: string; bottom: string };
  name: { x: number; y: number; w: number; size: number; weight: number; color: string };
  profession: { x: number; y: number; w: number; size: number; weight: number; color: string };
  photo: {
    x: number;
    y: number;
    w: number;
    h: number;
    shape: "circle" | "rect";
    radius: number;
  };
  ring: { color: string; width: number };
  photoShadow?: { color: string; blur: number; offsetY: number };
  card: DeckblattContactCard;
  contactColor: string;
  divider: { x: number; y: number; w: number; h: number; color: string };
  band?: DeckblattLayout["band"];
}): DeckblattLayout {
  const { name, profession, photo, card } = cfg;
  return {
    accent: cfg.accent,
    ink: cfg.ink,
    muted: cfg.muted,
    nameFont: cfg.nameFont ?? SANS,
    bodyFont: SANS,
    base: cfg.base,
    name,
    profession,
    contact: {
      x: card.x + CARD_TEXT_INSET_X,
      y: card.y + CARD_TEXT_BASELINE_OFFSET,
      w: card.w - CARD_TEXT_INSET_X * 2,
      size: 34,
      lineGap: 52,
      color: cfg.contactColor,
    },
    photo,
    ring: cfg.ring,
    photoShadow:
      cfg.photoShadow ?? { color: "rgba(15,23,42,0.25)", blur: 42, offsetY: 18 },
    contactCard: card,
    divider: cfg.divider,
    band: cfg.band ?? null,
    zones: {
      // Worst case (two-line name): the name may extend one line stride
      // below its single-line zone, and the profession follows it.
      title: {
        x: name.x,
        y: Math.max(0, name.y - name.size),
        w: name.w,
        h: Math.round(name.size * 2.4),
      },
      profession: {
        x: profession.x,
        y: Math.max(0, profession.y - profession.size - Math.round(name.size * 1.15)),
        w: profession.w,
        h: Math.round(profession.size * 2.6),
      },
      portrait: { x: photo.x, y: photo.y, w: photo.w, h: photo.h },
      contact: { x: card.x, y: card.y, w: card.w, h: card.h },
    },
  };
}

/** The shared contact-card geometry — one deliberate footer block in every
 *  style (the treatment, not the position, varies per style). */
const CONTACT_CARD_RECT = { x: 96, y: 1408, w: 1048, h: 210 };

export const DECKBLATT_STYLES: Record<DeckblattStyleId, DeckblattStyle> = {
  modern: {
    id: "modern",
    labelKey: "deckblatt.style.modern",
    designPrompt:
      "modern German corporate design: clean minimal full-bleed composition on a soft light violet-tinted background, one large subtle geometric shape in muted violet flowing from the top-left corner, generous calm negative space, premium editorial aesthetic, flat vector-clean rendering, A4 portrait page",
    layout: layout({
      accent: "#6d5bd0",
      ink: "#17171f",
      muted: "#4b4b57",
      base: { top: "#f5f3fb", bottom: "#e6e0f5" },
      name: { x: 96, y: 340, w: 520, size: 96, weight: 700, color: "#17171f" },
      profession: { x: 96, y: 448, w: 520, size: 44, weight: 600, color: "#6d5bd0" },
      photo: { x: 688, y: 240, w: 456, h: 608, shape: "rect", radius: 36 },
      ring: { color: "rgba(255,255,255,0.9)", width: 6 },
      card: {
        ...CONTACT_CARD_RECT,
        radius: 24,
        background: "rgba(255,255,255,0.78)",
        border: "rgba(109,91,208,0.28)",
        borderWidth: 1.5,
        strip: { w: 6, color: "#6d5bd0" },
      },
      contactColor: "#3c3c48",
      divider: { x: 96, y: 507, w: 420, h: 6, color: "#6d5bd0" },
      band: { x: 0, y: 0, w: 26, h: DECKBLATT_HEIGHT, color: "#6d5bd0" },
    }),
  },
  classic: {
    id: "classic",
    labelKey: "deckblatt.style.classic",
    designPrompt:
      "traditional German Bewerbung cover page: elegant full-bleed warm paper-white background with the faintest paper texture, restrained classic serif elegance, extremely quiet and premium, subtle vertical tonal gradation only, A4 portrait page",
    layout: layout({
      accent: "#1f3a5f",
      ink: "#14181f",
      muted: "#444b55",
      nameFont: SERIF,
      base: { top: "#fcfbf8", bottom: "#efe9dd" },
      name: { x: 96, y: 332, w: 576, size: 88, weight: 700, color: "#14181f" },
      profession: { x: 96, y: 436, w: 576, size: 40, weight: 600, color: "#1f3a5f" },
      photo: { x: 704, y: 230, w: 440, h: 587, shape: "rect", radius: 6 },
      ring: { color: "rgba(255,255,255,0.95)", width: 6 },
      card: {
        ...CONTACT_CARD_RECT,
        radius: 6,
        background: "rgba(255,255,255,0.72)",
        border: "rgba(31,58,95,0.35)",
        borderWidth: 1.5,
        strip: null,
      },
      contactColor: "#3a414d",
      // Full-width hairline: deliberately passes BEHIND the portrait
      // (the photo is drawn over it) — the classic continuous rule.
      divider: { x: 96, y: 482, w: 1048, h: 3, color: "#1f3a5f" },
    }),
  },
  digital: {
    id: "digital",
    labelKey: "deckblatt.style.digital",
    designPrompt:
      "digital tech startup aesthetic: full-bleed deep navy background with subtle gradient glow in cyan and violet, abstract circuit-like thin lines, modern IT and e-commerce feel, high contrast, premium dark editorial composition, A4 portrait page",
    layout: layout({
      accent: "#22d3ee",
      ink: "#f4f7fb",
      muted: "#b9c4d4",
      base: { top: "#0d1526", bottom: "#1c2b4d" },
      name: { x: 96, y: 336, w: 520, size: 96, weight: 700, color: "#f4f7fb" },
      profession: { x: 96, y: 444, w: 520, size: 44, weight: 600, color: "#22d3ee" },
      photo: { x: 688, y: 236, w: 460, h: 614, shape: "rect", radius: 28 },
      ring: { color: "rgba(34,211,238,0.45)", width: 5 },
      photoShadow: { color: "rgba(4,8,18,0.55)", blur: 48, offsetY: 20 },
      card: {
        ...CONTACT_CARD_RECT,
        radius: 24,
        background: "rgba(9,14,27,0.66)",
        border: "rgba(34,211,238,0.35)",
        borderWidth: 1.5,
        strip: null,
      },
      contactColor: "#d5deea",
      divider: { x: 96, y: 503, w: 380, h: 5, color: "#22d3ee" },
    }),
  },
  technical: {
    id: "technical",
    labelKey: "deckblatt.style.technical",
    designPrompt:
      "industrial engineering aesthetic: full-bleed light grey technical grid background, precise thin lines, subtle isometric geometric details in steel blue, clean Mechatronik and engineering feel, flat technical illustration style, A4 portrait page",
    layout: layout({
      accent: "#2563eb",
      ink: "#101820",
      muted: "#46525f",
      base: { top: "#f4f6f8", bottom: "#dde5ee" },
      name: { x: 96, y: 336, w: 552, size: 92, weight: 700, color: "#101820" },
      profession: { x: 96, y: 442, w: 552, size: 44, weight: 600, color: "#2563eb" },
      photo: { x: 696, y: 232, w: 452, h: 602, shape: "rect", radius: 20 },
      ring: { color: "rgba(255,255,255,0.9)", width: 6 },
      card: {
        ...CONTACT_CARD_RECT,
        radius: 18,
        background: "rgba(255,255,255,0.82)",
        border: "rgba(37,99,235,0.30)",
        borderWidth: 1.5,
        strip: { w: 6, color: "#2563eb" },
      },
      contactColor: "#333d49",
      divider: { x: 96, y: 500, w: 360, h: 5, color: "#2563eb" },
      band: { x: 0, y: DECKBLATT_HEIGHT - 26, w: DECKBLATT_WIDTH, h: 26, color: "#2563eb" },
    }),
  },
  corporate: {
    id: "corporate",
    labelKey: "deckblatt.style.corporate",
    designPrompt:
      "premium corporate business design: full-bleed executive composition in deep charcoal and warm white areas, one elegant gold accent line, minimalist layout, subtle flat paper texture, A4 portrait page",
    layout: layout({
      accent: "#b08d3e",
      ink: "#14161a",
      muted: "#4a4d53",
      base: { top: "#f6f5f1", bottom: "#e9e6de" },
      name: { x: 96, y: 344, w: 560, size: 94, weight: 700, color: "#14161a" },
      profession: { x: 96, y: 452, w: 560, size: 44, weight: 600, color: "#b08d3e" },
      photo: { x: 704, y: 244, w: 440, h: 587, shape: "rect", radius: 4 },
      ring: { color: "rgba(255,255,255,0.85)", width: 5 },
      card: {
        ...CONTACT_CARD_RECT,
        radius: 12,
        background: "rgba(255,255,255,0.76)",
        border: "rgba(176,141,62,0.42)",
        borderWidth: 1.5,
        strip: { w: 6, color: "#b08d3e" },
      },
      contactColor: "#3f4248",
      divider: { x: 96, y: 508, w: 300, h: 8, color: "#b08d3e" },
    }),
  },
  minimal: {
    id: "minimal",
    labelKey: "deckblatt.style.minimal",
    designPrompt:
      "ultra minimal Scandinavian design: full-bleed near-white background, one small soft pastel accent shape in the upper right area, maximum calm white space, quiet and airy, flat rendering, A4 portrait page",
    layout: layout({
      accent: "#9a8f80",
      ink: "#1c1c1e",
      muted: "#5c5c60",
      base: { top: "#fdfdfc", bottom: "#f1efe8" },
      name: { x: 96, y: 372, w: 536, size: 100, weight: 700, color: "#1c1c1e" },
      profession: { x: 96, y: 480, w: 536, size: 42, weight: 600, color: "#9a8f80" },
      photo: { x: 664, y: 296, w: 540, h: 540, shape: "circle", radius: 270 },
      ring: { color: "rgba(255,255,255,0.9)", width: 6 },
      card: {
        ...CONTACT_CARD_RECT,
        radius: 24,
        background: "rgba(255,255,255,0.62)",
        border: "rgba(28,28,30,0.16)",
        borderWidth: 1,
        strip: null,
      },
      contactColor: "#4a4a4e",
      divider: { x: 96, y: 530, w: 220, h: 4, color: "#9a8f80" },
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

/** A zone as a percentage of the canvas (for the prompt's reserved areas). */
function zonePercent(z: DeckblattZone): string {
  const pct = (n: number, total: number) => Math.round((n / total) * 100);
  return `from ${pct(z.x, DECKBLATT_WIDTH)}% to ${pct(z.x + z.w, DECKBLATT_WIDTH)}% of the width and from ${pct(z.y, DECKBLATT_HEIGHT)}% to ${pct(z.y + z.h, DECKBLATT_HEIGHT)}% of the height`;
}

/**
 * The full GPT Image 2 prompt for the Deckblatt BACKGROUND.
 *
 * What enters the prompt: the profession (sanitized) and the style
 * direction plus the reserved-area geometry. What NEVER enters: name,
 * email, phone, address — the model is explicitly told not to invent
 * them, and the exact personal text is rendered locally afterwards.
 *
 * What the model is asked for: a FULL-BLEED abstract A4 background with
 * calm reserved zones and ABSOLUTELY NO people. The user's photo is NOT
 * part of the model's image input (the provider edits a deterministic
 * neutral base instead) — so a generated/extra person is structurally
 * impossible, and the prompt's negative constraints guard against the
 * model inventing a generic one.
 */
export function buildDeckblattPrompt(style: DeckblattStyle, profession: string): string {
  const safeProfession = profession.replace(/[^\p{L}\p{N}&'-]/gu, " ").trim();
  const z = style.layout.zones;
  return [
    "Create a premium full-bleed A4 portrait (2:3) background design for a professional German Bewerbung cover page (Deckblatt) for an Ausbildung application.",
    "",
    `Profession context (abstract inspiration only — never a literal depiction):\n${safeProfession || "general Ausbildung"}`,
    "",
    `Design style:\n${style.designPrompt}`,
    "",
    "Full-bleed canvas rules:",
    "- The design must fill the ENTIRE canvas edge to edge: 100% of the width and 100% of the height.",
    "- The background must reach all four edges and all four corners.",
    "- No white margins, no borders around the design, no empty panels, no letterboxing, no cut-out rectangles, no sub-image inside the canvas.",
    "",
    "Reserved areas — keep them calm, smooth and low-contrast (the application adds the real content there afterwards):",
    `- Portrait area (${zonePercent(z.portrait)}): a large portrait photograph will cover this area; keep it smooth, low-contrast and free of fine detail, busy patterns and important shapes.`,
    `- Title area (${zonePercent(z.title)}): a large name will be placed here; keep it clean, calm and legible.`,
    `- Profession area (${zonePercent(z.profession)}): a headline will be placed here; keep it unobtrusive.`,
    `- Contact area (${zonePercent(z.contact)}): small contact text on a card will be placed here; keep it unobtrusive.`,
    "",
    "CRITICAL — ABSOLUTELY NO PEOPLE IN THE IMAGE (hard requirement):",
    "- Do not include any person, human figure, face, head, body, hand or silhouette.",
    "- Do not include workers, candidates, students, models, mannequins, cartoon or robotic people.",
    "- Do not include the person from any reference image. Do not depict anyone at all.",
    "- The image must contain zero humans. If in doubt, keep the area abstract.",
    "",
    "No text and no invented data:",
    "- Do not render any readable text, letters, words, numbers or contact details anywhere in the image.",
    "- Do not invent applicant information.",
    "- Do not invent contact information.",
    "- Do not invent names.",
    "- Do not invent phone numbers.",
    "- Do not invent email addresses.",
    "- Do not invent addresses.",
    "- The exact applicant text and the applicant's own photograph are rendered separately by the application.",
    "- Do not add watermarks, logos, signatures or QR codes.",
    "",
    "Output requirements:",
    "- A4 portrait composition, one cohesive full-page design",
    "- professional German Bewerbung aesthetic, premium but restrained",
    "- strong visual hierarchy, modern editorial composition, professional whitespace",
    "- flat, print-friendly rendering, suitable for printing on A4 paper",
    "- no gaming aesthetic, no excessive decorative elements",
  ].join("\n");
}
