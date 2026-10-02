import "server-only";

/**
 * Web search — server-side discovery abstraction (Tavily).
 *
 * Provider: the official Tavily Search API
 *   POST https://api.tavily.com/search
 *   Authorization: Bearer <key>, Content-Type: application/json
 *   Response: { query, results: [{ title, url, content, score, … }] }
 *   Errors:   { detail: { error } } (or detail: [...] for 422 validation)
 * Reference: https://docs.tavily.com/documentation/api-reference/endpoint/search
 *
 * Configuration (server-only — the key NEVER reaches the browser):
 *   TAVILY_API_KEY   required. This is the ONLY key this provider reads.
 *
 * Request budget: at most MAX_TAVILY_REQUESTS_PER_RUN Tavily requests per
 * search operation. The counter lives on the client instance, and each
 * search run creates exactly one client — so the cap is per search
 * operation. Once spent, `search()` returns [] WITHOUT any network call:
 * no open loop, no unbounded retry, no per-company request.
 *
 * Gemini Google Search Grounding was REMOVED from this provider (AI Search
 * 2.4). Other Gemini services are untouched — this module never reads
 * GEMINI_API_KEY.
 */

export type WebSearchProviderName = "tavily";

/** Official endpoint (documented above). */
export const TAVILY_SEARCH_URL = "https://api.tavily.com/search";
/** Hard cap of Tavily requests per search operation. */
export const MAX_TAVILY_REQUESTS_PER_RUN = 3;

const TAVILY_TIMEOUT_MS = 20_000;
const MAX_RESULTS_HARD_CAP = 20;
/** Tiny in-memory cache — no migration, no external service. */
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX_ENTRIES = 50;

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
  /** Provider relevance score (Tavily `score`, 0..1) when returned. */
  score?: number;
  /** Result hostname, lowercased and www-stripped when derivable. */
  domain?: string;
}

/** Kept for API compatibility with the pipeline. Tavily has no structured
 *  JSON-output mode, so the Tavily client does not implement
 *  `searchStructured` (this phase is discovery-only). */
export interface StructuredFieldSchema {
  type: "STRING" | "BOOLEAN";
  description?: string;
}
export interface StructuredSearchSchema {
  properties: Record<string, StructuredFieldSchema>;
  required: string[];
}
export interface WebSearchStructuredResult<T> {
  data: T;
  results: WebSearchResult[];
}

export interface WebSearchClient {
  name: WebSearchProviderName;
  /**
   * One Tavily search request (multiple results per request), or [] once
   * the per-run budget is spent (no network call).
   */
  search(query: string, maxResults: number): Promise<WebSearchResult[]>;
  /** Not implemented by the Tavily provider (discovery-only phase). */
  searchStructured?(
    query: string,
    schema: StructuredSearchSchema,
  ): Promise<WebSearchStructuredResult<Record<string, unknown>>>;
}

export interface ProviderErrorInfo {
  code: number | null;
  status: string | null;
  message: string | null;
}

/**
 * Controlled error: provider reachable but rejected/failed the request.
 *
 * The `code`/`providerStatus`/`providerMessage` fields carry Tavily's own
 * error detail for the FUNCTION LOGS and the UI diagnostics card. The
 * `message` stays a controlled, key-free phrase safe to surface anywhere.
 */
export class WebSearchError extends Error {
  readonly status: number | null;
  readonly code: number | null;
  readonly providerStatus: string | null;
  readonly providerMessage: string | null;
  /** Kept for pipeline compatibility; a search API has no model → null. */
  readonly model: string | null;
  constructor(
    message: string,
    status: number | null = null,
    info: ProviderErrorInfo = { code: null, status: null, message: null },
    model: string | null = null,
  ) {
    super(message);
    this.name = "WebSearchError";
    this.status = status;
    this.code = info.code;
    this.providerStatus = info.status;
    this.providerMessage = info.message;
    this.model = model;
  }
}

// ---------------------------------------------------------------------------
// Safe diagnostics — for the server (Vercel function) logs.
// NEVER logs the API key, the full query text or any personal data.
// ---------------------------------------------------------------------------

let diagnosticWarnBudget = 3;
let diagnosticOkLogged = false;

