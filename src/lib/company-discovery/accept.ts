/**
 * The email acceptor — rules (a)–(g) of §4.2, in one place, pure and
 * unit-testable.
 *
 * This module can ACCEPT an address and REJECT an address. It cannot create
 * one: every candidate it accepts must be handed to it as a literal string
 * that occurs in content fetched during this run. There is no function here
 * that joins a local part with a domain, derives anything from a company name,
 * or expands a pattern — which is what makes "no fabricated emails" a
 * structural property rather than a promise.
 *
 * (a) LITERAL PRESENCE — visible text, `mailto:` targets and JSON-LD `email`
 *     values all end up in the text handed to {@link acceptEmailFromContent};
 *     the address must then be found verbatim (or in the obfuscation notation
 *     a human reader sees, e.g. `name(at)firma(dot)de`). No JavaScript is
 *     executed, no image is OCR'd and no protection scheme is decoded; a page
 *     that only yields an address that way is `source_blocked` instead (§4.3).
 * (b) COMPANY BINDING — the address must sit on the company's own verified
 *     site, or in a block that explicitly attributes it to that company.
 * (c) VALID & NORMALIZED — trimmed, query/fragment/trailing punctuation
 *     removed, IDN-safe, lower-cased dedupe key.
 * (d) NOT A PLACEHOLDER.
 * (e) NOT A SYSTEM ADDRESS (role infrastructure, hosting/CMS/analytics vendors).
 * (f) NOT GENERATED — structurally impossible here.
 * (g) LLM SAFETY — an address proposed by a heuristic (or a model) is accepted
 *     only when the exact normalized string is present in the fetched content.
 */

import { emailDedupeKey, normalizeOpportunityEmail } from "@/lib/opportunities/email-export";
import { extractEmails } from "@/lib/opportunities/enrichment/text-extract";
import type { DiscoveryEmailSource } from "./types";

export interface AcceptedEmail {
  /** Normalized (lower-cased, trimmed) address. */
  email: string;
  /** The exact public page it literally appears on. */
  sourceUrl: string;
  sourceType: DiscoveryEmailSource;
  verificationStatus: "verified";
  verificationMethod:
    | "literal_in_listing"
    | "literal_on_official_site"
    | "literal_on_attributed_third_party_page";
  /** True when the address' domain equals the company website's domain. */
  domainMatch: boolean;
  /** ≤160 characters around the match, sanitized. */
  evidenceSnippet: string;
}

/** Infrastructure mailboxes that are never a business contact (§4.2e). */
const SYSTEM_LOCALS = new Set([
  "noreply",
  "no-reply",
  "donotreply",
  "do-not-reply",
  "mailer-daemon",
  "mailerdaemon",
  "postmaster",
  "abuse",
  "webmaster",
  "hostmaster",
  "root",
  "sysadmin",
  "privacy",
  "datenschutz",
  "impressum",
  "unsubscribe",
  "bounce",
  "bounces",
]);

/** Local parts that are placeholders rather than a real mailbox (§4.2d). */
const PLACEHOLDER_LOCALS = new Set([
  "name",
  "user",
  "test",
  "your",
  "youremail",
  "deinname",
  "ihrname",
  "ihre-email",
  "email",
  "mail",
  "mustermann",
  "maxmustermann",
  "beispiel",
  "example",
  "vorname",
  "nachname",
  "firstname",
  "lastname",
  "someone",
  "anyone",
  "admin",
]);

const PLACEHOLDER_LOCAL_RE =
  /^(name|user|test|your|beispiel|example|mustermann|vorname|nachname|firstname|lastname|ihre[-_.]?e?mail|dein[-_.]?name|mail)($|[._-])/;

