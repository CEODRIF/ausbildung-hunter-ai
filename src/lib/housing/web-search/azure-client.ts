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
 * Response (official "Response shape", verified 2026-10-10): `output[]` with
 * `web_search_call` items (`action: { type: "search", query, sources? }`;
 * reasoning models may also emit `open_page` / `find_in_page` actions that
 * carry a `url`) and a `message` item whose content[].annotations[] carries
 * `url_citation` objects — flat `{ type, url, title, start_index, end_index }`
 * in the documented Azure shape (the nested `{ url_citation: { … } }` OpenAI
 * spelling is accepted defensively too). Billable count =
 * `tool_usage.web_search.num_requests`.
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
  /**
   * Optional photo URL the provider delivered WITH the citation (public
   * search-result metadata, e.g. a Bing thumbnail). Only present when the
   * provider actually returned one — never fabricated by us.
   */
  image?: string;
}

export interface WebDiscoveryResult {
  /** The model's grounded answer text (may be empty). */
  text: string;
  /** Citations exactly as returned by the search tool. */
  citations: SearchCitation[];
  /** Source URLs from `web_search_call.action.sources` (may be empty). */
  sources: string[];
  /**
   * Optional image metadata the provider returned ALONGSIDE a source URL
   * (same contract as `SearchCitation.image`), keyed by the raw URL the
   * provider wrote. The documented Azure shape currently carries no images
   * — this is parsed defensively and empty when absent.
   */
  sourceImages: Record<string, string>;
  /** The queries the search tool actually ran. */
  queries: string[];
  /** Billable Bing transactions reported by the API, when present. */
  numRequests: number | null;
  /**
   * Number of `web_search_call` output items. 0 = the model answered without
   * invoking the search tool (possible with tool_choice "auto") — the caller
   * surfaces this as an explicit warning instead of a silent empty result.
   */
  webSearchCalls: number;
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
    max_output_tokens: LIMITS.maxOutputTokens,
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
    // AbortSignal.timeout() raises TimeoutError; network-level aborts may
    // surface as AbortError. BOTH are timeouts — mapping AbortError to
    // provider_error mislabels the failure (task §10: clear separation).
    const isTimeout =
      error instanceof Error &&
      (error.name === "TimeoutError" || error.name === "AbortError");
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
  const parsed = parseResponsesPayload(payload);
  // Safe diagnostics: COUNTS ONLY — never URLs, response text, keys, or
  // request details. This line is what makes "search ran but no results
  // shown" debuggable: it shows whether the tool was invoked, how many
  // citations/sources came back, and the billable Bing count.
  console.info(
    `[housing-web-search] azure response web_search_calls=${parsed.webSearchCalls} citations=${parsed.citations.length} sources=${parsed.sources.length} queries=${parsed.queries.length} bing_requests=${parsed.numRequests ?? "n/a"} output_text_chars=${parsed.text.length}`,
  );
  return parsed;
}

