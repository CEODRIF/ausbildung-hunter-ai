import "server-only";

/**
 * Web search — server-side discovery abstraction.
 *
 * The AI Ausbildung Search discovery layer needs a general web-search
 * mechanism (publicly indexed pages from many sources: job portals,
 * company career pages, social media). It deliberately does NOT integrate
 * each website individually: queries (including `site:` operators) are sent
 * to Google Gemini with **Google Search Grounding** enabled, and the
 * grounding metadata (the public pages Google actually returned for the
 * query) is used for discovery. Pages are then visited directly with a
 * guarded fetcher (see ./fetch-page) that respects robots.txt and skips
 * anti-bot/rate-limited responses — nothing is bypassed.
 *
 * Anti-fabrication by construction: result URLs come ONLY from the
 * grounding metadata (`groundingChunks[].web` + `dynamicSearchPages`)
 * returned by Google with the search. The model's generated text is not
 * used for URLs at all — it cannot smuggle in invented links.
 *
 * Configuration (smallest required set — see .env.example + check-env):
 *   GEMINI_API_KEY           Google Gemini API key (AI Studio)
 *   GEMINI_GROUNDING_MODEL   optional, default gemini-2.5-flash-lite — the
 *                            lightest/lowest-cost model that supports
 *                            Google Search Grounding
 *
 * Key reuse: if the app's AI provider is already Gemini, the existing key
 * is reused automatically — when AI_API_URL points at the Google AI Studio
 * OpenAI-compatible endpoint (generativelanguage.googleapis.com),
 * AI_API_KEY is the same key the native Gemini API accepts. (Vertex AI
 * endpoints use different auth; set GEMINI_API_KEY explicitly there.)
 *
 * The key is never exposed to the client: only this module (server-only)
 * reads it, and every error path returns a controlled message. With NO
 * usable key the web discovery layer degrades gracefully: the official BA
 * source keeps working and the UI shows "not configured".
 */

export type WebSearchProviderName = "gemini_grounding";

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface WebSearchClient {
  name: WebSearchProviderName;
  search(
    query: string,
    maxResults: number,
  ): Promise<WebSearchResult[]>;
}

/** Controlled error: provider reachable but rejected/failed the query. */
export class WebSearchError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "WebSearchError";
    this.status = status;
  }
}

const GROUNDING_TIMEOUT_MS = 20_000;
const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";
const DEFAULT_GROUNDING_MODEL = "gemini-2.5-flash-lite";
const MAX_RESULTS_HARD_CAP = 20;

function isPlaceholder(value: string | undefined): boolean {
  if (!value) return true;
  const v = value.trim().toLowerCase();
  return (
    v.length < 8 ||
    v.startsWith("your-") ||
    v.startsWith("replace") ||
    v.includes("example") ||
    v === "changeme"
  );
}

/** True when the configured AI endpoint is Google AI Studio's
 *  OpenAI-compatible API — there AI_API_KEY IS a Gemini key. */
function isAiStudioEndpoint(value: string | undefined): boolean {
  return !!value && /generativelanguage\.googleapis\.com/i.test(value);
}

/**
 * Resolve the Gemini key for search grounding:
 *   1. explicit GEMINI_API_KEY (when it is a real key, not a placeholder)
 *   2. reuse AI_API_KEY when the AI provider endpoint is Google AI Studio
 *   otherwise null (web layer stays disabled — graceful degradation)
 */
export function resolveGeminiGroundingKey(): string | null {
  const explicit = process.env.GEMINI_API_KEY?.trim();
  if (explicit && !isPlaceholder(explicit)) return explicit;
  const aiKey = process.env.AI_API_KEY?.trim();
  if (aiKey && !isPlaceholder(aiKey) && isAiStudioEndpoint(process.env.AI_API_URL))
    return aiKey;
  return null;
}

function groundingModel(): string {
  const configured = (process.env.GEMINI_GROUNDING_MODEL ?? "").trim();
  return configured || DEFAULT_GROUNDING_MODEL;
}

/** The grounding response is untrusted input: every field is type-checked
 *  on the way out, and only https URLs from Google's own metadata survive. */
async function geminiGroundingSearch(
  query: string,
  maxResults: number,
  key: string,
): Promise<WebSearchResult[]> {
  const model = groundingModel();
  const prompt =
    `Search Google for the exact query below, then list the most relevant ` +
    `PUBLIC web pages you found, one URL per line. ` +
    `Query: ${query.slice(0, 400)}\n` +
    `Only list URLs that actually appeared in the Google search results. ` +
    `Never invent, guess, or modify a URL. If nothing relevant is found, ` +
    `answer "none".`;
  const response = await fetch(
    `${GEMINI_API_BASE}/models/${encodeURIComponent(model)}:generateContent`,
    {
      method: "POST",
      headers: {
        "x-goog-api-key": key,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        tools: [{ google_search: {} }],
        generationConfig: { temperature: 0, maxOutputTokens: 256 },
      }),
      signal: AbortSignal.timeout(GROUNDING_TIMEOUT_MS),
      cache: "no-store",
    },
  );
  if (!response.ok)
    throw new WebSearchError(
      response.status === 401 || response.status === 403
        ? "The web search provider rejected the configured key."
        : response.status === 429
          ? "The web search provider rate limit was reached."
          : response.status >= 500
            ? "The web search provider is temporarily unavailable."
            : "The web search provider rejected the request.",
      response.status,
    );
  const data = (await response.json()) as {
    candidates?: Array<{
      groundingMetadata?: {
        groundingChunks?: Array<{
          web?: { uri?: unknown; title?: unknown };
        }>;
        searchGroundingMetadata?: { dynamicSearchPages?: unknown };
      };
    }>;
  };
  const metadata = data.candidates?.[0]?.groundingMetadata;
  const limit = Math.min(
    Math.max(maxResults, 1),
    MAX_RESULTS_HARD_CAP,
  );
  const results: WebSearchResult[] = [];
  const seen = new Set<string>();
  const add = (uri: unknown, title: unknown) => {
    if (typeof uri !== "string" || uri.length === 0) return;
    let parsed: URL;
    try {
      parsed = new URL(uri);
    } catch {
      return;
    }
    if (parsed.protocol !== "https:") return;
    // Canonicalize (drop fragments) so the same page is not duplicated.
    const canonical = `${parsed.origin}${parsed.pathname}${parsed.search}`;
    if (seen.has(canonical)) return;
    seen.add(canonical);
    results.push({
      title: typeof title === "string" ? title.slice(0, 300) : "",
      url: canonical,
      snippet: "",
    });
  };
  for (const chunk of metadata?.groundingChunks ?? [])
    add(chunk?.web?.uri, chunk?.web?.title);
  const pages = metadata?.searchGroundingMetadata?.dynamicSearchPages;
  if (Array.isArray(pages)) for (const page of pages) add(page, "");
  return results.slice(0, limit);
}

/**
 * Resolve the configured web-search client. Gemini Google Search Grounding
 * is the single provider: returns a client when a usable key exists
 * (explicit GEMINI_API_KEY, or the reused AI_API_KEY on a Google AI Studio
 * endpoint), otherwise null — the discovery layer then degrades gracefully
 * to the official BA source only.
 */
export function getWebSearchClient(): WebSearchClient | null {
  const key = resolveGeminiGroundingKey();
  if (!key) return null;
  return {
    name: "gemini_grounding",
    search: (q, n) => geminiGroundingSearch(q, n, key),
  };
}
