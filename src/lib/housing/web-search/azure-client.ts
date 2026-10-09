import "server-only";

import { LIMITS, validateAzureEndpoint } from "./config";

/**
 * Azure AI Foundry — hosted `web_search` tool via the Responses API.
 *
 * Official reference (read 2026-10-09, re-verified 2026-10-10):
 *   https://learn.microsoft.com/azure/foundry/openai/how-to/web-search
 *   https://learn.microsoft.com/azure/foundry/foundry-models/concepts/endpoints
 *
 *   POST {foundry-base}/responses  (v1 implicit versioning, no api-version)
 *   foundry-base = https://{resource}.openai.azure.com/openai/v1
 *              OR https://{resource}.services.ai.azure.com/openai/v1
 *   headers: api-key: <resource key>, content-type: application/json
 *   body:    { model, reasoning:{effort:"low"},
 *             tools:[{type:"web_search", filters?:{allowed_domains,blocked_domains},
 *                     user_location?:{type:"approximate",country,city,region,timezone}}],
 *             tool_choice:"auto",
 *             include:["web_search_call.action.sources"],
 *             input:"<query>" }
 *
 * Response: `output[]` with `web_search_call` items (action.query, action.sources)
 * and a `message` item whose content[0].annotations[] carries
 * `url_citation { url, title }`. Billable count = `tool_usage.web_search.num_requests`.
 *
 * Compliance: Grounding with Bing (enterprise) TOU — citations must be
 * displayed to the end user; output may only be cached as part of our work
 * product (handled by the discovery cache, 15-min in-memory TTL); no
 * training use; robots-blocked sites must not be used.
 *
 * Security: the key is server-side only and NEVER appears in error
 * messages, logs, or responses (controlled messages below).
 */

export interface SearchCitation {
  url: string;
  title: string;
}

export interface WebDiscoveryResult {
  /** The model's grounded answer text (may be empty). */
  text: string;
  /** Citations exactly as returned by the search tool. */
  citations: SearchCitation[];
  /** Source URLs from `web_search_call.action.sources` (may be empty). */
  sources: string[];
  /** The queries the search tool actually ran. */
  queries: string[];
  /** Billable Bing transactions reported by the API, when present. */
  numRequests: number | null;
}

export type WebSearchFailure =
  | "not_configured"
  | "endpoint_unavailable" // 404: base URL does not host the Responses API
  | "tool_blocked" // 401/403: key rejected or the tool is blocked
  | "rate_limited" // 429 from the search stack
  | "provider_error" // 5xx / network
  | "timeout";

export class WebSearchApiError extends Error {
  constructor(
    readonly failure: WebSearchFailure,
    message: string,
    readonly httpStatus: number | null = null,
  ) {
    super(message);
    this.name = "WebSearchApiError";
  }
}

