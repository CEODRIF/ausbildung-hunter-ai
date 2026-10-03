import "server-only";

/**
 * Pollinations.ai image provider — SERVER ONLY.
 *
 * Model: `openai/gpt-image-2`, called through the OpenAI-compatible
 * `POST /v1/images/edits` endpoint (verified against the live Pollinations
 * model catalog: input_modalities text+image, max 16 reference images).
 *
 * What the model receives as IMAGE INPUT is a deterministic NEUTRAL base
 * image (buildDeckblattBaseImage): a style-anchored abstract gradient.
 * The applicant's photo is NOT sent to the provider — it stays in the
 * browser and on this API (validated, then composited locally by
 * render.ts / deckblatt-sheet.tsx). That makes a generated or duplicated
 * person structurally impossible: there is no person for the model to
 * incorporate, and the prompt adds hard negative constraints against the
 * model inventing one.
 *
 * Why a base image at all: the OpenAI-compatible /v1/images/edits
 * contract requires at least one image input. A style-anchored gradient
 * gives the model a full-bleed canvas with the right palette to build on.
 *
 * Hard security contract:
 *  - The API key is read from `process.env.POLLINATIONS_API_KEY` (NO
 *    NEXT_PUBLIC_ prefix) and is used in exactly one place: the Bearer
 *    header of the outbound request. It is never logged, never returned
 *    to the browser and never embedded in a URL or query parameter.
 *  - The provider payload contains ONLY the prompt (profession + style
 *    direction — no name/email/phone/address) and the neutral base image
 *    — never the applicant's photo.
 *  - Errors are classified so the route can (a) pick a user-safe German
 *    message and (b) decide whether the daily quota must be refunded.
 *
 * Error taxonomy:
 *  - provider_unauthorized    → 401/403 or missing key. NOT retried —
 *                                retrying an auth failure only hammers the
 *                                provider and burns quota time.
 *  - provider_rate_limited    → 429. Retried once after backoff.
 *  - provider_unavailable     → 5xx / timeout / network. Retried once.
 *  - provider_bad_request     → 400 (bad input: invalid image, size, …).
 *                                NOT retried (deterministic failure).
 *  - provider_content_blocked → 400 `content_blocked` (safety filter).
 *                                NOT retried.
 *  - provider_invalid_image   → 200, but no usable b64_json / too large.
 *                                NOT retried (deterministic failure).
 */
import { deflateSync } from "node:zlib";
import type { DeckblattStyle } from "./styles";

const POLLINATIONS_EDITS_URL = "https://gen.pollinations.ai/v1/images/edits";
const POLLINATIONS_MODEL = "openai/gpt-image-2";
/** A4-portrait output size (2:3) of the gpt-image model family. The local
 *  renderer cover-fits any result to the 1240×1754 sheet, so an
 *  occasionally different provider size never breaks the output. */
const POLLINATIONS_SIZE = "1024x1536";
/** Print-grade output (the Deckblatt must survive printing). */
const POLLINATIONS_QUALITY = "high";

/** GPT Image 2 with an image input can take longer than diffusion models
 *  under load; the per-attempt budget is generous but bounded. */
const ATTEMPT_TIMEOUT_MS = 180_000;
/** One retry with backoff for transient failures (429/5xx/timeout). */
const RETRY_BACKOFF_MS = 4_000;
/** A valid A4 composition should be far below this; anything else is a
 *  provider anomaly (error payload served as image, etc.). */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Deterministic neutral base image (PNG encoder — no dependencies)
// ---------------------------------------------------------------------------

