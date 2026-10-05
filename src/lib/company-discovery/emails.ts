import "server-only";

import {
  acceptEmailsFromContent,
  mergeAcceptedEmails,
  textNamesCompany,
  type AcceptedEmail,
  type MergedAcceptedEmail,
} from "./accept";
import type { BlockedReason } from "./classify";
import { guardedFetch, type FetchContext } from "./fetch-guard";
import { isFreeMailDomain } from "@/lib/opportunities/company-contact";
import { isPortalHost } from "./sources";
import type { DiscoveryEmailSource, SourceAttempt } from "./types";

/**
 * Public-email discovery — MULTI-SOURCE, with no dependency on Arbeitsagentur.
 *
 * Hard rules:
 *  - An address is reported only when it is LITERALLY published in content
 *    fetched during this run (§4.2a). Nothing is derived from a company name,
 *    nothing is guessed, and a blocked or unreachable source yields an
 *    INCONCLUSIVE outcome — never a fabricated address and never a silent
 *    "no public email".
 *  - Arbeitsagentur is removed from the email path entirely (§3.3): the
 *    offer contact block of a BA record is never read. Its offers still
 *    identify companies; that is all they contribute.
 *
 * Source order (§4.1):
 *   1. an address printed in the listing of an ENABLED portal;
 *   2. the company's official website — Impressum, Kontakt, Karriere, Jobs,
 *      Ausbildung, Ansprechpartner/Team, homepage;
 *   3. public search results of a permitted provider;
 *   4. trusted public pages (chamber / registry / association directories),
 *      accepted only when the block attributes the address to the company.
 */

/**
 * Pages fetched per company. The §4.7 ceiling is 6 — and the fixed target
 * list (SITE_PAGE_PATHS) has exactly 6 entries, so the default tries ALL of
 * them: Impressum/Kontakt first (highest email yield), then Karriere/Jobs/
 * Ausbildung (the pages that document the START YEAR of the apprenticeship),
 * then Team. 404s are real answers and cost one request each; a robots/
 * deliberate refusal stops the host. Env-tunable (DISCOVERY_MAX_EMAIL_PAGES,
 * clamped into [0, 6]).
 */
export function emailPageBudget(): number {
  const raw = process.env.DISCOVERY_MAX_EMAIL_PAGES?.trim();
  if (raw !== undefined && raw !== "") {
    const value = Number.parseInt(raw, 10);
    if (Number.isInteger(value) && value >= 0) {
      return Math.min(value, 6);
    }
  }
  return 6;
}

/** Kept for tests/contracts: the hard ceiling the budget may never exceed. */
export const MAX_EMAIL_PAGES_PER_COMPANY = 6;

/** Per-company wall clock budget (§4.7). */
export const MAX_COMPANY_EMAIL_MS = 25_000;

/** A page of the company's site, reduced to what extraction needs. */
export interface CompanySiteTextPage {
  url: string;
  kind: string;
  text: string;
}

export interface SitePageFetchOutcome {
  pages: CompanySiteTextPage[];
  attempts: SourceAttempt[];
  /** True when a REQUIRED page could not be inspected (blocked/inconclusive). */
  blocked: boolean;
  blockedReason: BlockedReason | null;
}

/** The guarded site pass. Injected so the rules stay testable offline. */
export type CompanySiteFetcher = (websiteUrl: string) => Promise<SitePageFetchOutcome>;

/** Page kinds, mapped to the provenance value stored with an address. */
const SOURCE_BY_PAGE_KIND: Record<string, DiscoveryEmailSource> = {
  impressum: "official_site_impressum",
  kontakt: "official_site_contact",
  contact: "official_site_contact",
  karriere: "official_site_career",
  career: "official_site_career",
  jobs: "official_site_jobs",
  stellenangebote: "official_site_jobs",
  bewerbung: "official_site_jobs",
  ausbildung: "official_site_ausbildung",
  azubi: "official_site_ausbildung",
  team: "official_site_contact_person",
  ansprechpartner: "official_site_contact_person",
  home: "official_site_other",
  other: "official_site_other",
};

