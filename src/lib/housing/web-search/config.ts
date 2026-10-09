import "server-only";

/**
 * Housing / "Wohnen" — web-discovery configuration.
 *
 * AZURE ONLY (enforced in this resolver, not in an environment variable):
 *   Azure AI Foundry Responses API with the hosted `web_search` tool
 *   (Grounding with Bing Search). Reuses the EXISTING Foundry
 *   resource/deployment (gpt-5-mini) — no new Azure resource.
 *   Docs: https://learn.microsoft.com/azure/foundry/openai/how-to/web-search
 *
 * The housing pipeline has NO Tavily fallback: the resolver returns either a
 * fully validated `azure` provider or null ("not_configured" state in the
 * UI, never a paid call). The Germany Copilot's independent Tavily
 * integration (src/lib/web-search, src/lib/germany-research.ts) is a
 * separate feature and is NOT affected by this change.
 *
 * Endpoint contract (official docs, verified 2026-10-10):
 *   POST https://{resource}.openai.azure.com/openai/v1/responses
 *   header `api-key`, `model` in the body (the deployment name).
 * Anything that does not produce exactly that URL shape fails safe at
 * resolution time (not_configured) BEFORE any provider call.
 *
 * Provider selection: `HOUSING_WEB_SEARCH=azure` is the supported explicit
 * setting; any other value is ignored with a one-time warning.
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
  /**
   * Max search-API calls per user request, general mode: a primary German
   * query plus ONE cost-aware secondary German query (only when the first
   * call under-delivered — see webModeSecondCallThreshold).
   */
  maxSearchCallsPerRun: 2,
  /** Max search-API calls per user request, targeted mode (one domain-restricted call). */
  maxTargetedSearchCalls: 1,
  /** Max pages fetched per user request (targeted mode, fetchable domains only). */
  maxPagesToFetch: 3,
  fetchTimeoutMs: 10_000,
  robotsTimeoutMs: 8_000,
  /** Page bodies larger than this are truncated (parse best-effort). */
  fetchMaxBytes: 512 * 1024,
  /**
   * Whole-request budget. Covers up to TWO sequential search calls (each
   * capped by searchTimeoutMs) plus a small fetch reserve — and stays under
   * the route's maxDuration (60 s) with ~5 s of headroom. 2026-10-10
   * timeout incident: gpt-5-mini + web_search regularly needs 15–25 s per
   * call, so the 45 s budget squeezed the second call and the per-call 20 s
   * cap turned otherwise-fine slow answers into "timeout" failures.
   */
  requestTimeoutMs: 55_000,
  /** Manual redirect hops, each hop re-validated against the URL guard. */
  maxRedirects: 3,
  /**
   * Max listings returned per run. A single Bing call typically yields
   * ~8–15 results; the multi-query merge can produce more, so this cap must
   * not be the reason results get truncated (the 2026-10-10 "seven results"
   * audit found it was not the cause, but it would have clipped the merge).
   */
  maxResults: 40,
  /**
   * General (whole-web) mode: run the SECOND paid search call only when the
   * first call yielded fewer than this many usable candidates. Cost-aware
   * multi-query retrieval — a rich first result set is not chased with a
   * redundant second call.
   */
  webModeSecondCallThreshold: 8,
  /**
   * In-memory result cache. Enterprise TOU §3(c): Bing output may only be
   * stored as part of our work product — a short in-process TTL for the
   * SAME user's search, never a persistent database.
   */
  cacheTtlMs: 15 * 60 * 1000,
  cacheMaxEntries: 50,
  robotsCacheTtlMs: 10 * 60 * 1000,
  /**
   * Per-call search-API (Azure) timeout. 2026-10-10 timeout incident:
   * reasoning + web_search frequently needs 15–25 s; 20 s aborted good-but-
   * slow calls. 30 s leaves room for both calls inside the 55 s budget.
   */
  searchTimeoutMs: 30_000,
  /**
   * Output-token budget for the Responses call. gpt-5-mini is a REASONING
   * model: reasoning tokens share this budget with the visible answer. The
   * answer must fit a JSON array of individually cited listings (each
   * listing needs its URL inside the text), so 500 was too small and 1500
   * truncated answers at ~8–10 items — one of the root causes of the
   * "Berlin returns only seven" audit finding. 4000 fits ~25–30 compact
   * JSON listings plus low-effort reasoning with headroom.
   */
  maxOutputTokens: 4000,
} as const;

