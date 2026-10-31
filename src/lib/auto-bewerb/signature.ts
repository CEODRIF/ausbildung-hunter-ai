/**
 * AUTO BEWERB — Step 5: the candidate's GENUINE handwritten signature.
 *
 * Pure + isomorphic (no Supabase, no React) so the client and the server
 * share the exact same validation contract. The signature is a raw image
 * the USER uploads — it is NEVER generated or invented (no synthetic
 * script fonts, no cursive rendering).
 *
 * Storage contract (see engine.ts):
 *  - ONE signature per user, at a FIXED owner-scoped path in the private
 *    `application-attachments` bucket:
 *      `${userId}/auto-bewerb/signature/signature.png`  (PNG)
 *      `${userId}/auto-bewerb/signature/signature.jpg`  (JPEG)
 *  - Deliberately NOT in the `auto_bewerb_attachments` e-mail library: the
 *    signature is embedded INTO the cover-letter PDF (a separate attachment),
 *    never attached to the e-mail on its own.
 *  - Only PNG and JPEG are accepted — the two rasters pdf-lib embeds
 *    natively (`embedPng` / `embedJpg`). WEBP is rejected because the PDF
 *    renderer cannot embed it without a lossy conversion step.
 *  - Magic bytes are the source of truth (never the browser's MIME hint or
 *    file name).
 */

export type SignatureType = "png" | "jpeg";

export const SIGNATURE_MAX_BYTES = 5 * 1024 * 1024;

export const SIGNATURE_MIME: Record<SignatureType, string> = {
  png: "image/png",
  jpeg: "image/jpeg",
};

/** Extension of the stored object (JPEG output is "jpg"). */
export const SIGNATURE_EXT: Record<SignatureType, "png" | "jpg"> = {
  png: "png",
  jpeg: "jpg",
};

export type SignatureValidationResult =
  | { ok: true; type: SignatureType }
  | { ok: false; code: "empty" | "too_large" | "invalid_type" };

/** Magic-byte detection: PNG signature or JPEG SOI + APP marker. */
export function detectSignatureType(buffer: Buffer): SignatureType | null {
  if (buffer.length < 12) return null;
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47 &&
    buffer[4] === 0x0d && buffer[5] === 0x0a && buffer[6] === 0x1a && buffer[7] === 0x0a
  )
    return "png";
  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "jpeg";
  return null;
}

export function validateSignature(buffer: Buffer): SignatureValidationResult {
  if (buffer.length < 1) return { ok: false, code: "empty" };
  if (buffer.length > SIGNATURE_MAX_BYTES) return { ok: false, code: "too_large" };
  const type = detectSignatureType(buffer);
  if (!type) return { ok: false, code: "invalid_type" };
  return { ok: true, type };
}

/** The two FIXED owner-scoped storage paths (one per accepted format). */
export function signatureStoragePaths(userId: string): { png: string; jpg: string } {
  const base = `${userId}/auto-bewerb/signature/signature`;
  return { png: `${base}.png`, jpg: `${base}.jpg` };
}
