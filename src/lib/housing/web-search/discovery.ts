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
import { extractCityFromText, matchCity } from "./geo";
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
 *              result sets are merged and deduped.
 *   targeted — exactly 1 domain-restricted search call
 *   fetches  — ≤ maxPagesToFetch pages, allowlisted FETCHABLE-policy
 *              domains only (both modes), robots-checked first (fail-
 *              closed), SSRF-guarded. Unreviewed domains are never fetched.
 *
 * Location correctness (2026-10-10 production fix):
 *   A result is labelled with the requested city ONLY when its location
 *   evidence (fetched page > cited model JSON > title/URL-slug scan)
 *   supports it. Evidence naming a KNOWN different German city → the
 *   result is rejected and counted (cityMismatches). Absent/unknown
 *   evidence → shown with `city_unverified: true`, never with the
 *   requested city. See ./geo.
 *
 * Honesty:
 *   - Every displayed listing URL must be a URL the search tool actually
 *     returned (citations ∪ action.sources). The model's JSON answer is
 *     cross-validated against that set. The model frequently RETRANSCRIBES
 *     listing URLs (e.g. immowelt /expose/123 vs /123 — the same listing);
 *     a JSON item therefore also matches when hostname + 6-digit listing
 *     id are identical. Anything else is treated as fabricated and counted.
 *   - verification_status: "verified" ONLY for fields parsed from a fetched
 *     page (JSON-LD / explicit text). Model-stated fields with a genuine
 *     citation → "partially_verified". Discovery only → "unverified".
 *   - fields we cannot verify stay null — never invented. A listing whose
 *     title we could not obtain gets a NEUTRAL, explicitly-derived label
 *     ("Anzeige auf <hostname>") with title_is_fallback — not "Titel
 *     unbekannt" presented as a fact.
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
 * Machine-readable note about WHY a listing carries its verification level
 * (localized by the UI). `null` = nothing specific to report.
 */
export type VerificationNote =
  | "page_fetched"
  | "page_unstructured"
  | "tos_no_fetch"
  | "robots_blocked"
  | "fetch_failed"
  | null;

/**
 * Result funnel — privacy-safe, count-only diagnostics (never URLs,
 * response text, or personal data) so "search ran but few/no results
 * displayed" is explainable from the API response and the server log alone.
 */
