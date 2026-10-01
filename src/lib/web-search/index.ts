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
 *   GEMINI_GROUNDING_API_KEY DEDICATED key for web search / Google Search
 *                            grounding ONLY (highest priority for this
 *                            provider). Other Gemini services keep using
 *                            GEMINI_API_KEY.
 *   GEMINI_API_KEY           shared Google Gemini API key (AI Studio) —
 *                            fallback for grounding when no dedicated
 *                            grounding key is configured
 *   GEMINI_GROUNDING_MODEL   optional, default gemini-2.5-flash-lite — the
 *                            lightest/lowest-cost model that supports
 *                            Google Search Grounding
 *
 * Key reuse: if no Gemini key is configured at all and the app's AI
 * provider is already Gemini, the existing key is reused automatically —
 * when AI_API_URL points at the Google AI Studio OpenAI-compatible
 * endpoint (generativelanguage.googleapis.com), AI_API_KEY is the same key
 * the native Gemini API accepts. (Vertex AI endpoints use different auth;
 * set GEMINI_API_KEY explicitly there.)
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

/** JSON-schema fragment for structured grounding (Gemini responseSchema
 *  subset: flat object of string/boolean fields). */
export interface StructuredFieldSchema {
  type: "STRING" | "BOOLEAN";
  description?: string;
}
export interface StructuredSearchSchema {
  properties: Record<string, StructuredFieldSchema>;
  required: string[];
}
export interface WebSearchStructuredResult<T> {
  /** The model's JSON output, validated against `schema.required`. */
  data: T;
  /** Grounding metadata: the real public pages behind the answer. */
  results: WebSearchResult[];
}

export interface WebSearchClient {
  name: WebSearchProviderName;
  search(
    query: string,
    maxResults: number,
  ): Promise<WebSearchResult[]>;
  /** Optional: Google Search grounding with structured JSON output.
   *  Company-website discovery (AI Search 2.1) uses this when present;
   *  providers without it fall back to plain `search` + verification. */
  searchStructured?(
    query: string,
    schema: StructuredSearchSchema,
  ): Promise<WebSearchStructuredResult<Record<string, unknown>>>;
}

/**
 * Controlled error: provider reachable but rejected/failed the query.
 *
 * `gemini*` fields carry Google's error code/status/message from the
 * response body — diagnostic detail for the FUNCTION LOGS (server-only).
 * The `message` string itself stays a controlled, key-free phrase that is
 * safe to surface anywhere (UI hint, per-source logs).
 */
export class WebSearchError extends Error {
  readonly status: number | null;
  readonly geminiCode: number | null;
  readonly geminiStatus: string | null;
  readonly geminiMessage: string | null;
  /** Model the failed call was sent to (null for network-level failures). */
  readonly model: string | null;
  constructor(
    message: string,
    status: number | null = null,
    gemini: { code: number | null; status: string | null; message: string | null } = {
      code: null,
      status: null,
      message: null,
    },
    model: string | null = null,
  ) {
    super(message);
    this.name = "WebSearchError";
    this.status = status;
    this.geminiCode = gemini.code;
    this.geminiStatus = gemini.status;
    this.geminiMessage = gemini.message;
    this.model = model;
  }
}

const GROUNDING_TIMEOUT_MS = 20_000;
const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";
const DEFAULT_GROUNDING_MODEL = "gemini-2.5-flash-lite";
/** One-shot fallback when the configured model no longer exists (404 /
 *  "model not found" on 400) — gemini-2.5-flash is a stable model with
 *  documented Google Search grounding support. Self-heals stale
 *  GEMINI_GROUNDING_MODEL values without touching the provider. */
const FALLBACK_GROUNDING_MODEL = "gemini-2.5-flash";
const MAX_RESULTS_HARD_CAP = 20;

// ---------------------------------------------------------------------------
// Safe diagnostics — for the Vercel function logs (server-only).
// NEVER logs the API key or any credential: only key PRESENCE (bool),
// model name, HTTP status, Google's error code/status/message (truncated)
// and whether grounding metadata came back.
// ---------------------------------------------------------------------------
interface GroundingDiagnostic {
  model: string;
  /** Which env var supplied the key (NAME only — never a value). */
  keySource: string;
  httpStatus: number | null;
  geminiCode: number | null;
  geminiStatus: string | null;
  geminiMessage: string | null;
  /** Number of grounding chunks found (null = error path, not applicable). */
  groundingChunks: number | null;
  /** Wall-clock duration of the HTTP call (null = network failure). */
  durationMs: number | null;
}

let warnDetailBudget = 3; // cap repeated identical error noise per process
let okLogged = false;

/** Test hook: restore per-process diagnostic budgets. */
export function resetGroundingDiagnostics(): void {
  warnDetailBudget = 3;
  okLogged = false;
}

