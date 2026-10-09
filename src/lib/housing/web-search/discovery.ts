import "server-only";

import { createHash } from "node:crypto";

import type { HousingListing, HousingSearchParams } from "@/lib/housing/types";

import {
  azureWebSearch,
  WebSearchApiError,
  type SearchCitation,
  type WebDiscoveryResult,
} from "./azure-client";
import {
  ALLOWED_DOMAINS,
  domainForHost,
  LIMITS,
  resolveSearchProvider,
  type AllowedDomain,
  type ResolvedSearchProvider,
} from "./config";
import { buildHousingQueries } from "./queries";
import { parseModelListings, type ModelListingItem } from "./parse-model-listings";
import { guardedFetch, UnsafeUrlError } from "./url-guard";
import { parseListingPage } from "./parse-listing";
import { robotsVerdictForUrl } from "./robots";

/**
 * Housing web-discovery pipeline (general + targeted modes).
 *
 * Retrieval (cost-aware multi-query):
 *   general  — 1 primary German search call; a SECOND complementary German
 *              call only when the first yields fewer than
 *              LIMITS.webModeSecondCallThreshold usable candidates. Both
 *              result sets are merged and deduped, so a rich first call is
 *              not chased with a redundant paid call.
 *   targeted — exactly 1 domain-restricted search call
 *   fetches  — ≤ maxPagesToFetch pages, allowlisted FETCHABLE-policy
 *              domains only (both modes), robots-checked first (fail-
 *              closed), SSRF-guarded. Unreviewed domains are never fetched.
 *
 * Whole-web mode is NOT display-filtered to the reviewed allowlist
 * (2026-10-10 audit: that filter was the main cause of "Berlin returns
 * only seven" — Bing's own results outside the 7 reviewed portals were
 * silently dropped). The allowlist still decides FETCHABILITY: only
 * reviewed, explicitly fetchable open-data domains may be fetched;
 * everything else is link-only (search snippets / model-stated fields).
 * Targeted mode remains bound to the user's selected domains.
 *
 * Honesty:
 *   - Every displayed listing URL must be a URL the search tool actually
 *     returned (citations ∪ action.sources). The model's JSON answer is
 *     cross-validated against that set — invented URLs are dropped and
 *     counted (fabricatedRejected).
 *   - verification_status: "verified" ONLY for fields parsed from a fetched
 *     page (JSON-LD / explicit text). Model-stated fields with a genuine
 *     citation → "partially_verified". Discovery only → "unverified".
 *   - fields we cannot verify stay null — never invented.
 *   - expiry is discarded only when RELIABLY established (a fetched page
 *     states an availability date already in the past).
 *
 * Enterprise TOU (Grounding with Bing): output is cached in-memory only
 * (15-min TTL, work-product scope), citations are preserved verbatim for
 * display, and no persistent database of search output is built.
 */

export type WebSearchMode = "web" | "targeted";

export interface HousingWebSearchInput {
  mode: WebSearchMode;
  params: Pick<
    HousingSearchParams,
    | "city"
    | "postal_code"
    | "radius_km"
    | "max_warm_rent"
    | "accommodation_type"
    | "rooms"
    | "min_area_sqm"
    | "available_before"
  >;
  /** targeted mode: subset of the allowlist (default: all allowlisted). */
  domains?: string[];
}

/**
 * Pipeline-level statuses. NOTE: the per-user DAILY quota is enforced by the
 * route (server-side, per user, Europe/Berlin day — see ./quota.ts); the
 * route answers quota exhaustion with status "daily_quota_exhausted" before
 * this pipeline is ever entered.
 */
export type WebSearchStatus =
  | "ok"
  | "not_configured"
  | "tool_blocked"
  | "endpoint_unavailable"
  | "rate_limited"
  | "provider_error"
  | "timeout";

/**
 * Result funnel — safe, count-only diagnostics (never URLs or response
 * text) so "search ran but few/no results displayed" is explainable from
 * the API response alone.
 */
