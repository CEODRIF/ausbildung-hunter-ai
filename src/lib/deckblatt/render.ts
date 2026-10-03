/**
 * Deckblatt local renderer — the ONLY place where personal text meets the
 * AI design.
 *
 * Architecture (the "no invented data, no generated people" contract):
 *  - The image model receives a design-only prompt (styles.ts) and a
 *    deterministic NEUTRAL base image; it returns a full-bleed background
 *    WITHOUT any text and WITHOUT any people.
 *  - The EXACT personal text (name, profession, email, phone, address) and
 *    the user's own photo are composited HERE, in the browser, from the
 *    values the user typed/uploaded — never by the model. The portrait is
 *    a major page element (the style's PORTRAIT_ZONE), placed over the
 *    calm reserved area the background was asked to keep free.
 *
 * Two consumers, one source of truth (the layout constants in styles.ts):
 *  - renderDeckblattPng() below → canvas → PNG data URL (download);
 *  - DeckblattSheet (components/deckblatt-sheet.tsx) → HTML/CSS preview and
 *    the print portal (PDF). Both use the SAME pure helpers
 *    (nameDisplayLines / heroBaselines / fitFontSize / coverFit) so
 *    preview, PDF and PNG cannot drift apart.
 *
 * This module is DOM-safe to import anywhere: the canvas/document APIs are
 * only touched INSIDE renderDeckblattPng (browser), the helpers are pure.
 */
import {
  DECKBLATT_HEIGHT,
  DECKBLATT_WIDTH,
  type DeckblattStyle,
} from "./styles";

export interface DeckblattData {
  firstName: string;
  lastName: string;
  profession: string;
  email: string;
  phone: string;
  address: string;
}

/** Minimum font sizes below which text stops being print-legible.
 *  PROFESSION_MIN_SIZE is 26 (one notch below the name's 48): the longest
 *  German occupation names (43 chars, e.g. "Fachinformatiker für
 *  Anwendungsentwicklung") must still stay INSIDE their zone's gutter to
 *  the portrait instead of overflowing it. */
const NAME_MIN_SIZE = 48;
const PROFESSION_MIN_SIZE = 26;
const CONTACT_MIN_SIZE = 22;
/** The hero block's line stride (name → name → profession). */
const HERO_STRIDE = 1.15;

// ---------------------------------------------------------------------------
// Pure layout helpers (shared by canvas renderer AND HTML sheet)
// ---------------------------------------------------------------------------

/**
 * Explicit name line breaks, decided by character count so the canvas and
 * the HTML preview ALWAYS break at the same place (font metrics differ
 * slightly between canvas and CSS — a width-based wrap could diverge).
 * A combined name of more than 16 characters is split into first/last —
 * the two-line hero keeps each line large (the name is the strongest
 * element) instead of shrinking one long line to a small font.
 */
export function nameDisplayLines(data: DeckblattData): string[] {
  const first = data.firstName.trim();
  const last = data.lastName.trim();
  if (!first && !last) return [""];
  const single = [first, last].filter(Boolean).join(" ");
  if (first && last && single.length > 16) return [first, last];
  return [single];
}

/**
 * Deterministic "shrink to fit" estimate: the average advance of a
 * proportional font at size S is ≈ S × factor per character (0.60 for a
 * bold sans display face, 0.50 for regular body text — conservative, so
 * the shrink triggers early rather than late). Both renderers apply the
 * same formula; the canvas additionally measures and clamps if the
 * estimate was too optimistic.
 */
export function fitFontSize(
  text: string,
  availablePx: number,
  size: number,
  bold: boolean,
): number {
  if (!text) return size;
  const factor = bold ? 0.6 : 0.5;
  const estimated = text.length * size * factor;
  if (estimated <= availablePx) return size;
  return Math.floor((availablePx / estimated) * size);
}

/** Final name font size per line (explicit break + fit to the TITLE_ZONE). */
export function nameLineSizes(data: DeckblattData, style: DeckblattStyle): number[] {
  return nameDisplayLines(data).map((line) =>
    Math.max(
      NAME_MIN_SIZE,
      fitFontSize(line, style.layout.name.w, style.layout.name.size, true),
    ),
  );
}

/** Final profession font size (fit to its own zone width). */
export function professionFontSize(data: DeckblattData, style: DeckblattStyle): number {
  return Math.max(
    PROFESSION_MIN_SIZE,
    fitFontSize(data.profession, style.layout.profession.w, style.layout.profession.size, false),
  );
}

/** Final contact font size (the widest contact line drives it; fit to the
 *  contact card's inner width). */
export function contactFontSize(data: DeckblattData, style: DeckblattStyle): number {
  const lines = contactDisplayLines(data);
  const widest = lines.reduce((a, b) => (a.length >= b.length ? a : b), "");
  return Math.max(
    CONTACT_MIN_SIZE,
    fitFontSize(widest, style.layout.contact.w, style.layout.contact.size, false),
  );
}

