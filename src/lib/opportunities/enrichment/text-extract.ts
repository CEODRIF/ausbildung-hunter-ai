import { normalizeOpportunityEmail } from "../email-export";

/**
 * Deterministic contact extraction from ALREADY-FETCHED public page text.
 *
 * Hard rule (no-invention contract): every value returned here appears
 * literally in the input text. Nothing is generated, guessed or
 * completed — an email is NEVER derived from the company name, a phone
 * number requires an explicit "tel" context, and a contact person must be
 * named next to an "Ansprechpartner"-style label. When the text documents
 * nothing, the answer is null — full stop.
 *
 * Pure module (no I/O): unit-testable without any network.
 */

/** Candidate email addresses (raw matches), validated + scored. */
export interface ExtractedEmail {
  value: string;
  /** How strongly the address reads as an application/contact address. */
  score: number;
}

const EMAIL_RE = /[\w.+-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+/g;

/** Domains that can never be a real company contact. */
const FAKE_DOMAIN_RE =
  /^(example|test|localhost|invalid|placeholder|no-reply|noreply)\.[a-z]{2,}$/i;

/** File extensions that indicate an image/document name, not an address. */
const FILE_EXT_RE = /\.(png|jpe?g|gif|webp|svg|pdf|docx?|xlsx?)$/i;

/** Local parts that are explicitly NOT application contact channels. */
const NON_CONTACT_LOCAL_RE =
  /^(no-?reply|donotreply|do-not-reply|abuse|legal|copyright|privacy|datenschutz|impersonum|impersonal|noreply)$/i;

/** Local parts strongly associated with applications/personal contact. */
const CONTACT_INTENT_RE =
  /(bewerb|karriere|personal|ausbild|azubi|jobs?|stellen|contact|anfrage|kontakt)/i;

/** Generic contact local parts (weaker signal than intent words). */
const GENERIC_LOCAL_RE = /^(info|post|mail|contact)$/i;

/** Personal-name-like local part — requires a dot ("anna.tenholt",
 *  "a.mueller"); a single plain word is NOT a personal name. */
const PERSON_LOCAL_RE = /^(?:[a-z]{1,3}\.)+[a-z]{2,}$/i;

/**
 * Extract + score every structurally valid email literally present in
 * `text`. Returns [] when none — callers must render that as
 * "not publicly available", never as a placeholder address.
 */
export function extractEmails(
  text: string,
  options: { companyDomain?: string | null } = {},
): ExtractedEmail[] {
  if (!text) return [];
  const seen = new Map<string, ExtractedEmail>();
  const matches = text.match(EMAIL_RE) ?? [];
  for (const raw of matches) {
    const value = normalizeOpportunityEmail(raw);
    if (!value) continue; // placeholder or structurally invalid
    const at = value.indexOf("@");
    const local = value.slice(0, at);
    const domain = value.slice(at + 1).toLowerCase();
    if (FAKE_DOMAIN_RE.test(domain)) continue;
    if (FILE_EXT_RE.test(value)) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    let score = 0;
    if (NON_CONTACT_LOCAL_RE.test(local)) score -= 6;
    if (CONTACT_INTENT_RE.test(local)) score += 4;
    if (PERSON_LOCAL_RE.test(local)) score += 2;
    if (options.companyDomain && domain === options.companyDomain) score += 2;
    if (GENERIC_LOCAL_RE.test(local)) score += 1;
    if (/(newsletter|marketing|press|media)$/.test(local)) score -= 2;
    seen.set(key, { value, score });
  }
  return [...seen.values()].sort((a, b) => b.score - a.score);
}

/**
 * The single best application contact email, or null. Ties resolve to the
 * first occurrence in the text (document order = publisher emphasis).
 */
export function bestEmail(
  text: string,
  options: { companyDomain?: string | null } = {},
): string | null {
  const ranked = extractEmails(text, options);
  return ranked.length > 0 ? ranked[0].value : null;
}

/**
 * German phone numbers with an explicit telephone context ("Tel.",
 * "Telefon", "phone") within 30 characters before the number, or a
 * country-prefixed +49 number. PLZ (5 digits) and years can never match:
 * every accepted form starts with + or 0 and carries at least 7 digits.
 */
export function extractPhone(text: string): string | null {
  if (!text) return null;
  const contextMatches = text.matchAll(
    /(?:tel(?:efon)?\.?|phone|tel\.?)\s*[:\-–—]?\s*([\+0][\d][\d\s\-/().]{5,22})/gi,
  );
  for (const match of contextMatches) {
    const candidate = cleanPhone(match[1]);
    if (candidate) return candidate;
  }
  const plus49 = text.match(/\+49[\s\-/]?\d{2,5}[\s\-/]?\d{4,8}(?:[\s\-/]?\d{0,4})?/);
  if (plus49) {
    const candidate = cleanPhone(plus49[0]);
    if (candidate) return candidate;
  }
  return null;
}

function cleanPhone(raw: string): string | null {
  const trimmed = raw.trim().replace(/[\s\-/().]+$/g, "");
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 15) return null;
  if (!/^\+?0?\d+$/.test(digits)) return null;
  // A bare 5-digit "0xxxx" is a PLZ, not a phone number.
  if (digits.length === 5) return null;
  return trimmed;
}

