/**
 * Deterministic company-contact extraction (AI Search 2.5).
 *
 * Turns the data the search provider ALREADY returned (title, snippet,
 * content, URL) plus the guarded pages of the official website into
 * attributed contact information — without a single extra provider request
 * and without ever inventing an address.
 *
 * Hard rules (enforced here, unit-tested):
 *  - only addresses that literally appear in the source text are returned;
 *  - an address is only attributed to a company when the source page is on
 *    that company's own domain, or the same text names the company;
 *  - free mail providers (gmail/outlook/yahoo/…) never count as a company's
 *    official address;
 *  - person-looking addresses (max.mustermann@…, m.mustermann@…) never count
 *    as the company's contact;
 *  - nothing is ever derived from the company name.
 */

import { extractEmails } from "@/lib/opportunities/enrichment/text-extract";

export type EmailConfidence = "high" | "medium" | "low";
export type EmailSourceKind = "tavily_result_content" | "official_page";

/**
 * Company contact seed: what ONE search result told us about a company,
 * carried from discovery into the enrichment so the official website and any
 * published address are used WITHOUT a second provider request.
 */
export interface CompanyContactSeed {
  /** Host of the result URL (the company's domain for company pages). */
  domain: string;
  /** Candidate official website (non-portal hosts only). */
  websiteUrl: string | null;
  /** Public page the data was read from. */
  sourceUrl: string;
  /** Title + snippet text (used for the company-name attribution check). */
  text: string;
  /** Addresses found verbatim in that text and attributable to the domain. */
  emails: ContactEmail[];
}

/** Distinct intents for the (max 3) discovery requests. */
export type DiscoveryIntent = "jobs" | "company" | "contact";

const INTENT_SUFFIX: Record<DiscoveryIntent, string> = {
  jobs: "",
  company: "Unternehmen Karriere Kontakt Ausbildung",
  contact: "Bewerbung E-Mail Kontaktadresse offizielle Website",
};

/**
 * Builds the (at most three) discovery queries — one per intent, never three
 * near-identical strings:
 *   jobs    → the planned query itself (Ausbildung/job discovery)
 *   company → company / career / contact discovery
 *   contact → email / contact-details / official-website discovery
 */
export function buildDiscoveryQueries(
  webQueries: string[],
  max: number,
): Array<{ intent: DiscoveryIntent; query: string }> {
  const base = webQueries.map((q) => q.trim()).filter(Boolean)[0];
  if (!base) return [];
  const intents: DiscoveryIntent[] = ["jobs", "company", "contact"];
  return intents
    .slice(0, Math.max(0, max))
    .map((intent) => ({
      intent,
      query: `${base}${INTENT_SUFFIX[intent] ? ` ${INTENT_SUFFIX[intent]}` : ""}`,
    }));
}

export interface ContactEmail {
  email: string;
  /** Public page the address was read from (provenance). */
  sourceUrl: string;
  source: EmailSourceKind;
  confidence: EmailConfidence;
  /** True when the address' domain equals the source page's domain. */
  sameDomain: boolean;
}

/** Addresses that must never be presented as a company's official contact. */
const FREE_MAIL_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "outlook.de",
  "hotmail.com",
  "hotmail.de",
  "live.com",
  "live.de",
  "yahoo.com",
  "yahoo.de",
  "gmx.de",
  "gmx.net",
  "web.de",
  "t-online.de",
  "icloud.com",
  "me.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "mail.com",
  "freenet.de",
  "posteo.de",
  "arcor.de",
]);

/** Role addresses: application/recruiting beats general contact. */
const APPLICATION_LOCALS = [
  "bewerbung",
  "bewerbungen",
  "karriere",
  "ausbildung",
  "ausbildungs",
  "azubi",
  "azubis",
  "jobs",
  "job",
  "stellen",
  "stellenangebote",
  "recruiting",
  "hr",
];
const GENERAL_LOCALS = [
  "info",
  "kontakt",
  "contact",
  "mail",
  "office",
  "verwaltung",
  "service",
  "anfrage",
  "post",
  "team",
  "hallo",
  "hello",
  "willkommen",
];