/** The pages an official-site pass visits, in the order §4.1 recommends. */
export const SITE_PAGE_PATHS: ReadonlyArray<{ path: string; kind: string }> = [
  { path: "/impressum", kind: "impressum" },
  { path: "/kontakt", kind: "kontakt" },
  { path: "/karriere", kind: "karriere" },
  { path: "/jobs", kind: "jobs" },
  { path: "/ausbildung", kind: "ausbildung" },
  { path: "/team", kind: "team" },
];

// ---------------------------------------------------------------------------
// In-site discovery (agentic engine): the site's own links, allow-listed
// ---------------------------------------------------------------------------

/**
 * The only in-site path SEGMENTS a discovered link may open. Everything else
 * (marketing pages, shop, blog, external links) is NEVER fetched — the pass
 * follows the site's own contact/career structure, and nothing more.
 * A link qualifies when ANY of its path segments is listed; the DEEPEST
 * matching segment wins (`/karriere/ausbildung` is an Ausbildung page, not a
 * generic career page).
 */
const DISCOVERED_SEGMENT_KINDS: ReadonlyArray<{ segment: RegExp; kind: string }> = [
  { segment: /^impressum$/i, kind: "impressum" },
  { segment: /^kontakt(?:en)?$/i, kind: "kontakt" },
  { segment: /^contact$/i, kind: "contact" },
  { segment: /^karriere$/i, kind: "karriere" },
  { segment: /^careers?$/i, kind: "karriere" },
  { segment: /^jobs$/i, kind: "jobs" },
  { segment: /^stellenangebote$/i, kind: "jobs" },
  { segment: /^stellen$/i, kind: "jobs" },
  { segment: /^ausbildung$/i, kind: "ausbildung" },
  { segment: /^azubis?$/i, kind: "ausbildung" },
  { segment: /^bewerbung(?:en)?$/i, kind: "bewerbung" },
  { segment: /^team$/i, kind: "team" },
  { segment: /^ansprechpartner$/i, kind: "ansprechpartner" },
];

/** The kind of a discovered path — the deepest matching segment, or null. */
function discoveredPathKind(path: string): string | null {
  const segments = path.split("/").filter(Boolean).map((segment) => segment.toLowerCase());
  for (let i = segments.length - 1; i >= 0; i -= 1) {
    const entry = DISCOVERED_SEGMENT_KINDS.find(({ segment }) =>
      segment.test(segments[i]),
    );
    if (entry) return entry.kind;
  }
  return null;
}

/**
 * The hard cap for DISCOVERED (link-followed) pages per company. The fixed
 * §4.1 targets (MAX_EMAIL_PAGES_PER_COMPANY) always keep their priority; this
 * only bounds the extra pages the site itself pointed to. `0` disables the
 * discovery step entirely. Clamped into [0, 5].
 */
export function discoveredPageLimit(): number {
  const raw = process.env.DISCOVERY_MAX_DISCOVERED_PAGES?.trim();
  if (raw !== undefined && raw !== "") {
    const value = Number.parseInt(raw, 10);
    if (Number.isInteger(value) && value >= 0) {
      return Math.min(value, 5);
    }
  }
  return 3;
}

/**
 * Read the company's own links from pages it ALREADY fetched this pass and
 * return the additional contact/career pages worth opening:
 *   - SAME ORIGIN ONLY (relative paths; absolute foreign URLs are dropped);
 *   - ALLOW-LISTED path families only (Kontakt / Impressum / Karriere / Jobs /
 *     Ausbildung / Bewerbung / Team / Ansprechpartner);
 *   - never a page already visited (by pathname, trailing slash irrelevant);
 *   - deterministic first-seen order, hard-capped at `limit`.
 * A link the site does not publish is simply not discovered — nothing is
 * guessed, so an empty result is a real answer, not a failure.
 */
