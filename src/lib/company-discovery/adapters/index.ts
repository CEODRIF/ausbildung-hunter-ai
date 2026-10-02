import "server-only";

import type { OpportunitySearchParams } from "@/lib/opportunities/types";
import {
  type WebSearchClient,
  type WebSearchResult,
} from "@/lib/web-search";
import type { AdapterResult, NormalizedOffer, OfferSourceAdapter } from "../adapter";
import { guardedFetch, type FetchContext } from "../fetch-guard";
import { detailLinks, parseListingPage } from "../listing";
import { generateSearchQueries, type SearchQueryMeta } from "../queries";
import type { SourceCategory, SourceId, SourcePolicy } from "../sources";
import { enabledSources, isPortalHost, isSourceEnabled, sourceById } from "../sources";

/**
 * The adapters that exist for `enabled_*` sources.
 *
 * One implementation serves every enabled portal: it goes through the guarded
 * fetcher (SSRF, robots, pacing, per-host circuit breaker, central classifier)
 * and reads offers ONLY from the platform's own `schema.org/JobPosting`
 * structured data. There is deliberately no site-specific CSS selector list —
 * a redesign could silently turn such selectors into wrong data, whereas
 * structured data is a machine-readable statement by the publisher itself.
 *
 * Two shapes cover every enabled source:
 *   `listing_query`       the listing page publishes JobPosting blocks itself
 *                         (Ausbildung.de; queried via `?q=`).
 *   `listing_then_detail` the listing is only an index of detail links, and the
 *                         JobPosting lives on the detail page (AUBI-plus.de).
 *                         The detail URL SHAPE is declared per source; the
 *                         FIELDS always come from the detail page.
 *
 * Every adapter returns a value, never a throw: a block is `blocked`, an
 * unexpected page yields ZERO offers — inventing one would be worse than
 * finding none.
 */

interface PortalAdapterConfig {
  id: SourceId;
  displayName: string;
  category: SourceCategory;
  policy: Extract<SourcePolicy, "enabled_public" | "enabled_official_api">;
  /**
   * The robots-allowed listing page. Query-free where the audit established
   * one, so the request never depends on a query string the portal might
   * disallow. Verified with a plain GET during implementation.
   */
  listingUrl: string;
  mode: "listing_query" | "listing_then_detail";
  /** Only for `listing_then_detail`: the documented detail URL shape. */
  detailPathPattern?: RegExp;
  /** Detail pages fetched per pass (kept inside the per-run page budget). */
  detailLimit?: number;
  /** Verified against a live page with a plain GET during implementation. */
  endpointConfirmed: boolean;
}

const PORTAL_CONFIGS: readonly PortalAdapterConfig[] = [
  {
    id: "ausbildung-de",
    displayName: "Ausbildung.de",
    category: "ausbildung",
    policy: "enabled_public",
    // The listing page itself carries the JobPosting blocks.
    listingUrl: "https://www.ausbildung.de/suche/",
    mode: "listing_query",
    endpointConfirmed: false,
  },
  {
    id: "aubi-plus-de",
    displayName: "AUBI-plus.de",
    category: "ausbildung",
    policy: "enabled_public",
    // Query-free listing path advertised by the site; robots allows it.
    listingUrl: "https://www.aubi-plus.de/aktuelle-ausbildungsplaetze/",
    mode: "listing_then_detail",
    // Shape of a detail page: /ausbildung/<slug>-<id>/
    detailPathPattern: /^\/ausbildung\/[a-z0-9-]+-\d+\/?$/i,
    detailLimit: 5,
    endpointConfirmed: true,
  },
] as const;

/**
 * Whether a source's endpoint was verified against a live page during
 * implementation. Unconfirmed adapters run fail-closed: an unexpected page
 * yields zero offers rather than invented ones.
 */
export const ENDPOINT_CONFIRMED: Partial<Record<SourceId, boolean>> =
  Object.fromEntries(
    PORTAL_CONFIGS.map((config) => [config.id, config.endpointConfirmed]),
  );

function targetGoal(criteria: OpportunitySearchParams): "ausbildung" | "arbeit" {
  return criteria.goal === "arbeit" ? "arbeit" : "ausbildung";
}

function searchQuery(criteria: OpportunitySearchParams): string {
  return [criteria.role, criteria.keyword]
    .map((part) => (part ?? "").trim())
    .filter(Boolean)
    .join(" ")
    .trim();
}

