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
  type ResolvedSearchProvider,
} from "./config";
import { buildHousingQueries } from "./queries";
import { guardedFetch, UnsafeUrlError } from "./url-guard";
import { parseListingPage } from "./parse-listing";
import { robotsVerdictForUrl } from "./robots";

/**
 * Housing web-discovery pipeline (general + targeted modes).
 *
 * Bounded by design (cost + abuse):
 *   general  — 1 search call (DE); 1 retry (EN) only when <3 candidates
 *   targeted — exactly 1 domain-restricted search call
 *   fetches  — ≤ maxPagesToFetch pages, fetchable-policy domains only,
 *              robots-checked first (fail-closed), SSRF-guarded
 *
 * Honesty:
 *   - verification_status: "verified" ONLY for fields parsed from a fetched
 *     page (JSON-LD / explicit text). Search snippets / model output →
 *     "partially_verified" at best. Discovery only → "unverified".
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
  warnings: string[];
  cached: boolean;
  fetchedAt: string;
}

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
  snippet: string;
  /** Domain entry the URL matched. */
  domain: (typeof ALLOWED_DOMAINS)[number];
}

const NON_LISTING_PATH_RE =
  /^\/(impressum|datenschutz|agb|kontakt|login|registrieren|anmelden|hilfe|faq|jobs|karriere|about|en\/?|de\/?|sitemap\.xml|robots\.txt|api\/)(?!.*\d{6})/i;

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

function looksLikeListingUrl(url: URL, domain: string): boolean {
  const path = url.pathname;
  if (NON_LISTING_PATH_RE.test(path)) return false;
  // Open-data dataset pages are "listings" for our purposes (machine-readable
  // housing data).
  if (domain === "open.nrw" || domain === "opendata.de") {
    return /\/(dataset|data|api)\//i.test(path);
  }
  // Portal listing pages carry a numeric id in the path (6+ digits) or a
  // listing-like path segment.
  return (
    /\d{6,}/.test(path) ||
    /\/(expose|angebote|detail|immobilie|kauf|miet|apartments|rooms|ad)[/-]/i.test(path)
  );
}

