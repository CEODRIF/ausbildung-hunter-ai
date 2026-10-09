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
import { sanitizeImageUrls, validateImageUrl } from "./image-safety";
import { parseListingPage } from "./parse-listing";
import { robotsVerdictForUrl } from "./robots";

/**
 * Housing web-discovery pipeline (general + targeted modes).
 *
 * Retrieval (cost-aware multi-query):
 *   general  — 1 primary German search call (apartment family for "all"),
 *              then the complementary query families (WG / student /
 *              private rental for "all"; alt phrasing for specific types)
 *              in a bounded-parallelism pool (LIMITS.webModeParallelism),
 *              with early stop: enough candidates
 *              (LIMITS.webModeSecondCallThreshold), a stall (a call added
 *              no new candidates), the call cap
 *              (LIMITS.maxSearchCallsPerRun), the billable Bing
 *              transaction cap (LIMITS.maxBingTransactionsPerRun) or the
 *              shared request deadline. All result sets are merged and
 *              deduped. BOUNDED PAID BUDGET: worst case 4 calls / 4
 *              reported Bing transactions per run.
 *   targeted — exactly 1 domain-restricted search call
 *   fetches  — ≤ maxPagesToFetch pages, allowlisted FETCHABLE-policy
 *              domains only (both modes), robots-checked first (fail-
 *              closed), SSRF-guarded. Unreviewed domains are never fetched.
 *
 * Result-URL classification (./classifyResultUrl):
 *   direct_listing — kept (individual-offer signal: portal listing
 *     pattern / 6+ digit listing id / listing segment / id query param).
 *   portal_page    — homepage / search / browse / legal pages: rejected
 *     and counted DISTINCTLY (uniqueSearchPages) so the funnel shows how
 *     many real results were lost — occurrences (searchPagesRejected)
 *     overstate when a url arrives in several calls.
 *   direct_listing_id — a BARE 6+ digit path id without listing vocabulary.
 *     On REVIEWED (audited) domains: a direct listing. On UNREVIEWED web-mode
 *     domains: kept only with the model's JSON reference (news article ids
 *     look identical; the model's offer-identification breaks the tie).
 *   maybe_listing  — unpatterned individual content page: on REVIEWED
 *     domains rejected as portal page; on UNREVIEWED web-mode domains
 *     kept ONLY when the model's JSON names exactly that URL (it saw the
 *     real results and the query contract forbids non-offers). This both
 *     rescues genuine slugged listings (no numeric id) and keeps news
 *     articles / directories out of the results.
 */
export type ResultUrlKind =
  | "direct_listing"
  | "direct_listing_id"
  | "portal_page"
  | "maybe_listing";