function createPortalAdapter(config: PortalAdapterConfig): OfferSourceAdapter {
  return {
    id: config.id,
    displayName: config.displayName,
    category: config.category,
    policy: config.policy,
    async searchOffers(criteria, ctx): Promise<AdapterResult> {
      const context = ctx as FetchContext;
      const goal = targetGoal(criteria);
      const query = searchQuery(criteria);
      // Nothing to look for — and no page worth fetching.
      if (config.mode === "listing_query" && !query) {
        return { status: "ok", offers: [] };
      }

      const listingUrl =
        config.mode === "listing_query"
          ? `${config.listingUrl}?q=${encodeURIComponent(query)}`
          : config.listingUrl;

      const listing = await guardedFetch(context, listingUrl, { textBudget: 20_000 });
      if (!listing.ok) {
        if (listing.kind === "blocked") {
          return { status: "blocked", reason: listing.reason };
        }
        return {
          status: "error",
          message: listing.kind === "unsafe" ? "unsafe_url" : listing.message,
        };
      }

      const listingContext = {
        offerSource: config.displayName,
        sourceId: config.id,
        field: criteria.keyword ?? null,
        goal,
      };

      // --- the listing page itself carries the offers ---------------------
      if (config.mode === "listing_query") {
        return {
          status: "ok",
          offers: parseListingPage({
            ...listingContext,
            html: listing.page.html,
            pageUrl: listing.page.finalUrl,
          }),
        };
      }

      // --- the listing is an index; the offers live on the detail pages ----
      const pattern = config.detailPathPattern;
      if (!pattern) return { status: "ok", offers: [] };
      const links = detailLinks({
        html: listing.page.html,
        pageUrl: listing.page.finalUrl,
        pattern,
        limit: config.detailLimit ?? 5,
      });

      const offers: NormalizedOffer[] = [];
      for (const link of links) {
        // A blocked detail page opens the circuit breaker for the host; the
        // loop then stops asking (the breaker refuses further requests), and
        // whatever was already read is still returned honestly.
        const detail = await guardedFetch(context, link, { textBudget: 20_000 });
        if (!detail.ok) {
          if (detail.kind === "blocked") {
            if (offers.length === 0) {
              return { status: "blocked", reason: detail.reason };
            }
            break;
          }
          continue;
        }
        offers.push(
          ...parseListingPage({
            ...listingContext,
            html: detail.page.html,
            pageUrl: detail.page.finalUrl,
          }),
        );
      }
      return { status: "ok", offers };
    },
  };
}

/**
 * The bounded budget of the search-engine OFFER-discovery layer. Two
 * independent page bounds: one PER QUERY (so no single family can eat the
 * radius) and one for the WHOLE RUN (the global safety bound).
 */
export interface SearchAdapterBudget {
  maxQueries: number;
  maxResultsPerQuery: number;
  /** Offer pages fetched for a single query. */
  maxPagesPerQuery: number;
  /** Total offer pages fetched across all queries. */
  maxPagesToFetch: number;
}

const DEFAULT_SEARCH_BUDGET: SearchAdapterBudget = {
  maxQueries: 12,
  maxResultsPerQuery: 10,
  maxPagesPerQuery: 5,
  maxPagesToFetch: 20,
};

/** The host of a URL, or "" when it cannot be parsed. */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

/**
 * The search-engine adapter (§6–§9). It is the ONE adapter that reaches the web
 * through the project's legitimate search provider (Tavily) — never by scraping
 * a search engine's result pages. For each bounded, structured query it takes
 * the provider's result URLs, drops portal/provider hosts, and fetches the rest
 * through the SAME guarded fetcher (SSRF / robots / pacing / circuit breaker /
 * central classifier) before reading only `schema.org/JobPosting` data.
 *
 * Like every adapter it returns a value, never a throw: a missing provider is
 * `skipped`, a per-query provider failure is skipped (the run continues), and a
 * blocked result page simply yields no offer (its host's breaker is already
 * open). No offer field is ever inferred — `parseListingPage` keeps missing
 * facts `null`.
 */