export function discoverSitePaths(input: {
  /** The HTML of one already-fetched page of the company's site. */
  html: string;
  /** The site's origin, e.g. `https://firma.de`. */
  origin: string;
  /** Every URL already visited in this pass (fixed + discovered). */
  visitedUrls: Iterable<string>;
  /** How many additional pages to return at most. */
  limit: number;
}): Array<{ url: string; path: string; kind: string }> {
  const visited = new Set<string>();
  for (const url of input.visitedUrls) {
    visited.add(url.toLowerCase());
    try {
      visited.add(
        new URL(url).pathname.replace(/\/+$/, "").toLowerCase(),
      );
    } catch {
      // not a URL; the raw value above is still compared
    }
  }
  const found: Array<{ url: string; path: string; kind: string }> = [];
  const seenPaths = new Set<string>();
  const re = /href\s*=\s*["']([/^][^"']*)["']/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(input.html)) !== null && found.length < input.limit) {
    if (input.limit <= 0) break;
    let href = match[1];
    // Same origin by construction: relative paths only, never `//host`.
    if (!href.startsWith("/") || href.startsWith("//")) continue;
    const cut = href.search(/[?#]/);
    if (cut !== -1) href = href.slice(0, cut);
    const path =
      href.length > 1 && href.endsWith("/") ? href.slice(0, -1) : href;
    if (path.length < 3 || path.length > 120) continue;
    const normalized = path.toLowerCase();
    if (seenPaths.has(normalized) || visited.has(normalized)) continue;
    const kind = discoveredPathKind(normalized);
    if (!kind) continue;
    seenPaths.add(normalized);
    found.push({ url: `${input.origin}${path}`, path, kind });
  }
  return found;
}

/** Every address of a fetched page that passes the acceptance rules. */
export function sitePageEmails(input: {
  page: CompanySiteTextPage;
  companyName: string;
  companyDomain: string | null;
}): AcceptedEmail[] {
  return acceptEmailsFromContent({
    text: input.page.text,
    sourceUrl: input.page.url,
    sourceType: SOURCE_BY_PAGE_KIND[input.page.kind] ?? "official_site_other",
    companyName: input.companyName,
    companyDomain: input.companyDomain,
  });
}

/**
 * The real guarded site pass: fetch the company's public contact/career pages
 * through the ONE guarded fetcher and report what each attempt ended with.
 */
export function createGuardedSiteFetcher(ctx: FetchContext): CompanySiteFetcher {
  return async (websiteUrl: string): Promise<SitePageFetchOutcome> => {
    const pages: CompanySiteTextPage[] = [];
    let blocked = false;
    let blockedReason: BlockedReason | null = null;
    /** Attempts this pass added to the shared context. */
    const attemptsBefore = ctx.attempts.length;

    let origin: string;
    try {
      origin = new URL(websiteUrl).origin;
    } catch {
      return { pages, attempts: [], blocked: false, blockedReason: null };
    }

    // Impressum and Kontakt first — they are the pages §4.4 makes REQUIRED,
    // and the highest-yield sources of a published address in Germany.
    const targets = SITE_PAGE_PATHS.map((entry) => ({
      url: `${origin}${entry.path}`,
      kind: entry.kind,
    })).slice(0, emailPageBudget());

    /** Required pages that were actually inspected (reachable, not blocked). */
    const inspected = new Set<string>();
    const REQUIRED_KINDS = ["impressum", "kontakt"];
    /** HTML of every page already read — the in-site discovery input. */
    const readHtml: string[] = [];

    for (const target of targets) {
      const result = await guardedFetch(ctx, target.url, { textBudget: 20_000 });
      if (result.ok) {
        pages.push({ url: result.page.finalUrl, kind: target.kind, text: result.page.text });
        readHtml.push(result.page.html);
        inspected.add(target.kind);
        continue;
      }
      if (result.kind === "blocked") {
        blocked = true;
        blockedReason = result.reason;
        break; // the circuit breaker is open for this host; stop asking
      }
      // A technical failure is NOT an answer. A transient/inconclusive one
      // (timeout, 5xx, network) leaves the required pages uninspected, which
      // must never be reported as "no public email".
      const inconclusive =
        result.message === "timeout" ||
        result.message === "fetch_failed" ||
        /^http_5\d\d$/.test(result.message);
      if (inconclusive && !REQUIRED_KINDS.every((kind) => inspected.has(kind))) {
        blocked = true;
        blockedReason = "unreachable";
        break;
      }
      // A 404 on an optional page is a real answer ("that page does not
      // exist") — keep going, and it does not block the outcome.
    }

    // ---- in-site discovery (agentic engine) --------------------------------
    // The pages the site ALREADY told us about: contact/career links the
    // fetched pages publish (Kontakt-Unterseite, /karriere/ausbildung, …).
    // Allow-listed, same-origin, visited-deduped, hard-capped — and only
    // after the fixed targets, so the §4.4 required pages keep priority.
    if (!blocked) {
      const limit = discoveredPageLimit();
      if (limit > 0 && readHtml.length > 0) {
        let discoveredFetched = 0;
        outer: for (const html of readHtml) {
          if (discoveredFetched >= limit) break;
          const discovered = discoverSitePaths({
            html,
            origin,
            visitedUrls: pages.map((page) => page.url),
            limit: limit - discoveredFetched,
          });
          for (const entry of discovered) {
            if (discoveredFetched >= limit) break outer;
            if (pages.some((page) => page.kind === entry.kind)) {
              // A page of this kind was already read — the extra link adds
              // no evidence class; keep the pass tight.
              continue;
            }
            discoveredFetched += 1;
            const result = await guardedFetch(ctx, entry.url, { textBudget: 20_000 });
            if (result.ok) {
              pages.push({ url: result.page.finalUrl, kind: entry.kind, text: result.page.text });
            } else if (result.kind === "blocked") {
              // The host's breaker is open: further discovered pages would
              // hit it too. A block on a DISCOVERED page never downgrades an
              // email already found, and (unlike a required page) does not
              // turn the whole pass inconclusive.
              break outer;
            }
            // 404 / technical failure: that link is dead — skip, keep going.
          }
        }
      }
    }

    return {
      pages,
      attempts: ctx.attempts.slice(attemptsBefore),
      blocked,
      blockedReason,
    };
  };
}

// ---------------------------------------------------------------------------
// Official-domain resolution (agentic engine): Job portal → employer identity
// → official website. A company the source never gave a website for is
// resolved by FETCHING the provider's own search results for the company —
// never by turning a name into a domain.
// ---------------------------------------------------------------------------

/**
 * Result URLs fetched per company during domain resolution. Small on purpose:
 * the company's Impressum/own page is what names the operator, and the fixed
 * site pass (below) opens the standard pages once a domain is verified.
 * Clamped into [0, 3].
 */
export function siteResolutionPageLimit(): number {
  const raw = process.env.DISCOVERY_MAX_SITE_RESOLUTION_PAGES?.trim();
  if (raw !== undefined && raw !== "") {
    const value = Number.parseInt(raw, 10);
    if (Number.isInteger(value) && value >= 0) {
      return Math.min(value, 3);
    }
  }
  return 2;
}

export interface OfficialSiteResolution {
  /**
   * The VERIFIED official origin — set only when a fetched page on that host
   * literally names the company (the same binding rule email acceptance
   * uses). A name never becomes a domain; an unverified host stays null.
   */
  websiteUrl: string | null;
  /** The verified-domain page(s) actually fetched this run (extraction + evidence). */
  pages: CompanySiteTextPage[];
  /** Guarded-fetch attempts this resolution added to the shared context. */
  attempts: SourceAttempt[];
}

/**
 * Resolve the company's official website from the provider's search results
 * for that company. For each candidate URL (bounded, de-duped per host,
 * portal/search-engine hosts excluded) the page is fetched through the ONE
 * guarded fetcher (SSRF / robots / pacing / circuit breaker) and counts as
 * the OFFICIAL domain only when its text literally names the company.
 *
 * Never throws: an unreachable or non-naming page simply does not prove the
 * domain — the honest answer is `websiteUrl: null`, and the caller then falls
 * back to the snippet-only search step exactly as before.
 */
export async function resolveOfficialSite(input: {
  companyName: string;
  /** The provider's result URLs for the company (in relevance order). */
  urls: string[];
  ctx: FetchContext;
  /** Max candidate pages to fetch (default {@link siteResolutionPageLimit}). */
  limit?: number;
}): Promise<OfficialSiteResolution> {
  const limit = input.limit ?? siteResolutionPageLimit();
  const attemptsBefore = input.ctx.attempts.length;
  const attemptsOf = (): SourceAttempt[] =>
    input.ctx.attempts.slice(attemptsBefore);
  const empty: OfficialSiteResolution = {
    websiteUrl: null,
    pages: [],
    attempts: attemptsOf(),
  };
  if (limit <= 0 || input.urls.length === 0) return empty;

  /** Hosts that deliberately refused (breaker open for the rest of the run). */
  const deadHosts = new Set<string>();
  /** Candidate pages actually requested (robots probes and refusals cost nothing). */
  let fetched = 0;
  for (const url of input.urls) {
    if (fetched >= limit) break;
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      continue;
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") continue;
    const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
    if (!host) continue;
    // A portal or search-engine host is never the company's own site — even
    // when its page names the company (it does, in a listing context).
    if (isPortalHost(host)) continue;
    if (deadHosts.has(host)) continue; // the breaker is open: not asked again

    // Several candidates may share the company's own host (impressum,
    // kontakt, karriere …) — the top results for a contact query usually do.
    fetched += 1;
    const result = await guardedFetch(input.ctx, url, { textBudget: 20_000 });
    if (!result.ok) {
      if (result.kind === "blocked") {
        // A deliberate refusal (401/403/429/consent/robots) opens the host's
        // circuit breaker for the run — no further candidate can succeed
        // there, so the host is dropped; the NEXT host's candidates still run.
        deadHosts.add(host);
      }
      continue; // blocked / error / 404: that page proves nothing
    }
    // THE verification: the host's own page literally states the company's
    // name (an Impressum legally names its operator; a career page names it
    // in its heading/footer). Without this, the domain is just a guess.
    if (!textNamesCompany(result.page.text, input.companyName)) continue;

    const path = parsed.pathname.replace(/\/+$/, "");
    const kind = discoveredPathKind(path) ?? "other";
    return {
      websiteUrl: parsed.origin,
      pages: [{ url: result.page.finalUrl, kind, text: result.page.text }],
      attempts: attemptsOf(),
    };
  }
  return empty;
}

// ---------------------------------------------------------------------------
// Start-year evidence — the company's own pages, in apprenticeship context
// ---------------------------------------------------------------------------

/**
 * A start year documented on the company's OWN inspected pages. A year only
 * counts when an apprenticeship/beginning word sits in its sentence
 * neighbourhood — "Ausbildung 2027", "Ausbildungsbeginn: 01.08.2027",
 * "Beginn August 2027", "Start 2027", "Ausbildung ab 2027", "Ausbildungs-
 * stellen 2027" … A bare number (copyright, address, phone) is noise and
 * never counts. When the company's pages document DIFFERENT years, the
 * evidence conflicts — the honest answer is "unusable", not a choice.
 */
export interface SiteYearEvidence {
  /** The documented year (first one found), or null when no evidence. */
  year: number | null;
  /** The page where it is documented (evidence provenance). */
  url: string | null;
  /** The company's own pages contradict each other (≥2 different years). */
  conflict: boolean;
}

/**
 * Context windows stay within one text block (no newline) and are short, so
 * the year stays in the neighbourhood of its word — German dates
 * ("01.08.2027") keep their dots and are still matched.
 */
/** "…Ausbildung …2027" / "…Ausbildungsplatz …01.08.2027" (word → year). */
const YEAR_AFTER_APPRENTICESHIP_RE =
  /\b(ausbildung|ausbildungen|ausbildungsplatz|ausbildungsplatze|ausbildungsstellen|ausbildungsstart|azubi|azubis|duales studium|lehrstelle)\b[^\n]{0,80}?(\b20\d{2}\b)/gi;
/** "…Beginn August 2027" / "…Ausbildungsbeginn: 2027" / "…Start 2027". */
const YEAR_AFTER_BEGINNING_RE =
  /\b(ausbildungsbeginn|beginn|antritt|start)\b[^\n]{0,40}?(20\d{2})\b/gi;
/** "…2027 …Ausbildung" (year → word, e.g. "Ausbildung ab 2027" variants). */
const YEAR_BEFORE_APPRENTICESHIP_RE =
  /(\b20\d{2}\b)[^\n]{0,40}?\b(ausbildung|azubis?)\b/gi;

/**
 * Scan the company's own fetched pages for a documented start year. Pure and
 * deterministic: it reports what the pages literally say, nothing else.
 */
export function siteYearEvidence(
  pages: Array<{ url: string; text: string }>,
): SiteYearEvidence {
  const years = new Map<number, string>(); // year → page where documented
  const push = (year: number, url: string): void => {
    if (!years.has(year)) years.set(year, url);
  };
  for (const page of pages) {
    for (const entry of [
      [YEAR_AFTER_APPRENTICESHIP_RE, 2] as const,
      [YEAR_AFTER_BEGINNING_RE, 2] as const,
      [YEAR_BEFORE_APPRENTICESHIP_RE, 1] as const,
    ]) {
      const [re, group] = entry;
      re.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = re.exec(page.text)) !== null) {
        push(Number(match[group]), page.url);
        if (match[0].length === 0) re.lastIndex += 1; // safety: zero-width
      }
    }
  }
  const entries = [...years.entries()];
  if (entries.length === 0) return { year: null, url: null, conflict: false };
  const [year, url] = entries[0];
  return { year, url, conflict: entries.length > 1 };
}