/** Hosting / CMS / analytics / tracking vendors — never the company itself. */
const VENDOR_DOMAINS = new Set([
  "sentry.io",
  "wixpress.com",
  "wix.com",
  "squarespace.com",
  "jimdo.com",
  "wordpress.com",
  "automattic.com",
  "shopify.com",
  "hubspot.com",
  "mailchimp.com",
  "sendgrid.net",
  "mailgun.org",
  "cloudflare.com",
  "google.com",
  "googlemail.com",
  "facebook.com",
  "instagram.com",
  "linkedin.com",
  "xing.com",
  "indeed.com",
  "stepstone.de",
  "kununu.com",
  "glassdoor.com",
  "trustpilot.com",
  "typeform.com",
  "gstatic.com",
]);

/** `logo@2x.png`-style file-name artefacts (§4.2d). */
const FILE_EXT_RE = /\.(png|jpe?g|gif|webp|svg|avif|pdf|docx?|xlsx?|pptx?|zip|css|js)$/i;

/** Reserved/unroutable TLDs and host patterns that are never a real business. */
const NON_DELIVERABLE_DOMAIN_RE =
  /(^|\.)(example|example\.com|invalid|test|localhost|local|internal|lan)$/i;
const EXAMPLE_HOST_RE = /^example\./i;

/** Visible obfuscation a human reader can decode — nothing else. */
const AT_NOTATION_RE = /\s*[[({]\s*(?:at|ät)\s*[\])}]\s*/gi;
const DOT_NOTATION_RE = /\s*[[({]\s*(?:dot|punkt)\s*[\])}]\s*/gi;

/** Turn the notation a human reads into a parseable address. */
export function deobfuscateEmailNotation(text: string): string {
  return text.replace(AT_NOTATION_RE, "@").replace(DOT_NOTATION_RE, ".");
}