/** Paths/pages that make an address especially relevant for applying. */
const CONTACT_PATH_RE =
  /(karriere|career|jobs?|stellen|bewerbung|ausbildung|azubi|kontakt|contact|impressum|team|ueber-uns|about)/i;

/** Recruiting pages only — the ONE case where a person-looking address is
 *  accepted (an explicitly published recruiting contact). An Impressum
 *  listing a named person must NOT become the company's contact. */
const RECRUITING_PATH_RE = /(karriere|career|jobs?|stellen|bewerbung|ausbildung|azubi)/i;

/** Lower-cases a host and drops the www. prefix. */
export function domainOf(host: string): string {
  return host.toLowerCase().replace(/^www\./, "");
}

export function isFreeMailDomain(domain: string): boolean {
  return FREE_MAIL_DOMAINS.has(domainOf(domain));
}

/** Classifies the local part; null = neither a known role nor obviously a
 *  person (treated as a person below to stay conservative). */
export function roleOfLocalPart(
  local: string,
): "application" | "general" | null {
  const normalized = local.toLowerCase().replace(/[._-].*$/, "");
  if (APPLICATION_LOCALS.includes(local.toLowerCase())) return "application";
  if (GENERAL_LOCALS.includes(local.toLowerCase())) return "general";
  if (APPLICATION_LOCALS.includes(normalized)) return "application";
  if (GENERAL_LOCALS.includes(normalized)) return "general";
  return null;
}

/** Person-looking addresses: `vorname.nachname@`, `v.nachname@`, `m.mueller@`. */
export function looksLikePersonAddress(local: string): boolean {
  const value = local.toLowerCase();
  if (!value.includes(".") && !value.includes("_") && !value.includes("-"))
    return false;
  const parts = value.split(/[._-]/).filter(Boolean);
  if (parts.length < 2) return false;
  const [first, second] = parts;
  // Initial + surname (m.mueller) or two name-like parts (max.mustermann).
  if (first.length === 1 && second.length > 1) return true;
  return parts.every((part) => part.length > 1 && part.length <= 14);
}

function textNamesCompany(text: string, companyName: string | null): boolean {
  if (!companyName) return false;
  const normalized = companyName
    .toLowerCase()
    .replace(/\b(gmbh|mbh|ag|kg|ohg|ug|se|e\.v\.|gbr|co\.?|holding|gruppe|group)\b/g, " ")
    .replace(/[^a-z0-9äöüß]+/g, " ")
    .trim();
  if (normalized.length < 4) return false;
  const haystack = text
    .toLowerCase()
    .replace(/[^a-z0-9äöüß]+/g, " ")
    .replace(/\s+/g, " ");
  return haystack.includes(normalized);
}

function classifyAddress(input: {
  email: string;
  sourceUrl: string;
  companyName: string | null;
  source: EmailSourceKind;
  sourceText: string;
}): ContactEmail | null {
  const [local, domain] = input.email.split("@");
  if (!local || !domain) return null;
  const pageDomain = domainOf(hostFromUrl(input.sourceUrl));
  const sameDomain = pageDomain !== "" && pageDomain === domainOf(domain);
  const namesCompany = textNamesCompany(input.sourceText, input.companyName);

  // Attribution gate: the address must belong to the page's own domain, or
  // the very text that contains it must name the company.
  if (!sameDomain && !namesCompany) return null;

  const role = roleOfLocalPart(local);

  // Free mail is never an official company address.
  if (isFreeMailDomain(domain)) return null;

  // Person-looking addresses are only kept when the source page is the
  // company's own page AND it is a recruiting/contact page (an explicitly
  // published recruiting contact).
  if (looksLikePersonAddress(local) && role === null) {
    if (!sameDomain || !RECRUITING_PATH_RE.test(input.sourceUrl)) return null;
    return {
      email: input.email,
      sourceUrl: input.sourceUrl,
      source: input.source,
      confidence: "low",
      sameDomain,
    };
  }

  if (role === null && !sameDomain) return null;

  const confidence: EmailConfidence = sameDomain
    ? role !== null
      ? "high"
      : "medium"
    : "medium";

  return {
    email: input.email,
    sourceUrl: input.sourceUrl,
    source: input.source,
    confidence,
    sameDomain,
  };
}