/**
 * An address printed in an ENABLED portal's listing (§4.1 step 1). The literal
 * presence is re-checked against the listing evidence; the attribution was
 * established by the adapter that parsed the listing.
 */
export function listingEmailCandidate(input: {
  email: string;
  sourceUrl: string;
  evidence: string;
  companyName: string;
}): AcceptedEmail | null {
  const accepted = acceptEmailsFromContent({
    text: `${input.email}\n${input.evidence}`,
    sourceUrl: input.sourceUrl,
    sourceType: "job_listing",
    companyName: input.companyName,
  })[0];
  return accepted ?? null;
}

/**
 * An address read from a permitted provider's search result. Tavily returns
 * page content with the result, so the address is literally present in content
 * of this run — that is what makes it acceptable (§4.1 step 3).
 */
export function searchResultEmails(input: {
  content: string;
  sourceUrl: string;
  companyName: string;
  companyDomain: string | null;
}): AcceptedEmail[] {
  return acceptEmailsFromContent({
    text: input.content,
    sourceUrl: input.sourceUrl,
    sourceType: "search_result",
    companyName: input.companyName,
    companyDomain: input.companyDomain,
  });
}

/**
 * A trusted public page (chamber / registry / association directory). Accepted
 * only when the block carrying the address names the company (§4.2b).
 */
