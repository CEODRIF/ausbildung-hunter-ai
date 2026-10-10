import "server-only";

/**
 * Housing / "Wohnen" — web-discovery configuration.
 *
 * TWO independent, server-side-validated resolvers (2026-10-10
 * high-coverage engine): each returns a fully validated provider or null
 * (the "not_configured" UI state — never a paid call), and the pipeline
 * (./discovery) runs whatever is ready, isolated per provider:
 *
 *   AZURE (resolveSearchProvider) — Azure AI Foundry Responses API with
 *   the hosted `web_search` tool (Grounding with Bing Search). Reuses the
 *   EXISTING Foundry resource/deployment (gpt-5-mini) — no new Azure
 *   resource. Docs:
 *   https://learn.microsoft.com/azure/foundry/openai/how-to/web-search
 *   Endpoint contract (official docs, verified 2026-10-10):
 *     POST https://{resource}.openai.azure.com/openai/v1/responses
 *     header `api-key`, `model` in the body (the deployment name).
 *   Anything that does not produce exactly that URL shape fails safe at
 *   resolution time (not_configured) BEFORE any provider call.
 *   Provider selection: `HOUSING_WEB_SEARCH=azure` is the supported
 *   explicit setting; any other value is ignored with a one-time warning.
 *   This resolver returns ONLY `azure` or null by design.
 *
 *   GOOGLE (resolveGeminiProvider) — Gemini API with the official
 *   `google_search` grounding tool (see that function's docblock for the
 *   verified endpoint/contract and the model rules). Server-side
 *   `GEMINI_API_KEY` (the app's shared key — no housing-specific key) +
 *   optional `HOUSING_GEMINI_MODEL` override.
 *
 * The housing pipeline has NO Tavily fallback: the resolvers above are the
 * only provider sources. The Germany Copilot's independent Tavily
 * integration (src/lib/web-search, src/lib/germany-research.ts) is a
 * separate feature and is NOT affected by this module.
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

/**
 * Multi-provider search budget (2026-10-10 high-coverage engine task).
 *
 * GOOGLE (Gemini API + official `google_search` grounding tool — verified
 * official docs 2026-10-10, page last updated 2026-10-09):
 *   The Custom Search JSON API is CLOSED TO NEW CUSTOMERS (official note on
 *   developers.google.com), so the self-serve official Google web-search
 *   surface is Gemini grounding. Billing: per executed search query on
 *   Gemini 3+ models — 5,000 queries/month free, then $14 per 1,000
 *   (1.4 ¢/query). Each call may execute 1–3 queries (the model decides).
 *   Worst case = all three rounds run (thin market): 9 calls × 3 queries =
 *   27 queries ≈ 38 ¢ — inside the default 50 ¢ cost cap, which is
 *   enforced on the measured count BEFORE the next paid call is issued.
 *
 * AZURE: unchanged bounded budget (4 Responses calls / 4 Bing transactions)
 * — it now runs as the COMPLEMENTARY source, not the only one.
 */
export const PROVIDER_LIMITS = {
  /** Max Gemini (google_search) calls per whole-web run — hard backstop
   *  equal to the sum of the round caps (3+3+3); the rounds themselves
   *  gate on candidate thresholds, this is the absolute ceiling. */
  maxGoogleCallsPerRun: 9,
  /** Google calls in round 1 (breadth). */
  googleRound1Calls: 3,
  /** Google calls in round 2 (deep-dive) — issued only while unique
   *  candidates stay below the round-2 threshold. */
  googleRound2Calls: 3,
  /** Google calls in round 3 (gap-filling via site: queries). */
  googleRound3Calls: 3,
  /** Azure calls in round 1 (complementary to Google, same bounded pool
   *  logic as the single-provider era). */
  azureRound1Calls: 2,
  /** Run a second round while unique candidates < this (breadth gate). */
  roundTwoCandidateThreshold: 30,
  /** Run a third round while unique candidates < this (gap gate). */
  roundThreeCandidateThreshold: 15,
  /** Default estimated-cost cap per run (Google side, cents). Env may
   *  LOWER via HOUSING_SEARCH_MAX_COST_CENTS_PER_RUN. */
  defaultMaxCostCentsPerRun: 50,
  /**
   * Estimated cost of ONE executed Google search query (list price
   * $14/1,000). The monthly free tier (5,000 queries) is reported in
   * diagnostics but not tracked persistently (no DB by design) — the
   * per-run cap is the hard control.
   */
  googleCostCentsPerQuery: 1.4,
  /** Parallelism across providers within a round. */
  discoveryParallelism: 2,
  /**
   * Search SESSIONS for "load more" (in-memory, consistent with the 15-min
   * result cache: warm serverless instances resolve the token; a cold-miss
   * token degrades to a clear "start a new search" UI state — never a
   * paid re-run, never stale data presented as fresh).
   */
  sessionTtlMs: 10 * 60 * 1000,
  sessionMaxEntries: 200,
  /** Hard cap of candidates a single session may hold. */
  sessionMaxCandidates: 500,
  /** First-page size (cards). */
  pageSize: 24,
  /** Max page fetches per CONTINUATION (enrichment of the next page only). */
  continuationFetchBudget: 8,
} as const;