function sanitizeSnippet(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

/**
 * The literal-presence check (§4.2a + §4.2g): the exact normalized address as
 * it appears in the content, with a short sanitized snippet as evidence.
 * Returns null when the string is not present — in which case the candidate is
 * discarded, whatever produced it.
 */
export function findLiteralEvidence(
  text: string,
  email: string,
): { index: number; snippet: string } | null {
  const target = email.toLowerCase();
  const lower = text.toLowerCase();
  let index = lower.indexOf(target);
  let haystack = text;
  if (index < 0) {
    haystack = deobfuscateEmailNotation(text);
    index = haystack.toLowerCase().indexOf(target);
    if (index < 0) return null;
  }
  const start = Math.max(0, index - 60);
  const end = Math.min(haystack.length, index + target.length + 60);
  return { index, snippet: sanitizeSnippet(haystack.slice(start, end)) };
}

/** (d) a placeholder local part or a file-name artefact. */
export function isPlaceholderAddress(email: string): boolean {
  const [local, domain] = email.toLowerCase().split("@");
  if (!local || !domain) return true;
  if (FILE_EXT_RE.test(domain)) return true;
  // `*.invalid`, `*.test`, `example.*`, `domain.tld` … are not real companies.
  if (NON_DELIVERABLE_DOMAIN_RE.test(domain)) return true;
  if (EXAMPLE_HOST_RE.test(domain)) return true;
  if (PLACEHOLDER_LOCALS.has(local)) return true;
  if (PLACEHOLDER_LOCAL_RE.test(local)) return true;
  return false;
}

/** (e) role infrastructure or a hosting/CMS/analytics vendor. */
export function isSystemAddress(email: string): boolean {
  const [local, domain] = email.toLowerCase().split("@");
  if (!local || !domain) return true;
  if (SYSTEM_LOCALS.has(local)) return true;
  const bare = domain.replace(/^www\./, "");
  for (const vendor of VENDOR_DOMAINS) {
    if (bare === vendor || bare.endsWith(`.${vendor}`)) return true;
  }
  return false;
}

/** The host of a URL, or "" when it cannot be parsed. */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** Domain equality including sub-domains (`mail.acme.de` vs `acme.de`). */
export function sameDomain(a: string, b: string): boolean {
  if (!a || !b) return false;
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}

/** Does the text name the company (conservative, legal form stripped)? */
export function textNamesCompany(
  text: string,
  companyName: string | null | undefined,
): boolean {
  if (!companyName) return false;
  const normalized = companyName
    .toLowerCase()
    .replace(
      /\b(gmbh|mbh|ag|kg|ohg|ug|se|e\.v\.|gbr|co\.?|holding|gruppe|group|partners?)\b/g,
      " ",
    )
    .replace(/[^a-z0-9äöüß]+/g, " ")
    .trim();
  if (normalized.length < 4) return false;
  const haystack = text
    .toLowerCase()
    .replace(/[^a-z0-9äöüß]+/g, " ")
    .replace(/\s+/g, " ");
  return haystack.includes(normalized);
}

/** How an accepted address was verified, derived from its source type. */
export function verificationMethodOf(
  sourceType: DiscoveryEmailSource,
): AcceptedEmail["verificationMethod"] {
  if (sourceType === "job_listing" || sourceType === "offer") {
    return "literal_in_listing";
  }
  if (sourceType.startsWith("official_site_") || sourceType === "company_website") {
    return "literal_on_official_site";
  }
  return "literal_on_attributed_third_party_page";
}

/**
 * Accept at most ONE address out of `text`, applying (a)–(g).
 *
 * `attributionText` is the block the binding check may use when the page is
 * not on the company's own domain (e.g. a chamber directory entry). When it is
 * omitted, `text` is used.
 */
export function acceptEmailFromContent(input: {
  text: string;
  sourceUrl: string;
  sourceType: DiscoveryEmailSource;
  companyName?: string | null;
  /** The company's verified website domain, when known (binding + domainMatch). */
  companyDomain?: string | null;
  /** When set, candidates are expected to belong to this host. */
  attributeToHostOfSource?: boolean;
}): AcceptedEmail | null {
  const accepted = acceptEmailsFromContent(input);
  return accepted[0] ?? null;
}

/**
 * All addresses of `text` that pass (a)–(g), strongest first. The list is
 * ordered by the deterministic priority of §4.1 (application-grade role
 * mailbox > general contact > other), ties going to the first occurrence.
 */
export function acceptEmailsFromContent(input: {
  text: string;
  sourceUrl: string;
  sourceType: DiscoveryEmailSource;
  companyName?: string | null;
  companyDomain?: string | null;
}): AcceptedEmail[] {
  if (!input.text) return [];
  const pageHost = hostOf(input.sourceUrl);
  const companyDomain = (input.companyDomain ?? "").toLowerCase().replace(/^www\./, "");
  const onCompanySite =
    companyDomain !== "" && sameDomain(pageHost, companyDomain);
  // (b) Binding: the page belongs to the company, or a block on the page names
  // it. With no company name and no company page nothing can bind an address,
  // so there is nothing to look at.
  if (!onCompanySite && !input.companyName) return [];

  // (a) Candidate strings come from the fetched text AND from the notation a
  // human reader decodes (`name(at)firma(dot)de`). Only the visible notation is
  // decoded — never an image, never a script, never a protection scheme.
  const deobfuscated = deobfuscateEmailNotation(input.text);
  const candidates = new Set<string>();
  for (const { value } of extractEmails(input.text)) candidates.add(value);
  for (const { value } of extractEmails(deobfuscated)) candidates.add(value);

  const found: AcceptedEmail[] = [];
  for (const value of candidates) {
    const normalized = normalizeOpportunityEmail(value);
    if (!normalized) continue;
    const email = normalized.toLowerCase();
    // (c) already normalized by the shared helper; (d)+(e) below.
    if (isPlaceholderAddress(email)) continue;
    if (isSystemAddress(email)) continue;
    // (g) the exact string must be present in what we fetched.
    const evidence = findLiteralEvidence(input.text, email);
    if (!evidence) continue;
    const domain = email.split("@")[1] ?? "";
    const domainMatch = companyDomain !== "" && sameDomain(domain, companyDomain);
    // (b) Off the company's own site, attribution must hold in the SAME block
    // that carries the address — a company named somewhere else on the page
    // does not attribute this mailbox.
    //
    // Granularity depends on the source: on a third-party page the block is the
    // text around the match, while on a LISTING the block IS the offer itself
    // (one listing = one offer record, whose employer field and description
    // together are that single block).
    const requiresSnippetAttribution = input.sourceType !== "job_listing";
    if (
      !onCompanySite &&
      requiresSnippetAttribution &&
      !textNamesCompany(evidence.snippet, input.companyName)
    ) {
      continue;
    }
    found.push({
      email,
      sourceUrl: input.sourceUrl,
      sourceType: input.sourceType,
      verificationStatus: "verified",
      verificationMethod: verificationMethodOf(input.sourceType),
      domainMatch,
      evidenceSnippet: evidence.snippet,
    });
  }
  return orderAccepted(found);
}

/** Role classification used for the priority order (§4.1). */
const APPLICATION_LOCALS = new Set([
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
]);
const GENERAL_LOCALS = new Set([
  "info",
  "kontakt",
  "contact",
  "office",
  "verwaltung",
  "service",
  "anfrage",
  "post",
  "team",
  "hallo",
  "hello",
  "willkommen",
]);

/** 60 = application-grade, 40 = general contact, 20 = other (§4.1). */
export function emailPriority(email: string): number {
  const local = (email.split("@")[0] ?? "").toLowerCase();
  const stem = local.replace(/[._-].*$/, "");
  if (APPLICATION_LOCALS.has(local) || APPLICATION_LOCALS.has(stem)) return 60;
  if (GENERAL_LOCALS.has(local) || GENERAL_LOCALS.has(stem)) return 40;
  return 20;
}

/** Source-type precedence: a listing beats a site page beats a search hit. */
const SOURCE_RANK: Partial<Record<DiscoveryEmailSource, number>> = {
  job_listing: 5,
  offer: 5,
  official_site_ausbildung: 4,
  official_site_career: 4,
  official_site_jobs: 4,
  impressum: 4,
  official_site_impressum: 4,
  kontakt: 3,
  official_site_contact: 3,
  karriere: 3,
  ausbildung: 3,
  bewerbungen: 3,
  official_site_contact_person: 3,
  official_site_other: 2,
  company_website: 2,
  trusted_public_page: 2,
  search_result: 1,
};

export function sourceRank(sourceType: DiscoveryEmailSource): number {
  return SOURCE_RANK[sourceType] ?? 0;
}

/**
 * The deterministic evidence grade of an ACCEPTED address (never a guess —
 * the address is already literal-presence verified; this only grades WHERE
 * it was published):
 *   high   the address' domain is the company's own website domain, or it was
 *          read on the company's official Impressum / Kontakt page;
 *   medium read on another official-site career page, or printed in an
 *          enabled portal's listing (attribution established by the adapter);
 *   low    read on a third-party page or a search-result snippet only.
 */
export function emailConfidenceOf(
  email: Pick<AcceptedEmail, "sourceType" | "domainMatch">,
): "high" | "medium" | "low" {
  if (email.domainMatch) return "high";
  switch (email.sourceType) {
    case "official_site_impressum":
    case "official_site_contact":
    case "impressum":
    case "kontakt":
      return "high";
    case "official_site_career":
    case "official_site_jobs":
    case "official_site_ausbildung":
    case "official_site_contact_person":
    case "job_listing":
    case "karriere":
    case "ausbildung":
    case "bewerbungen":
      return "medium";
    default:
      return "low";
  }
}

/**
 * The 0–100 confidence SCORE exported with a verified email, derived ONLY
 * from stored evidence:
 *   base 75 (high) / 55 (medium) / 35 (low)
 *  +15   the address' domain matches the company's official website domain
 *  +5    per independent extra public page that also publishes the address
 *        (max +10 — corroboration, capped)
 *   clamped into [0, 100]. Null input (no verified email) → null.
 */
export function confidenceScoreOf(
  email:
    | (Pick<AcceptedEmail, "sourceType" | "domainMatch"> & {
        sourceUrls: readonly string[];
      })
    | null,
): number | null {
  if (!email) return null;
  const grade = emailConfidenceOf(email);
  let score = grade === "high" ? 75 : grade === "medium" ? 55 : 35;
  if (email.domainMatch) score += 15;
  const corroboration = Math.max(0, email.sourceUrls.length - 1);
  score += Math.min(corroboration, 2) * 5;
  return Math.max(0, Math.min(score, 100));
}

/** Deterministic order: priority, then source rank, then document order. */
function orderAccepted(emails: AcceptedEmail[]): AcceptedEmail[] {
  return emails
    .map((email, index) => ({ email, index }))
    .sort((a, b) => {
      const byPriority =
        emailPriority(b.email.email) - emailPriority(a.email.email);
      if (byPriority !== 0) return byPriority;
      const bySource = sourceRank(b.email.sourceType) - sourceRank(a.email.sourceType);
      if (bySource !== 0) return bySource;
      return a.index - b.index;
    })
    .map((entry) => entry.email);
}

/**
 * Merge the same address found on several pages into ONE record that keeps
 * every source URL — the highest-priority source stays primary (§4.5).
 */
export interface MergedAcceptedEmail extends AcceptedEmail {
  /** Every page the address was literally found on, primary first. */
  sourceUrls: string[];
}

export function mergeAcceptedEmails(
  emails: AcceptedEmail[],
): MergedAcceptedEmail[] {
  const byEmail = new Map<string, MergedAcceptedEmail>();
  for (const candidate of emails) {
    const key = emailDedupeKey(candidate.email);
    const existing = byEmail.get(key);
    if (!existing) {
      byEmail.set(key, { ...candidate, sourceUrls: [candidate.sourceUrl] });
      continue;
    }
    if (!existing.sourceUrls.includes(candidate.sourceUrl)) {
      existing.sourceUrls.push(candidate.sourceUrl);
    }
    const better =
      emailPriority(candidate.email) > emailPriority(existing.email) ||
      (emailPriority(candidate.email) === emailPriority(existing.email) &&
        sourceRank(candidate.sourceType) > sourceRank(existing.sourceType));
    if (better) {
      const urls = existing.sourceUrls;
      byEmail.set(key, { ...candidate, sourceUrls: urls });
    }
  }
  return [...byEmail.values()];
}

/** Type guard used by the orchestrator when reading stored values back. */
export function isVerifiedStatus(value: string | null | undefined): boolean {
  return value === "verified";
}

/**
 * Is a STORED address eligible as a verified public email (§4.5/§4.6)?
 *
 * `false` for the two legacy shapes:
 *   - `sourceType === "offer"` — the address came from an Arbeitsagentur
 *     record's description, which §3.3 removes from the email path for good;
 *   - no `sourceUrl` at all — an address without provenance is unverifiable.
 * Also `false` when a stored verification status exists and is not `verified`.
 *
 * Used by the UI (legacy marker + what may be selected for a campaign) and by
 * the Excel export, so both agree on what "published" means.
 */
export function isEligiblePublicEmail(input: {
  sourceUrl: string | null;
  sourceType: string;
  verificationStatus?: string | null;
}): boolean {
  if (input.sourceType === "offer") return false;
  if (!input.sourceUrl) return false;
  if (
    input.verificationStatus !== undefined &&
    input.verificationStatus !== null &&
    input.verificationStatus !== "verified"
  ) {
    return false;
  }
  return true;
}