/**
 * Named contact person next to an "Ansprechpartner/in"-style label.
 * Only a FULLY NAMED person (with Frau/Herr) counts — an empty label
 * ("Ansprechpartner: —") or a non-name continuation must never produce a
 * value (no invention).
 */
export function extractContactPerson(text: string): string | null {
  if (!text) return null;
  const labelRe =
    /ansprechpartner(?:in)?\s*(?:(?:ist|war|sind)\s+)?\s*[:\-–—]?\s*((?:Frau|Herr)\s+[\p{L}'-]+(?:\s+[\p{L}'-]+){0,2})/iu;
  const match = text.match(labelRe);
  if (!match) return null;
  const name = match[1].trim();
  if (name.length < 4 || name.length > 60) return null;
  if (/@|http/.test(name)) return null;
  return name;
}

/** Kind of a company site page (drives data confidence). */
export type PageKind =
  | "impressum"
  | "kontakt"
  | "karriere"
  | "ausbildung"
  | "home"
  | "other";

/** Path-based page classification (deterministic, no content guessing). */
export function classifyPageUrl(url: string): PageKind {
  let path = "";
  try {
    path = new URL(url).pathname.toLowerCase();
  } catch {
    return "other";
  }
  if (path.includes("impressum")) return "impressum";
  if (/(^|\/)(kontakt|contact)(?=\/|$)/.test(path)) return "kontakt";
  if (/(^|\/)(karriere|careers?|stellenangebote|stellenanzeigen|jobs?|bewerbung)(?=\/|$)/.test(path))
    return "karriere";
  if (/(^|\/)(ausbildung|azubi|berufe)(?=\/|$)/.test(path)) return "ausbildung";
  if (path === "/" || path === "") return "home";
  return "other";
}

/** Confidence of a fact found on a given kind of company-site page. */
export function pageKindConfidence(kind: PageKind): "high" | "medium" | "low" {
  switch (kind) {
    case "impressum":
      return "high";
    case "kontakt":
      return "medium";
    case "karriere":
    case "ausbildung":
      return "medium";
    case "home":
      return "low";
    default:
      return "low";
  }
}

/** Confidence of a fact found on the JOB POSTING page itself (level 1). */
export const POSTING_PAGE_CONFIDENCE: "high" | "medium" | "low" = "medium";

/** Max of two confidences (null-safe). */
export function maxConfidence(
  a: "high" | "medium" | "low" | null,
  b: "high" | "medium" | "low" | null,
): "high" | "medium" | "low" | null {
  if (a === null) return b;
  if (b === null) return a;
  const rank = { high: 3, medium: 2, low: 1 } as const;
  return rank[a] >= rank[b] ? a : b;
}