function truncateText(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/** Defense in depth: strip anything key-shaped before it reaches the logs. */
function scrubSecrets(value: string): string {
  return value.replace(/tvly-[A-Za-z0-9_-]{6,}/gi, "[key-redacted]");
}

interface TavilyDiagnostic {
  requestNo: number;
  httpStatus: number | null;
  code: number | null;
  providerStatus: string | null;
  providerMessage: string | null;
  durationMs: number | null;
  results: number | null;
  note?: string;
}

function logTavily(kind: "ok" | "warn", d: TavilyDiagnostic): void {
  if (kind === "ok") {
    if (diagnosticOkLogged) return;
    diagnosticOkLogged = true;
  } else if (diagnosticWarnBudget > 0) {
    diagnosticWarnBudget -= 1;
  } else {
    return;
  }
  const line =
    `[TAVILY] ${kind} request=${d.requestNo}/${MAX_TAVILY_REQUESTS_PER_RUN} ` +
    `key=present http=${d.httpStatus ?? "n/a"} ` +
    `code=${d.code ?? "n/a"}/${d.providerStatus ?? "n/a"}` +
    (d.durationMs !== null ? ` durationMs=${d.durationMs}` : "") +
    (d.results !== null ? ` results=${d.results}` : "") +
    (d.providerMessage
      ? ` msg="${truncateText(scrubSecrets(d.providerMessage.replace(/\s+/g, " ")), 200)}"`
      : "") +
    (d.note ? ` ${d.note}` : "");
  (kind === "ok" ? console.info : console.warn)(line);
}

/** Tests only: restore the diagnostic log budgets. */
export function resetTavilyDiagnostics(): void {
  diagnosticWarnBudget = 3;
  diagnosticOkLogged = false;
}

// ---------------------------------------------------------------------------
// Key resolution (server-only)
// ---------------------------------------------------------------------------

function isPlaceholder(value: string): boolean {
  const lowered = value.toLowerCase();
  return (
    value.length < 8 ||
    lowered.startsWith("your-") ||
    lowered.startsWith("your_") ||
    lowered.includes("placeholder") ||
    lowered === "changeme" ||
    lowered === "tvly-your-api-key"
  );
}

/** The Tavily key, or null when unset/placeholder (the web layer then
 *  degrades gracefully: BA keeps working and the UI shows "not configured"). */
export function resolveTavilyKey(): string | null {
  const key = process.env.TAVILY_API_KEY?.trim();
  if (!key || isPlaceholder(key)) return null;
  return key;
}

// ---------------------------------------------------------------------------
// Result parsing + dedupe
// ---------------------------------------------------------------------------

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** Cache/dedupe key: https-only, host-lowercased, hash + trailing slash gone. */
function normalizeResultUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
    const path = parsed.pathname.replace(/\/+$/, "");
    return `https://${host}${path}${parsed.search}`;
  } catch {
    return null;
  }
}

/** Maps the raw Tavily payload to our result shape, dropping duplicates by
 *  normalized URL AND by (domain, title) so the same company page never
 *  appears twice. Every field is type-checked (untrusted provider input). */
export function parseTavilyResults(
  payload: unknown,
  limit: number,
): WebSearchResult[] {
  const raw = (payload as { results?: unknown })?.results;
  if (!Array.isArray(raw)) return [];
  const results: WebSearchResult[] = [];
  const seenUrls = new Set<string>();
  const seenDomainTitle = new Set<string>();
  for (const entry of raw) {
    const item = entry as {
      title?: unknown;
      url?: unknown;
      content?: unknown;
      score?: unknown;
    };
    if (typeof item?.url !== "string" || item.url.length === 0) continue;
    const canonical = normalizeResultUrl(item.url);
    if (!canonical || seenUrls.has(canonical)) continue;
    const title = typeof item.title === "string" ? item.title : "";
    const domain = hostOf(canonical);
    const domainTitle = `${domain}|${title.toLowerCase().replace(/\s+/g, " ").trim()}`;
    if (domainTitle !== "|" && seenDomainTitle.has(domainTitle)) continue;
    seenUrls.add(canonical);
    if (domainTitle !== "|") seenDomainTitle.add(domainTitle);
    results.push({
      title,
      url: canonical,
      snippet: typeof item.content === "string" ? item.content : "",
      ...(typeof item.score === "number" ? { score: item.score } : {}),
      ...(domain ? { domain } : {}),
    });
  }
  const capped = Math.min(Math.max(limit, 1), MAX_RESULTS_HARD_CAP);
  return results.slice(0, capped);
}

/** Tavily error bodies are `{ detail: { error } }` or `{ detail: [ … ] }`. */
async function readTavilyError(
  response: Response,
): Promise<ProviderErrorInfo> {
  try {
    const body = (await response.json()) as { detail?: unknown };
    const detail = body?.detail;
    if (typeof detail === "string") {
      return { code: response.status, status: null, message: detail };
    }
    if (Array.isArray(detail)) {
      const first = detail[0] as { msg?: unknown } | undefined;
      const msg = typeof first?.msg === "string" ? first.msg : null;
      return { code: response.status, status: "VALIDATION_ERROR", message: msg };
    }
    const error = (detail as { error?: unknown } | undefined)?.error;
    if (typeof error === "string") {
      return {
        code: response.status,
        status: null,
        message: error,
      };
    }
    return { code: response.status, status: null, message: null };
  } catch {
    return { code: response.status, status: null, message: null };
  }
}