export interface SearchFunnel {
  /** Azure Responses API calls made. */
  providerCalls: number;
  /** Bing `web_search` tool invocations reported by the provider. */
  webSearchCalls: number;
  /** Citations + source URLs before deduplication. */
  rawCandidates: number;
  /** Distinct normalized real URLs the search tool returned. */
  uniqueCandidates: number;
  /** URLs that were not valid http(s). */
  invalidUrls: number;
  /** Real URLs that are not individual listing pages (home/search/legal). */
  searchPagesRejected: number;
  /** Real URLs rejected because their location evidence names a KNOWN
   *  different city than the one requested. */
  cityMismatches: number;
  /** Real URLs already seen (dedup across queries/calls/portals). */
  duplicateResults: number;
  /** (targeted mode) real URLs outside the user's selected domains. */
  offAllowlist: number;
  /** Model JSON items parsed (valid URLs, sane field values). */
  jsonItems: number;
  /** Model JSON items attached to a real candidate (by URL or listing id). */
  jsonMatched: number;
  /** Model JSON items whose URL/id was NOT returned by the search tool. */
  fabricatedRejected: number;
  /** Candidates that received at least one fact from JSON or a fetched page. */
  detailsEnriched: number;
  /** Valid listings after all validation, before the display cap. */
  validListings: number;
  /** Listings finally returned to the client. */
  displayedListings: number;
  /** Wall-clock pipeline duration. */
  elapsedMs: number;
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
  providerCalls: 0,
  webSearchCalls: 0,
  rawCandidates: 0,
  uniqueCandidates: 0,
  invalidUrls: 0,
  searchPagesRejected: 0,
  cityMismatches: 0,
  duplicateResults: 0,
  offAllowlist: 0,
  jsonItems: 0,
  jsonMatched: 0,
  fabricatedRejected: 0,
  detailsEnriched: 0,
  validListings: 0,
  displayedListings: 0,
  elapsedMs: 0,
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

/**
 * The dominant numeric listing id inside a URL (path or query). Same
 * hostname + same id = the same listing, even when the portal (or the
 * model) writes the path differently (immowelt: /expose/123 and /123).
 */
function listingId(rawUrl: string): string | null {
  try {
    const u = new URL(rawUrl);
    const m = `${u.pathname} ${u.search}`.match(/\d{6,}/);
    return m ? m[0] : null;
  } catch {
    return null;
  }
}

function hostnameOf(rawUrl: string): string {
  try {
    return new URL(rawUrl).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
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
  rawCandidates: number;
  /** Distinct normalized real URLs (before the listing heuristic). */
  uniqueCandidates: number;
  invalidUrls: number;
  duplicateResults: number;
  offAllowlist: number;
  searchPagesRejected: number;
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
  let duplicateResults = 0;
  let offAllowlist = 0;
  let searchPagesRejected = 0;

  const push = (rawUrl: string) => {
    const normalized = normalizeUrl(rawUrl);
    if (!normalized) {
      invalidUrls += 1;
      return;
    }
    if (out.has(normalized)) {
      duplicateResults += 1;
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
      searchPagesRejected += 1;
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
    rawCandidates: citations.length + sources.length,
    uniqueCandidates: countDistinctRealUrls(citations, sources),
    invalidUrls,
    duplicateResults,
    offAllowlist,
    searchPagesRejected,
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
    const n = Number.parseFloat(
      cleaned.includes(",") ? cleaned.replace(/\./g, "").replace(",", ".") : cleaned.replace(/\.(?=\d{3})/g, ""),
    );
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

  // Declared before `fail` (which reports them on every failure path).
  const searchCalls: string[] = [];
  let bingRequests: number | null = null;

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
    stats: { searchCalls: searchCalls.length, pagesFetched: 0, bingRequests },
    funnel: { ...funnel, elapsedMs: now() - started },
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
  //    whole-request budget, so two full-timeout calls can never run past it.
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
  funnel.providerCalls = searchCalls.length;
  funnel.webSearchCalls = webSearchCalls;
  funnel.rawCandidates = collected.rawCandidates;
  funnel.uniqueCandidates = collected.uniqueCandidates;
  funnel.invalidUrls = collected.invalidUrls;
  funnel.duplicateResults = collected.duplicateResults;
  funnel.offAllowlist = collected.offAllowlist;
  funnel.searchPagesRejected = collected.searchPagesRejected;
  funnel.jsonItems = jsonItems.length;

  // 6) Cross-validate the model's JSON items against the REAL result set
  //    (citations ∪ sources): the fabrication guard. A JSON url whose
  //    hostname + listing id do not belong to any returned result is
  //    dropped and counted. Lenient on PATH (portals write the same
  //    listing several ways) but strict on host + id.
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

  const realByHostId = new Map<string, Candidate>();
  for (const c of collected.candidates) {
    const id = listingId(c.url);
    if (id) realByHostId.set(`${hostnameOf(c.url)}|${id}`, c);
  }

  let jsonMatched = 0;
  for (const item of jsonItems) {
    const n = normalizeUrl(item.url);
    let target: Candidate | undefined;
    if (n && realUrls.has(n)) {
      target = candidatesByNormalizedUrl.get(n);
    } else if (n) {
      // Lenient match: same portal + same numeric listing id (portals write
      // the same listing several ways: immowelt /expose/123 and /123).
      const id = listingId(item.url);
      if (id) target = realByHostId.get(`${hostnameOf(item.url)}|${id}`);
    }
    if (!target) {
      funnel.fabricatedRejected += 1;
      continue;
    }
    if (target.json === null) {
      target.json = item;
      jsonMatched += 1;
    }
  }
  funnel.jsonMatched = jsonMatched;

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
  if (funnel.searchPagesRejected > 0) {
    warnings.push(`candidates_dropped_search_pages=${funnel.searchPagesRejected}`);
  }
  if (funnel.fabricatedRejected > 0) warnings.push(`fabricated_urls_rejected=${funnel.fabricatedRejected}`);
  // City mismatches are decided later in the enrichment loop; the warning
  // is appended there (count-only, privacy-safe).
  if (jsonItems.length > 0 && funnel.fabricatedRejected === jsonItems.length) {
    // The model answered with JSON but NONE of the URLs/ids are real — treat
    // the whole answer as unusable, keep the citation-based candidates.
    for (const c of candidatesByNormalizedUrl.values()) c.json = null;
    funnel.jsonMatched = 0;
  }

  const candidates = collected.candidates.slice(0, LIMITS.maxResults);

  // 7) Enrichment + location gating. Fetch + verify on allowlisted
  //    FETCHABLE-policy domains only (robots-checked, SSRF-guarded), then
  //    validate the location evidence and build the normalized listing.
  const listings: HousingListing[] = [];
  let pagesFetched = 0;

  for (const candidate of candidates) {
    if (now() > requestDeadline) {
      warnings.push("request_timeout_budget");
      break;
    }
    let verification: HousingListing["verification_status"] = "unverified";
    let note: VerificationNote = null;
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
            note = strong ? "page_fetched" : "page_unstructured";
          } catch (error) {
            // Fetch problems NEVER block the rest of the results: the
            // candidate stays, simply unverified (or partially, from JSON).
            if (error instanceof UnsafeUrlError) {
              warnings.push(`unsafe_url_skipped:${candidate.domain.domain}`);
            } else {
              warnings.push(`fetch_failed:${candidate.domain.domain}`);
              note = "fetch_failed";
            }
          }
        } else {
          note = "robots_blocked";
          warnings.push(
            verdict === "disallowed"
              ? `robots_blocked:${candidate.domain.domain}`
              : `robots_unknown:${candidate.domain.domain}`,
          );
        }
      }
    } else if (candidate.domain && candidate.domain.policy === "search_only") {
      note = "tos_no_fetch";
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

    // 8) Location correctness — the requested city may only be shown when
    //    the evidence supports it. Known-different city → reject + count.
    //    Evidence sources: fetched page (strongest) > cited model JSON >
    //    title/URL-slug scan (weakest). The hostname is NOT used as
    //    evidence ("frankfurt-immo.de" may host Berlin listings).
    let slugPath = "";
    try {
      slugPath = new URL(candidate.url).pathname;
    } catch {
      slugPath = "";
    }
    const evidenceCity =
      parsed?.city ?? json?.city ?? extractCityFromText(`${candidate.title} ${slugPath}`) ?? null;
    const evidencePlz = parsed?.postalCode ?? null;
    const geo = matchCity(
      input.params.city,
      input.params.postal_code,
      evidenceCity,
      evidencePlz,
    );
    if (geo.status === "mismatch") {
      funnel.cityMismatches += 1;
      continue;
    }
    const requestedCity = input.params.city.trim();
    const city =
      geo.status === "match"
        ? requestedCity || geo.evidenceCity || ""
        : geo.evidenceCity || "";
    const cityUnverified = geo.status !== "match";

    // 9) Expiry — discard ONLY when reliably established (fetched page
    //    states availability already ended).
    if (parsed && isPastIsoDate(parsed.availableUntil, started)) {
      warnings.push("expired_listing_discarded");
      continue;
    }

    // 10) Neutral, explicitly-derived title when no real title was obtained
    //     (never presented as the provider's title).
    const titleIsFallback = !candidate.title && json?.title == null;
    const title =
      candidate.title ||
      json?.title ||
      `Anzeige auf ${hostnameOf(candidate.url)}`;

    // 11) Per-field provenance (which channel each value came through).
    const field_provenance: NonNullable<HousingListing["field_provenance"]> = {};
    if (parsed?.rentColdEur != null) field_provenance.rent_cold_eur = "page";
    else if (json?.rent_cold_eur != null) field_provenance.rent_cold_eur = "search";
    if (parsed?.rentWarmEur != null) field_provenance.rent_warm_eur = "page";
    else if (json?.rent_warm_eur != null) field_provenance.rent_warm_eur = "search";
    else if (titleRentWarm != null) field_provenance.rent_warm_eur = "search";
    if (json?.additional_costs_eur != null) field_provenance.additional_costs_eur = "search";
    if (parsed?.rooms != null) field_provenance.rooms = "page";
    else if (json?.rooms != null) field_provenance.rooms = "search";
    if (parsed?.livingAreaSqm != null) field_provenance.living_area_sqm = "page";
    else if (json?.living_area_sqm != null) field_provenance.living_area_sqm = "search";
    if (parsed?.availableFrom) field_provenance.available_from = "page";
    else if (json?.available_from) field_provenance.available_from = "search";
    if (json?.floor != null) field_provenance.floor = "search";
    if (json?.furnished != null) field_provenance.furnished = "search";
    if (parsed?.images?.length) field_provenance.images = "page";
    if (parsed?.city) field_provenance.city = "page";
    else if (json?.city != null) field_provenance.city = "search";

    const detailsEnriched =
      parsed !== null ||
      json?.rent_cold_eur != null ||
      json?.rent_warm_eur != null ||
      json?.rooms != null ||
      json?.living_area_sqm != null;
    if (detailsEnriched) funnel.detailsEnriched += 1;

    // 12) Normalize to HousingListing (unknown fields stay null — never
    //     invented). Precedence: fetched page > model JSON (cited) > title.
    const listing: HousingListing = {
      provider: "web-search",
      source_id: stableSourceId(candidate.url),
      title,
      listing_url: candidate.url,
      city,
      postal_code: parsed?.postalCode || null,
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
      city_unverified: cityUnverified,
      title_is_fallback: titleIsFallback,
      field_provenance,
      verification_notes: note,
    };
    listings.push(listing);
  }

  funnel.validListings = listings.length;
  funnel.displayedListings = listings.length;
  funnel.elapsedMs = now() - started;
  if (funnel.cityMismatches > 0) {
    warnings.push(`city_mismatch_rejected=${funnel.cityMismatches}`);
  }

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
