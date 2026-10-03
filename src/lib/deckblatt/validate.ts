/**
 * Deckblatt validation — PURE and isomorphic (no server/browser imports).
 *
 * One source of truth used by BOTH sides:
 *  - the client (deckblatt-generator.tsx) validates before any request so
 *    the user gets inline field errors without a round trip;
 *  - the server route (/api/deckblatt/generate) re-validates the same rules
 *    on the untrusted request body (defense in depth).
 *
 * The result is intentionally i18n-free: it maps fields to error CODES
 * ("required" | "invalidEmail" | "invalidPhone") that each side maps to its
 * own translated messages. No personal data ever leaves these functions.
 */

export interface DeckblattForm {
  firstName: string;
  lastName: string;
  profession: string;
  email: string;
  phone: string;
  address: string;
}

export type DeckblattFieldKey = keyof DeckblattForm;

export type DeckblattFieldError = "required" | "invalidEmail" | "invalidPhone";

/** Hard input-length caps (server + client agree; also clamped in the API). */
export const DECKBLATT_FIELD_LIMITS: Record<DeckblattFieldKey, number> = {
  firstName: 40,
  lastName: 40,
  profession: 80,
  email: 120,
  phone: 30,
  address: 160,
};

/**
 * Practical email format check (RFC 5322 is overkill for a Bewerbung form):
 * one local part, one @, a domain with at least one dot and 2+ char TLD.
 */
export const DECKBLATT_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * German phone numbers start with + or 0, then digits and the usual
 * separators (spaces, parentheses, hyphens, slashes, dots).
 */
export const DECKBLATT_PHONE_RE = /^[+0][0-9][0-9 ()/.-]{4,29}$/;

export type DeckblattFieldErrors = Partial<Record<DeckblattFieldKey, DeckblattFieldError>>;

/** Coerce an unknown request body into the validated form shape (max-length
 *  clamp + trim). Never throws — a malformed body just fails validation. */
export function parseDeckblattForm(body: unknown): DeckblattForm {
  const record = (typeof body === "object" && body !== null ? body : {}) as Record<
    string,
    unknown
  >;
  const take = (key: DeckblattFieldKey): string => {
    const raw = record[key];
    const max = DECKBLATT_FIELD_LIMITS[key];
    return typeof raw === "string" ? raw.slice(0, max).trim() : "";
  };
  return {
    firstName: take("firstName"),
    lastName: take("lastName"),
    profession: take("profession"),
    email: take("email"),
    phone: take("phone"),
    address: take("address"),
  };
}

/**
 * Validate the form. Returns a map of field → error code (empty = valid).
 * Order of precedence per field: missing → "required", wrong format →
 * "invalidEmail" / "invalidPhone".
 */
export function validateDeckblattForm(form: DeckblattForm): DeckblattFieldErrors {
  const errors: DeckblattFieldErrors = {};
  for (const key of Object.keys(DECKBLATT_FIELD_LIMITS) as DeckblattFieldKey[]) {
    if (form[key].length === 0) errors[key] = "required";
  }
  if (errors.email === "required" || !DECKBLATT_EMAIL_RE.test(form.email)) {
    if (!errors.email) errors.email = "invalidEmail";
  }
  if (errors.phone === "required" || !DECKBLATT_PHONE_RE.test(form.phone)) {
    if (!errors.phone) errors.phone = "invalidPhone";
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Photo (client-side only — the file itself never leaves the browser)
// ---------------------------------------------------------------------------

/** Accepted MIME types for the Bewerbungsfoto. */
export const DECKBLATT_PHOTO_MIME_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;

export type DeckblattPhotoMime = (typeof DECKBLATT_PHOTO_MIME_TYPES)[number];

/** 10 MB raw file cap (the client downscales before anything is rendered). */
export const DECKBLATT_PHOTO_MAX_BYTES = 10 * 1024 * 1024;

/** Minimum edge in px — smaller photos do not print cleanly on A4. */
export const DECKBLATT_PHOTO_MIN_EDGE = 300;

/** Maximum edge in px — beyond that we only downscale, never need more. */
export const DECKBLATT_PHOTO_MAX_EDGE = 4000;

export type DeckblattPhotoFileError =
  | "invalidType"
  | "tooLarge"
  | "tooSmall"
  | "readError";

/** File-level checks (MIME + raw size). */
export function validateDeckblattPhotoFile(file: {
  type: string;
  size: number;
}): DeckblattPhotoFileError | null {
  if (!(DECKBLATT_PHOTO_MIME_TYPES as readonly string[]).includes(file.type)) {
    return "invalidType";
  }
  if (file.size > DECKBLATT_PHOTO_MAX_BYTES) return "tooLarge";
  return null;
}

/**
 * Server-side checks for the photo PAYLOAD — the base64 data URL the
 * client sends to /api/deckblatt/generate. The photo is now part of the
 * AI image input (portrait integration for GPT Image 2), so the body must
 * stay bounded: strict data-URL shape + a decoded byte cap.
 */
export type DeckblattPhotoPayloadError = "invalidFormat" | "tooLarge";

/** Decoded-photo cap for the request body (the client downscales first,
 *  so anything above this is a broken/malicious payload). */
export const DECKBLATT_PHOTO_DATA_URL_MAX_BYTES = 4 * 1024 * 1024;

const PHOTO_DATA_URL_RE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/;

export function validateDeckblattPhotoDataUrl(dataUrl: string): DeckblattPhotoPayloadError | null {
  if (typeof dataUrl !== "string" || dataUrl.length === 0) return "invalidFormat";
  if (!PHOTO_DATA_URL_RE.test(dataUrl)) return "invalidFormat";
  const b64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  if (b64.length * 0.75 > DECKBLATT_PHOTO_DATA_URL_MAX_BYTES) return "tooLarge";
  return null;
}

/** Dimension checks (both edges within the printable band). */
export function validateDeckblattPhotoDimensions(
  width: number,
  height: number,
): DeckblattPhotoFileError | null {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return "readError";
  }
  // Max edge first: an 11000px file is "tooLarge" even if the other edge is
  // tiny (downscaling would not save the aspect ratio).
  if (Math.max(width, height) > DECKBLATT_PHOTO_MAX_EDGE) return "tooLarge";
  if (Math.min(width, height) < DECKBLATT_PHOTO_MIN_EDGE) return "tooSmall";
  return null;
}