export function classifyResultUrl(url: URL, domain: AllowedDomain | null): ResultUrlKind {
  const path = url.pathname;
  // Root / empty path = the portal home page — never an individual offer.
  if (path === "/" || path === "") return "portal_page";
  if (NON_LISTING_PATH_RE.test(path)) return "portal_page";
  if (SEARCH_RESULTS_PATH_RE.test(path)) return "portal_page";
  // Open-data dataset pages are "listings" for our purposes (machine-readable
  // housing data); other open.nrw pages are portal pages.
  if (domain && (domain.domain === "open.nrw" || domain.domain === "opendata.de")) {
    return /\/(dataset|data|api)\//i.test(path) ? "direct_listing" : "portal_page";
  }
  // Strong listing vocabulary (any domain): explicit individual-offer paths.
  if (LISTING_SEGMENT_RE.test(path) || LISTING_QUERY_RE.test(url.search)) {
    return "direct_listing";
  }
  // Editorial / media sections are never offers (even with long path ids).
  if (MEDIA_PATH_RE.test(path)) return "maybe_listing";
  // Bare numeric id: unambiguous on audited domains, ambiguous elsewhere.
  if (/\d{6,}/.test(path)) return domain !== null ? "direct_listing" : "direct_listing_id";
  return "maybe_listing";
}

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
  /** Occurrences (across calls/sources) of URLs that are not individual
   *  listing pages (home/search/legal/overview). NOTE: an occurrence —
   *  the SAME url can appear in multiple calls, so this can exceed
   *  uniqueCandidates. Use `uniqueSearchPages` for "how many distinct
   *  results were lost to this rule". */
  searchPagesRejected: number;
  /** DISTINCT urls rejected as portal/search/overview/legal pages. */
  uniqueSearchPages: number;
  /** Occurrences of unreviewed-domain content pages that the model did
    *  NOT identify as an individual offer (articles, directories, slugged
    *  non-listings). */
  contentRejected: number;
  /** Candidates REJECTED because no credible title could be established
    *  (no citation title, no model title, no page title) — a generic
    *  "Anzeige auf <host>" label is never presented as a listing. */
  untitledRejected: number;
  /** Candidates REJECTED because title or page evidence identifies a SALE
    *  (Kauf/Verkauf) rather than a rental. */
  nonRentalRejected: number;
  /** Candidates kept ONLY because the model's JSON referenced the exact
   *  URL (web mode, unreviewed domains — slugged listings without a
   *  numeric id that the generic listing pattern does not catch). */
  jsonOnlyKept: number;
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
  /** Listings that received at least one VALIDATED real photo URL. */
  imagesAttached: number;
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
  /** True when this caller rode an IDENTICAL search that was already in
   *  flight (in-memory coalescing) — no second provider call, and the
   *  route refunds this caller's reserved quota slot. */
  deduplicated?: boolean;
  fetchedAt: string;
}

export const ZERO_FUNNEL: SearchFunnel = {
  providerCalls: 0,
  webSearchCalls: 0,
  rawCandidates: 0,
  uniqueCandidates: 0,
  invalidUrls: 0,
  searchPagesRejected: 0,
  uniqueSearchPages: 0,
  contentRejected: 0,
  untitledRejected: 0,
  nonRentalRejected: 0,
  jsonOnlyKept: 0,
  cityMismatches: 0,
  duplicateResults: 0,
  offAllowlist: 0,
  jsonItems: 0,
  jsonMatched: 0,
  fabricatedRejected: 0,
  detailsEnriched: 0,
  imagesAttached: 0,
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
    // The key covers ALL material params (p = every search filter). City is
    // normalized (trim + lowercase) because "berlin" and "Berlin" are the
    // same search — the key only; the query text keeps the user's casing.
    p: { ...input.params, city: input.params.city.trim().toLowerCase() },
    d: input.domains ? [...input.domains].sort() : null,
  });
  return createHash("sha256").update(norm).digest("hex").slice(0, 32);
}

/**
 * Only a SUCCESSFUL run with at least one validated listing is cacheable.
 * Errors, timeouts, empty results and zero-valid-listing runs are NEVER
 * cached — the next identical search re-runs the provider calls instead of
 * replaying a bad result (the defect behind a low-quality card being
 * served "aus dem Kurzzeit-Cache").
 */
function isCacheable(outcome: HousingWebSearchOutcome): boolean {
  return outcome.status === "ok" && outcome.listings.length > 0;
}

/** In-flight identical searches coalesce onto ONE provider run. */
const inFlightSearches = new Map<string, Promise<HousingWebSearchOutcome>>();

// --- candidate handling ------------------------------------------------------

interface Candidate {
  url: string;
  title: string;
  /** Photo URL delivered by the search provider alongside this result
   *  (public search-result metadata; raw — validated in the pipeline).
   *  null = the provider returned no image for this result. */
  imageUrl: string | null;
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
 *
 * STRONG listing vocabulary (segment/query): on any domain this is a
 * direct listing signal. A BARE 6+ digit id alone is AMBIGUOUS on
 * unreviewed domains — portals and news sites both use long numeric ids
 * in their paths (FAZ article /.../1790123456.html). On reviewed
 * allowlisted domains a bare id still counts (their URL schemes are
 * audited); on unreviewed web-mode domains it additionally needs the
 * model's JSON to name exactly that URL (the model saw the results and
 * the query contract forbids non-offers).
 */
