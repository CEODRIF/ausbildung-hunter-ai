import "server-only";

import { isIP } from "node:net";

import { isUnsafeIp } from "./url-guard";

/**
 * Server-side validation of property photo URLs.
 *
 * Images are ONLY ever obtained from two legitimate channels (see
 * ./discovery):
 *   1. metadata of pages WE are allowed to fetch (fetchable-policy domains,
 *      robots-checked: JSON-LD `image`, og:image / twitter:image), or
 *   2. image metadata returned BY the search provider as part of the
 *      publicly delivered search results.
 * The model's JSON answer is NEVER an image source (it would be
 * unverifiable — a fabricated photo presented as the real property).
 *
 * This module does NOT fetch image bytes (requirement: avoid server-side
 * fetching beyond the existing security policy). Validation is purely
 * syntactic + host-based; the browser loads the image directly from the
 * public origin.
 *
 * Rules (fail closed — an unparseable or unsafe URL simply yields no
 * photo, and the UI renders the neutral placeholder):
 *   - https: only. http: would be mixed content on our https app (the
 *     browser blocks it anyway, a broken tile); data:, blob:,
 *     javascript: and every other scheme are rejected outright.
 *   - no credentials in the URL.
 *   - hostname never localhost / *.local / *.internal; an IP-literal
 *     hostname must be a PUBLIC address (private / loopback / link-local
 *     / CGNAT / multicast / reserved ranges are rejected — the same table
 *     the SSRF guard uses for page fetches).
 *   - length cap + no control characters (defence against oversized or
 *     crafted URLs reaching the client).
 *   - relative references are resolved against `baseUrl` — fetched pages
 *     legitimately write og:image="/media/1.jpg"; the resolved result
 *     still has to pass every check above.
 *   - dedup, order preserved (first = primary card photo), capped.
 */

/** Max photo URLs kept per listing (first is the card photo). */
export const MAX_LISTING_IMAGES = 5;
const MAX_IMAGE_URL_LENGTH = 2048;

/** True when the string contains a control character (C0/C1) — never
 *  legitimate in a URL. (Code-point check: no regex escapes needed.) */
function hasControlCharacter(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) return true;
  }
  return false;
}

/**
 * Validate ONE candidate image URL. `baseUrl` (the page the reference was
 * taken from, or null for provider metadata, which is absolute) is used
 * only to resolve relative references. Returns the canonical https URL
 * or null.
 */
export function validateImageUrl(raw: unknown, baseUrl: string | null): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed.length > MAX_IMAGE_URL_LENGTH) return null;
  if (hasControlCharacter(trimmed)) return null;

  let u: URL;
  try {
    u = new URL(trimmed, baseUrl ?? undefined);
  } catch {
    return null; // relative without a base, or unparseable
  }
  if (u.protocol !== "https:") return null;
  if (u.username !== "" || u.password !== "") return null;

  const host = u.hostname.toLowerCase();
  if (host === "" || host === "localhost") return null;
  if (host.endsWith(".local") || host.endsWith(".internal")) return null;
  // IP-literal hostname: must be a public address. (We never fetch these
  // URLs server-side, so DNS rebinding is not a concern; the check keeps
  // the response itself free of internal-address references.)
  // Note: URL.hostname keeps the brackets on IPv6 literals ([::1]);
  // isIP() does not accept them, so strip before the version check.
  const ipHost = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (isIP(ipHost) !== 0 && isUnsafeIp(ipHost)) return null;

  u.hash = "";
  return u.toString();
}

/**
 * Validate a LIST of candidate image URLs (e.g. JSON-LD `image` array +
 * og:image). Order = priority (the first survivor is the card photo).
 * Never throws on malformed input.
 */
export function sanitizeImageUrls(rawUrls: unknown, baseUrl: string | null): string[] {
  if (!Array.isArray(rawUrls)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of rawUrls) {
    if (out.length >= MAX_LISTING_IMAGES) break;
    const validated = validateImageUrl(raw, baseUrl);
    if (validated !== null && !seen.has(validated)) {
      seen.add(validated);
      out.push(validated);
    }
  }
  return out;
}
