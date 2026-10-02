import "server-only";

import {
  acceptEmailsFromContent,
  mergeAcceptedEmails,
  type AcceptedEmail,
  type MergedAcceptedEmail,
} from "./accept";
import type { BlockedReason } from "./classify";
import { guardedFetch, type FetchContext } from "./fetch-guard";
import { isFreeMailDomain } from "@/lib/opportunities/company-contact";
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
 * Pages fetched per company. The §4.7 ceiling is 6; this budget is deliberately
 * lower because Impressum/Kontakt almost always suffice in Germany.
 */
export const MAX_EMAIL_PAGES_PER_COMPANY = 3;

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
    })).slice(0, MAX_EMAIL_PAGES_PER_COMPANY);

    /** Required pages that were actually inspected (reachable, not blocked). */
    const inspected = new Set<string>();
    const REQUIRED_KINDS = ["impressum", "kontakt"];

    for (const target of targets) {
      const result = await guardedFetch(ctx, target.url, { textBudget: 20_000 });
      if (result.ok) {
        pages.push({ url: result.page.finalUrl, kind: target.kind, text: result.page.text });
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

    return {
      pages,
      attempts: ctx.attempts.slice(attemptsBefore),
      blocked,
      blockedReason,
    };
  };
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
}

export interface CompanyEmailOutcome {
  /** Every accepted address, deduped, priority-ordered, all URLs kept. */
  emails: MergedAcceptedEmail[];
  /** Real access attempts (allowed sources only). */
  attempts: SourceAttempt[];
  /** True when every REQUIRED source was inspected successfully. */
  requiredInspected: boolean;
  /** True when a required source was blocked or stayed inconclusive. */
  blocked: boolean;
  blockedReason: BlockedReason | null;
  /** Machine reason for the caller's outcome resolution (§4.4). */
  reasonCode: "email_found" | "no_public_email" | "source_blocked" | "no_website_found";
  /** The primary address (highest priority), or null. */
  primary: MergedAcceptedEmail | null;
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

  if (website) {
    if (!input.fetchSite) {
      // The page budget is exhausted: the required source was NOT inspected,
      // so the outcome is inconclusive rather than "no public email".
      blocked = true;
      blockedReason = "unreachable";
    } else {
      const outcome = await input.fetchSite(website);
      attempts.push(...outcome.attempts);
      for (const page of outcome.pages) {
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

  const emails = mergeAcceptedEmails(collected);
  const primary = emails[0] ?? null;

  if (primary) {
    // A found address wins: a block elsewhere never downgrades it (§4.4).
    return {
      emails,
      attempts,
      requiredInspected,
      blocked: false,
      blockedReason: null,
      reasonCode: "email_found",
      primary,
    };
  }

  if (!website && !input.search.ran) {
    return {
      emails,
      attempts,
      requiredInspected: false,
      blocked: true,
      blockedReason: "unreachable",
      reasonCode: "no_website_found",
      primary: null,
    };
  }

  if (blocked) {
    return {
      emails,
      attempts,
      requiredInspected: false,
      blocked: true,
      blockedReason,
      reasonCode: "source_blocked",
      primary: null,
    };
  }

  return {
    emails,
    attempts,
    requiredInspected,
    blocked: false,
    blockedReason: null,
    reasonCode: "no_public_email",
    primary: null,
  };
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
