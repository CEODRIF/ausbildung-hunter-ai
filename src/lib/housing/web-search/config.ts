import "server-only";

import { resolveTavilyKey } from "@/lib/web-search";

/**
 * Housing / "Wohnen" — web-discovery configuration.
 *
 * Two bounded, server-side search backends behind one interface:
 *   1. azure  — Azure AI Foundry Responses API with the hosted `web_search`
 *               tool (Grounding with Bing Search). Uses the EXISTING Foundry
 *               resource/deployment (gpt-5-mini) — no new Azure resource.
 *               Docs: https://learn.microsoft.com/azure/foundry/openai/how-to/web-search
 *   2. tavily — the app's existing Tavily client (already configured + billed
 *               for the Germany copilot). Fallback when the Azure endpoint is
 *               not configured.
 *
 * Provider resolution is `HOUSING_WEB_SEARCH=auto|azure|tavily` (default
 * auto = Azure when the app's AI endpoint is a Foundry endpoint, else Tavily).
 * Nothing is paid for unless a search is actually run, and every run is
 * bounded (see LIMITS) — see docs/housing-web-search-plan.md.
 *
 * DOMAIN POLICY (per domain, reviewed 2026-10-09):
 *   search_only — the site's ToS prohibit automated retrieval. We use the
 *                 search engine's index to DISCOVER listing pages and show
 *                 the user a direct link; we NEVER fetch or parse the page.
 *   fetchable   — open-data portals whose robots.txt / license permit
 *                 machine access. Fetched on-demand (robots check first,
 *                 fail-closed) to verify/extract structured fields.
 */

export type WebDomainPolicy = "search_only" | "fetchable";

export interface AllowedDomain {
  /** Host used for suffix matching (`example.de` matches `www.example.de`). */
  domain: string;
  /** Human label for the UI. */
  label: string;
  policy: WebDomainPolicy;
  /** Why this policy — the audit trail for the allowlist. */
  rationale: string;
}

export const ALLOWED_DOMAINS: readonly AllowedDomain[] = [
  {
    domain: "immobilienscout24.de",
    label: "ImmoScout24",
    policy: "search_only",
    rationale:
      "Official ToS/API terms prohibit non-partner automated retrieval (API is partner-gated, paid). Search-engine discovery + direct links only.",
  },
  {
    domain: "immowelt.de",
    label: "Immowelt",
    policy: "search_only",
    rationale:
      "No public search API; ToS prohibit systematic automated retrieval. Search-engine discovery + direct links only.",
  },
  {
    domain: "wg-gesucht.de",
    label: "WG-Gesucht",
    policy: "search_only",
    rationale:
      "No official public API; ToS prohibit scraping. Search-engine discovery + direct links only.",
  },
  {
    domain: "kleinanzeigen.de",
    label: "Kleinanzeigen",
    policy: "search_only",
    rationale:
      "No self-service public API (business-contract only). Search-engine discovery + direct links only.",
  },
  {
    domain: "immonet.de",
    label: "Immonet",
    policy: "search_only",
    rationale:
      "No public search API; ToS prohibit systematic automated retrieval. Search-engine discovery + direct links only.",
  },
  {
    domain: "open.nrw",
    label: "Open.NRW (Open Data)",
    policy: "fetchable",
    rationale:
      "State open-data portal (NRW). robots.txt (fetched 2026-10-09) does not disallow dataset pages; CKAN API endpoints are designed for machine access; datasets carry open licenses.",
  },
  {
    domain: "opendata.de",
    label: "opendata.de (Open Data)",
    policy: "fetchable",
    rationale:
      "Open-data aggregator. No robots.txt restrictions observed (2026-10-09); content is published for reuse under open licenses.",
  },
];

