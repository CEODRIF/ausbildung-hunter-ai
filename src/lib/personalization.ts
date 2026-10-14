/**
 * Smart personalization for the application composer.
 *
 * One editable draft may contain three stable tokens:
 *
 *   {{company_name}}  the recipient's company name (resolved per recipient)
 *   {{contact_name}}  the recipient's contact person name
 *   {{greeting}}      the formal German greeting
 *
 * Every recipient's outgoing copy is rendered INDEPENDENTLY on the server
 * (see renderPersonalizedMessage): the draft keeps the tokens, each message
 * is built from that recipient's own data only, and no rendered output is
 * ever reused for another recipient (no cross-recipient leakage).
 *
 * This module is PURE (no I/O, no server imports) so the exact same rules
 * run client-side (editor hints, recipient table) and server-side (the
 * sending pipeline).
 *
 * Safety contract:
 *  - Recipient data (email, company, contact name) is UNTRUSTED input.
 *  - Inserted values are HTML-escaped in HTML contexts and are only ever
 *    written into TEXT nodes — never into tags or attributes. A token that
 *    ends up inside tag markup is left untouched and therefore caught by
 *    the validation step below.
 *  - Unresolvable variables fall back to safe, configurable constants.
 *    Rendered output that still contains a known token is an ERROR
 *    (PersonalizationError) — unresolved tokens are never sent.
 *  - Gender is NEVER guessed from first names. A personalized greeting
 *    requires an explicit "Herr …" / "Frau …" form in the contact name;
 *    anything else uses the general formal greeting.
 *  - Generic mailbox words (bewerbung, info, karriere, …) are never
 *    presented as a person's name.
 *
 * Tokens are inserted by the editor toolbar (document.execCommand
 * "insertText"); hand-typed variants with different spacing (e.g.
 * "{{ company_name }}") are deliberately NOT replaced — they fail
 * validation so a malformed variable can never reach a recipient.
 */

/* ------------------------------------------------------------------ *
 * Tokens
 * ------------------------------------------------------------------ */

export const COMPANY_TOKEN = "{{company_name}}";
export const CONTACT_TOKEN = "{{contact_name}}";
export const GREETING_TOKEN = "{{greeting}}";

export const PERSONALIZATION_TOKENS: readonly string[] = [
  COMPANY_TOKEN,
  CONTACT_TOKEN,
  GREETING_TOKEN,
];

/** Matches exactly the three known tokens (no whitespace variants). */
const TOKEN_RE = /\{\{(company_name|contact_name|greeting)\}\}/g;

/**
 * Validation pattern: the known tokens WITH optional inner whitespace.
 * Replacement only ever matches the exact token (so a hand-typed spaced
 * variant is never silently substituted), but validation treats it as an
 * unresolved variable — something that looks like our token never leaves
 * the building.
 */
const UNRESOLVED_TOKEN_RE = /\{\{\s*(company_name|contact_name|greeting)\s*\}\}/;

/** True when the string contains at least one exact known token. */
export function hasPersonalizationTokens(value: string): boolean {
  return (value ?? "").match(TOKEN_RE) !== null;
}

/* ------------------------------------------------------------------ *
 * Fallbacks (safe, configurable)
 * ------------------------------------------------------------------ */

/**
 * Used when no company can be identified reliably for a recipient.
 * Deliberately in the DATIVE so the templates read naturally after the
 * prepositions they use ("… bei Ihrem Unternehmen …", "… in Ihrem
 * Unternehmen …"). Never derived from the email address.
 */
export const COMPANY_FALLBACK = "Ihrem Unternehmen";

/** Pairs with "Sehr geehrte …" when no contact person is known. */
export const CONTACT_FALLBACK = "Damen und Herren";

/** The general formal German greeting — the ONLY default greeting. */
export const GREETING_FALLBACK = "Sehr geehrte Damen und Herren,";

