/**
 * Company identity for discovery — Phase 2 (deterministic, conservative).
 *
 * Goal: "Siemens AG", "SIEMENS AG", "Siemens" and "Siemens Deutschland"
 * resolve to ONE company; two genuinely different companies are NEVER
 * merged just because their names look similar. When in doubt: do not merge.
 *
 * The key is derived from the SOURCE-DOCUMENTED company name only:
 *   1. strip ONE trailing legal-form TOKEN on the raw name with a word
 *      boundary ("Siemens AG" → "Siemens"; "Travelse" stays untouched —
 *      no boundary between "ll" and "se");
 *   2. strip the documented national suffix "Deutschland" as an independent
 *      trailing word (the user-specified merge case "Siemens Deutschland");
 *   3. the shared `normalizeIdentity` (NFD-strip, lowercase, a-z0-9);
 *   4. stub protection: if the core would shrink below 3 chars, fall back
 *      to the full normalized name.
 *
 * No fuzzy/substring similarity is ever used: "Bau AG" and "Bauen GmbH"
 * stay separate ("bau" vs "bauen"). Domain/website-based merging arrives
 * with the Phase 3 Company Resolver, where an identified official domain
 * provides independent evidence.
 */

import { normalizeIdentity } from "@/lib/opportunities/web-discovery";

/** Trailing legal form as an independent word (longest alternatives first). */
const LEGAL_FORM_RE =
  /\b(?:GmbH\s*&\s*Co\.\s*KG|GmbH|e\.K\.|E\.K\.|KG|AG|SE|OHG|GbR|MBH|Inc\.?|Ltd\.?|LLC|LLP|NV|SA|SARL|Pty)\s*$/i;

/** "… Deutschland" as an independent trailing word (case-insensitive). */
const NATIONAL_SUFFIX_RE = /\bDeutschland\s*$/i;

/** Minimum core length after stripping (stub protection). */
const MIN_CORE_LENGTH = 3;

/**
 * Deterministic company key from a source-documented name.
 * The full normalized name is the fallback, so the result is never empty
 * for a non-empty input.
 */
export function companyKeyOf(name: string | null): string {
  const normalized = normalizeIdentity(name);
  if (!normalized) return "";
  let core = (name as string).trim().replace(LEGAL_FORM_RE, "").trim();
  core = core.replace(NATIONAL_SUFFIX_RE, "").trim();
  core = normalizeIdentity(core);
  return core.length >= MIN_CORE_LENGTH ? core : normalized;
}

/**
 * Names that do not identify a real employer. A candidate with such a name
 * can never become a counted company (no invention, no guessing).
 */
const GENERIC_COMPANY_NAMES = new Set([
  "unbekannt",
  "unknown",
  "unbezeichnet",
  "bewerbung",
  "karriere",
  "jobboerse",
  "divers",
  "diverse",
  "verschiedene",
  "arbeitsagentur",
  "bundesagentur",
  "jobvermittlung",
  "vermittlung",
  "portal",
  "online",
]);

export function isUsableCompanyName(name: string | null): boolean {
  const normalized = normalizeIdentity(name);
  if (normalized.length < MIN_CORE_LENGTH) return false;
  if (/^\d+$/.test(normalized)) return false; // pure number, not a company
  if (GENERIC_COMPANY_NAMES.has(normalized)) return false;
  return true;
}