const LISTING_SEGMENT_RE =
  /\/(expose|exposes|angebot|angebote|detail|details|immobilie|obj|objekt|objekte|listing|listings|property|properties|flat|flats|apartment|apartments|room|rooms|ad|ads|wohnung|zimmer|wg)([/?#]|$)/i;
const LISTING_QUERY_RE = /[?&](id|expose|objekt|objnr|angebot|listing|property|flat|room|ad)=\d{4,}/i;

/**
 * Media / editorial section markers. Pages under these are articles,
 * reports and explainers about housing — never individual offers,
 * regardless of any numeric id in the path.
 */
const MEDIA_PATH_RE =
  /\/(aktuell|news|article|articles|artikel|bericht|berichte|reportage|reportagen|studie|studien|analyse|analysen|magazin|magazine|wissen|newsroom|themen|thema|topic|topics)([/?#-]|$)/i;

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

interface CollectResult {
  candidates: Candidate[];
  rawCandidates: number;
  /** Distinct normalized real URLs (before the listing heuristic). */
  uniqueCandidates: number;
  invalidUrls: number;
  duplicateResults: number;
  offAllowlist: number;
  /** Occurrences of portal/search/overview/legal pages. */
  searchPagesRejected: number;
  /** Distinct URLs rejected as portal/search/overview/legal pages. */
  uniqueSearchPages: number;
  /** Occurrences of unreviewed content pages the model did not name. */
  contentRejected: number;
  /** Candidates kept only via the model's exact-URL JSON reference. */
  jsonOnlyKept: number;
}

/**
 * Turn raw citations + sources into validated candidates.
 *
 * - targeted mode: the user's selected domains are BINDING (off-allowlist
 *   URLs are dropped and counted).
 * - web mode: no display filter — any valid individual-listing URL is
 *   accepted (the allowlist only governs fetchability, via `domain`).
 * - `jsonEvidenceUrls`: normalized URLs the model's JSON names WITH
 *   substantive property evidence (see itemHasSubstance). Used ONLY for the
 *   keep-rule on unreviewed web-mode domains (maybe_listing /
 *   direct_listing_id): a bare title is not evidence of an offer.
 */
function collectCandidates(
  citations: SearchCitation[],
  sources: string[],
  input: HousingWebSearchInput,
  sourceImages: Record<string, string> = {},
  jsonEvidenceUrls: Set<string> = new Set(),
): CollectResult {
  const inTargeted = input.mode === "targeted";
  const selectedDomains =
    inTargeted && input.domains && input.domains.length > 0
      ? new Set(input.domains)
      : inTargeted
        ? new Set(ALLOWED_DOMAINS.map((d) => d.domain))
        : null; // web mode: not binding

  const titleByUrl = new Map<string, string>();
  // Provider-delivered photo metadata per normalized result URL. RAW here —
  // validated in the pipeline (./image-safety). First sighting wins.
  const imageByUrl = new Map<string, string>();
  for (const c of citations) {
    const n = normalizeUrl(c.url);
    if (!n) continue;
    if (c.title && !titleByUrl.has(n)) titleByUrl.set(n, c.title);
    if (c.image && !imageByUrl.has(n)) imageByUrl.set(n, c.image);
  }
  for (const [rawUrl, img] of Object.entries(sourceImages)) {
    const n = normalizeUrl(rawUrl);
    if (n && img && !imageByUrl.has(n)) imageByUrl.set(n, img);
  }

  const out = new Map<string, Candidate>();
  const order: string[] = [];
  let invalidUrls = 0;
  let duplicateResults = 0;
  let offAllowlist = 0;
  let searchPagesRejected = 0;
  let contentRejected = 0;
  let jsonOnlyKept = 0;
  // DISTINCT urls per rejection bucket — the occurrence counters above
  // overstate losses when the same url arrives in several calls/sources
  // (the "28 results in, 34 excluded" arithmetic the UI confused).
  const searchPageUrls = new Set<string>();

  const keep = (normalized: string, entry: AllowedDomain | null, viaJsonOnly: boolean) => {
    out.set(normalized, {
      url: normalized,
      title: titleByUrl.get(normalized) ?? "",
      imageUrl: imageByUrl.get(normalized) ?? null,
      domain: entry,
      json: null,
    });
    order.push(normalized);
    if (viaJsonOnly) jsonOnlyKept += 1;
  };

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
    const kind = classifyResultUrl(u, entry);
    if (kind === "direct_listing") {
      keep(normalized, entry, false);
      return;
    }
    if (kind === "portal_page" || entry !== null) {
      // General portal/search/legal page — or any non-strong-signal page
      // of a REVIEWED domain (their overviews must not masquerade as
      // listings; their URL schemes are audited, so a bare id there above
      // already classified as direct_listing).
      searchPagesRejected += 1;
      searchPageUrls.add(normalized);
      return;
    }
    // direct_listing_id / maybe_listing on an UNREVIEWED domain (web mode
    // only — targeted mode already returned above): keep it when — and
    // only when — the model's JSON names exactly this URL AND carries
    // substantive property evidence for it (the model saw the actual
    // results; the query contract forbids non-offers). Rescues genuine
    // slugged / bare-id listings, keeps news articles, reports and
    // directories out of the results — and, crucially, a generic portal
    // URL the model merely mentioned without property facts.
    if (jsonEvidenceUrls.has(normalized)) {
      keep(normalized, entry, true);
      return;
    }
    contentRejected += 1;
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
    uniqueSearchPages: searchPageUrls.size,
    contentRejected,
    jsonOnlyKept,
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

/**
 * A model JSON item carries SUBSTANTIVE property evidence when at least one
 * property field is non-null. Title/city/source alone are NOT evidence that
 * a page is an individual listing — a model naming a generic portal URL with
 * only a title was the root cause of "Anzeige auf <host>" cards.
 */
export function itemHasSubstance(item: ModelListingItem): boolean {
  return (
    item.rent_cold_eur !== null ||
    item.rent_warm_eur !== null ||
    item.additional_costs_eur !== null ||
    item.rooms !== null ||
    item.living_area_sqm !== null ||
    item.floor !== null ||
    item.available_from !== null ||
    item.furnished !== null ||
    item.deposit_eur !== null ||
    item.address !== null ||
    item.pets_allowed !== null ||
    item.wg_suitable !== null
  );
}

/**
 * SALE intent in a resolved title: explicit purchase vocabulary. Deliberately
 * narrow — NEUBAU/EFH are NOT included (new-build and family-house RENTALS
 * exist and must not be killed by this rule).
 */
const SALE_TITLE_RE =
  /\b(zum\s+kauf|kaufpreis|kaufangebot|kaufobjekt|kaufen|verkauft|verkauf)\b/i;
/** Rental intent that neutralizes an incidental sale word in the title. */
const RENTAL_TITLE_RE =
  /\b(miete|mieten|warmmiete|kaltmiete|nebenkosten|kaution|mietzins|mietvertrag)\b/i;

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

async function executeHousingWebSearch(
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

  // 2) Build queries (two complementary German queries for general mode).
  //    (The result cache is handled by the runHousingWebSearch wrapper.)
  const built = buildHousingQueries(input.params);
  const location = input.params.city.trim() || input.params.postal_code.trim();
  const userLocation = location
    ? { country: "DE", city: input.params.city.trim() || undefined }
    : undefined;

  // 4) Run bounded search calls. Each call gets a timeout that respects the
  //    whole-request budget, so two full-timeout calls can never run past it.
  let webSearchCalls = 0;
  /** web_search calls reported by the PRIMARY call only (the pool's empty
   *  complement payloads must not mask a model search decline). */
  let primaryWebSearchCalls = 0;
  let citations: SearchCitation[] = [];
  let sources: string[] = [];
  let sourceImages: Record<string, string> = {};
  let jsonItems: ModelListingItem[] = [];

  /** Internal sentinel: the shared request deadline has no room for a call.
   *  NOT a provider failure — the pool simply stops issuing more calls. */
  class CallBudgetExhausted extends Error {
    constructor() {
      super("call_budget_exhausted");
      this.name = "CallBudgetExhausted";
    }
  }

  const requestDeadline = started + LIMITS.requestTimeoutMs;
  /** Per-call timeout clamped to the shared deadline; null = not enough
   *  time left for a call that could still pay off (see
   *  LIMITS.minRemainingForCallMs). */
  const timeoutForCall = (): number | null => {
    const remaining = requestDeadline - now();
    if (remaining < LIMITS.minRemainingForCallMs) return null;
    return Math.min(LIMITS.searchTimeoutMs, remaining);
  };

  // Azure-only search call: the resolver (./config) guarantees `provider`
  // is a fully validated `azure` provider or null (handled above). There is
  // deliberately NO fallback provider in the housing pipeline.
  const runOneCall = async (
    query: string,
    allowed: string[] | undefined,
  ): Promise<WebDiscoveryResult> => {
    // Re-check the deadline at issue time (the pool guard ran a moment
    // earlier; a parallel call may have consumed the remaining budget).
    const t = timeoutForCall();
    if (t === null) throw new CallBudgetExhausted();
    searchCalls.push(query);
    const res = await azureWebSearch({
      base: provider.base,
      key: provider.key,
      model: provider.model,
      input: query,
      allowedDomains: allowed,
      userLocation,
      fetchImpl: deps.fetchImpl,
      timeoutMs: t,
    });
    bingRequests =
      bingRequests === null ? res.numRequests : bingRequests + (res.numRequests ?? 0);
    webSearchCalls += res.webSearchCalls;
    return res;
  };

  /** Normalized URLs the model's JSON names WITH substantive property
   *  evidence (the keep-evidence for maybe_listing / direct_listing_id
   *  candidates on unreviewed web-mode domains). A JSON item that only has
   *  a title/city is NOT evidence — that was how a generic portal page got
   *  presented as a listing. */
  const jsonEvidenceUrls = (): Set<string> => {
    const s = new Set<string>();
    for (const item of jsonItems) {
      if (!itemHasSubstance(item)) continue;
      const n = normalizeUrl(item.url);
      if (n) s.add(n);
    }
    return s;
  };

  const mergeCall = (res: WebDiscoveryResult): void => {
    citations = [...citations, ...res.citations];
    sources = [...sources, ...res.sources];
    // First call's image metadata wins on URL conflicts (deterministic).
    sourceImages = { ...res.sourceImages, ...sourceImages };
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
      primaryWebSearchCalls = webSearchCalls;
    } else {
      // Cost-aware MULTI-QUERY retrieval: the primary query family always
      // runs; the complementary families (WG / student / private rental
      // for "all", the alt phrasing for specific types) run in a bounded-
      // parallelism pool with early stop:
      //   - probe ≥ webModeSecondCallThreshold candidates → done,
      //   - a call added no NEW candidates (stall) → done,
      //   - maxSearchCallsPerRun / maxBingTransactionsPerRun → done,
      //   - not enough deadline left for a call that could pay off → done.
      mergeCall(await runOneCall(built.queries[0], undefined));
      primaryWebSearchCalls = webSearchCalls;
      const complements = built.queries.slice(1);
      if (complements.length > 0) {
        const probeCandidates = (): number =>
          collectCandidates(citations, sources, input, sourceImages, jsonEvidenceUrls())
            .candidates.length;
        let stalled = false; // one call added nothing new → stop the pool
        const poolGuard = (): boolean => {
          if (stalled) return false;
          if (searchCalls.length >= LIMITS.maxSearchCallsPerRun) return false;
          if (bingRequests !== null && bingRequests >= LIMITS.maxBingTransactionsPerRun)
            return false;
          return timeoutForCall() !== null;
        };
        let next = 0;
        const worker = async (): Promise<void> => {
          while (next < complements.length && poolGuard()) {
            const query = complements[next++];
            const before = probeCandidates();
            if (before >= LIMITS.webModeSecondCallThreshold) break;
            try {
              mergeCall(await runOneCall(query, undefined));
            } catch (error) {
              // A successful call already happened — keep its results and
              // report the partial run honestly instead of failing the whole
              // search. Budget exhaustion simply ends the pool.
              if (error instanceof CallBudgetExhausted) break;
              const failed =
                error instanceof WebSearchApiError ? error.failure : "provider_error";
              warnings.push(`complementary_call_failed:${failed}`);
              continue;
            }
            if (probeCandidates() === before) {
              // Cost-aware stop: the index surfaced no NEW individual
              // listings for this city/budget. Deliberately NOT a warning
              // (it is the normal outcome on thin markets — warnings drive
              // the UI's partial-results banner); the funnel counters
              // (providerCalls vs. uniqueCandidates) document it.
              stalled = true;
            }
          }
        };
        const workers = Math.min(LIMITS.webModeParallelism, complements.length);
        await Promise.all(Array.from({ length: workers }, () => worker()));
      }
    }
  } catch (error) {
    if (error instanceof CallBudgetExhausted) {
      // The PRIMARY call itself had no deadline room (not a provider fault).
      return fail("timeout", "request_budget_exhausted", provider.kind, {
        citations,
        queries: searchCalls,
      });
    }
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
  const collected = collectCandidates(citations, sources, input, sourceImages, jsonEvidenceUrls());
  funnel.providerCalls = searchCalls.length;
  funnel.webSearchCalls = webSearchCalls;
  funnel.rawCandidates = collected.rawCandidates;
  funnel.uniqueCandidates = collected.uniqueCandidates;
  funnel.invalidUrls = collected.invalidUrls;
  funnel.duplicateResults = collected.duplicateResults;
  funnel.offAllowlist = collected.offAllowlist;
  funnel.searchPagesRejected = collected.searchPagesRejected;
  funnel.uniqueSearchPages = collected.uniqueSearchPages;
  funnel.contentRejected = collected.contentRejected;
  funnel.jsonOnlyKept = collected.jsonOnlyKept;
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
    if (citations.length === 0 && sources.length === 0 && primaryWebSearchCalls === 0) {
      // The model answered WITHOUT invoking the web_search tool in the
      // PRIMARY call — the single most likely cause of a silent empty
      // result (official docs: prompt more explicitly; we do, but the model
      // can still decline). Judged on the primary call because the
      // complementary pool's empty payloads would otherwise mask the decline.
      warnings.push("azure_no_web_search_call");
    }
    warnings.push(input.mode === "targeted" ? "no_candidates_on_allowed_domains" : "no_candidates_found");
  }
  if (funnel.invalidUrls > 0) warnings.push(`candidates_dropped_invalid_url=${funnel.invalidUrls}`);
  if (funnel.offAllowlist > 0) warnings.push(`candidates_dropped_off_allowlist=${funnel.offAllowlist}`);
  if (funnel.searchPagesRejected > 0) {
    warnings.push(
      `candidates_dropped_search_pages=${funnel.searchPagesRejected} unique=${funnel.uniqueSearchPages}`,
    );
  }
  if (funnel.contentRejected > 0) {
    warnings.push(`candidates_dropped_non_listing_content=${funnel.contentRejected}`);
  }
  if (funnel.jsonOnlyKept > 0) warnings.push(`candidates_kept_via_json_reference=${funnel.jsonOnlyKept}`);
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
    /** Final URL of the fetched page (post-redirects) — the base for
     *  resolving relative image references (og:image="/media/1.jpg"). */
    let pageFinalUrl: string | null = null;
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
            pageFinalUrl = page.finalUrl;
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
         json.furnished !== null ||
         json.deposit_eur !== null ||
         json.address !== null ||
         json.pets_allowed !== null ||
         json.wg_suitable !== null);
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

    // 10) Title — an individual listing needs a CREDIBLE title from real
    //     evidence, in priority order: search citation > cross-validated
    //     model JSON > fetched-page JSON-LD name > the page's own <title>.
    //     When NONE exists the candidate is REJECTED and counted — a
    //     generic "Anzeige auf <host>" label must never be presented as a
    //     listing (root cause of the title-less Berlin cards).
    const citationTitle = candidate.title || null;
    const jsonTitle = json?.title ?? null;
    const pageListingTitle = parsed?.title ?? null;
    const title = citationTitle ?? jsonTitle ?? pageListingTitle ?? parsed?.docTitle ?? null;
    if (title === null) {
      funnel.untitledRejected += 1;
      continue;
    }
    // docTitle-derived (a real, page-sourced title, but the document's own
    // <title> — not the provider's listing title) is marked as fallback so
    // the UI can note it; it is NOT invented.
    const titleIsFallback =
      citationTitle === null && jsonTitle === null && pageListingTitle === null;

    // 10a) Rental verification — this is a RENTAL search. Clear SALE
    //     evidence (page text classified as sale, or a title with purchase
    //     vocabulary and no rental intent) rejects the candidate and is
    //     counted. No clear sale evidence → keep (absence of evidence is
    //     not evidence of sale; URL classification + JSON substance already
    //     established that this is an individual offer).
    const titleIsSale = SALE_TITLE_RE.test(title) && !RENTAL_TITLE_RE.test(title);
    if (parsed?.rentalSignal === "sale" || titleIsSale) {
      funnel.nonRentalRejected += 1;
      continue;
    }

    // 10b) Photos — only the two legitimate channels, page metadata beats
    //      search metadata. Every URL is server-validated (https-only, no
    //      credentials, no private/loopback/link-local IP hosts); invalid
    //      references are dropped so the UI falls back to the placeholder.
    //      The model's JSON is never an image source (see ./image-safety).
    const pageImages = parsed
      ? sanitizeImageUrls(
          [...parsed.images, ...(parsed.ogImage ? [parsed.ogImage] : [])],
          pageFinalUrl,
        )
      : [];
    const searchImage = candidate.imageUrl ? validateImageUrl(candidate.imageUrl, null) : null;
    const images = pageImages.length > 0 ? pageImages : searchImage ? [searchImage] : [];

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
    if (parsed?.depositEur != null) field_provenance.deposit_eur = "page";
    else if (json?.deposit_eur != null) field_provenance.deposit_eur = "search";
    if (parsed?.address != null) field_provenance.address = "page";
    else if (json?.address != null) field_provenance.address = "search";
    if (json?.pets_allowed != null) field_provenance.pets_allowed = "search";
    if (json?.wg_suitable != null) field_provenance.wg_suitable = "search";
    if (pageImages.length > 0) field_provenance.images = "page";
    else if (images.length > 0) field_provenance.images = "search";
    if (parsed?.city) field_provenance.city = "page";
    else if (json?.city != null) field_provenance.city = "search";

    const detailsEnriched =
      parsed !== null ||
      json?.rent_cold_eur != null ||
      json?.rent_warm_eur != null ||
      json?.rooms != null ||
      json?.living_area_sqm != null;
    if (detailsEnriched) funnel.detailsEnriched += 1;
    if (images.length > 0) funnel.imagesAttached += 1;

    // 12) Normalize to HousingListing (unknown fields stay null — never
    //     invented). Precedence: fetched page > model JSON (cited) > title.
    const listing: HousingListing = {
      provider: "web-search",
      source_id: stableSourceId(candidate.url),
      title,
      listing_url: candidate.url,
      city,
      postal_code: parsed?.postalCode || null,
      address: parsed?.address ?? json?.address ?? null,
      latitude: null,
      longitude: null,
      rent_cold_eur: parsed?.rentColdEur ?? json?.rent_cold_eur ?? titleRentCold ?? null,
      additional_costs_eur: json?.additional_costs_eur ?? null,
      rent_warm_eur: parsed?.rentWarmEur ?? json?.rent_warm_eur ?? titleRentWarm ?? null,
      deposit_eur: parsed?.depositEur ?? json?.deposit_eur ?? null,
      rooms: parsed?.rooms ?? json?.rooms ?? null,
      living_area_sqm: parsed?.livingAreaSqm ?? json?.living_area_sqm ?? null,
      available_from: parsed?.availableFrom ?? json?.available_from ?? null,
      furnished: json?.furnished ?? false,
      balcony: false,
      pets_allowed: json?.pets_allowed ?? null,
      wg_suitable: json?.wg_suitable ?? null, // null = not stated — never claimed
      verified: false, // we never claim portal-side verification
      accommodation_type: input.params.accommodation_type === "all" ? "apartment" : input.params.accommodation_type,
      images,
      // Only present when a REAL, validated photo URL exists — the UI must
      // render the neutral placeholder otherwise (never a substitute image).
      ...(images.length > 0 ? { image_url: images[0] } : {}),
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
  if (funnel.untitledRejected > 0) {
    warnings.push(`candidates_dropped_untitled=${funnel.untitledRejected}`);
  }
  if (funnel.nonRentalRejected > 0) {
    warnings.push(`candidates_dropped_non_rental=${funnel.nonRentalRejected}`);
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

  return outcome;
}

/**
 * Public entry point — wraps executeHousingWebSearch with the two
 * correctness layers the task requires:
 *
 * 1) RESULT CACHE (same search within TTL → no paid call). Only
 *    cacheable outcomes (ok + ≥1 validated listing, see isCacheable) are
 *    ever written; stale or zero-valid-listing entries are bypassed on
 *    read defensively.
 *
 * 2) IN-FLIGHT COALESCING — concurrent identical searches share ONE
 *    provider run. Riders get the same outcome flagged `deduplicated:
 *    true`; the route refunds their reserved quota slot, so a duplicate
 *    request never burns a second paid call or a second quota unit.
 */
export async function runHousingWebSearch(
  input: HousingWebSearchInput,
  deps: DiscoveryDependencies = {},
): Promise<HousingWebSearchOutcome> {
  const now = deps.now ?? Date.now;
  const key = cacheKey(input);

  const cachedEntry = resultCache.get(key);
  if (
    cachedEntry &&
    now() - cachedEntry.at <= LIMITS.cacheTtlMs &&
    cachedEntry.outcome.status === "ok" &&
    cachedEntry.outcome.listings.length > 0
  ) {
    return { ...cachedEntry.outcome, cached: true, deduplicated: false };
  }

  const inFlight = inFlightSearches.get(key);
  if (inFlight) {
    const shared = await inFlight;
    return { ...shared, cached: false, deduplicated: true };
  }

  const promise = executeHousingWebSearch(input, deps).finally(() => {
    inFlightSearches.delete(key);
  });
  inFlightSearches.set(key, promise);
  const outcome = await promise;
  if (isCacheable(outcome)) {
    resultCache.set(key, { at: now(), outcome });
  }
  return outcome;
}
