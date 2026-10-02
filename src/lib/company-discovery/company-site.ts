import "server-only";

import type { NormalizedOffer } from "./adapter";
import { guardedFetch, type FetchContext } from "./fetch-guard";
import { detailLinks, parseListingPage } from "./listing";

/**
 * Company-website → more offers (§11). Once a run has discovered a company
 * whose OFFICIAL domain was already established (by the existing enrichment /
 * the offer's own `sameAs`), its own same-site Ausbildung / Karriere / Jobs
 * pages may carry further real offers.
 *
 * Deliberately conservative:
 *  - the entry point is the company's verified homepage;
 *  - preferred targets are the OFFER LINKS the homepage itself exposes
 *    (`detailLinks` with a declared path shape); only when it links none do we
 *    fall back to a few well-known offer paths;
 *  - EVERY fetch goes through the ONE guarded fetcher (SSRF / robots / pacing /
 *    per-host circuit breaker / central classifier) — a robots-disallowed or
 *    blocked page is never forced, and a block opens the host's breaker;
 *  - only `schema.org/JobPosting` data is read; missing fields stay `null`.
 */

/** Same-origin paths that plausibly hold a company's own offers. */
const OFFER_PATH_RE =
  /\/(ausbildung|ausbildungsplaetze|ausbildungs-plaetze|ausbildungsbetriebe|aktuelle-ausbildungsplaetze|karriere|jobs|stellen|stellenangebote|jobsuche|azubi|duales-studium|praktikum)(\/|$)/i;

/**
 * The well-known paths used ONLY when the homepage linked none of its own
 * offers. Besides the offer pages they include the pages where a company
 * publishes its CONTACT POINTS (Kontakt, Impressum, Team) — the same pages
 * the public-email pass reads, so one inspection serves both purposes. Every
 * path stays behind robots + the central classifier; the whole set is capped
 * by `maxPages` (total pages per company, homepage included).
 */
const FALLBACK_OFFER_PATHS: readonly string[] = [
  "/ausbildung",
  "/karriere",
  "/jobs",
  "/stellenangebote",
  "/kontakt",
  "/impressum",
  "/team",
];

export interface CompanySiteOfferInput {
  /** The company's verified official website (homepage origin). */
  websiteUrl: string;
  /** The run's field (context only when the listing states none). */
  field: string | null;
  /** The offer type this discovery pass targets. */
  goal: "ausbildung" | "arbeit";
  /** TOTAL pages to fetch for this company, homepage INCLUDED (bounded by
   *  the run's fan-out limits — default 6, hard cap 8). */
  maxPages: number;
}

export interface CompanySiteOfferResult {
  offers: NormalizedOffer[];
  /** Real pages fetched for this company (homepage + offer pages). */
  pagesFetched: number;
  /** True when the company's site refused (its host breaker is now open). */
  blocked: boolean;
  reason: string | null;
}

export async function discoverCompanySiteOffers(
  ctx: FetchContext,
  input: CompanySiteOfferInput,
): Promise<CompanySiteOfferResult> {
  const offers: NormalizedOffer[] = [];
  let pagesFetched = 0;
  let blocked = false;
  let reason: string | null = null;

  const listingContext = {
    offerSource: "Company websites",
    sourceId: "company-websites",
    field: input.field,
    goal: input.goal,
  };

  // 1. the homepage itself (parse + expose its offer links).
  const home = await guardedFetch(ctx, input.websiteUrl, { textBudget: 20_000 });
  if (!home.ok) {
    if (home.kind === "blocked") {
      return { offers, pagesFetched, blocked: true, reason: home.reason };
    }
    return { offers, pagesFetched, blocked: false, reason: null };
  }
  pagesFetched += 1;
  offers.push(
    ...parseListingPage({ ...listingContext, html: home.page.html, pageUrl: home.page.finalUrl }),
  );

  const hardPageCeiling = Math.max(1, input.maxPages);
  if (pagesFetched >= hardPageCeiling) {
    return { offers, pagesFetched, blocked, reason };
  }

  // 2. offer links the homepage exposes (same-origin, declared shape).
  const targets = detailLinks({
    html: home.page.html,
    pageUrl: home.page.finalUrl,
    pattern: OFFER_PATH_RE,
    limit: hardPageCeiling - 1,
  });

  // 3. no linked offers → the well-known paths (offer + contact points),
  //    still robots-gated, still capped by the company page budget.
  if (targets.length === 0) {
    let origin: string;
    try {
      origin = new URL(home.page.finalUrl).origin;
    } catch {
      return { offers, pagesFetched, blocked, reason };
    }
    for (const path of FALLBACK_OFFER_PATHS) {
      if (targets.length >= hardPageCeiling - 1) break;
      targets.push(`${origin}${path}`);
    }
  }

  for (const target of targets) {
    if (pagesFetched >= hardPageCeiling) break;
    const page = await guardedFetch(ctx, target, { textBudget: 20_000 });
    if (!page.ok) {
      if (page.kind === "blocked") {
        blocked = true;
        reason = page.reason;
        break; // the host breaker is open; stop asking it
      }
      continue; // a technical failure is not an answer, and not a block
    }
    pagesFetched += 1;
    offers.push(
      ...parseListingPage({ ...listingContext, html: page.page.html, pageUrl: page.page.finalUrl }),
    );
  }

  return { offers, pagesFetched, blocked, reason };
}