/** Hard, code-level limits. Env may lower (never raise) some of them. */
export const LIMITS = {
  /** Max search-API calls per user request, general mode (DE + optional EN retry). */
  maxSearchCallsPerRun: 2,
  /** Max search-API calls per user request, targeted mode (one domain-restricted call). */
  maxTargetedSearchCalls: 1,
  /** Max pages fetched per user request (targeted mode, fetchable domains only). */
  maxPagesToFetch: 3,
  fetchTimeoutMs: 10_000,
  robotsTimeoutMs: 8_000,
  /** Page bodies larger than this are truncated (parse best-effort). */
  fetchMaxBytes: 512 * 1024,
  /** Whole-request budget. */
  requestTimeoutMs: 25_000,
  /** Manual redirect hops, each hop re-validated against the URL guard. */
  maxRedirects: 3,
  /** Max listings returned per run. */
  maxResults: 20,
  /**
   * In-memory result cache. Enterprise TOU §3(c): Bing output may only be
   * stored as part of our work product — a short in-process TTL for the
   * SAME user's search, never a persistent database.
   */
  cacheTtlMs: 15 * 60 * 1000,
  cacheMaxEntries: 50,
  robotsCacheTtlMs: 10 * 60 * 1000,
  /** Search-API (Azure) timeout. */
  searchTimeoutMs: 20_000,
} as const;

/** Identifies ourselves honestly to fetched sites (never a browser UA). */
export const FETCH_USER_AGENT =
  "AusbildungsWegBot/1.0 (+https://ausbildungsweg.net; housing listing verification)";

export type SearchProviderKind = "azure" | "tavily";

export interface ResolvedSearchProvider {
  kind: SearchProviderKind;
  /** azure only: OpenAI-compatible base (…/v1). */
  base?: string;
  /** azure only: resource API key (server-side only). */
  key?: string;
  /** azure only: model deployment (gpt-5-mini). */
  model?: string;
}

const AZURE_ENDPOINT_RE = /(openai\.azure\.com|services\.ai\.azure\.com|azure\.com)/i;

/**
 * Which search backend serves housing web discovery right now.
 * Returns null = nothing configured → the UI shows an honest
 * "web search not configured" state instead of failing.
 */
export function resolveSearchProvider(): ResolvedSearchProvider | null {
  const forced = (process.env.HOUSING_WEB_SEARCH ?? "auto").trim().toLowerCase();

  const aiUrl = (process.env.AI_API_URL ?? "").trim().replace(/\/+$/, "");
  const aiKey = (process.env.AI_API_KEY ?? "").trim();
  const aiModel = (process.env.AI_MODEL ?? "").trim();
  const isAzure = aiUrl !== "" && AZURE_ENDPOINT_RE.test(aiUrl);

  // Explicit overrides win; otherwise reuse the existing app AI endpoint when
  // it is a Foundry endpoint (the Responses API is served on the same base).
  const azureBase =
    (process.env.AZURE_WEB_SEARCH_ENDPOINT ?? "").trim().replace(/\/+$/, "") ||
    (isAzure ? aiUrl : "");
  const azureKey =
    (process.env.AZURE_WEB_SEARCH_KEY ?? "").trim() || (isAzure ? aiKey : "");
  const azureModel =
    (process.env.AZURE_WEB_SEARCH_MODEL ?? "").trim() ||
    (isAzure ? aiModel : "");

  const azureReady = azureBase !== "" && azureKey !== "" && azureModel !== "";
  const tavilyReady = resolveTavilyKey() !== null;

  if (forced === "azure") return azureReady ? { kind: "azure", base: azureBase, key: azureKey, model: azureModel } : null;
  if (forced === "tavily") return tavilyReady ? { kind: "tavily" } : null;
  // auto: prefer Azure (the configured Foundry deployment), fall back to the
  // already-in-use Tavily key.
  if (azureReady) return { kind: "azure", base: azureBase, key: azureKey, model: azureModel };
  if (tavilyReady) return { kind: "tavily" };
  return null;
}

/** Look up the allowlist entry for a host (suffix match, www-stripped). */
export function domainForHost(host: string): AllowedDomain | null {
  const normalized = host.toLowerCase().replace(/^www\./, "");
  for (const entry of ALLOWED_DOMAINS) {
    if (normalized === entry.domain || normalized.endsWith(`.${entry.domain}`)) {
      return entry;
    }
  }
  return null;
}

export function allowedDomainIds(): string[] {
  return ALLOWED_DOMAINS.map((d) => d.domain);
}