/** Controlled, key-free message + a short machine status per HTTP code. */
function controlledMessage(http: number, info: ProviderErrorInfo): {
  message: string;
  status: string;
} {
  const suffix = ` (HTTP ${http})`;
  if (http === 401) {
    return {
      message: "The web search provider rejected the configured key" + suffix,
      status: "UNAUTHORIZED",
    };
  }
  if (http === 429) {
    return {
      message: "The web search provider rate limit was reached" + suffix,
      status: "RATE_LIMITED",
    };
  }
  if (http === 432 || http === 433) {
    return {
      message: "The web search provider usage limit was reached" + suffix,
      status: "USAGE_LIMIT",
    };
  }
  if (http === 422 || http === 400) {
    return {
      message: "The web search provider rejected the request" + suffix,
      status: "INVALID_REQUEST",
    };
  }
  if (http >= 500) {
    return {
      message: "The web search provider is temporarily unavailable" + suffix,
      status: "PROVIDER_ERROR",
    };
  }
  return {
    message: "The web search provider rejected the request" + suffix,
    status: info.status ?? "ERROR",
  };
}

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

async function tavilySearch(
  query: string,
  maxResults: number,
  key: string,
  requestNo: number,
): Promise<WebSearchResult[]> {
  const startedAt = Date.now();
  const body = {
    query: query.slice(0, 400),
    search_depth: "basic",
    max_results: Math.min(Math.max(maxResults, 1), MAX_RESULTS_HARD_CAP),
    include_answer: false,
    include_raw_content: false,
    include_images: false,
    include_usage: true,
  };
  let response: Response;
  try {
    response = await fetch(TAVILY_SEARCH_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TAVILY_TIMEOUT_MS),
      cache: "no-store",
    });
  } catch (error) {
    logTavily("warn", {
      requestNo,
      httpStatus: null,
      code: null,
      providerStatus: null,
      providerMessage: error instanceof Error ? error.name : "network error",
      durationMs: null,
      results: null,
    });
    throw new WebSearchError(
      "The web search provider was unreachable (network or timeout).",
    );
  }
  if (!response.ok) {
    const info = await readTavilyError(response);
    const controlled = controlledMessage(response.status, info);
    logTavily("warn", {
      requestNo,
      httpStatus: response.status,
      code: info.code,
      providerStatus: controlled.status,
      providerMessage: info.message,
      durationMs: Date.now() - startedAt,
      results: null,
    });
    throw new WebSearchError(controlled.message, response.status, {
      code: info.code,
      status: controlled.status,
      message: info.message,
    });
  }
  const payload = (await response.json()) as unknown;
  const results = parseTavilyResults(
    payload,
    Math.min(Math.max(maxResults, 1), MAX_RESULTS_HARD_CAP),
  );
  logTavily(results.length > 0 ? "ok" : "warn", {
    requestNo,
    httpStatus: 200,
    code: 200,
    providerStatus: "OK",
    providerMessage:
      results.length > 0 ? null : "provider returned no usable results",
    durationMs: Date.now() - startedAt,
    results: results.length,
  });
  return results;
}

// ---------------------------------------------------------------------------
// Tiny result cache (per server instance — no migration, no new service)
// ---------------------------------------------------------------------------

const memoryCache = new Map<string, { at: number; results: WebSearchResult[] }>();

/** Tests only. */
export function clearTavilyMemoryCache(): void {
  memoryCache.clear();
}

function cacheGet(key: string): WebSearchResult[] | null {
  const hit = memoryCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    memoryCache.delete(key);
    return null;
  }
  return hit.results;
}

function cacheSet(key: string, results: WebSearchResult[]): void {
  if (memoryCache.size >= CACHE_MAX_ENTRIES) {
    const oldest = memoryCache.keys().next().value;
    if (oldest !== undefined) memoryCache.delete(oldest);
  }
  memoryCache.set(key, { at: Date.now(), results });
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

/**
 * Resolve the configured web-search client. Tavily is the single provider:
 * returns a client when TAVILY_API_KEY is usable, otherwise null — the
 * discovery layer then degrades gracefully to the official BA source only.
 *
 * The returned client owns the per-search-operation request budget.
 */
export function getWebSearchClient(): WebSearchClient | null {
  const key = resolveTavilyKey();
  if (!key) return null;
  let requestsUsed = 0;
  return {
    name: "tavily",
    async search(query: string, maxResults: number): Promise<WebSearchResult[]> {
      const cacheKey = `${query.trim()}|${maxResults}`;
      const cached = cacheGet(cacheKey);
      if (cached) return cached;
      if (requestsUsed >= MAX_TAVILY_REQUESTS_PER_RUN) {
        // Hard cap: no network call, no retry loop.
        logTavily("warn", {
          requestNo: requestsUsed,
          httpStatus: null,
          code: null,
          providerStatus: null,
          providerMessage: null,
          durationMs: null,
          results: 0,
          note: `request budget exhausted (${MAX_TAVILY_REQUESTS_PER_RUN} max) — skipped`,
        });
        return [];
      }
      requestsUsed += 1;
      const results = await tavilySearch(query, maxResults, key, requestsUsed);
      cacheSet(cacheKey, results);
      return results;
    },
    // NOTE: searchStructured is deliberately NOT implemented — Tavily has no
    // structured-output mode and this phase is discovery-only, so company
    // website discovery must not spend a request per company.
  };
}