function collectCandidates(
  result: WebDiscoveryResult,
  input: HousingWebSearchInput,
  warnings: string[],
): Candidate[] {
  const selectedDomains =
    input.mode === "targeted" && input.domains && input.domains.length > 0
      ? input.domains
      : ALLOWED_DOMAINS.map((d) => d.domain);
  const selected = new Set(selectedDomains);

  const out: Candidate[] = [];
  const seen = new Set<string>();
  // Funnel counters — turned into warnings when the funnel empties the
  // results, so "search ran but nothing displayed" is diagnosable from the
  // API response alone (counts only, never URLs).
  let droppedOffAllowlist = 0;
  let droppedNotListingUrl = 0;
  let invalidUrls = 0;
  const push = (rawUrl: string, title: string, snippet: string) => {
    const normalized = normalizeUrl(rawUrl);
    if (!normalized || seen.has(normalized)) {
      if (!normalized) invalidUrls += 1;
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
    if (!entry || !selected.has(entry.domain)) {
      droppedOffAllowlist += 1; // allowlist is binding
      return;
    }
    if (!looksLikeListingUrl(u, entry.domain)) {
      droppedNotListingUrl += 1;
      return;
    }
    seen.add(normalized);
    out.push({ url: normalized, title, snippet, domain: entry });
  };

  for (const c of result.citations) push(c.url, c.title, "");
  for (const s of result.sources) push(s, "", "");
  if (out.length === 0) {
    if (result.citations.length === 0 && result.sources.length === 0 && result.webSearchCalls === 0) {
      // The model answered WITHOUT invoking the web_search tool — the single
      // most likely cause of a silent empty result (official docs: prompt
      // more explicitly; we do, but the model can still decline).
      warnings.push("azure_no_web_search_call");
    }
    warnings.push("no_candidates_on_allowed_domains");
    if (invalidUrls > 0) warnings.push(`candidates_dropped_invalid_url=${invalidUrls}`);
    if (droppedOffAllowlist > 0) warnings.push(`candidates_dropped_off_allowlist=${droppedOffAllowlist}`);
    if (droppedNotListingUrl > 0) warnings.push(`candidates_dropped_not_listing_url=${droppedNotListingUrl}`);
  }
  return out;
}

function snippetExtractsRent(snippet: string): { cold: number | null; warm: number | null } {
  const cold = snippet.match(/Kaltmiete\s*(?:von)?\s*[:\-–]?\s*(\d{1,5}(?:[ .,]\d{1,3}){0,3})\s*(?:€|EUR|Euro)/i);
  const warm = snippet.match(/Warmmiete\s*(?:von)?\s*[:\-–]?\s*(\d{1,5}(?:[ .,]\d{1,3}){0,3})\s*(?:€|EUR|Euro)/i);
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
    warnings,
    cached: false,
    fetchedAt: new Date(started).toISOString(),
  });

  // 1) Provider resolution (honest "not configured" state, not an error).
  const provider = deps.provider === undefined ? resolveSearchProvider() : deps.provider;
  if (!provider) {
    return fail("not_configured", "no_search_provider", null);
  }

  // 2) Result cache (same user search within TTL → no paid call).
  const key = cacheKey(input);
  const cachedEntry = resultCache.get(key);
  if (cachedEntry && now() - cachedEntry.at <= LIMITS.cacheTtlMs) {
    return { ...cachedEntry.outcome, cached: true };
  }

  // 3) Build queries.
  const built = buildHousingQueries(input.params);
  const location = input.params.city.trim() || input.params.postal_code.trim();
  const userLocation = location
    ? { country: "DE", city: input.params.city.trim() || undefined }
    : undefined;

  // 5) Run bounded search calls.
  const selectedDomains =
    input.mode === "targeted" && input.domains && input.domains.length > 0
      ? input.domains
      : ALLOWED_DOMAINS.map((d) => d.domain);

  const searchCalls: string[] = [];
  let bingRequests: number | null = null;
  let webSearchCalls = 0;
  let citations: SearchCitation[] = [];
  let sources: string[] = [];
  let text = "";

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
    });
    bingRequests =
      bingRequests === null ? res.numRequests : bingRequests + (res.numRequests ?? 0);
    webSearchCalls += res.webSearchCalls;
    return res;
  };

  try {
    if (input.mode === "targeted") {
      const res = await runOneCall(built.targetedQuery, selectedDomains);
      citations = res.citations;
      sources = res.sources;
      text = res.text;
    } else {
      const first = await runOneCall(built.queries[0], undefined);
      citations = first.citations;
      sources = first.sources;
      text = first.text;
      // Count-only probe (empty warnings sink): funnel warnings are reported
      // once, from the FINAL collectCandidates below, so a successful retry
      // never leaves a stale "no web search call" warning behind.
      const initial = collectCandidates({ ...first, citations, sources }, input, []);
      if (initial.length < 3 && built.queries.length > 1) {
        // Retry ONCE in English, only when the German query under-delivered.
        const second = await runOneCall(built.queries[1], undefined);
        citations = [...citations, ...second.citations];
        sources = [...sources, ...second.sources];
        text = text || second.text;
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

  // 6) Collect + dedupe candidates (allowlist binding).
  const candidates = collectCandidates(
    { text, citations, sources, queries: searchCalls, numRequests: null, webSearchCalls },
    input,
    warnings,
  ).slice(0, LIMITS.maxResults);

  // 7) Targeted mode: fetch + verify on fetchable-policy domains only.
  const listings: HousingListing[] = [];
  let pagesFetched = 0;
  const requestDeadline = started + LIMITS.requestTimeoutMs;

  for (const candidate of candidates) {
    if (now() > requestDeadline) {
      warnings.push("request_timeout_budget");
      break;
    }
    let verification: HousingListing["verification_status"] = "unverified";
    let parsed: ReturnType<typeof parseListingPage> | null = null;
    let snippetRentCold: number | null = null;
    let snippetRentWarm: number | null = null;

    if (input.mode === "targeted" && candidate.domain.policy === "fetchable") {
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
            // candidate stays, simply unverified (or partially, from snippet).
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
    } else if (input.mode === "targeted" && candidate.domain.policy === "search_only") {
      // Restricted site: link only — never fetched (ToS). A snippet that
      // explicitly states a rent upgrades confidence — nothing else does.
      const snippet = candidate.snippet;
      const rents = snippetExtractsRent(snippet);
      if (rents.cold != null || rents.warm != null) verification = "partially_verified";
      snippetRentCold = rents.cold;
      snippetRentWarm = rents.warm;
    }

    // 8) Expiry — discard ONLY when reliably established (fetched page
    //    states availability already ended).
    if (parsed && isPastIsoDate(parsed.availableUntil, started)) {
      warnings.push("expired_listing_discarded");
      continue;
    }

    // 9) Normalize to HousingListing (unknown fields stay null).
    const listing: HousingListing = {
      provider: "web-search",
      source_id: stableSourceId(candidate.url),
      title: candidate.title || parsed?.title || "Titel unbekannt",
      listing_url: candidate.url,
      city: input.params.city.trim() || parsed?.city || "",
      postal_code: input.params.postal_code.trim() || parsed?.postalCode || null,
      address: null,
      latitude: null,
      longitude: null,
      rent_cold_eur: parsed?.rentColdEur ?? snippetRentCold ?? null,
      additional_costs_eur: null,
      rent_warm_eur: parsed?.rentWarmEur ?? snippetRentWarm ?? null,
      deposit_eur: null,
      rooms: parsed?.rooms ?? null,
      living_area_sqm: parsed?.livingAreaSqm ?? null,
      available_from: parsed?.availableFrom ?? null,
      furnished: false,
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
    };
    listings.push(listing);
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
    warnings: [...new Set(warnings)],
    cached: false,
    fetchedAt: new Date(now()).toISOString(),
  };

  resultCache.set(key, { at: now(), outcome });
  return outcome;
}
