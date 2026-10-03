/**
 * Deckblatt local renderer — the ONLY place where personal text meets the
 * AI design.
 *
 * Architecture (the "no invented data" contract):
 *  - The image model receives a design-only prompt (styles.ts) and returns
 *    a background WITHOUT any text.
 *  - The EXACT personal text (name, profession, email, phone, address) and
 *    the user's own photo are composited HERE, in the browser, from the
 *    values the user typed/uploaded — never by the model.
 *
 * Two consumers, one source of truth (the layout constants in styles.ts):
 *  - renderDeckblattPng() below → canvas → PNG data URL (download);
 *  - DeckblattSheet (components/deckblatt-sheet.tsx) → HTML/CSS preview and
 *    the print portal (PDF). Both use the SAME pure helpers
 *    (nameDisplayLines / fitFontSize / coverFit) so preview, PDF and PNG
 *    cannot drift apart.
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

/** Name block width in design px (left zone; the photo zone starts ~x 900). */
const NAME_MAX_WIDTH = 640;
/** Contact block width in design px (full sheet width minus margins). */
const CONTACT_MAX_WIDTH = DECKBLATT_WIDTH - 192;
/** Minimum font sizes below which text stops being print-legible. */
const NAME_MIN_SIZE = 48;
const CONTACT_MIN_SIZE = 22;

// ---------------------------------------------------------------------------
// Pure layout helpers (shared by canvas renderer AND HTML sheet)
// ---------------------------------------------------------------------------

/**
 * Explicit name line breaks, decided by character count so the canvas and
 * the HTML preview ALWAYS break at the same place (font metrics differ
 * slightly between canvas and CSS — a width-based wrap could diverge).
 */
export function nameDisplayLines(data: DeckblattData): string[] {
  const first = data.firstName.trim();
  const last = data.lastName.trim();
  if (!first && !last) return [""];
  const single = [first, last].filter(Boolean).join(" ");
  if (first && last && single.length > 24) return [first, last];
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

/** Final name font size per line (explicit break + fit clamp). */
export function nameLineSizes(data: DeckblattData, style: DeckblattStyle): number[] {
  return nameDisplayLines(data).map((line) =>
    Math.max(
      NAME_MIN_SIZE,
      fitFontSize(line, NAME_MAX_WIDTH, style.layout.name.size, true),
    ),
  );
}

/** Final contact font size (the widest contact line drives it). */
export function contactFontSize(data: DeckblattData, style: DeckblattStyle): number {
  const lines = contactDisplayLines(data);
  const widest = lines.reduce((a, b) => (a.length >= b.length ? a : b), "");
  return Math.max(
    CONTACT_MIN_SIZE,
    fitFontSize(widest, CONTACT_MAX_WIDTH, style.layout.contact.size, false),
  );
}

/** Contact lines in print order: email, phone, address. */
export function contactDisplayLines(data: DeckblattData): string[] {
  return [data.email.trim(), data.phone.trim(), data.address.trim()].filter(Boolean);
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
 * Drawing order: background (cover) → accent band → divider → photo
 * (cover + shape clip + soft ring) → name → profession → contact block.
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

  // 1. AI background — cover-fit (the provider may return any size).
  const bgFit = coverFit(
    background.naturalWidth,
    background.naturalHeight,
    DECKBLATT_WIDTH,
    DECKBLATT_HEIGHT,
  );
  ctx.drawImage(background, bgFit.sx, bgFit.sy, bgFit.sw, bgFit.sh, 0, 0, DECKBLATT_WIDTH, DECKBLATT_HEIGHT);

  const L = style.layout;

  // 2. Accent band (under all text, over the background).
  if (L.band) {
    ctx.fillStyle = L.band.color;
    ctx.fillRect(L.band.x, L.band.y, L.band.w, L.band.h);
  }

  // 3. Divider.
  ctx.fillStyle = L.divider.color;
  ctx.fillRect(L.divider.x, L.divider.y, L.divider.w, L.divider.h);

  // 4. Photo — cover-fit into the layout rect, shape-clipped, soft ring.
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
  // Ring around the photo (subtle, light — works on both light and dark
  // backgrounds).
  ctx.save();
  ctx.lineWidth = 6;
  ctx.strokeStyle = "rgba(255,255,255,0.55)";
  if (L.photo.shape === "circle") {
    ctx.beginPath();
    ctx.arc(L.photo.x + L.photo.w / 2, L.photo.y + L.photo.h / 2, L.photo.w / 2 - 3, 0, Math.PI * 2);
    ctx.stroke();
  } else {
    roundRectPath(ctx, L.photo.x + 3, L.photo.y + 3, L.photo.w - 6, L.photo.h - 6, L.photo.radius - 3);
    ctx.stroke();
  }
  ctx.restore();

  // 5. Name (explicit lines + per-line fit; canvas measures and clamps
  //    additionally if the estimate was optimistic).
  const nameLines = nameDisplayLines(data);
  const nameSizes = nameLineSizes(data, style);
  ctx.textBaseline = "alphabetic";
  let nameY = L.name.y;
  nameLines.forEach((line, i) => {
    const size = nameSizes[i];
    ctx.font = `${L.name.weight} ${size}px ${L.nameFont}`;
    const measured = ctx.measureText(line).width;
    const finalSize =
      measured > NAME_MAX_WIDTH
        ? Math.max(NAME_MIN_SIZE, Math.floor((NAME_MAX_WIDTH / measured) * size))
        : size;
    ctx.font = `${L.name.weight} ${finalSize}px ${L.nameFont}`;
    ctx.fillStyle = L.name.color;
    ctx.fillText(line, L.name.x, nameY);
    nameY += Math.round(finalSize * 1.12);
  });

  // 6. Profession.
  const professionSize = Math.max(
    28,
    fitFontSize(data.profession, NAME_MAX_WIDTH, L.profession.size, false),
  );
  ctx.font = `${L.profession.weight} ${professionSize}px ${L.bodyFont}`;
  ctx.fillStyle = L.profession.color;
  ctx.fillText(data.profession, L.profession.x, L.profession.y);

  // 7. Contact block (email / phone / address, top to bottom).
  const contactSize = contactFontSize(data, style);
  ctx.font = `400 ${contactSize}px ${L.bodyFont}`;
  ctx.fillStyle = L.contact.color;
  contactDisplayLines(data).forEach((line, i) => {
    ctx.fillText(line, L.contact.x, L.contact.y + i * L.contact.lineGap);
  });

  return canvas.toDataURL("image/png");
}