/** Contact lines in print order: email, phone, address. */
export function contactDisplayLines(data: DeckblattData): string[] {
  return [data.email.trim(), data.phone.trim(), data.address.trim()].filter(Boolean);
}

/**
 * The hero block's BASELINES (canvas textBaseline "alphabetic" / CSS top
 * correction happens in the consumers):
 *  - name: the first line at layout.name.y, each further line one stride
 *    (size × 1.15) below;
 *  - profession / divider: at their single-line positions, pushed down by
 *    exactly one name stride when the name wraps to two lines — the hero
 *    block never overlaps itself regardless of the name length.
 */
export function heroBaselines(
  style: DeckblattStyle,
  data: DeckblattData,
): { name: number[]; profession: number; divider: number } {
  const L = style.layout;
  const lines = nameDisplayLines(data);
  const shift = lines.length > 1 ? Math.round(L.name.size * HERO_STRIDE) : 0;
  return {
    name: lines.map((_, i) => L.name.y + Math.round(i * L.name.size * HERO_STRIDE)),
    profession: L.profession.y + shift,
    divider: L.divider.y + shift,
  };
}

/**
 * "Cover" fit: scale the source to FILL the destination, centered (both
 * dimensions), returning the source rect to draw from. Pure math — used
 * for the AI background (any provider size) and the photo.
 */
export function coverFit(
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number,
): { sx: number; sy: number; sw: number; sh: number } {
  if (srcW <= 0 || srcH <= 0) return { sx: 0, sy: 0, sw: dstW, sh: dstH };
  const scale = Math.max(dstW / srcW, dstH / srcH);
  const sw = dstW / scale;
  const sh = dstH / scale;
  return {
    sx: (srcW - sw) / 2,
    sy: (srcH - sh) / 2,
    sw,
    sh,
  };
}

// ---------------------------------------------------------------------------
// Canvas PNG export (browser only)
// ---------------------------------------------------------------------------

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () =>
      reject(new Error("Could not decode an image for the Deckblatt render."));
    img.src = url;
  });
}

function roundRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const radius = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  if (typeof ctx.roundRect === "function") {
    ctx.roundRect(x, y, w, h, radius);
    return;
  }
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

/**
 * Compose the final A4 Deckblatt (1240×1754 design px ≈ 300-class print
 * detail) and return it as a PNG data URL.
 *
 * Drawing order: base gradient (full canvas) → AI background (full-bleed
 * cover) → accent band → divider → contact card → photo (shadow + cover +
 * shape clip + ring) → name → profession → contact block.
 */
