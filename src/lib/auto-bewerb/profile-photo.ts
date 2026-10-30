/**
 * AUTO BEWERB — profile photo (Bewerbungsfoto): validation + reference
 * contract. Pure and isomorphic (no Supabase, no React, no native modules)
 * so client components can share the exact limits with the server. The
 * storage writes, ownership checks and the raster processing live in the
 * engine / profile-photo-process (server-only).
 *
 * Security contract:
 *  - The upload's bytes are the source of truth (magic bytes), never the
 *    browser's MIME hint or file name.
 *  - Generated CVs NEVER store a client-provided URL. They store the opaque
 *    server-owned token `abphoto:v1:<sha256>:<ext>` (buildPhotoRef), which
 *    resolves to a storage path under the VERIFIED owner's folder prefix —
 *    the renderer cannot be pointed at arbitrary objects (the token has no
 *    path component; the hash is 256 bits).
 *  - Previously saved CVs keep their frozen token: replacing the current
 *    photo does not touch old objects, so old CVs never silently change.
 */

export type ProfilePhotoType = "png" | "jpeg" | "webp";

export const PROFILE_PHOTO_TYPES: readonly ProfilePhotoType[] = ["png", "jpeg", "webp"] as const;

/** Max RAW upload size (the processed object is smaller, same cap). */
export const PROFILE_PHOTO_MAX_BYTES = 5 * 1024 * 1024;

/** Longest edge of the processed object (CVs display ~23×32 mm; 1000 px is
 *  far beyond print resolution — anything larger only bloats the PDF). */
export const PROFILE_PHOTO_MAX_EDGE_PX = 1000;

/** A CV photo below 300 px per side is unreadable in print and almost
 *  never intentional (mirrors the deckblatt photo floor). */
export const PROFILE_PHOTO_MIN_EDGE_PX = 300;

/** Guard against pathologically large raster decodes (memory bound). */
export const PROFILE_PHOTO_HARD_MAX_EDGE_PX = 8000;