export interface ResponsesRequest {
  /** Resolved by config.resolveSearchProvider() — single source of truth. */
  base: string;
  key: string;
  model: string;
  input: string;
  allowedDomains?: string[];
  userLocation?: { country: string; city?: string; region?: string };
  /** Injected for tests. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export async function azureWebSearch(req: ResponsesRequest): Promise<WebDiscoveryResult> {
  const key = req.key;
  const model = req.model;
  if (req.base === "" || key === "" || model === "") {
    throw new WebSearchApiError("not_configured", "Azure web search is not configured.");
  }
  // Defensive re-validation (the resolver already enforces this): the final
  // URL must be a documented {resource}.openai.azure.com or
  // {resource}.services.ai.azure.com /openai/v1/responses endpoint.
  // A malformed base fails safe BEFORE any paid call.
  const base = validateAzureEndpoint(req.base);
  if (!base) {
    throw new WebSearchApiError("not_configured", "Azure web search endpoint is not configured correctly.");
  }
  const url = `${base}/responses`;
  const body: Record<string, unknown> = {
    model,
    input: req.input,
    reasoning: { effort: "low" },
    tools: [
      {
        type: "web_search",
        ...(req.allowedDomains && req.allowedDomains.length > 0
          ? { filters: { allowed_domains: req.allowedDomains.slice(0, 100) } }
          : {}),
        ...(req.userLocation
          ? {
              user_location: {
                type: "approximate",
                country: req.userLocation.country,
                ...(req.userLocation.city ? { city: req.userLocation.city } : {}),
                ...(req.userLocation.region ? { region: req.userLocation.region } : {}),
                timezone: "Europe/Berlin",
              },
            }
          : {}),
      },
    ],
    tool_choice: "auto",
    include: ["web_search_call.action.sources"],
    max_output_tokens: 500,
  };

  const fetchImpl = req.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "api-key": key,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(req.timeoutMs ?? LIMITS.searchTimeoutMs),
      cache: "no-store",
    });
  } catch (error) {
    const isTimeout = error instanceof Error && error.name === "TimeoutError";
    throw new WebSearchApiError(
      isTimeout ? "timeout" : "provider_error",
      isTimeout
        ? "The web search provider timed out."
        : "The web search provider was unreachable.",
    );
  }

  if (!res.ok) {
    let failure: WebSearchFailure = "provider_error";
    if (res.status === 401 || res.status === 403) failure = "tool_blocked";
    else if (res.status === 404) failure = "endpoint_unavailable";
    else if (res.status === 429) failure = "rate_limited";
    // Do NOT read/echo the provider error body — it can contain request
    // details. Status code only.
    throw new WebSearchApiError(
      failure,
      `The web search provider rejected the request (HTTP ${res.status}).`,
      res.status,
    );
  }

  const payload = (await res.json()) as {
    output?: unknown;
    output_text?: unknown;
    tool_usage?: unknown;
  };
  return parseResponsesPayload(payload);
}

/** Pure response parsing — exported for tests. */
export function parseResponsesPayload(payload: {
  output?: unknown;
  output_text?: unknown;
  tool_usage?: unknown;
}): WebDiscoveryResult {
  const citations: SearchCitation[] = [];
  const sources: string[] = [];
  const queries: string[] = [];
  const seenCitation = new Set<string>();
  const seenSource = new Set<string>();
  let text = typeof payload.output_text === "string" ? payload.output_text : "";

  const numRequests =
    payload.tool_usage &&
    typeof payload.tool_usage === "object" &&
    typeof (payload.tool_usage as { web_search?: unknown }).web_search === "object"
      ? Number(
          ((payload.tool_usage as { web_search: { num_requests?: unknown } }).web_search)
            .num_requests,
        )
      : null;

  const output = Array.isArray(payload.output) ? payload.output : [];
  for (const item of output) {
    if (typeof item !== "object" || item === null) continue;
    const rec = item as Record<string, unknown>;
    if (rec.type === "web_search_call") {
      const actionRaw = rec.action;
      if (actionRaw && typeof actionRaw === "object") {
        const action = actionRaw as Record<string, unknown>;
        if (typeof action.query === "string") queries.push(action.query);
        if (Array.isArray(action.sources)) {
          for (const s of action.sources) {
            const url = typeof s === "string" ? s : (s as { url?: unknown })?.url;
            if (typeof url === "string" && !seenSource.has(url)) {
              seenSource.add(url);
              sources.push(url);
            }
          }
        }
      }
    } else if (rec.type === "message" && Array.isArray(rec.content)) {
      for (const block of rec.content) {
        if (typeof block !== "object" || block === null) continue;
        const b = block as Record<string, unknown>;
        if (typeof b.text === "string") text += b.text;
        if (Array.isArray(b.annotations)) {
          for (const ann of b.annotations) {
            if (ann && typeof ann === "object" && ann.type === "url_citation") {
              const u = typeof ann.url === "string" ? ann.url : null;
              if (u && !seenCitation.has(u)) {
                seenCitation.add(u);
                citations.push({ url: u, title: typeof ann.title === "string" ? ann.title : "" });
              }
            }
          }
        }
      }
    }
  }
  return {
    text,
    citations,
    sources,
    queries,
    numRequests: Number.isFinite(numRequests as number) ? (numRequests as number) : null,
  };
}