export interface SearchFunnel {
  /** Distinct real URLs the search tool returned (citations ∪ sources). */
  candidatesRetrieved: number;
  /** URLs that were not valid http(s). */
  invalidUrls: number;
  /** Real URLs already seen (dedup across queries/calls/portals). */
  duplicatesRemoved: number;
  /** (targeted mode) real URLs outside the user's selected domains. */
  offAllowlist: number;
  /** Real URLs that are not individual listing pages (home/search/legal). */
  notListingUrl: number;
  /** Model JSON items parsed (valid URLs, sane field values). */
  jsonItems: number;
  /** Model JSON items whose URL was NOT returned by the search tool. */
  fabricatedRejected: number;
  /** Listings finally returned to the client. */
  displayed: number;
}

export interface HousingWebSearchOutcome {
  status: WebSearchStatus;
  message: string | null;
  /** Azure-only feature — never anything else (see ./config). */
  provider: "azure" | null;
  mode: WebSearchMode;
  listings: HousingListing[];
  /** Citations exactly as returned by the search tool (display required). */
  citations: SearchCitation[];
  /** The queries actually sent to the search provider. */
  queries: string[];
  stats: {
    searchCalls: number;
    pagesFetched: number;
    /** Billable Bing transactions (azure only, when reported). */
    bingRequests: number | null;
  };
  funnel: SearchFunnel;
  warnings: string[];
  cached: boolean;
  fetchedAt: string;
}

export const ZERO_FUNNEL: SearchFunnel = {
  candidatesRetrieved: 0,
  invalidUrls: 0,
  duplicatesRemoved: 0,
  offAllowlist: 0,
  notListingUrl: 0,
  jsonItems: 0,
  fabricatedRejected: 0,
  displayed: 0,
};

// --- result cache (in-memory, TTL — work-product scope only) ----------------

interface CacheEntry {
  at: number;
  outcome: HousingWebSearchOutcome;
}
const resultCache = new Map<string, CacheEntry>();
export function clearWebSearchCache(): void {
  resultCache.clear();
}

function cacheKey(input: HousingWebSearchInput): string {
  const norm = JSON.stringify({
    mode: input.mode,
    p: input.params,
    d: input.domains ? [...input.domains].sort() : null,
  });
  return createHash("sha256").update(norm).digest("hex").slice(0, 32);
}

// --- candidate handling ------------------------------------------------------

interface Candidate {
  url: string;
  title: string;
  /** Reviewed allowlist entry for the host, or null (unreviewed — never
   *  fetched; displayed with the bare hostname as source). */
  domain: AllowedDomain | null;
  /** Model-stated fields, cross-validated against the real result set. */
  json: ModelListingItem | null;
}

/** Legal / auth / info pages that can never be an individual listing. */
const NON_LISTING_PATH_RE =
  /^\/(impressum|datenschutz|agb|kontakt|login|registrieren|anmelden|hilfe|faq|jobs|karriere|about|en\/?|de\/?|sitemap\.xml|robots\.txt|api\/)(?!.*\d{6})/i;

/**
 * Portal SEARCH / overview / category pages — these must NOT be presented
 * as individual rental listings (task rule: do not mislabel a search page).
 */