/** Identifies ourselves honestly to fetched sites (never a browser UA). */
export const FETCH_USER_AGENT =
  "AusbildungsWegBot/1.0 (+https://ausbildungsweg.net; housing listing verification)";

export type SearchProviderKind = "azure";

/**
 * Fully validated Azure provider. `base` is guaranteed to be a documented
 * Foundry Responses base (`https://{resource}.openai.azure.com/openai/v1`
 * or `https://{resource}.services.ai.azure.com/openai/v1`, no trailing
 * slash), so the client's `${base}/responses` URL matches the documented
 * contract.
 */
export interface ResolvedSearchProvider {
  kind: SearchProviderKind;
  base: string;
  /** resource API key (server-side only — never logged or returned). */
  key: string;
  /** model deployment (e.g. "gpt-5-mini"; the body's `model` field). */
  model: string;
}

/**
 * The two base-URL forms the documented Responses endpoint accepts
 * (learn.microsoft.com/azure/foundry/foundry-models/concepts/endpoints,
 * 2026-08-01: "The base URL accepts both
 * https://{resource}.openai.azure.com/openai/v1/ and
 * https://{resource}.services.ai.azure.com/openai/v1/ formats"; the
 * web-search how-to uses the same /openai/v1 surface):
 *   https://{resource}.openai.azure.com/openai/v1
 *   https://{resource}.services.ai.azure.com/openai/v1
 * Returns the normalized base (no trailing slash) or null. Strict on
 * purpose: an endpoint from a different surface (playground display,
 * native Azure path, OpenAI standard API) would silently produce wrong or
 * rejected paid requests — fail safe at resolution time instead.
 */
export function validateAzureEndpoint(base: string): string | null {
  let u: URL;
  try {
    u = new URL(base);
  } catch {
    return null;
  }
  if (u.protocol !== "https:") return null;
  const host = u.hostname.toLowerCase();
  const hostOk =
    (host.endsWith(".openai.azure.com") && host !== "openai.azure.com") ||
    (host.endsWith(".services.ai.azure.com") && host !== "services.ai.azure.com");
  if (!hostOk) return null;
  if (u.pathname.replace(/\/+$/, "") !== "/openai/v1") return null;
  return `${u.protocol}//${host}${u.pathname.replace(/\/+$/, "")}`;
}

/** One-time warning when the operator set a non-azure provider mode. */
let warnedNonAzureMode = false;

/**
 * Which search backend serves housing web discovery right now.
 * Returns null = nothing configured → the UI shows an honest
 * "web search not configured" state instead of failing.
 *
 * Azure-only by construction: there is no code path that returns a
 * non-azure provider, regardless of any other environment variable
 * (e.g. TAVILY_API_KEY is read by the Germany Copilot, never here).
 */
export function resolveSearchProvider(): ResolvedSearchProvider | null {
  const forced = (process.env.HOUSING_WEB_SEARCH ?? "azure").trim().toLowerCase();
  if (forced !== "azure" && forced !== "" && !warnedNonAzureMode) {
    warnedNonAzureMode = true;
    console.warn(
      `[housing-web-search] HOUSING_WEB_SEARCH='${forced}' ignored — housing web search is Azure-only (no fallback)`,
    );
  }

  // Explicit overrides win; otherwise reuse the app's AI endpoint when it
  // IS a documented Foundry Responses base (the strict validator decides).
  const explicitBase = validateAzureEndpoint((process.env.AZURE_WEB_SEARCH_ENDPOINT ?? "").trim());
  const appBase = validateAzureEndpoint((process.env.AI_API_URL ?? "").trim());

  let base: string | null = explicitBase;
  let key = (process.env.AZURE_WEB_SEARCH_KEY ?? "").trim();
  let model = (process.env.AZURE_WEB_SEARCH_MODEL ?? "").trim();
  if (!base) {
    base = appBase;
    key = key || (process.env.AI_API_KEY ?? "").trim();
    model = model || (process.env.AI_MODEL ?? "").trim();
  }

  // All three must resolve for Azure to be ready (endpoint + key + model
  // deployment with the web_search tool). Malformed/missing → null, and
  // the pipeline answers "not_configured" before any paid call.
  if (!base || key === "" || model === "") return null;
  return { kind: "azure", base, key, model };
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
