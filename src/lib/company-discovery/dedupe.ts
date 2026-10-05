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

// ---------------------------------------------------------------------------
// Run-level identity index (name + domain + email)
// ---------------------------------------------------------------------------

/**
 * The host of a website URL as a dedupe key: lower-cased, `www.` stripped.
 * A NAME alone can collide ("Siemens" at two locations) or miss a duplicate
 * ("Siemens AG" vs "siemens.de"); the official domain is independent evidence
 * of the same employer. An empty/invalid input yields "" (never a key).
 */
export function hostKeyOf(websiteUrl: string | null | undefined): string {
  if (!websiteUrl) return "";
  try {
    return new URL(websiteUrl).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** The e-mail address as a dedupe key (lower-cased, trimmed). "" when absent. */
export function emailKeyOf(email: string | null | undefined): string {
  return (email ?? "").trim().toLowerCase();
}

/** Which existing identity a newcomer would collide with — or `new`. */
export type DuplicateMatch = "new" | "name" | "domain" | "email";

/**
 * The run-level dedupe set with STRONG identity: a company is a duplicate
 * when ANY of its name key, official domain, or verified public email was
 * already seen in the run (§ dedupe: name + domain + email).
 *
 * The index is deliberately plain data (three Sets) so a continue-batch can
 * rebuild it from the persisted rows of the previous batch — the same
 * company is never processed twice, in a single batch or across them.
 */
export class CompanyIdentityIndex {
  private readonly nameKeys = new Set<string>();
  private readonly domainKeys = new Set<string>();
  private readonly emailKeys = new Set<string>();

  /**
   * Check a newcomer WITHOUT registering it. `name` is required (the key);
   * `domain`/`email` are only consulted when non-empty, so a company whose
   * domain/email are not yet known can still be caught by name — and, later,
   * registered with its full identity via {@link mark}.
   */
  check(
    name: string,
    domain: string | null | undefined = null,
    email: string | null | undefined = null,
  ): DuplicateMatch {
    if (name && this.nameKeys.has(name)) return "name";
    const host = hostKeyOf(domain ?? null);
    if (host && this.domainKeys.has(host)) return "domain";
    const address = emailKeyOf(email ?? null);
    if (address && this.emailKeys.has(address)) return "email";
    return "new";
  }

  /** Register a processed company's full identity. Empty parts are skipped. */
  mark(
    name: string,
    domain: string | null | undefined = null,
    email: string | null | undefined = null,
  ): void {
    if (name) this.nameKeys.add(name);
    const host = hostKeyOf(domain ?? null);
    if (host) this.domainKeys.add(host);
    const address = emailKeyOf(email ?? null);
    if (address) this.emailKeys.add(address);
  }

  /** How many distinct names the index holds (the dedupe set size). */
  get nameCount(): number {
    return this.nameKeys.size;
  }

  /**
   * The domains this run has already counted (bare hosts, key-normalized).
   * Lets a discovery source SKIP companies it would only re-discover — work
   * is never repeated without a reason.
   */
  knownDomains(): ReadonlySet<string> {
    return this.domainKeys;
  }
}