const SEARCH_RESULTS_PATH_RE =
  /\/(suche|suchergebnisse|search|browse|kategorie|kategorien|category|categories|stadt|staedte|region|regionen|ort|orte|preiskarte|preise-check|markt|s-wohnung|s-hauser|s-zimmer|s-angebot)([/?#-]|$)/i;

/**
 * Domain-AGNOSTIC individual-listing indicators. German portals put a 6+
 * digit id in the path (the dominant pattern: /expose/123456789,
 * wg-gesucht slugs, kleinanzeigen "c20:123456789"); slugged portals use
 * listing-like path segments or a numeric id query parameter.
 */
const LISTING_SEGMENT_RE =
  /\/(expose|exposes|angebot|angebote|detail|details|immobilie|obj|objekt|objekte|listing|listings|property|properties|flat|flats|apartment|apartments|room|rooms|ad|ads|wohnung|zimmer|wg)([/?#]|$)/i;
const LISTING_QUERY_RE = /[?&](id|expose|objekt|objnr|angebot|listing|property|flat|room|ad)=\d{4,}/i;

function normalizeUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    u.hash = "";
    // Drop tracking params; keep everything else (listings often need ids).
    for (const key of [...u.searchParams.keys()]) {
      if (/^(utm_|gclid|fbclid|ref|source|campaign)/i.test(key)) u.searchParams.delete(key);
    }
    u.hostname = u.hostname.toLowerCase().replace(/^www\./, "");
    return u.toString().replace(/^http:/, "https:");
  } catch {
    return null;
  }
}

function looksLikeListingUrl(url: URL, domain: AllowedDomain | null): boolean {
  const path = url.pathname;
  if (NON_LISTING_PATH_RE.test(path)) return false;
  if (SEARCH_RESULTS_PATH_RE.test(path)) return false;
  // Open-data dataset pages are "listings" for our purposes (machine-readable
  // housing data).
  if (domain === null || (domain.domain !== "open.nrw" && domain.domain !== "opendata.de")) {
    // Generic individual-listing heuristics (any domain).
    return (
      /\d{6,}/.test(path) || LISTING_SEGMENT_RE.test(path) || LISTING_QUERY_RE.test(url.search)
    );
  }
  return /\/(dataset|data|api)\//i.test(path);
}

interface CollectResult {
  candidates: Candidate[];
  /** Distinct normalized real URLs (before the listing heuristic). */
  candidatesRetrieved: number;
  invalidUrls: number;
  duplicatesRemoved: number;
  offAllowlist: number;
  notListingUrl: number;
}

/**
 * Turn raw citations + sources into validated candidates.
 *
 * - targeted mode: the user's selected domains are BINDING (off-allowlist
 *   URLs are dropped and counted).
 * - web mode: no display filter — any valid individual-listing URL is
 *   accepted (the allowlist only governs fetchability, via `domain`).
 */
function collectCandidates(
  citations: SearchCitation[],
  sources: string[],
  input: HousingWebSearchInput,
): CollectResult {
  const inTargeted = input.mode === "targeted";
  const selectedDomains =
    inTargeted && input.domains && input.domains.length > 0
      ? new Set(input.domains)
      : inTargeted
        ? new Set(ALLOWED_DOMAINS.map((d) => d.domain))
        : null; // web mode: not binding

  const titleByUrl = new Map<string, string>();
  for (const c of citations) {
    const n = normalizeUrl(c.url);
    if (n && c.title && !titleByUrl.has(n)) titleByUrl.set(n, c.title);
  }

  const out = new Map<string, Candidate>();
  const order: string[] = [];
  let invalidUrls = 0;
  let duplicatesRemoved = 0;
  let offAllowlist = 0;
  let notListingUrl = 0;

  const push = (rawUrl: string) => {
    const normalized = normalizeUrl(rawUrl);
    if (!normalized) {
      invalidUrls += 1;
      return;
    }
    if (out.has(normalized)) {
      duplicatesRemoved += 1;
      return;
    }
    let u: URL;
    try {
      u = new URL(normalized);
    } catch {
      invalidUrls += 1;
      return;
    }
    const entry = domainForHost(u.hostname);
    if (selectedDomains !== null) {
      // targeted mode: the user's selection is binding.
      if (!entry || !selectedDomains.has(entry.domain)) {
        offAllowlist += 1;
        return;
      }
    }
    if (!looksLikeListingUrl(u, entry)) {
      notListingUrl += 1;
      return;
    }
    out.set(normalized, {
      url: normalized,
      title: titleByUrl.get(normalized) ?? "",
      domain: entry,
      json: null,
    });
    order.push(normalized);
  };

  // Citations first (they carry titles), then the tool's source list.
  for (const c of citations) push(c.url);
  for (const s of sources) push(s);

  return {
    candidates: order.map((k) => out.get(k)!),
    candidatesRetrieved: countDistinctRealUrls(citations, sources),
    invalidUrls,
    duplicatesRemoved,
    offAllowlist,
    notListingUrl,
  };
}

function countDistinctRealUrls(citations: SearchCitation[], sources: string[]): number {
  const seen = new Set<string>();
  for (const c of citations) {
    const n = normalizeUrl(c.url);
    if (n) seen.add(n);
  }
  for (const s of sources) {
    const n = normalizeUrl(s);
    if (n) seen.add(n);
  }
  return seen.size;
}

function titleExtractsRent(title: string): { cold: number | null; warm: number | null } {
  const cold = title.match(/Kalt(?:miete)?\s*(?:von)?\s*[:\-–]?\s*(\d{1,5}(?:[ .,]\d{1,3}){0,3})\s*(?:€|EUR|Euro)/i);
  const warm = title.match(/Warm(?:miete)?\s*(?:von)?\s*[:\-–]?\s*(\d{1,5}(?:[ .,]\d{1,3}){0,3})\s*(?:€|EUR|Euro)/i);
  const parse = (raw: string | undefined): number | null => {
    if (!raw) return null;
    const cleaned = raw.replace(/\s/g, "");
    const n = Number.parseFloat(cleaned.includes(",") ? cleaned.replace(".", "").replace(",", ".") : cleaned.replace(/\.(?=\d{3})/g, ""));
    return Number.isFinite(n) ? n : null;
  };
  return { cold: parse(cold?.[1]), warm: parse(warm?.[1]) };
}

function stableSourceId(url: string): string {
  return createHash("sha1").update(url).digest("hex").slice(0, 16);
}

function isPastIsoDate(value: string | null, now: number): boolean {
  if (!value) return false;
  const ts = Date.parse(value);
  return Number.isFinite(ts) && ts < now;
}

// --- the pipeline -------------------------------------------------------------

export interface DiscoveryDependencies {
  now?: () => number;
  fetchImpl?: typeof fetch;
  /** Inject a provider (tests). Omitted → resolveSearchProvider(). */
  provider?: ResolvedSearchProvider | null;
  /**
   * Tests inject `fetchImpl` (drives the Azure call, robots and page
   * fetches). No network is needed.
   */
}

export async function runHousingWebSearch(
  input: HousingWebSearchInput,
  deps: DiscoveryDependencies = {},
): Promise<HousingWebSearchOutcome> {
  const now = deps.now ?? Date.now;
  const started = now();
  const warnings: string[] = [];
  const funnel: SearchFunnel = { ...ZERO_FUNNEL };

  const fail = (
    status: WebSearchStatus,
    message: string | null,
    provider: "azure" | null,
    extra: Partial<Pick<HousingWebSearchOutcome, "citations" | "queries" | "listings">> = {},
  ): HousingWebSearchOutcome => ({
    status,
    message,
    provider,
    mode: input.mode,
    listings: extra.listings ?? [],
    citations: extra.citations ?? [],
    queries: extra.queries ?? [],
    stats: { searchCalls: 0, pagesFetched: 0, bingRequests: null },
    funnel: { ...funnel },
    warnings,
    cached: false,
    fetchedAt: new Date(started).toISOString(),
  });

  // 1) Provider resolution (honest "not configured" state, not an error).
  const provider = deps.provider === undefined ? resolveSearchProvider() : deps.provider;
  if (!provider) {
    return fail("not_configured", "no_search_provider", null);
  }

  // 2) Result cache (same search within TTL → no paid call).
  const key = cacheKey(input);
  const cachedEntry = resultCache.get(key);
  if (cachedEntry && now() - cachedEntry.at <= LIMITS.cacheTtlMs) {
    return { ...cachedEntry.outcome, cached: true };
  }

  // 3) Build queries (two complementary German queries for general mode).
  const built = buildHousingQueries(input.params);
  const location = input.params.city.trim() || input.params.postal_code.trim();
  const userLocation = location
    ? { country: "DE", city: input.params.city.trim() || undefined }
    : undefined;

  // 4) Run bounded search calls. Each call gets a timeout that respects the
  //    whole-request budget, so two 20 s calls can never run past it.
  const searchCalls: string[] = [];
  let bingRequests: number | null = null;
  let webSearchCalls = 0;
  let citations: SearchCitation[] = [];
  let sources: string[] = [];
  let jsonItems: ModelListingItem[] = [];

  const requestDeadline = started + LIMITS.requestTimeoutMs;
  const timeoutForCall = (): number =>
    Math.max(8_000, Math.min(LIMITS.searchTimeoutMs, requestDeadline - now()));

  // Azure-only search call: the resolver (./config) guarantees `provider`
  // is a fully validated `azure` provider or null (handled above). There is
  // deliberately NO fallback provider in the housing pipeline.
  const runOneCall = async (
    query: string,
    allowed: string[] | undefined,
  ): Promise<WebDiscoveryResult> => {
    searchCalls.push(query);
    const res = await azureWebSearch({
      base: provider.base,
      key: provider.key,
      model: provider.model,
      input: query,
      allowedDomains: allowed,
      userLocation,
      fetchImpl: deps.fetchImpl,
      timeoutMs: timeoutForCall(),
    });
    bingRequests =
      bingRequests === null ? res.numRequests : bingRequests + (res.numRequests ?? 0);
    webSearchCalls += res.webSearchCalls;
    return res;
  };

  const mergeCall = (res: WebDiscoveryResult): void => {
    citations = [...citations, ...res.citations];
    sources = [...sources, ...res.sources];
    // Structured model answer (JSON per the query contract). Parsed per call
    // — concatenating two call texts would break array extraction.
    const parsed = parseModelListings(res.text);
    if (parsed.truncated) warnings.push("json_truncated_salvaged");
    jsonItems = [...jsonItems, ...parsed.items];
  };

  const selectedDomains =
    input.mode === "targeted" && input.domains && input.domains.length > 0
      ? input.domains
      : ALLOWED_DOMAINS.map((d) => d.domain);

  try {
    if (input.mode === "targeted") {
      mergeCall(await runOneCall(built.targetedQuery, selectedDomains));
    } else {
      // Cost-aware multi-query: primary call first; the complementary
      // second call only when the first under-delivered.
      mergeCall(await runOneCall(built.queries[0], undefined));
      const probe = collectCandidates(citations, sources, input).candidates.length;
      if (probe < LIMITS.webModeSecondCallThreshold) {
        try {
          mergeCall(await runOneCall(built.queries[1], undefined));
        } catch (secondError) {
          // The FIRST call succeeded — keep its results and report the
          // partial run honestly instead of failing the whole search.
          const failed =
            secondError instanceof WebSearchApiError ? secondError.failure : "provider_error";
          warnings.push(`second_call_failed:${failed}`);
        }
      }
    }
  } catch (error) {
    if (error instanceof WebSearchApiError) {
      const status: WebSearchStatus =
        error.failure === "tool_blocked"
          ? "tool_blocked"
          : error.failure === "endpoint_unavailable"
            ? "endpoint_unavailable"
            : error.failure === "rate_limited"
              ? "rate_limited"
              : error.failure === "timeout"
                ? "timeout"
                : "provider_error";
      return fail(status, error.message, provider.kind, { citations, queries: searchCalls });
    }
    if (error instanceof Error && error.name === "WebSearchError") {
      return fail("provider_error", "The web search provider rejected the request.", provider.kind, {
        citations,
        queries: searchCalls,
      });
    }
    return fail("provider_error", "The web search request failed.", provider.kind, {
      citations,
      queries: searchCalls,
    });
  }

  // 5) Collect + dedupe candidates.
  const collected = collectCandidates(citations, sources, input);
  funnel.candidatesRetrieved = collected.candidatesRetrieved;
  funnel.invalidUrls = collected.invalidUrls;
  funnel.duplicatesRemoved = collected.duplicatesRemoved;
  funnel.offAllowlist = collected.offAllowlist;
  funnel.notListingUrl = collected.notListingUrl;
  funnel.jsonItems = jsonItems.length;

  // 6) Cross-validate the model's JSON items against the REAL result set
  //    (citations ∪ sources): the fabrication guard. A JSON url that the
  //    search tool never returned is dropped and counted.
  const realUrls = new Set<string>();
  for (const c of citations) {
    const n = normalizeUrl(c.url);
    if (n) realUrls.add(n);
  }
  for (const s of sources) {
    const n = normalizeUrl(s);
    if (n) realUrls.add(n);
  }
  const candidatesByNormalizedUrl = new Map<string, Candidate>();
  for (const c of collected.candidates) candidatesByNormalizedUrl.set(c.url, c);
  for (const item of jsonItems) {
    const n = normalizeUrl(item.url);
    if (!n || !realUrls.has(n)) {
      funnel.fabricatedRejected += 1;
      continue;
    }
    const target = candidatesByNormalizedUrl.get(n);
    if (!target) continue; // not an individual listing page — field data unusable
    if (target.json === null) target.json = item;
  }

  if (collected.candidates.length === 0) {
    if (citations.length === 0 && sources.length === 0 && webSearchCalls === 0) {
      // The model answered WITHOUT invoking the web_search tool — the single
      // most likely cause of a silent empty result (official docs: prompt
      // more explicitly; we do, but the model can still decline).
      warnings.push("azure_no_web_search_call");
    }
    warnings.push(input.mode === "targeted" ? "no_candidates_on_allowed_domains" : "no_candidates_found");
  }
  if (funnel.invalidUrls > 0) warnings.push(`candidates_dropped_invalid_url=${funnel.invalidUrls}`);
  if (funnel.offAllowlist > 0) warnings.push(`candidates_dropped_off_allowlist=${funnel.offAllowlist}`);
  if (funnel.notListingUrl > 0) warnings.push(`candidates_dropped_not_listing_url=${funnel.notListingUrl}`);
  if (funnel.fabricatedRejected > 0) warnings.push(`fabricated_urls_rejected=${funnel.fabricatedRejected}`);
  if (jsonItems.length > 0 && funnel.fabricatedRejected === jsonItems.length) {
    // The model answered with JSON but NONE of the URLs are real — treat the
    // whole answer as unusable, keep the citation-based candidates.
    for (const c of candidatesByNormalizedUrl.values()) c.json = null;
  }

  const candidates = collected.candidates.slice(0, LIMITS.maxResults);

  // 7) Enrichment: fetch + verify on allowlisted FETCHABLE-policy domains
  //    only (both modes). Robots-checked (fail-closed), SSRF-guarded.
  const listings: HousingListing[] = [];
  let pagesFetched = 0;

  for (const candidate of candidates) {
    if (now() > requestDeadline) {
      warnings.push("request_timeout_budget");
      break;
    }
    let verification: HousingListing["verification_status"] = "unverified";
    let parsed: ReturnType<typeof parseListingPage> | null = null;
    let titleRentCold: number | null = null;
    let titleRentWarm: number | null = null;

    const fetchable = candidate.domain?.policy === "fetchable";
    if (fetchable && candidate.domain) {
      if (pagesFetched >= LIMITS.maxPagesToFetch) {
        warnings.push("fetch_budget_exhausted");
      } else {
        const url = new URL(candidate.url);
        const verdict = await robotsVerdictForUrl(url, { fetchImpl: deps.fetchImpl, now });
        if (verdict === "allowed") {
          try {
            const page = await guardedFetch(candidate.url, candidate.domain, {
              fetchImpl: deps.fetchImpl,
            });
            pagesFetched += 1;
            parsed = parseListingPage(page.text);
            // "verified" requires STRUCTURED or explicitly-labelled facts —
            // a bare <title> tag is not enough.
            const strong =
              parsed.fromJsonLd ||
              parsed.rentColdEur != null ||
              parsed.rentWarmEur != null ||
              parsed.rooms != null ||
              parsed.livingAreaSqm != null;
            verification = strong ? "verified" : "partially_verified";
          } catch (error) {
            // Fetch problems NEVER block the rest of the results: the
            // candidate stays, simply unverified (or partially, from JSON).
            if (error instanceof UnsafeUrlError) {
              warnings.push(`unsafe_url_skipped:${candidate.domain.domain}`);
            } else {
              warnings.push(`fetch_failed:${candidate.domain.domain}`);
            }
          }
        } else {
          warnings.push(
            verdict === "disallowed"
              ? `robots_blocked:${candidate.domain.domain}`
              : `robots_unknown:${candidate.domain.domain}`,
          );
        }
      }
    }

    // Model-stated fields (with a genuine citation) or title-level facts
    // upgrade to "partially_verified" — never "verified".
    const json = candidate.json;
    const hasJsonFacts =
      json !== null &&
      (json.title !== null ||
        json.city !== null ||
        json.rent_cold_eur !== null ||
        json.rent_warm_eur !== null ||
        json.additional_costs_eur !== null ||
        json.rooms !== null ||
        json.living_area_sqm !== null ||
        json.floor !== null ||
        json.available_from !== null ||
        json.furnished !== null);
    if (verification === "unverified" && hasJsonFacts) verification = "partially_verified";

    if (parsed == null && candidate.title) {
      const t = titleExtractsRent(candidate.title);
      titleRentCold = t.cold;
      titleRentWarm = t.warm;
      if (verification === "unverified" && (t.cold != null || t.warm != null)) {
        verification = "partially_verified";
      }
    }

    // 8) Expiry — discard ONLY when reliably established (fetched page
    //    states availability already ended).
    if (parsed && isPastIsoDate(parsed.availableUntil, started)) {
      warnings.push("expired_listing_discarded");
      continue;
    }

    // 9) Normalize to HousingListing (unknown fields stay null — never
    //    invented). Precedence: fetched page > model JSON (cited) > title.
    const listing: HousingListing = {
      provider: "web-search",
      source_id: stableSourceId(candidate.url),
      title: candidate.title || json?.title || "Titel unbekannt",
      listing_url: candidate.url,
      city: input.params.city.trim() || parsed?.city || json?.city || "",
      postal_code: input.params.postal_code.trim() || parsed?.postalCode || null,
      address: null,
      latitude: null,
      longitude: null,
      rent_cold_eur: parsed?.rentColdEur ?? json?.rent_cold_eur ?? titleRentCold ?? null,
      additional_costs_eur: json?.additional_costs_eur ?? null,
      rent_warm_eur: parsed?.rentWarmEur ?? json?.rent_warm_eur ?? titleRentWarm ?? null,
      deposit_eur: null,
      rooms: parsed?.rooms ?? json?.rooms ?? null,
      living_area_sqm: parsed?.livingAreaSqm ?? json?.living_area_sqm ?? null,
      available_from: parsed?.availableFrom ?? json?.available_from ?? null,
      furnished: json?.furnished ?? false,
      balcony: false,
      pets_allowed: null,
      wg_suitable: false, // unknown from search — never claimed
      verified: false, // we never claim portal-side verification
      accommodation_type: input.params.accommodation_type === "all" ? "apartment" : input.params.accommodation_type,
      images: parsed?.images ?? [],
      features: [],
      description: null,
      provider_updated_at: null,
      last_checked_at: new Date(now()).toISOString(),
      source_terms_version: null,
      data_status: "live",
      listing_active: null,
      source_type: parsed ? "page_fetch" : "web_search",
      verification_status: verification,
      floor: json?.floor ?? null,
      source_label: json?.source ?? null,
    };
    listings.push(listing);
  }

  funnel.displayed = listings.length;

  const outcome: HousingWebSearchOutcome = {
    status: "ok",
    message: null,
    provider: provider.kind,
    mode: input.mode,
    listings,
    citations,
    queries: searchCalls,
    stats: {
      searchCalls: searchCalls.length,
      pagesFetched,
      bingRequests,
    },
    funnel: { ...funnel },
    warnings: [...new Set(warnings)],
    cached: false,
    fetchedAt: new Date(now()).toISOString(),
  };

  resultCache.set(key, { at: now(), outcome });
  return outcome;
}