const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE: ReadonlyArray<number> = (() => {
  const table = new Array<number>(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out[4] = type.charCodeAt(0);
  out[5] = type.charCodeAt(1);
  out[6] = type.charCodeAt(2);
  out[7] = type.charCodeAt(3);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

function hexToRgb(hex: string): [number, number, number] {
  const value = parseInt(hex.slice(1), 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * The NEUTRAL image input for the model: a deterministic vertical
 * gradient PNG (RGB, 8-bit, 512×768 = 2:3) in the style's palette
 * (top → bottom of style.layout.base).
 *
 * Deterministic: the same style always yields the same bytes (no
 * randomness, fixed deflate level) — so generations differ only through
 * the model's own variation, never through the payload.
 */
export function buildDeckblattBaseImage(style: DeckblattStyle): string {
  const w = 512;
  const h = 768;
  const top = hexToRgb(style.layout.base.top);
  const bottom = hexToRgb(style.layout.base.bottom);

  const raw = new Uint8Array(h * (1 + w * 3));
  for (let y = 0; y < h; y += 1) {
    const t = y / (h - 1);
    const r = Math.round(top[0] + (bottom[0] - top[0]) * t);
    const g = Math.round(top[1] + (bottom[1] - top[1]) * t);
    const b = Math.round(top[2] + (bottom[2] - top[2]) * t);
    const rowStart = y * (1 + w * 3);
    raw[rowStart] = 0; // PNG filter type: none
    for (let x = 0; x < w; x += 1) {
      const px = rowStart + 1 + x * 3;
      raw[px] = r;
      raw[px + 1] = g;
      raw[px + 2] = b;
    }
  }

  const ihdr = new Uint8Array(13);
  const ihdrView = new DataView(ihdr.buffer);
  ihdrView.setUint32(0, w);
  ihdrView.setUint32(4, h);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor (RGB)
  ihdr[10] = 0; // compression method
  ihdr[11] = 0; // filter method
  ihdr[12] = 0; // no interlace

  const png = concatBytes([
    PNG_SIGNATURE,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", new Uint8Array(deflateSync(raw, { level: 9 }))),
    pngChunk("IEND", new Uint8Array(0)),
  ]);
  return `data:image/png;base64,${Buffer.from(png).toString("base64")}`;
}

// ---------------------------------------------------------------------------
// Provider request
// ---------------------------------------------------------------------------

export type PollinationsErrorCode =
  | "provider_unauthorized"
  | "provider_rate_limited"
  | "provider_unavailable"
  | "provider_bad_request"
  | "provider_content_blocked"
  | "provider_invalid_image";

export class PollinationsError extends Error {
  readonly code: PollinationsErrorCode;
  constructor(code: PollinationsErrorCode, message: string) {
    super(message);
    this.name = "PollinationsError";
    this.code = code;
  }
}

/** True when a failed generation should be tried again (transient only). */
function isTransient(code: PollinationsErrorCode): boolean {
  return code === "provider_rate_limited" || code === "provider_unavailable";
}

interface ImageEditBody {
  model: string;
  prompt: string;
  image: Array<{ image_url: string }>;
  size: string;
  quality: string;
  response_format: "b64_json";
}

interface ImageEditResponse {
  data?: Array<{ b64_json?: string }>;
}

async function fetchOnce(body: ImageEditBody, apiKey: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ATTEMPT_TIMEOUT_MS);
  try {
    const response = await fetch(POLLINATIONS_EDITS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (response.status === 401 || response.status === 403) {
      throw new PollinationsError(
        "provider_unauthorized",
        `Pollinations rejected the API key (HTTP ${response.status}).`,
      );
    }
    if (response.status === 429) {
      throw new PollinationsError(
        "provider_rate_limited",
        "Pollinations rate limit exceeded (HTTP 429).",
      );
    }
    if (response.status === 400) {
      // Documented 400 codes: content_blocked, failed_to_download_image,
      // invalid_image_url, image_too_large, unsupported_image_media_type.
      // (The detail string is a controlled API message — never logged.)
      let detail = "";
      try {
        const errorBody = (await response.json()) as {
          error?: { code?: string; message?: string };
        };
        detail = `${errorBody.error?.code ?? ""} ${errorBody.error?.message ?? ""}`;
      } catch {
        // Non-JSON 400 body — treat as a plain bad request.
      }
      if (/content_blocked|blocked/i.test(detail)) {
        throw new PollinationsError(
          "provider_content_blocked",
          "The provider safety filter blocked the request.",
        );
      }
      throw new PollinationsError(
        "provider_bad_request",
        "The provider rejected the input (HTTP 400).",
      );
    }
    if (!response.ok) {
      throw new PollinationsError(
        "provider_unavailable",
        `Pollinations returned HTTP ${response.status}.`,
      );
    }

    const payload = (await response.json()) as ImageEditResponse;
    const b64 = payload.data?.[0]?.b64_json;
    if (typeof b64 !== "string" || b64.length === 0) {
      throw new PollinationsError(
        "provider_invalid_image",
        "Pollinations returned no image data (missing b64_json).",
      );
    }
    if (b64.length * 0.75 > MAX_IMAGE_BYTES) {
      throw new PollinationsError(
        "provider_invalid_image",
        "Image response too large.",
      );
    }
    return b64;
  } catch (error) {
    if (error instanceof PollinationsError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new PollinationsError(
        "provider_unavailable",
        `Pollinations request timed out after ${ATTEMPT_TIMEOUT_MS} ms.`,
      );
    }
    // Network-level failure (DNS, connection reset, …) — transient.
    throw new PollinationsError(
      "provider_unavailable",
      "Network error while contacting the image provider.",
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Generate the Deckblatt BACKGROUND. `baseImage` is the deterministic
 * neutral style base (buildDeckblattBaseImage) — the applicant's photo is
 * deliberately NOT part of this payload (it is composited locally after
 * the generation, so the model can never draw, duplicate or alter it).
 * Returns the generated image as base64 (the route wraps it into a data
 * URL for the browser).
 */
export async function generateDeckblattDesign(
  prompt: string,
  baseImage: string,
): Promise<string> {
  const apiKey = process.env.POLLINATIONS_API_KEY?.trim();
  if (!apiKey) {
    throw new PollinationsError(
      "provider_unauthorized",
      "POLLINATIONS_API_KEY is not configured on the server.",
    );
  }
  if (!baseImage) {
    throw new PollinationsError(
      "provider_bad_request",
      "No base image input was provided.",
    );
  }

  const body: ImageEditBody = {
    model: POLLINATIONS_MODEL,
    prompt,
    image: [{ image_url: baseImage }],
    size: POLLINATIONS_SIZE,
    quality: POLLINATIONS_QUALITY,
    response_format: "b64_json",
  };

  let lastError: PollinationsError | null = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return await fetchOnce(body, apiKey);
    } catch (error) {
      if (!(error instanceof PollinationsError)) throw error;
      lastError = error;
      if (!isTransient(error.code) || attempt === 2) break;
      // One backoff between the two attempts (deterministic — no jitter
      // needed for a single-user request path).
      await new Promise((resolve) => setTimeout(resolve, RETRY_BACKOFF_MS));
    }
  }
  throw lastError ?? new PollinationsError("provider_unavailable", "Unknown provider error.");
}