export function createSearchAdapter(
  client: WebSearchClient | null,
  meta: SearchQueryMeta = {},
  budget: SearchAdapterBudget = DEFAULT_SEARCH_BUDGET,
): OfferSourceAdapter {
  return {
    id: "search-api",
    displayName: "Search API (Tavily)",
    category: "search",
    policy: "enabled_official_api",
    async searchOffers(criteria, ctx): Promise<AdapterResult> {
      if (!client) {
        return { status: "skipped", reason: "search_provider_not_configured" };
      }
      const fetchContext = ctx as FetchContext;
      const queries = generateSearchQueries(criteria, meta, budget.maxQueries);
      if (queries.length === 0) {
        return {
          status: "ok",
          offers: [],
          stats: { queriesExecuted: 0, resultsInspected: 0 },
        };
      }
      const goal = targetGoal(criteria);

      const offers: NormalizedOffer[] = [];
      const seenUrls = new Set<string>();
      let pagesFetched = 0; // across ALL queries (the global bound)
      let queriesExecuted = 0; // provider queries actually issued

      for (const query of queries) {
        if (pagesFetched >= budget.maxPagesToFetch) break;
        let results: WebSearchResult[];
        queriesExecuted += 1; // the query WAS issued, whatever the provider says
        try {
          results = await client.search(query, budget.maxResultsPerQuery);
        } catch {
          // The provider refused/failed this one query — the step did not run;
          // the remaining queries still do. Never a run-ending error.
          continue;
        }
        let pagesThisQuery = 0;
        for (const result of results) {
          if (pagesFetched >= budget.maxPagesToFetch) break;
          if (pagesThisQuery >= budget.maxPagesPerQuery) break;
          const host = hostOf(result.url);
          if (!host) continue;
          // Portals have their own policy-gated adapters; the provider's own
          // host is never content. Both are left out of this layer.
          if (isPortalHost(host)) continue;
          if (host === "api.tavily.com" || host.endsWith(".tavily.com")) continue;
          if (seenUrls.has(result.url)) continue;
          seenUrls.add(result.url);

          const page = await guardedFetch(fetchContext, result.url, {
            textBudget: 20_000,
          });
          if (page.ok) {
            pagesFetched += 1;
            pagesThisQuery += 1;
            offers.push(
              ...parseListingPage({
                html: page.page.html,
                pageUrl: page.page.finalUrl,
                offerSource: "Search API (Tavily)",
                sourceId: "search-api",
                field: criteria.keyword ?? null,
                goal,
              }),
            );
          }
          // `blocked` → guardedFetch already opened that host's breaker; the
          // other results continue. `error`/`unsafe` → not an offer, move on.
        }
      }
      return {
        status: "ok",
        offers,
        stats: { queriesExecuted, resultsInspected: pagesFetched },
      };
    },
  };
}

/** Every implemented adapter, keyed by source id. */
const IMPLEMENTED: Partial<Record<SourceId, OfferSourceAdapter>> = {
  ...Object.fromEntries(
    PORTAL_CONFIGS.map((config) => [config.id, createPortalAdapter(config)]),
  ),
  // Static sentinel (no client) so the "enabled ⟹ adapter" invariant holds and
  // `adapterFor("search-api")` is non-null; the run builds a real one with the
  // provider client via `enabledAdapters({ searchClient })`.
  "search-api": createSearchAdapter(null),
};

/**
 * The adapter for a source — `null` for a `restricted`/`unverified` source, an
 * unregistered source, or an enabled source whose adapter is not written yet.
 * A `restricted` or `unverified` source is therefore NEVER requested.
 */
export function adapterFor(sourceId: string): OfferSourceAdapter | null {
  const source = sourceById(sourceId);
  if (!source || !isSourceEnabled(source)) return null;
  return IMPLEMENTED[source.id] ?? null;
}

export interface EnabledAdaptersOptions {
  /** The run's search client (its own bounded budget) or null when none. */
  searchClient?: WebSearchClient | null;
  /** Query/page budget for the search layer (from `discoveryLimits()`). */
  searchBudget?: SearchAdapterBudget;
  /** The run's beginn context for the query generator. */
  searchMeta?: SearchQueryMeta;
}

/**
 * All adapters of the run, in registry order. The search adapter is built with
 * THIS run's provider client + budget so its per-run request cap is honored
 * within the run; when no client is supplied it degrades to the sentinel
 * (which reports `skipped`, not an error).
 */
export function enabledAdapters(
  options: EnabledAdaptersOptions = {},
): OfferSourceAdapter[] {
  const searchClient = options.searchClient ?? null;
  const budget = options.searchBudget ?? DEFAULT_SEARCH_BUDGET;
  const meta = options.searchMeta ?? {};
  return enabledSources()
    .map((source) => {
      if (source.id === "search-api") {
        return createSearchAdapter(searchClient, meta, budget);
      }
      return IMPLEMENTED[source.id];
    })
    .filter((adapter): adapter is OfferSourceAdapter => adapter !== undefined);
}

/** Enabled sources that still have no adapter implementation. */
export function enabledSourcesWithoutAdapter(): SourceId[] {
  return enabledSources()
    .filter((source) => IMPLEMENTED[source.id] === undefined)
    .map((source) => source.id);
}
