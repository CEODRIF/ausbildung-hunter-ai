import "server-only";

/**
 * Pollinations.ai image provider — SERVER ONLY.
 *
 * Model: `openai/gpt-image-2`, called through the OpenAI-compatible
 * `POST /v1/images/edits` endpoint (verified against the live Pollinations
 * model catalog: input_modalities text+image, max 16 reference images).
 *
 * The user's Bewerbungsfoto is sent as the model's IMAGE INPUT
 * (`image: [{ image_url: <data URL> }]`) so the generated composition
 * contains the SAME person — positioned, cropped and framed only, never
 * transformed (the prompt in ./styles enforces identity preservation).
 * The prompt itself contains the profession + style direction only —
 * never name/email/phone/address.
 *
 * Hard security contract:
 *  - The API key is read from `process.env.POLLINATIONS_API_KEY` (NO
 *    NEXT_PUBLIC_ prefix) and is used in exactly one place: the Bearer
 *    header of the outbound request. It is never logged, never returned
 *    to the browser and never embedded in a URL or query parameter.
 *  - The portrait travels ONLY as a JSON body field to the provider —
 *    never as a URL query parameter, never in a log line.
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
 *  - provider_content_blocked → 400 `content_blocked` (safety filter,
 *                                e.g. a group photo). NOT retried.
 *  - provider_invalid_image   → 200, but no usable b64_json / too large.
 *                                NOT retried (deterministic failure).
 */

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
 * Generate the Deckblatt composition. `portraitDataUrl` is the user's
 * Bewerbungsfoto (validated base64 data URL) — sent to the model as image
 * input, identity-preserving. Returns the generated image as base64 (the
 * route wraps it into a data URL for the browser).
 */
export async function generateDeckblattDesign(
  prompt: string,
  portraitDataUrl: string,
): Promise<string> {
  const apiKey = process.env.POLLINATIONS_API_KEY?.trim();
  if (!apiKey) {
    throw new PollinationsError(
      "provider_unauthorized",
      "POLLINATIONS_API_KEY is not configured on the server.",
    );
  }
  if (!portraitDataUrl) {
    throw new PollinationsError(
      "provider_bad_request",
      "No portrait image input was provided.",
    );
  }

  const body: ImageEditBody = {
    model: POLLINATIONS_MODEL,
    prompt,
    image: [{ image_url: portraitDataUrl }],
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