/* ------------------------------------------------------------------ *
 * Company name resolution
 * ------------------------------------------------------------------ */

/**
 * Free-mail / webmail domains that must NEVER become a company name.
 * Matched against the registrable domain, so subdomain abuse
 * (bewerbung@mail.gmx.de) is covered too. Extend as new providers appear.
 */
const FREE_MAIL_DOMAINS = new Set([
  // DACH free providers
  "gmx.de",
  "gmx.net",
  "gmx.at",
  "gmx.ch",
  "gmx.us",
  "web.de",
  "t-online.de",
  "telering.de",
  "arcor.de",
  "1und1.de",
  "inet.com.de",
  // International free providers
  "gmail.com",
  "googlemail.com",
  "google.com",
  "outlook.com",
  "outlook.de",
  "hotmail.com",
  "hotmail.de",
  "live.com",
  "live.de",
  "msn.com",
  "yahoo.com",
  "yahoo.de",
  "ymail.com",
  "aol.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "proton.me",
  "protonmail.com",
  "zoho.com",
  "zoho.de",
  "mail.com",
  "rocketmail.com",
  "yandex.com",
  "yandex.ru",
  "rambler.ru",
  "qq.com",
  "163.com",
  "126.com",
  "sina.com",
  // Common EU/US free hosts
  "orange.fr",
  "free.fr",
  "sfr.fr",
  "wanadoo.fr",
  "laposte.net",
  "orange.nl",
  "ziggo.nl",
  "planet.nl",
  "kpnmail.nl",
  "voo.be",
  "skynet.be",
  "telenet.be",
  "att.net",
  "comcast.net",
  "verizon.net",
  "sbcglobal.net",
  "charter.net",
  "optusnet.com.au",
  "iinet.net.au",
]);

/**
 * Multi-label public suffixes: when the domain ends in one of these, the
 * registrable domain is the last THREE labels, not two (e.g. you register
 * "firma.berlin.de"; "job.de" is a TLD in its own right).
 */
const MULTI_LABEL_SUFFIXES = new Set([
  "job.de",
  "berlin.de",
  "hamburg.de",
  "bayern.de",
  "bw.de",
  "sth.de",
  "bawue.de",
  "co.uk",
  "org.uk",
  "ac.uk",
  "gov.uk",
  "com.au",
  "net.au",
  "org.au",
  "co.nz",
  "co.jp",
  "or.jp",
  "com.br",
  "co.in",
  "co.za",
  "com.tr",
]);

/**
 * Company display names for well-known employer domains where the
 * mechanical derivation (capitalise the first label) would be wrong.
 * This is the curated exception list — extend it freely; an entry always
 * wins over the heuristic below.
 */
const KNOWN_COMPANY_NAMES: Record<string, string> = {
  // Required examples (spec)
  "carrier.de": "Carrier",
  "bosch.de": "Bosch",
  "bmw.de": "BMW",
  // Common German employers (correct casing / full names)
  "siemens.de": "Siemens",
  "vw.de": "Volkswagen",
  "volkswagen.de": "Volkswagen",
  "mercedes-benz.de": "Mercedes-Benz",
  "adidas.de": "adidas",
  "allianz.de": "Allianz",
  "bahn.de": "Deutsche Bahn",
  "db.de": "Deutsche Bahn",
  "deutschebahn.de": "Deutsche Bahn",
  "telekom.de": "Deutsche Telekom",
  "lufthansa.de": "Lufthansa",
  "sap.de": "SAP",
  "pwc.de": "PwC",
  "kpmg.de": "KPMG",
  "deloitte.de": "Deloitte",
  "ey.com": "EY",
  "vodafone.de": "Vodafone",
  "zalando.de": "Zalando",
  "otto.de": "OTTO",
  "hpi.de": "HPI",
  "tum.de": "TUM",
  "kit.edu": "KIT",
};