export function trustedPageEmails(input: {
  content: string;
  sourceUrl: string;
  companyName: string;
}): AcceptedEmail[] {
  return acceptEmailsFromContent({
    text: input.content,
    sourceUrl: input.sourceUrl,
    sourceType: "trusted_public_page",
    companyName: input.companyName,
  });
}

/**
 * A website the company itself published: the domain of an address from an
 * ENABLED source. Free mail providers are never a company site, and a company
 * NAME is never turned into a host.
 */
export function companyWebsiteFromPublishedEmail(
  email: string | null | undefined,
): string | null {
  if (!email) return null;
  const domain = email.split("@")[1]?.trim().toLowerCase();
  if (!domain || !domain.includes(".") || isFreeMailDomain(domain)) return null;
  if (!/^[a-z0-9.-]+$/.test(domain)) return null;
  return `https://${domain}`;
}

export interface CompanyEmailInput {
  companyName: string;
  /** §4.1 (1): an address printed in an enabled portal's listing, or null. */
  listingEmail: { email: string; sourceUrl: string; evidence: string } | null;
  /** §4.1 (2): the company's own website, when known. */
  websiteUrl: string | null;
  /**
   * §4.1 (3): did the permitted public-search step run, and what did it
   * return? `ran:false` means the step could not be performed at all, which
   * makes a company WITHOUT a website inconclusive (§4.4).
   */
  search: {
    ran: boolean;
    results: Array<{ content: string; sourceUrl: string }>;
  };
  /** §4.1 (4): trusted public pages already fetched for this company. */
  trustedPages: Array<{ content: string; sourceUrl: string }>;
  /** The guarded site pass, or null when the run's page budget is exhausted. */
  fetchSite: CompanySiteFetcher | null;
  /**
   * Official-site pages that were ALREADY fetched this run (domain
   * resolution): their text is extracted like any site page (same binding
   * rules, real provenance URLs) and they join `inspectedPages`. They are
   * facts — fetched, read, and on the verified domain — never guesses.
   */
  prefetchedPages?: CompanySiteTextPage[];
}