/** Hard, code-level limits. Env may lower (never raise) some of them. */
export const LIMITS = {
  /**
   * Max Azure Responses calls per user request, general mode: one primary
   * call plus complementary query-family calls (apartment / WG / student /
   * private rental for "all"), each cost-aware (early stop — see
   * webModeSecondCallThreshold, maxBingTransactionsPerRun, deadline).
   * Bounded PAID BUDGET (2026-10-10 search-quality task): worst case
   * 4 Responses calls / 4 reported Bing transactions per run (before:
   * 2 calls, typically 1–2 transactions); typical run is 2–3 calls.
   */
  maxSearchCallsPerRun: 4,
  /** Max search-API calls per user request, targeted mode (one domain-restricted call). */
  maxTargetedSearchCalls: 1,
  /**
   * Bounded parallelism for the COMPLEMENTARY calls (the primary call
   * always runs first). 2 concurrent calls: the pool finishes in one wave
   * for ≤3 complements while each call still gets a full per-call timeout
   * within the shared request deadline.
   */
  webModeParallelism: 2,
  /**
   * Cost cap: cumulative BILLABLE Bing transactions reported by the API
   * (numRequests) per run. When reached, no further calls are issued.
   * 4 = the documented worst-case paid budget (see maxSearchCallsPerRun).
   */
  maxBingTransactionsPerRun: 4,
  /**
   * A call is only issued when at least this much of the request deadline
   * remains (a call aborted after 79 % of its timeout has already paid
   * for nothing but a timeout warning).
   */
  minRemainingForCallMs: 8_000,
  /** Max pages fetched per user request (targeted mode, fetchable domains only). */
  maxPagesToFetch: 3,
  /**
   * Page-fetch budget for WHOLE-WEB (multi-round) runs — larger than
   * targeted mode because round 1 can validate more candidates, and
   * fetchable (open-data) domains are where verified fields come from.
   * Still bounded: robots-checked, SSRF-guarded, deadline-capped.
   */
  webModeMaxPagesToFetch: 6,
  fetchTimeoutMs: 10_000,
  robotsTimeoutMs: 8_000,
  /** Page bodies larger than this are truncated (parse best-effort). */
  fetchMaxBytes: 512 * 1024,
  /**
   * Whole-request budget. Covers the primary call plus the complementary
   * pool (webModeParallelism concurrent, each capped by searchTimeoutMs,
   * each re-checked against the shared deadline) plus a small fetch
   * reserve — and stays under the route's maxDuration (60 s) with ~5 s of
   * headroom. 2026-10-10 timeout incident: gpt-5-mini + web_search
   * regularly needs 15–25 s per call, so the 45 s budget squeezed the
   * second call and the per-call 20 s cap turned otherwise-fine slow
   * answers into "timeout" failures.
   */
  requestTimeoutMs: 55_000,
  /** Manual redirect hops, each hop re-validated against the URL guard. */
  maxRedirects: 3,
  /**
   * Max VALIDATED listings one run may hold (2026-10-10 high-coverage
   * engine: raised from 40). The multi-round, multi-provider merge
   * routinely exceeds 40 unique candidates; display pagination (see
   * PROVIDER_LIMITS.pageSize + sessions) serves them page by page, so the
   * cap must not be the reason results get truncated.
   */
  maxResults: 120,
  /**
   * General (whole-web) mode: complementary paid search calls only run
   * (and keep running) while the merged result set has fewer than this
   * many usable candidates. Cost-aware multi-query retrieval — a rich
   * first result set is not chased with redundant calls.
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

/**
 * GOOGLE provider — Gemini API with the official `google_search` grounding
 * tool (verified 2026-10-10; the Custom Search JSON API is closed to new
 * customers, this is the supported self-serve Google web-search surface).
 *
 *   POST https://generativelanguage.googleapis.com/v1beta/interactions
 *   header `x-goog-api-key: <key>`
 *   body   { model, input, tools: [{ type: "google_search" }] }
 *
  * `GEMINI_API_KEY` is SERVER-SIDE ONLY — it must never appear in
  * NEXT_PUBLIC_*, client bundles, logs, or responses. Missing/empty key →
  * null → the engine runs Azure-only (graceful, reported in diagnostics).
  *
  * MODEL (verified against the official supported-models table, page last
  * updated 2026-10-09): the 3.5 generation offers `gemini-3.5-flash-lite`
  * ONLY — there is no plain `gemini-3.5-flash`. The current Flash model is
  * `gemini-3.8-flash` (the default here). Sending an unknown model name is
  * exactly the 2026-10-10 production failure: HTTP 404 / api_status
  * NOT_FOUND → the Google provider chip showed "error" while Bing worked.
  */
export interface ResolvedGeminiProvider {
  kind: "gemini";
  /** API key (server-side only). */
  key: string;
  /** Model name; default is a supported Flash model (see docs table). */
  model: string;
}

let warnedGeminiModel = false;

export function resolveGeminiProvider(): ResolvedGeminiProvider | null {
  const key = (process.env.GEMINI_API_KEY ?? "").trim();
  if (key === "") return null;
  // Default: gemini-3.8-flash — the current Flash model in the official
  // grounding supported-models table (see the interface docblock). The
  // family regex is a shape guard only; a valid-shape but nonexistent model
  // name is the provider's NOT_FOUND to report, not ours to guess.
  const raw = (process.env.HOUSING_GEMINI_MODEL ?? "gemini-3.8-flash").trim();
  // Defensive guard: the grounding tool is not available on every model —
  // restrict to the documented Gemini families (docs table, 2026-10-09).
  const model =
    /^(gemini-3[.\d]*[-\w]*|gemini-2[.\d]*[-\w]*)$/i.test(raw)
      ? raw
      : "gemini-3.8-flash";
  if (model !== raw && !warnedGeminiModel) {
    warnedGeminiModel = true;
    console.warn(
      `[housing-web-search] HOUSING_GEMINI_MODEL='${raw}' not a documented grounding model — using ${model}`,
    );
  }
  return { kind: "gemini", key, model };
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
