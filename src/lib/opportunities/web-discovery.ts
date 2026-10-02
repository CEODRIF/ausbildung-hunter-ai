/**
 * Shared web helpers for the opportunity pipeline.
 *
 * The AI Ausbildung Search discovery layer that once lived here
 * (runWebDiscovery, candidate verification, page extraction and
 * multi-source merging) was removed together with that feature. The two
 * pure helpers below are still used by the shared company-enrichment
 * modules (enrichment/index, enrichment/cache, enrichment/company-site).
 */

/** The host of a URL, or "" when it cannot be parsed. */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

/** Deterministic identity normalization for dedupe/lookup: NFD-stripped
 *  diacritics, lowercase, a-z0-9 only. */
export function normalizeIdentity(value: string | null): string {
  if (!value) return "";
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}