/**
 * First labels that mark a GENERIC portal domain rather than a company
 * name. Derivation stops here (→ fallback / user override).
 */
const GENERIC_FIRST_LABELS = new Set([
  "job",
  "jobs",
  "karriere",
  "bewerbung",
  "bewerbungen",
  "career",
  "careers",
  "hr",
  "human-resources",
  "personal",
  "recruiting",
  "talent",
  "stellen",
  "stellenangebote",
  "info",
  "kontakt",
  "contact",
  "team",
  "mail",
  "post",
  "service",
  "support",
  "admin",
  "office",
  "vertrieb",
  "sales",
  "ueber",
  "unternehmen",
  "firma",
  "willkommen",
  "welcome",
  "start",
  "home",
  "www",
  "web",
  "m",
  "mobile",
  "app",
  "dev",
  "test",
  "demo",
  "example",
  "sub",
  "subdomain",
]);

/**
 * The registrable domain of a host: subdomains are stripped, multi-label
 * public suffixes (berlin.de, co.uk, …) are respected. "mail.karriere.bmw.de"
 * → "bmw.de". Pure string handling, no external service.
 */
export function registrableDomain(domain: string): string {
  const labels = (domain ?? "").toLowerCase().split(".");
  if (labels.length < 2) return (domain ?? "").toLowerCase();
  const lastTwo = labels.slice(-2).join(".");
  if (labels.length > 2 && MULTI_LABEL_SUFFIXES.has(lastTwo)) {
    return labels.slice(-3).join(".");
  }
  return lastTwo;
}

/** Domain part of an email address (lowercased), or null when absent. */
function domainOfEmail(email: string): string | null {
  const at = (email ?? "").lastIndexOf("@");
  if (at <= 0 || at === (email ?? "").length - 1) return null;
  // The local part must be a plain non-empty token (no whitespace, no
  // second "@"): a malformed address cannot be attributed to a domain.
  const local = email.slice(0, at);
  if (!/^[^\s@]{1,64}$/.test(local)) return null;
  const domain = email.slice(at + 1).trim().toLowerCase();
  if (
    !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(
      domain,
    )
  )
    return null;
  return domain;
}

export interface CompanyResolution {
  /** The display name, or null when it could not be identified reliably. */
  value: string | null;
  /**
   *   "user"       – explicit per-recipient override (always wins)
   *   "known"      – curated KNOWN_COMPANY_NAMES entry
   *   "domain"     – derived from the registrable domain (best effort)
   *   "unresolved" – generic provider / portal / unknown → use the fallback
   */
  source: "user" | "known" | "domain" | "unresolved";
}

/**
 * Resolve the company name for ONE recipient.
 *
 * Order: explicit user override → free-mail check → curated known name →
 * conservative domain derivation. The derivation only accepts a single
 * alphabetic first label that is not a generic portal word; everything
 * else (hyphenated labels, punycode, digits, generic words, free providers)
 * resolves to null and the caller uses COMPANY_FALLBACK or the override.
 */
export function resolveCompanyName(
  email: string,
  userOverride?: string | null,
): CompanyResolution {
  const override = (userOverride ?? "").trim();
  if (override) return { value: override.slice(0, 160), source: "user" };

  const domain = domainOfEmail(email);
  if (!domain) return { value: null, source: "unresolved" };

  const root = registrableDomain(domain);
  if (FREE_MAIL_DOMAINS.has(root) || FREE_MAIL_DOMAINS.has(domain)) {
    return { value: null, source: "unresolved" };
  }

  const known = KNOWN_COMPANY_NAMES[root];
  if (known) return { value: known, source: "known" };

  const first = root.split(".")[0];
  if (!/^[a-z][a-z0-9]*$/.test(first)) {
    // hyphenated labels, punycode (xn--…), leading digits — never guess
    return { value: null, source: "unresolved" };
  }
  if (GENERIC_FIRST_LABELS.has(first)) {
    return { value: null, source: "unresolved" };
  }
  return {
    value: first.charAt(0).toUpperCase() + first.slice(1),
    source: "domain",
  };
}