export interface CompanyEmailOutcome {
  /** Every accepted address, deduped, priority-ordered, all URLs kept. */
  emails: MergedAcceptedEmail[];
  /** Real access attempts (allowed sources only). */
  attempts: SourceAttempt[];
  /** The official-site pages that were actually fetched AND readable. A
   *  page listed here exists and was read during this run — the only URLs
   *  that may be exported as a verified application page. */
  inspectedPages: Array<{ url: string; kind: string }>;
  /** True when every REQUIRED source was inspected successfully. */
  requiredInspected: boolean;
  /** True when a required source was blocked or stayed inconclusive. */
  blocked: boolean;
  blockedReason: BlockedReason | null;
  /** Machine reason for the caller's outcome resolution (§4.4). */
  reasonCode: "email_found" | "no_public_email" | "source_blocked" | "no_website_found";
  /** The primary address (highest priority), or null. */
  primary: MergedAcceptedEmail | null;
  /**
   * Start year documented on the company's OWN inspected pages (null: no
   * site, no evidence, or conflict — the caller must then treat the year as
   * UNCONFIRMED, never as a guess).
   */
  siteYear: SiteYearEvidence | null;
}

/**
 * Resolve the public addresses of ONE company across all allowed sources.
 *
 * Never throws: an unexpected failure inside a step is recorded as an attempt
 * and treated as inconclusive, so one company can never end a run.
 */
