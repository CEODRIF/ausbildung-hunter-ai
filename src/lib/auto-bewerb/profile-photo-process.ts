/**
 * AUTO BEWERB — profile photo processing (SERVER ONLY).
 *
 * Raster work runs on @napi-rs/canvas (the same native module the PDF text
 * extraction already ships — prebuilt glibc binaries, serverExternalPackages
 * in next.config.ts). It is an OPTIMIZATION with a graceful fallback: when
 * the decoder is unavailable or a header-valid file decodes as corrupt, the
 * ORIGINAL validated bytes are stored instead — a photo must never be
 * rejected because an optimization failed.
 */
import "server-only";

import { createCanvas, loadImage, type Image } from "@napi-rs/canvas";
import {
  PROFILE_PHOTO_MAX_EDGE_PX,
  PROFILE_PHOTO_MIME,
  photoExtMime,
  parsePhotoRef,
  type ProfilePhotoStoredExt,
  type ProfilePhotoType,
} from "./profile-photo";

export interface ProcessedPhoto {
  buffer: Buffer;
  ext: ProfilePhotoStoredExt;
  mime: string;
  width: number;
  height: number;
  /** true when the bytes were re-encoded (false = original kept as-is). */
  optimized: boolean;
}

/**
 * Optimize the validated photo while PRESERVING its aspect ratio:
 *  - longest edge scaled down to PROFILE_PHOTO_MAX_EDGE_PX (never upscaled);
 *  - WebP → JPEG (pdf-lib can embed PNG/JPEG but not WebP);
 *  - large PNGs → JPEG (photos compress ~10× better; alpha is flattened on
 *    white — the standard CV-photo presentation);
 *  - small PNGs and already-fine JPEGs are kept byte-identical.
 */
export async function processProfilePhoto(
  buffer: Buffer,
  type: ProfilePhotoType,
): Promise<ProcessedPhoto | null> {
  let img: Image;
  try {
    img = await loadImage(buffer);
  } catch {
    return null;
  }

  const keepAsIs = (ext: ProfilePhotoStoredExt, mime: string): ProcessedPhoto => ({
    buffer,
    ext,
    mime,
    width: img.width,
    height: img.height,
    optimized: false,
  });

  const scale = Math.min(1, PROFILE_PHOTO_MAX_EDGE_PX / Math.max(img.width, img.height));
  const needsResize = scale < 1;

  if (type === "webp") {
    // WebP can never be embedded by pdf-lib → always re-encode to JPEG.
    return reencode(img, scale, true);
  }
  if (type === "jpeg") {
    if (!needsResize) return keepAsIs("jpg", PROFILE_PHOTO_MIME.jpeg);
    return reencode(img, scale, true);
  }
  // png: keep small graphics byte-identical; otherwise re-encode (JPEG for
  // photos — the size heuristic keeps sharp technical graphics as PNG).
  if (!needsResize && buffer.length <= 700_000) return keepAsIs("png", PROFILE_PHOTO_MIME.png);
  return reencode(img, scale, buffer.length > 700_000 || needsResize);
}

async function reencode(
  img: Image,
  scale: number,
  asJpeg: boolean,
): Promise<ProcessedPhoto | null> {
  try {
    const width = Math.max(1, Math.round(img.width * scale));
    const height = Math.max(1, Math.round(img.height * scale));
    const out = createCanvas(width, height);
    const ctx = out.getContext("2d");
    ctx.fillStyle = "#ffffff"; // flatten alpha on white (standard CV-photo)
    ctx.fillRect(0, 0, width, height);
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, 0, 0, width, height);
    const raw = asJpeg ? out.toBuffer("image/jpeg", 0.85) : out.toBuffer("image/png");
    return {
      buffer: Buffer.from(raw),
      ext: asJpeg ? "jpg" : "png",
      mime: asJpeg ? "image/jpeg" : "image/png",
      width,
      height,
      optimized: true,
    };
  } catch {
    return null;
  }
}

/**
 * Resolve a CV photo reference to a renderable data URL for the VERIFIED
 * owner. `fetchOwnerObject` is injected by the engine (it builds the storage
 * path from the session-verified userId — never from client input) and must
 * return null when the object is gone; the renderer then simply omits the
 * photo instead of failing the document.
 */
export async function resolvePhotoDataUrl(
  userId: string,
  ref: string | null,
  fetchOwnerObject: (userId: string, hash: string, ext: ProfilePhotoStoredExt) => Promise<Buffer | null>,
): Promise<string | null> {
  if (!ref) return null;
  // Legacy documents (CV Builder imports) embed a data URL directly.
  if (ref.startsWith("data:image/")) {
    return ref.length <= 8 * 1024 * 1024 ? ref : null;
  }
  const parsed = parsePhotoRef(ref);
  if (!parsed) return null;
  let buffer: Buffer | null = null;
  try {
    buffer = await fetchOwnerObject(userId, parsed.hash, parsed.ext);
  } catch {
    return null;
  }
  if (!buffer || buffer.length < 1) return null;
  // WebP cannot be embedded by pdf-lib — decode + re-encode in memory.
  if (parsed.ext === "webp") {
    const processed = await processProfilePhoto(buffer, "webp");
    if (!processed) return null;
    return `data:${processed.mime};base64,${processed.buffer.toString("base64")}`;
  }
  return `data:${photoExtMime(parsed.ext)};base64,${buffer.toString("base64")}`;
}