/** Pure response parsing — exported for tests. */
export function parseResponsesPayload(payload: {
  output?: unknown;
  output_text?: unknown;
  tool_usage?: unknown;
}): WebDiscoveryResult {
  const citations: SearchCitation[] = [];
  const sources: string[] = [];
  const sourceImages: Record<string, string> = {};
  const queries: string[] = [];
  const seenCitation = new Set<string>();
  const seenSource = new Set<string>();
  let webSearchCalls = 0;

  /**
   * Read optional photo metadata a provider MAY deliver alongside a result
   * URL (public search-result metadata — e.g. Bing-style thumbnails).
   * Accepts the common spellings; returns null when absent. Defensive only:
   * the documented Azure shape has no image field, so this is normally
   * null — we never invent a photo.
   */
  const readImageMeta = (rec: Record<string, unknown>): string | null => {
    for (const key of ["image", "image_url", "thumbnail_url"]) {
      const v = rec[key];
      if (typeof v === "string" && v.trim() !== "") return v.trim();
      const nested = v && typeof v === "object" ? (v as Record<string, unknown>) : null;
      const nv = nested?.thumbnailUrl ?? nested?.url;
      if (typeof nv === "string" && nv.trim() !== "") return nv.trim();
    }
    return null;
  };
  // TEXT IS COLLECTED, THEN RESOLVED (below): the documented `output_text`
  // field ALREADY is the concatenation of all message output-text items —
  // using it AND appending the message blocks would double the text (harmless
  // for prose, but it corrupts the structured JSON answer: `[...][...]`).
  const messageTexts: string[] = [];

  const numRequests =
    payload.tool_usage &&
    typeof payload.tool_usage === "object" &&
    typeof (payload.tool_usage as { web_search?: unknown }).web_search === "object"
      ? Number(
          ((payload.tool_usage as { web_search: { num_requests?: unknown } }).web_search)
            .num_requests,
        )
      : null;

  const addSource = (url: string): void => {
    if (!seenSource.has(url)) {
      seenSource.add(url);
      sources.push(url);
    }
  };

  // Parse by `type`, never by position — with reasoning models the `output`
  // array also contains `reasoning` items (official docs, "Response shape").
  const output = Array.isArray(payload.output) ? payload.output : [];
  for (const item of output) {
    if (typeof item !== "object" || item === null) continue;
    const rec = item as Record<string, unknown>;
    if (rec.type === "web_search_call") {
      webSearchCalls += 1;
      const actionRaw = rec.action;
      if (actionRaw && typeof actionRaw === "object") {
        const action = actionRaw as Record<string, unknown>;
        // Documented Azure shape: action.query (string). The OpenAI API also
        // uses action.queries (array) — accept both.
        if (typeof action.query === "string") queries.push(action.query);
        if (Array.isArray(action.queries)) {
          for (const q of action.queries) {
            if (typeof q === "string") queries.push(q);
          }
        }
        // Reasoning models: open_page / find_in_page actions carry the page
        // URL the model consulted — a valid listing source.
        if (typeof action.url === "string") addSource(action.url);
        if (Array.isArray(action.sources)) {
          for (const s of action.sources) {
            // Documented shape: each entry is { type, url }; a bare string is
            // accepted defensively. Optional photo metadata (when the
            // provider delivers it) is captured alongside the URL.
            const url = typeof s === "string" ? s : (s as { url?: unknown })?.url;
            if (typeof url === "string") {
              addSource(url);
              if (typeof s === "object" && s !== null && !(url in sourceImages)) {
                const img = readImageMeta(s as Record<string, unknown>);
                if (img) sourceImages[url] = img;
              }
            }
          }
        }
      }
    } else if (rec.type === "message" && Array.isArray(rec.content)) {
      for (const block of rec.content) {
        if (typeof block !== "object" || block === null) continue;
        const b = block as Record<string, unknown>;
        if (typeof b.text === "string") messageTexts.push(b.text);
        if (Array.isArray(b.annotations)) {
          for (const ann of b.annotations) {
            if (!ann || typeof ann !== "object" || ann.type !== "url_citation") continue;
            // Documented Azure shape is FLAT (url/title on the annotation);
            // the OpenAI nested spelling { url_citation: { url, title } } is
            // accepted defensively.
            const nested =
              ann.url_citation && typeof ann.url_citation === "object"
                ? (ann.url_citation as Record<string, unknown>)
                : ann;
            const u = typeof nested.url === "string" ? nested.url : null;
            if (u && !seenCitation.has(u)) {
              seenCitation.add(u);
              const title = typeof nested.title === "string" ? nested.title : "";
              const img = readImageMeta(nested);
              citations.push(img ? { url: u, title, image: img } : { url: u, title });
            }
          }
        }
      }
    }
  }
  // Resolve the answer text: prefer the documented `output_text` (it is the
  // canonical concatenation of all message output-text items); fall back to
  // the collected message blocks when the field is absent/empty.
  const text =
    typeof payload.output_text === "string" && payload.output_text !== ""
      ? payload.output_text
      : messageTexts.join("");

  return {
    text,
    citations,
    sources,
    sourceImages,
    queries,
    numRequests: Number.isFinite(numRequests as number) ? (numRequests as number) : null,
    webSearchCalls,
  };
}