export async function resolveCompanyEmails(
  input: CompanyEmailInput,
): Promise<CompanyEmailOutcome> {
  const collected: AcceptedEmail[] = [];
  const attempts: SourceAttempt[] = [];

  // ---- 1. the listing (enabled portals only) ------------------------------
  if (input.listingEmail) {
    const candidate = listingEmailCandidate({
      email: input.listingEmail.email,
      sourceUrl: input.listingEmail.sourceUrl,
      evidence: input.listingEmail.evidence,
      companyName: input.companyName,
    });
    if (candidate) collected.push(candidate);
  }

  // The website the COMPANY published (or the run/engine found). A company name
  // is never turned into a host.
  const website =
    input.websiteUrl ?? companyWebsiteFromPublishedEmail(input.listingEmail?.email);
  const companyDomain = website ? safeHost(website) : null;

  // ---- 3. permitted public search results --------------------------------
  for (const result of input.search.results) {
    collected.push(
      ...searchResultEmails({
        content: result.content,
        sourceUrl: result.sourceUrl,
        companyName: input.companyName,
        companyDomain,
      }),
    );
  }

  // ---- 4. trusted public pages -------------------------------------------
  for (const page of input.trustedPages) {
    collected.push(
      ...trustedPageEmails({
        content: page.content,
        sourceUrl: page.sourceUrl,
        companyName: input.companyName,
      }),
    );
  }

  // ---- 2. the official website -------------------------------------------
  let blocked = false;
  let blockedReason: BlockedReason | null = null;
  let requiredInspected = false;
  const inspectedPages: Array<{ url: string; kind: string }> = [];
  /** The company's own pages with their text (start-year evidence input). */
  const sitePagesWithText: CompanySiteTextPage[] = [];

  if (website) {
    // Pages already fetched this run on the verified domain (domain
    // resolution): extracted with the same binding rules, and listed as
    // inspected — they are real evidence, not a second fetch's promise.
    for (const page of input.prefetchedPages ?? []) {
      inspectedPages.push({ url: page.url, kind: page.kind });
      sitePagesWithText.push(page);
      collected.push(
        ...sitePageEmails({
          page,
          companyName: input.companyName,
          companyDomain,
        }),
      );
    }
    if (!input.fetchSite) {
      // The page budget is exhausted: the required source was NOT inspected,
      // so the outcome is inconclusive rather than "no public email".
      blocked = true;
      blockedReason = "unreachable";
    } else {
      const outcome = await input.fetchSite(website);
      attempts.push(...outcome.attempts);
      for (const page of outcome.pages) {
        inspectedPages.push({ url: page.url, kind: page.kind });
        sitePagesWithText.push(page);
        collected.push(
          ...sitePageEmails({
            page,
            companyName: input.companyName,
            companyDomain,
          }),
        );
      }
      if (outcome.blocked) {
        blocked = true;
        blockedReason = outcome.blockedReason;
      }
      requiredInspected = !outcome.blocked;
    }
  } else {
    // No website could be identified → the public-search step IS the required
    // source (§4.4). If it never ran, the outcome is inconclusive.
    if (input.search.ran) {
      requiredInspected = true;
    } else {
      blocked = true;
      blockedReason = "unreachable";
    }
  }

  // Start year documented on the company's OWN inspected pages: the
  // acceptance stage may confirm the run's beginn filter with it (year mode).
  // No site / no evidence / conflicting pages → null = UNCONFIRMED.
  const siteYear: SiteYearEvidence | null =
    sitePagesWithText.length > 0 ? siteYearEvidence(sitePagesWithText) : null;

  const emails = mergeAcceptedEmails(collected);
  const primary = emails[0] ?? null;

  if (primary) {
    // A found address wins: a block elsewhere never downgrades it (§4.4).
    return {
      emails,
      attempts,
      inspectedPages,
      requiredInspected,
      blocked: false,
      blockedReason: null,
      reasonCode: "email_found",
      primary,
      siteYear,
    };
  }

  if (!website && !input.search.ran) {
    return {
      emails,
      attempts,
      inspectedPages,
      requiredInspected: false,
      blocked: true,
      blockedReason: "unreachable",
      reasonCode: "no_website_found",
      primary: null,
      siteYear,
    };
  }

  if (blocked) {
    return {
      emails,
      attempts,
      inspectedPages,
      requiredInspected: false,
      blocked: true,
      blockedReason,
      reasonCode: "source_blocked",
      primary: null,
      siteYear,
    };
  }

  return {
    emails,
    attempts,
    inspectedPages,
    requiredInspected,
    blocked: false,
    blockedReason: null,
    reasonCode: "no_public_email",
    primary: null,
    siteYear,
  };
}