/* ------------------------------------------------------------------ *
 * Contact person + greeting resolution
 * ------------------------------------------------------------------ */

/**
 * Generic mailbox words that must NEVER be presented as a person's name,
 * no matter where they come from (spec list). Used as a defence-in-depth
 * check on explicitly provided contact names as well.
 */
export const GENERIC_PERSON_WORDS = new Set([
  "bewerbung",
  "bewerbungen",
  "info",
  "karriere",
  "jobs",
  "job",
  "hr",
  "kontakt",
  "contact",
  "recruiting",
  "personal",
  "office",
  "support",
  "admin",
  "sales",
  "team",
  "hello",
  "noreply",
  "no-reply",
  "mail",
  "post",
  "service",
]);

/**
 * Shape of a plausible person name: letters (incl. German umlauts),
 * marks, spaces, dots, hyphens and apostrophes; 1–80 chars; starts with a
 * letter. Rejects anything containing markup, URLs, digits or punctuation
 * that would break the salutation.
 */
const NAME_SHAPE_RE = /^[\p{L}][\p{L}\p{Mn}'’ .\-]{0,79}$/u;

/** "Herr …" / "Frau …" at the start, then the remaining name. */
const SALUTATION_RE = /^(herr|frau)\b[ .,\-–]*(.*)$/i;

function normalizeName(raw: string | null | undefined): string | null {
  const cleaned = (raw ?? "").replace(/\s+/g, " ").trim();
  if (!cleaned) return null;
  if (!NAME_SHAPE_RE.test(cleaned)) return null;
  return cleaned.slice(0, 80);
}

function isGenericPersonWord(value: string): boolean {
  return value
    .toLowerCase()
    .split(/\s+/)
    .some((word) => GENERIC_PERSON_WORDS.has(word));
}

function capitalizeFirst(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export interface ParsedSalutation {
  gender: "male" | "female";
  /** The name after "Herr"/"Frau" (titles kept, e.g. "Dr. Schmidt"). */
  name: string;
}

/**
 * Extract an EXPLICIT salutation from a contact name.
 *
 *   "Herr Mustermann"  → { gender: "male",   name: "Mustermann" }
 *   "Frau Dr. Schmidt" → { gender: "female", name: "Dr. Schmidt" }
 *   "Max Mustermann"   → null (verified person, but no salutation info)
 *
 * Null means: do NOT personalise the greeting — the general formal
 * greeting must be used. Gender is never inferred from a first name.
 */
export function parseSalutation(
  cleaned: string,
): ParsedSalutation | null {
  const match = cleaned.match(SALUTATION_RE);
  if (!match) return null;
  const name = match[2].trim();
  if (!name || !NAME_SHAPE_RE.test(name)) return null;
  if (isGenericPersonWord(name)) return null;
  return {
    gender: match[1].toLowerCase() === "herr" ? "male" : "female",
    name: capitalizeFirst(name),
  };
}

/**
 * Render {{greeting}} for ONE recipient.
 *
 *   explicit "Herr X"  → "Sehr geehrter Herr X,"
 *   explicit "Frau Y"  → "Sehr geehrte Frau Y,"
 *   anything else      → "Sehr geehrte Damen und Herren,"
 */
export function renderGreeting(
  rawContactName: string | null | undefined,
): string {
  const cleaned = normalizeName(rawContactName);
  if (!cleaned || isGenericPersonWord(cleaned)) return GREETING_FALLBACK;
  const salutation = parseSalutation(cleaned);
  if (!salutation) return GREETING_FALLBACK;
  return salutation.gender === "male"
    ? `Sehr geehrter Herr ${salutation.name},`
    : `Sehr geehrte Frau ${salutation.name},`;
}

/**
 * Render {{contact_name}} for ONE recipient.
 *
 * With an explicit Herr/Frau form the full form is used (so
 * "Sehr geehrte {{contact_name}}," reads correctly); otherwise the
 * provided full name; when nothing trustworthy is available the
 * "Damen und Herren" fallback (pairs with "Sehr geehrte …").
 */
export function renderContactName(
  rawContactName: string | null | undefined,
): string {
  const cleaned = normalizeName(rawContactName);
  if (!cleaned || isGenericPersonWord(cleaned)) return CONTACT_FALLBACK;
  const salutation = parseSalutation(cleaned);
  if (salutation) {
    return `${salutation.gender === "male" ? "Herr" : "Frau"} ${salutation.name}`;
  }
  return cleaned;
}

/* ------------------------------------------------------------------ *
 * Per-recipient rendering
 * ------------------------------------------------------------------ */

export interface PersonalizedRecipient {
  email: string;
  /** Explicit per-recipient company override (wins over the domain). */
  companyName?: string | null;
  /** Explicit, user-provided contact person name (trusted source). */
  contactName?: string | null;
}

export interface PersonalizationTemplate {
  subject: string;
  bodyHtml: string;
  bodyText: string;
}

export interface RenderedMessage {
  subject: string;
  bodyHtml: string;
  bodyText: string;
}

/** Raised when a rendered message would still contain a known token. */
export class PersonalizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PersonalizationError";
  }
}