/** Defense in depth: even though Google's error messages never contain
 *  the key, strip any key-shaped token before it reaches the logs. */
function scrubSecrets(value: string): string {
  return value.replace(/AIza[0-9A-Za-z_\-]{10,}/g, "[key-redacted]");
}

function logGrounding(kind: "ok" | "warn", d: GroundingDiagnostic): void {
  const line =
    `[GEMINI_GROUNDING] ${kind} model=${d.model} key=present source=${d.keySource} ` +
    `http=${d.httpStatus ?? "n/a"} gemini=${d.geminiCode ?? "n/a"}/${d.geminiStatus ?? "n/a"}` +
    (d.durationMs !== null ? ` durationMs=${d.durationMs}` : "") +
    (d.geminiMessage
      ? ` msg="${truncateText(scrubSecrets(d.geminiMessage.replace(/\s+/g, " ")), 200)}"`
      : "") +
    (d.groundingChunks !== null ? ` groundingChunks=${d.groundingChunks}` : "");
  if (kind === "ok") {
    if (!okLogged) {
      okLogged = true;
      console.info(line);
    }
  } else if (warnDetailBudget > 0) {
    warnDetailBudget -= 1;
    console.warn(line);
  }
}

function truncateText(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

interface GeminiErrorInfo {
  code: number | null;
  status: string | null;
  message: string | null;
}

/** Parse Google's error body ({error:{code,status,message}}) — tolerant of
 *  non-JSON bodies (never throws). */
async function readGeminiError(response: Response): Promise<GeminiErrorInfo> {
  try {
    const body = (await response.json()) as {
      error?: { code?: unknown; status?: unknown; message?: unknown };
    };
    const e = body?.error;
    return {
      code: typeof e?.code === "number" ? e.code : null,
      status: typeof e?.status === "string" ? e.status : null,
      message: typeof e?.message === "string" ? e.message : null,
    };
  } catch {
    return { code: null, status: null, message: null };
  }
}

/** Controlled, key-free message (safe for UI/log surfaces) + HTTP status. */
function controlledMessage(http: number, gemini: GeminiErrorInfo): string {
  const suffix =
    ` (HTTP ${http}` + (gemini.status ? `, ${gemini.status}` : "") + ")";
  if (http === 401 || http === 403)
    return "The web search provider rejected the configured key" + suffix;
  if (http === 429)
    return "The web search provider rate limit was reached" + suffix;
  if (http >= 500)
    return "The web search provider is temporarily unavailable" + suffix;
  return "The web search provider rejected the request" + suffix;
}

/** True when the error means "this model no longer exists" — the only
 *  class of error where a one-shot model fallback is safe. */
function isModelNotFound(
  http: number | null,
  gemini: GeminiErrorInfo,
): boolean {
  if (http === 404) return true;
  return (
    http === 400 &&
    /not found|does not exist|unknown model|no such model|invalid model/i.test(
      `${gemini.status ?? ""} ${gemini.message ?? ""}`,
    )
  );
}

/** Retry ONCE with the fallback model for model-not-found errors only. */
async function fallbackOnModelNotFound<T>(
  error: unknown,
  model: string,
  keySource: string,
  retry: () => Promise<T>,
): Promise<T> {
  if (
    model !== FALLBACK_GROUNDING_MODEL &&
    error instanceof WebSearchError &&
    isModelNotFound(error.status, {
      code: error.geminiCode,
      status: error.geminiStatus,
      message: error.geminiMessage,
    })
  ) {
    logGrounding("warn", {
      model,
      keySource,
      httpStatus: error.status,
      geminiCode: error.geminiCode,
      geminiStatus: error.geminiStatus,
      geminiMessage: `model not available — retrying once with ${FALLBACK_GROUNDING_MODEL}`,
      groundingChunks: null,
      durationMs: null,
    });
    return retry();
  }
  throw error;
}

/** The single generateContent call: fetch + error mapping + diagnostics.
 *  Returns parsed JSON + duration on 200; throws WebSearchError otherwise. */
async function geminiGenerateContent(
  model: string,
  body: Record<string, unknown>,
  key: string,
  keySource: string,
): Promise<GeminiCallResult> {
  const startedAt = Date.now();
  let response: Response;
  try {
    response = await fetch(
      `${GEMINI_API_BASE}/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: "POST",
        headers: {
          "x-goog-api-key": key,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(GROUNDING_TIMEOUT_MS),
        cache: "no-store",
      },
    );
  } catch (error) {
    logGrounding("warn", {
      model,
      keySource,
      httpStatus: null,
      geminiCode: null,
      geminiStatus: null,
      geminiMessage: error instanceof Error ? error.name : "network error",
      groundingChunks: null,
      durationMs: null,
    });
    throw new WebSearchError(
      "The web search provider was unreachable (network or timeout).",
      null,
      { code: null, status: null, message: null },
      model,
    );
  }
  if (!response.ok) {
    const gemini = await readGeminiError(response);
    logGrounding("warn", {
      model,
      keySource,
      httpStatus: response.status,
      geminiCode: gemini.code,
      geminiStatus: gemini.status,
      geminiMessage: gemini.message,
      groundingChunks: null,
      durationMs: Date.now() - startedAt,
    });
    throw new WebSearchError(
      controlledMessage(response.status, gemini),
      response.status,
      gemini,
      model,
    );
  }
  const data = (await response.json()) as Record<string, unknown>;
  return { data, durationMs: Date.now() - startedAt };
}

interface GeminiCallResult {
  data: Record<string, unknown>;
  durationMs: number;
}

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
 * Resolve the Gemini key for search grounding. Priority:
 *   1. GEMINI_GROUNDING_API_KEY — the DEDICATED web-search/grounding key
 *      (used ONLY by this provider; other Gemini services keep using
 *      GEMINI_API_KEY)
 *   2. GEMINI_API_KEY — shared Gemini key (fallback when no dedicated
 *      grounding key is configured)
 *   3. reuse AI_API_KEY when the AI provider endpoint is Google AI Studio
 *   otherwise null (web layer stays disabled — graceful degradation)
 */
function resolveGroundingKeyInternal(): {
  key: string;
  source: string;
} | null {
  const dedicated = process.env.GEMINI_GROUNDING_API_KEY?.trim();
  if (dedicated && !isPlaceholder(dedicated))
    return { key: dedicated, source: "GEMINI_GROUNDING_API_KEY" };
  const explicit = process.env.GEMINI_API_KEY?.trim();
  if (explicit && !isPlaceholder(explicit))
    return { key: explicit, source: "GEMINI_API_KEY" };
  const aiKey = process.env.AI_API_KEY?.trim();
  if (aiKey && !isPlaceholder(aiKey) && isAiStudioEndpoint(process.env.AI_API_URL))
    return { key: aiKey, source: "AI_API_KEY" };
  return null;
}

export function resolveGeminiGroundingKey(): string | null {
  return resolveGroundingKeyInternal()?.key ?? null;
}

/** Which env var provided the grounding key (NAME only — never a value).
 *  Used in the safe [GEMINI_GROUNDING] diagnostics so the function logs
 *  prove which key the production requests were sent with. */
export function resolveGeminiGroundingKeySource(): string | null {
  return resolveGroundingKeyInternal()?.source ?? null;
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
  keySource: string,
): Promise<WebSearchResult[]> {
  const model = groundingModel();
  try {
    return await geminiGroundingSearchCore(query, maxResults, key, model, keySource);
  } catch (error) {
    return fallbackOnModelNotFound(error, model, keySource, () =>
      geminiGroundingSearchCore(
        query,
        maxResults,
        key,
        FALLBACK_GROUNDING_MODEL,
        keySource,
      ),
    );
  }
}

type GroundingMetadata = {
  groundingChunks?: Array<{ web?: { uri?: unknown; title?: unknown } }>;
  searchGroundingMetadata?: { dynamicSearchPages?: unknown };
};

function groundingChunkCount(metadata: GroundingMetadata | undefined): number {
  const chunks = metadata?.groundingChunks ?? [];
  const pages = metadata?.searchGroundingMetadata?.dynamicSearchPages;
  return chunks.length + (Array.isArray(pages) ? pages.length : 0);
}

function logGroundingOutcome(
  model: string,
  metadata: GroundingMetadata | undefined,
  durationMs: number,
  keySource: string,
): void {
  const chunkCount = groundingChunkCount(metadata);
  logGrounding(chunkCount > 0 ? "ok" : "warn", {
    model,
    keySource,
    httpStatus: 200,
    geminiCode: 200,
    geminiStatus: "OK",
    geminiMessage:
      chunkCount > 0
        ? null
        : "response contained NO grounding metadata — the google_search " +
          "tool may not be accepted for this model/key, or Google returned " +
          "no pages for the query",
    groundingChunks: chunkCount,
    durationMs,
  });
}

async function geminiGroundingSearchCore(
  query: string,
  maxResults: number,
  key: string,
  model: string,
  keySource: string,
): Promise<WebSearchResult[]> {
  const prompt =
    `Search Google for the exact query below, then list the most relevant ` +
    `PUBLIC web pages you found, one URL per line. ` +
    `Query: ${query.slice(0, 400)}\n` +
    `Only list URLs that actually appeared in the Google search results. ` +
    `Never invent, guess, or modify a URL. If nothing relevant is found, ` +
    `answer "none".`;
  const { data, durationMs } = await geminiGenerateContent(
    model,
    {
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      tools: [{ google_search: {} }],
      generationConfig: { temperature: 0, maxOutputTokens: 256 },
    },
    key,
    keySource,
  );
  const metadata = (
    (data.candidates as
      | Array<{ groundingMetadata?: GroundingMetadata }>
      | undefined)?.[0] ?? {}
  ).groundingMetadata;
  const limit = Math.min(
    Math.max(maxResults, 1),
    MAX_RESULTS_HARD_CAP,
  );
  logGroundingOutcome(model, metadata, durationMs, keySource);
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
 * Structured grounding: the model answers a question with a JSON object
 * (responseSchema) while Google Search Grounding provides the pages.
 * The grounding metadata (real public URLs) is returned alongside —
 * callers MUST still verify any URL against fetched content; the JSON is
 * a discovery hint, never the source of truth.
 */
 async function geminiStructuredSearch(
   query: string,
   schema: StructuredSearchSchema,
   key: string,
   keySource: string,
 ): Promise<WebSearchStructuredResult<Record<string, unknown>>> {
   const model = groundingModel();
   try {
     return await geminiStructuredSearchCore(query, schema, key, model, keySource);
   } catch (error) {
     return fallbackOnModelNotFound(error, model, keySource, () =>
       geminiStructuredSearchCore(
         query,
         schema,
         key,
         FALLBACK_GROUNDING_MODEL,
         keySource,
       ),
     );
   }
 }

type StructuredCandidate = {
  content?: { parts?: Array<{ text?: unknown }> };
  groundingMetadata?: GroundingMetadata;
};

async function geminiStructuredSearchCore(
  query: string,
  schema: StructuredSearchSchema,
  key: string,
  model: string,
  keySource: string,
): Promise<WebSearchStructuredResult<Record<string, unknown>>> {
  const { data, durationMs } = await geminiGenerateContent(
    model,
    {
      contents: [{ role: "user", parts: [{ text: query.slice(0, 1200) }] }],
      tools: [{ google_search: {} }],
      generationConfig: {
        temperature: 0,
        maxOutputTokens: 512,
        responseMimeType: "application/json",
        responseSchema: {
          type: "OBJECT",
          properties: schema.properties,
          required: schema.required,
        },
      },
    },
    key,
    keySource,
  );
  const candidate = (
    data.candidates as Array<StructuredCandidate> | undefined
  )?.[0];
  const rawText = candidate?.content?.parts
    ?.map((part) => (typeof part?.text === "string" ? part.text : ""))
    .join("")
    .trim();
  let parsed: Record<string, unknown> = {};
  if (rawText) {
    try {
      const obj = JSON.parse(rawText) as unknown;
      if (obj && typeof obj === "object" && !Array.isArray(obj))
        parsed = obj as Record<string, unknown>;
    } catch {
      parsed = {};
    }
  }
  // Required fields must be present (right types) — otherwise treat the
  // answer as unusable (nulls), never as an implicit "yes".
  for (const field of schema.required) {
    const value = parsed[field];
    const expected = schema.properties[field]?.type;
    const ok =
      expected === "BOOLEAN"
        ? typeof value === "boolean"
        : typeof value === "string";
    if (!ok) parsed[field] = expected === "BOOLEAN" ? false : "";
  }
  const metadata = candidate?.groundingMetadata;
  logGroundingOutcome(model, metadata, durationMs, keySource);
  const results: WebSearchResult[] = [];
  const seen = new Set<string>();
  const add = (uri: unknown, title: unknown) => {
    if (typeof uri !== "string" || uri.length === 0) return;
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(uri);
    } catch {
      return;
    }
    if (parsedUrl.protocol !== "https:") return;
    const canonical = `${parsedUrl.origin}${parsedUrl.pathname}${parsedUrl.search}`;
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
  return { data: parsed, results: results.slice(0, 10) };
}

/**
  * Resolve the configured web-search client. Gemini Google Search Grounding
  * is the single provider: returns a client when a usable key exists
  * (dedicated GEMINI_GROUNDING_API_KEY, else GEMINI_API_KEY, else the reused
  * AI_API_KEY on a Google AI Studio endpoint), otherwise null — the
  * discovery layer then degrades gracefully to the official BA source only.
  */
 export function getWebSearchClient(): WebSearchClient | null {
   const key = resolveGeminiGroundingKey();
   if (!key) return null;
   // Which env var supplied the key (name only — used in safe diagnostics).
   const keySource = resolveGeminiGroundingKeySource() ?? "GEMINI_API_KEY";
   return {
     name: "gemini_grounding",
     search: (q, n) => geminiGroundingSearch(q, n, key, keySource),
     searchStructured: (q, schema) => geminiStructuredSearch(q, schema, key, keySource),
   };
 }