/**
 * The kinds of inspected page that count as an application/career entry point.
 * Only a page that was ACTUALLY fetched and read this run qualifies — a URL
 * guessed from the domain is never an application URL.
 */
const APPLICATION_PAGE_KINDS = new Set([
  "karriere",
  "career",
  "jobs",
  "stellenangebote",
  "ausbildung",
  "azubi",
  "bewerbung",
]);

/**
 * The verified application URL of a company: the first application/career
 * page that was actually inspected during the email pass (in the fixed
 * page-order, so Karriere wins over Jobs), else `fallback` (the source offer
 * page), else null.
 */
export function applicationUrlOf(
  outcome: Pick<CompanyEmailOutcome, "inspectedPages">,
  fallback: string | null | undefined,
): string | null {
  const hit = outcome.inspectedPages.find((page) =>
    APPLICATION_PAGE_KINDS.has(page.kind),
  );
  return hit?.url ?? (fallback && fallback.length > 0 ? fallback : null);
}

function safeHost(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

/**
 * The counting rule behind `onlyPublicEmail` (§4.6):
 *   true  → only companies with a VERIFIED published address are results, so a
 *           run may honestly end PARTIAL instead of padding the list;
 *   false → every company is a result, and the UI states the honest status
 *           (`no_public_email` / `source_blocked`) for the others.
 * A missing address never silently removes a company when the user asked for
 * all of them, and nothing is ever invented in either mode.
 */
export function countsAsResult(input: {
  onlyPublicEmail: boolean;
  hasPublicEmail: boolean;
  /** The three-outcome literal resolved for the company (§4.4). */
  outcome?: "email_found" | "no_public_email" | "source_blocked";
}): boolean {
  if (!input.onlyPublicEmail) return true;
  if (input.outcome === "source_blocked") return false;
  return input.hasPublicEmail;
}