/**
 * Matches a discovery seed to a company by NAME (the seed text names it) or
 * by the host of a source-documented company URL. Conservative: no match
 * returns null, so an address is never attributed to the wrong company.
 */
export function findContactSeed(
  companyName: string,
  seeds: CompanyContactSeed[],
  documentedCompanyUrl?: string | null,
  sourceHosts?: Set<string>,
): CompanyContactSeed | null {
  const documentedHost = documentedCompanyUrl
    ? domainOf(hostFromUrl(documentedCompanyUrl))
    : "";
  let best: CompanyContactSeed | null = null;
  for (const seed of seeds) {
    if (documentedHost && seed.domain === documentedHost) return seed;
    // A seed on a host we already fetched for this company is evidence too.
    if (sourceHosts?.has(seed.domain)) return seed;
    if (!textNamesCompany(seed.text, companyName)) continue;
    const better =
      !best ||
      (seed.websiteUrl !== null && best.websiteUrl === null) ||
      (seed.emails.length > 0 && best.emails.length === 0);
    if (better) best = seed;
  }
  return best;
}

function hostFromUrl(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/** Emails readable from ONE search result (title + snippet/content + URL).
 *  This is the cheapest source: no page fetch, no extra provider request. */
export function emailsFromSearchResult(input: {
  title: string;
  snippet: string;
  url: string;
  companyName?: string | null;
}): ContactEmail[] {
  const text = `${input.title}\n${input.snippet}\n${input.url}`;
  const found = extractEmails(text);
  const result: ContactEmail[] = [];
  for (const { value: email } of found) {
    const classified = classifyAddress({
      email,
      sourceUrl: input.url,
      companyName: input.companyName ?? null,
      source: "tavily_result_content",
      sourceText: text,
    });
    if (classified) result.push(classified);
  }
  return dedupeEmails(result);
}

/** Emails readable from a fetched (guarded) page of the official website. */
export function emailsFromPageText(input: {
  text: string;
  sourceUrl: string;
  companyName?: string | null;
}): ContactEmail[] {
  const result: ContactEmail[] = [];
  for (const { value: email } of extractEmails(input.text)) {
    const classified = classifyAddress({
      email,
      sourceUrl: input.sourceUrl,
      companyName: input.companyName ?? null,
      source: "official_page",
      sourceText: input.text,
    });
    if (classified) result.push(classified);
  }
  return dedupeEmails(result);
}

export function dedupeEmails(emails: ContactEmail[]): ContactEmail[] {
  const byEmail = new Map<string, ContactEmail>();
  const rank: Record<EmailConfidence, number> = { high: 3, medium: 2, low: 1 };
  for (const entry of emails) {
    const key = entry.email.toLowerCase();
    const existing = byEmail.get(key);
    if (!existing || rank[entry.confidence] > rank[existing.confidence])
      byEmail.set(key, entry);
  }
  return [...byEmail.values()];
}

/**
 * Priority pick (requirement order):
 *   1. application/career address (bewerbung@, karriere@, ausbildung@, jobs@)
 *   2. general company address (info@, kontakt@, mail@ …)
 *   3. any other company-domain address
 * Ties break on confidence, then on the source page being a contact page.
 */
export function pickCompanyEmail(emails: ContactEmail[]): ContactEmail | null {
  let best: ContactEmail | null = null;
  let bestScore = -1;
  for (const entry of emails) {
    const local = entry.email.split("@")[0] ?? "";
    const role = roleOfLocalPart(local);
    let score = role === "application" ? 60 : role === "general" ? 40 : 20;
    if (entry.confidence === "high") score += 6;
    else if (entry.confidence === "medium") score += 3;
    if (CONTACT_PATH_RE.test(entry.sourceUrl)) score += 2;
    if (score > bestScore) {
      bestScore = score;
      best = entry;
    }
  }
  return best;
}

/**
 * A search result on a non-portal, non-social domain is a candidate for the
 * company's own website. Portal/social URLs are never a company website.
 */
export function companyWebsiteFromResult(
  url: string,
  isPortalHost: boolean,
  isSocialHost: boolean,
): string | null {
  if (isPortalHost || isSocialHost) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return null;
    // A career/contact path on the company's own domain IS the company site;
    // the origin is what the enrichment stores.
    return parsed.origin;
  } catch {
    return null;
  }
}