/** Escape a value for insertion into an HTML TEXT node. */
export function htmlEscape(value: string): string {
  return (value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Replace tokens in an HTML string, rewriting TEXT NODES ONLY.
 *
 * The string is split into alternating text / tag segments; tags are
 * returned byte-for-byte untouched, so replacement can never corrupt
 * markup or attributes. A token inside tag markup (attribute or
 * malformed) is simply not matched here and is caught by the validation
 * step in renderPersonalizedMessage.
 */
export function renderHtmlTemplate(
  html: string,
  values: Record<string, string>,
): string {
  const parts = (html ?? "").split(/(<[^<>]*>)/g);
  return parts
    .map((part, index) =>
      index % 2 === 1
        ? part
        : part.replace(TOKEN_RE, (token) =>
            htmlEscape(values[token.slice(2, -2)] ?? ""),
          ),
    )
    .join("");
}

/** Replace tokens in a plain-text string (subject, body text). */
export function renderTextTemplate(
  text: string,
  values: Record<string, string>,
): string {
  return (text ?? "").replace(TOKEN_RE, (token) => values[token.slice(2, -2)] ?? "");
}

/**
 * Render ONE recipient's outgoing message from the shared draft template.
 *
 *  - The template (with tokens) is never modified.
 *  - Every value is resolved from THIS recipient's data only.
 *  - All three values are guaranteed non-empty (safe fallbacks).
 *  - Throws PersonalizationError when a known token survives rendering —
 *    the caller must route the message through the per-recipient failure
 *    path, never send it.
 */
export function renderPersonalizedMessage(
  template: PersonalizationTemplate,
  recipient: PersonalizedRecipient,
): RenderedMessage {
  const values: Record<string, string> = {
    company_name:
      resolveCompanyName(recipient.email, recipient.companyName).value ??
      COMPANY_FALLBACK,
    contact_name: renderContactName(recipient.contactName),
    greeting: renderGreeting(recipient.contactName),
  };
  const subject = renderTextTemplate(template.subject, values);
  const bodyHtml = renderHtmlTemplate(template.bodyHtml, values);
  const bodyText = renderTextTemplate(template.bodyText, values);

  for (const rendered of [subject, bodyHtml, bodyText]) {
    if (UNRESOLVED_TOKEN_RE.test(rendered)) {
      throw new PersonalizationError(
        "A personalization variable could not be resolved for this recipient.",
      );
    }
  }
  return { subject, bodyHtml, bodyText };
}