export const PROFILE_PHOTO_MIME: Record<ProfilePhotoType, string> = {
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

/** Extension of the STORED (processed) object. JPEG output is "jpg". */
export const PROFILE_PHOTO_EXT: Record<ProfilePhotoType, "png" | "jpg" | "webp"> = {
  png: "png",
  jpeg: "jpg",
  webp: "webp",
};

export const PROFILE_PHOTO_REF_PREFIX = "abphoto:v1:";

export type PhotoValidationResult =
  | { ok: true; type: ProfilePhotoType }
  | { ok: false; code: "empty" | "too_large" | "invalid_type" | "too_small" | "too_high_resolution" };

// ---------------------------------------------------------------------------
// Magic-byte validation (pure — the bytes, not the browser hint, decide)
// ---------------------------------------------------------------------------

export function detectPhotoType(buffer: Buffer): ProfilePhotoType | null {
  if (buffer.length < 12) return null;
  // PNG
  if (
    buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47 &&
    buffer[4] === 0x0d && buffer[5] === 0x0a && buffer[6] === 0x1a && buffer[7] === 0x0a
  )
    return "png";
  // JPEG (SOI + APP marker)
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "jpeg";
  // WEBP (RIFF....WEBP)
  if (
    buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
    buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50
  )
    return "webp";
  return null;
}

export function validateProfilePhoto(buffer: Buffer): PhotoValidationResult {
  if (buffer.length < 1) return { ok: false, code: "empty" };
  if (buffer.length > PROFILE_PHOTO_MAX_BYTES) return { ok: false, code: "too_large" };
  const type = detectPhotoType(buffer);
  if (!type) return { ok: false, code: "invalid_type" };
  const dims = readImageDimensions(buffer, type);
  if (dims) {
    const minEdge = Math.min(dims.width, dims.height);
    const maxEdge = Math.max(dims.width, dims.height);
    if (minEdge < PROFILE_PHOTO_MIN_EDGE_PX) return { ok: false, code: "too_small" };
    if (maxEdge > PROFILE_PHOTO_HARD_MAX_EDGE_PX) return { ok: false, code: "too_high_resolution" };
  }
  return { ok: true, type };
}

// ---------------------------------------------------------------------------
// Dimension readers (pure header parsing — no decoder dependency)
// ---------------------------------------------------------------------------

/** PNG: the IHDR chunk starts at byte 8 (length) + 4 ("IHDR") → 16/20. */
function pngDimensions(buffer: Buffer): { width: number; height: number } | null {
  if (buffer.length < 24) return null;
  if (buffer.toString("ascii", 12, 16) !== "IHDR") return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

/** WebP: one of the three known bitstream formats (VP8 / VP8L / VP8X). */
function webpDimensions(buffer: Buffer): { width: number; height: number } | null {
  if (buffer.length < 30) return null;
  const format = buffer.toString("ascii", 12, 16);
  if (format === "VP8 ") {
    // 3-byte bitstream size, then frame tag; width/height are 14-bit fields
    // at offsets 26/28 (little-endian, low 14 bits valid).
    return {
      width: buffer.readUInt16LE(26) & 0x3fff,
      height: buffer.readUInt16LE(28) & 0x3fff,
    };
  }
  if (format === "VP8L") {
    // 1 byte signature (0x2f) + a 32-bit little-endian field: bits 0–13
    // width-1, bits 14–27 height-1, bits 28–30 version (must NOT be masked
    // away — a premature mask truncates the upper height bits).
    const bits = buffer.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: (bits >> 14 & 0x3fff) + 1 };
  }
  if (format === "VP8X") {
    return {
      width: (buffer.readUInt32LE(24) & 0x00ffffff) + 1,
      height: (buffer.readUInt32LE(27) & 0x00ffffff) + 1,
    };
  }
  return null;
}

/** JPEG: walk the marker chain to the first SOFn frame header. */
function jpegDimensions(buffer: Buffer): { width: number; height: number } | null {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1];
    // Standalone markers without a payload.
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) {
      offset += 2;
      continue;
    }
    const segLen = buffer.readUInt16BE(offset + 2);
    if (marker >= 0xc0 && marker <= 0xc3) {
      // SOF0..SOF3: precision(1) height(2) width(2)
      return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
    }
    if (segLen < 2) return null;
    offset += 2 + segLen;
  }
  return null;
}

export function readImageDimensions(
  buffer: Buffer,
  type: ProfilePhotoType,
): { width: number; height: number } | null {
  if (type === "png") return pngDimensions(buffer);
  if (type === "webp") return webpDimensions(buffer);
  return jpegDimensions(buffer);
}

// ---------------------------------------------------------------------------
// Storage path + frozen CV reference token
// ---------------------------------------------------------------------------

export type ProfilePhotoStoredExt = "jpg" | "png" | "webp";

/** Owner-scoped private-bucket path (deduplicated by content hash). */
export function profilePhotoStoragePath(userId: string, hash: string, ext: ProfilePhotoStoredExt): string {
  return `${userId}/auto-bewerb/photo/${hash}.${ext}`;
}

/** The opaque, server-owned reference stored in CvDocument.personal.photo. */
export function buildPhotoRef(hash: string, ext: ProfilePhotoStoredExt): string {
  return `${PROFILE_PHOTO_REF_PREFIX}${hash}:${ext}`;
}

const PHOTO_REF_RE = /^abphoto:v1:([0-9a-f]{64}):(jpg|png|webp)$/;

export function parsePhotoRef(ref: unknown): { hash: string; ext: ProfilePhotoStoredExt } | null {
  if (typeof ref !== "string") return null;
  const m = ref.match(PHOTO_REF_RE);
  if (!m) return null;
  return { hash: m[1], ext: m[2] as ProfilePhotoStoredExt };
}

export function isPhotoRef(value: unknown): value is string {
  return parsePhotoRef(value) !== null;
}

export function photoExtMime(ext: ProfilePhotoStoredExt): string {
  return ext === "jpg" ? "image/jpeg" : ext === "png" ? "image/png" : "image/webp";
}