export async function renderDeckblattPng(options: {
  style: DeckblattStyle;
  data: DeckblattData;
  backgroundUrl: string;
  photoUrl: string;
}): Promise<string> {
  const { style, data } = options;
  const [background, photo] = await Promise.all([
    loadImage(options.backgroundUrl),
    loadImage(options.photoUrl),
  ]);

  const canvas = document.createElement("canvas");
  canvas.width = DECKBLATT_WIDTH;
  canvas.height = DECKBLATT_HEIGHT;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D is not available in this browser.");
  ctx.imageSmoothingQuality = "high";

  const L = style.layout;

  // 1. Base gradient underlay (full canvas, edge to edge) — the style's
  //    neutral palette. The AI background always paints over it; it only
  //    shows if the provider image is missing or translucent, so the sheet
  //    can never fall back to raw white.
  const baseGradient = ctx.createLinearGradient(0, 0, 0, DECKBLATT_HEIGHT);
  baseGradient.addColorStop(0, L.base.top);
  baseGradient.addColorStop(1, L.base.bottom);
  ctx.fillStyle = baseGradient;
  ctx.fillRect(0, 0, DECKBLATT_WIDTH, DECKBLATT_HEIGHT);

  // 2. AI background — full-bleed cover-fit (the provider may return any
  //    size; the design is prompted to fill 100% of the canvas).
  const bgFit = coverFit(
    background.naturalWidth,
    background.naturalHeight,
    DECKBLATT_WIDTH,
    DECKBLATT_HEIGHT,
  );
  ctx.drawImage(background, bgFit.sx, bgFit.sy, bgFit.sw, bgFit.sh, 0, 0, DECKBLATT_WIDTH, DECKBLATT_HEIGHT);

  // 3. Accent band (under all text, over the background).
  if (L.band) {
    ctx.fillStyle = L.band.color;
    ctx.fillRect(L.band.x, L.band.y, L.band.w, L.band.h);
  }

  const hero = heroBaselines(style, data);

  // 4. Divider (the classic style's full-width rule passes BEHIND the
  //    portrait: the photo is drawn later and covers it there).
  ctx.fillStyle = L.divider.color;
  ctx.fillRect(L.divider.x, hero.divider, L.divider.w, L.divider.h);

  // 5. Contact card — the deliberate, high-contrast footer block.
  const card = L.contactCard;
  ctx.save();
  roundRectPath(ctx, card.x, card.y, card.w, card.h, card.radius);
  ctx.fillStyle = card.background;
  ctx.fill();
  if (card.strip) {
    ctx.clip();
    ctx.fillStyle = card.strip.color;
    ctx.fillRect(card.x, card.y, card.strip.w, card.h);
  }
  ctx.restore();
  ctx.save();
  roundRectPath(
    ctx,
    card.x + card.borderWidth / 2,
    card.y + card.borderWidth / 2,
    card.w - card.borderWidth,
    card.h - card.borderWidth,
    card.radius,
  );
  ctx.strokeStyle = card.border;
  ctx.lineWidth = card.borderWidth;
  ctx.stroke();
  ctx.restore();

  // 6. Photo — a MAJOR element (the style's PORTRAIT_ZONE): soft shadow,
  //    cover-fit into the zone, shape-clipped, style ring around it.
  ctx.save();
  if (L.photo.shape === "circle") {
    ctx.beginPath();
    ctx.arc(L.photo.x + L.photo.w / 2, L.photo.y + L.photo.h / 2, L.photo.w / 2, 0, Math.PI * 2);
  } else {
    roundRectPath(ctx, L.photo.x, L.photo.y, L.photo.w, L.photo.h, L.photo.radius);
  }
  ctx.shadowColor = L.photoShadow.color;
  ctx.shadowBlur = L.photoShadow.blur;
  ctx.shadowOffsetY = L.photoShadow.offsetY;
  ctx.fillStyle = "rgba(0,0,0,0.01)"; // invisible fill — the shadow is the goal
  ctx.fill();
  ctx.restore();

  const photoFit = coverFit(photo.naturalWidth, photo.naturalHeight, L.photo.w, L.photo.h);
  ctx.save();
  if (L.photo.shape === "circle") {
    ctx.beginPath();
    ctx.arc(L.photo.x + L.photo.w / 2, L.photo.y + L.photo.h / 2, L.photo.w / 2, 0, Math.PI * 2);
    ctx.clip();
  } else {
    roundRectPath(ctx, L.photo.x, L.photo.y, L.photo.w, L.photo.h, L.photo.radius);
    ctx.clip();
  }
  ctx.drawImage(
    photo,
    photoFit.sx,
    photoFit.sy,
    photoFit.sw,
    photoFit.sh,
    L.photo.x,
    L.photo.y,
    L.photo.w,
    L.photo.h,
  );
  ctx.restore();
  // Ring around the photo (style-coordinated — integrates it into the
  // design instead of reading as a white sticker).
  ctx.save();
  ctx.lineWidth = L.ring.width;
  ctx.strokeStyle = L.ring.color;
  if (L.photo.shape === "circle") {
    ctx.beginPath();
    ctx.arc(
      L.photo.x + L.photo.w / 2,
      L.photo.y + L.photo.h / 2,
      L.photo.w / 2 - L.ring.width / 2,
      0,
      Math.PI * 2,
    );
    ctx.stroke();
  } else {
    roundRectPath(
      ctx,
      L.photo.x + L.ring.width / 2,
      L.photo.y + L.ring.width / 2,
      L.photo.w - L.ring.width,
      L.photo.h - L.ring.width,
      Math.max(0, L.photo.radius - L.ring.width / 2),
    );
    ctx.stroke();
  }
  ctx.restore();

  // 7. Name (explicit lines + per-line fit to the TITLE_ZONE; canvas
  //    measures and clamps additionally if the estimate was optimistic).
  const nameLines = nameDisplayLines(data);
  const nameSizes = nameLineSizes(data, style);
  ctx.textBaseline = "alphabetic";
  nameLines.forEach((line, i) => {
    const size = nameSizes[i];
    ctx.font = `${L.name.weight} ${size}px ${L.nameFont}`;
    const measured = ctx.measureText(line).width;
    const finalSize =
      measured > L.name.w
        ? Math.max(NAME_MIN_SIZE, Math.floor((L.name.w / measured) * size))
        : size;
    ctx.font = `${L.name.weight} ${finalSize}px ${L.nameFont}`;
    ctx.fillStyle = L.name.color;
    ctx.fillText(line, L.name.x, hero.name[i]);
  });

  // 8. Profession (fit to its zone; pushed below a two-line name).
  const professionSize = professionFontSize(data, style);
  ctx.font = `${L.profession.weight} ${professionSize}px ${L.bodyFont}`;
  ctx.fillStyle = L.profession.color;
  ctx.fillText(data.profession, L.profession.x, hero.profession);

  // 9. Contact block (email / phone / address, top to bottom) — inside
  //    the card, so it is one anchored, contrast-guaranteed block.
  const contactSize = contactFontSize(data, style);
  ctx.font = `400 ${contactSize}px ${L.bodyFont}`;
  ctx.fillStyle = L.contact.color;
  contactDisplayLines(data).forEach((line, i) => {
    ctx.fillText(line, L.contact.x, L.contact.y + i * L.contact.lineGap);
  });

  return canvas.toDataURL("image/png");
}
