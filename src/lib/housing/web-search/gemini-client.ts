import "server-only";

import type { SearchCitation, WebDiscoveryResult, WebSearchFailure } from "./azure-client";
import { WebSearchApiError } from "./azure-client";

/**
 * Google provider — Gemini API with the official `google_search` grounding
 * tool ("Grounding with Google Search").
 *
 * Why Gemini (verified against official docs 2026-10-10, page last updated
 * 2026-10-09 — https://ai.google.dev/gemini-api/docs/google-search):
 *   - The Custom Search JSON API is CLOSED TO NEW CUSTOMERS (official note
 *     on developers.google.com/custom-search/v1/overview; existing customers
 *     grandfathered until 2027-01-01).
 *   - The new "Web Search Service API" is partner-only.
 *   - Vertex AI Search indexes your own content (≤50 domains), not the open
 *     web.
 *   → Gemini grounding is the official, self-serve Google web-search
 *     surface: the model executes real Google search queries and the
 *     response carries the source URLs (url_citation annotations /
 *     grounding chunks) — exactly what listing DISCOVERY needs.
 *
 * Billing (official, same page): per executed search query on Gemini 3+
 * models — 5,000 queries/month free, then $14 per 1,000. The number of
 * executed queries is read from the `google_search_call` steps (the model
 * may run 1–3 per call); that count IS the billable unit we track.
 *
 * Endpoint (official REST sample, same page):
 *   POST https://generativelanguage.googleapis.com/v1beta/interactions
 *   header: x-goog-api-key, content-type: application/json
 *   body:   { model, input, tools: [{ type: "google_search" }] }
 *
 * Security: the key is server-side only, sent ONLY in the x-goog-api-key
 * header, and NEVER echoed in errors, logs, or responses (status codes
 * only — the error body can contain request details).
 */

export interface GeminiSearchRequest {
  key: string;
  model: string;
  input: string;
  /** Injected for tests. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** API base override (tests). */
  baseUrl?: string;
}

const DEFAULT_BASE = "https://generativelanguage.googleapis.com/v1beta";

export async function geminiWebSearch(req: GeminiSearchRequest): Promise<WebDiscoveryResult> {
  if (req.key === "" || req.model === "") {
    throw new WebSearchApiError("not_configured", "Google (Gemini) web search is not configured.");
  }
  const base = (req.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, "");
  const url = `${base}/interactions`;

  let res: Response;
  try {
    res = await (req.fetchImpl ?? fetch)(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": req.key,
      },
      body: JSON.stringify({
        model: req.model,
        input: req.input,
        tools: [{ type: "google_search" }],
      }),
      signal: AbortSignal.timeout(req.timeoutMs ?? 30_000),
      cache: "no-store",
    });
  } catch (error) {
    const isTimeout =
      error instanceof Error &&
      (error.name === "TimeoutError" || error.name === "AbortError");
    throw new WebSearchApiError(
      isTimeout ? "timeout" : "provider_error",
      isTimeout
        ? "The Google search provider timed out."
        : "The Google search provider was unreachable.",
    );
  }

  if (!res.ok) {
    let failure: WebSearchFailure = "provider_error";
    if (res.status === 401 || res.status === 403) failure = "tool_blocked";
    else if (res.status === 404) failure = "endpoint_unavailable";
    else if (res.status === 429) failure = "rate_limited";
    // Safe root-cause diagnostics: extract ONLY the stable machine
    // `status` enum from the error envelope (e.g. "NOT_FOUND" = unknown
    // model/endpoint, "INVALID_ARGUMENT", "PERMISSION_DENIED",
    // "RESOURCE_EXHAUSTED") — never the message text (it can echo request
    // details), never the key. This is what makes production logs identify
    // the failure without exposing anything sensitive.
    let apiStatus: string | null = null;
    try {
      const errJson = (await res.clone().json().catch(() => null)) as
        | { error?: { status?: unknown } }
        | null;
      const s = errJson?.error?.status;
      if (typeof s === "string" && /^[A-Z][A-Z_]{2,31}$/.test(s)) apiStatus = s;
    } catch {
      // non-JSON error body — ignore, the HTTP status is enough.
    }
    if (apiStatus) {
      console.warn(
        `[housing-web-search] gemini api error http=${res.status} api_status=${apiStatus} model=${req.model}`,
      );
    }
    throw new WebSearchApiError(
      failure,
      apiStatus
        ? `The Google search provider rejected the request (HTTP ${res.status}, ${apiStatus}).`
        : `The Google search provider rejected the request (HTTP ${res.status}).`,
      res.status,
    );
  }

  const payload: unknown = await res.json().catch(() => null);
  const parsed = parseGeminiPayload(payload);
  // Safe diagnostics: COUNTS ONLY — never URLs, response text, keys.
  console.info(
    `[housing-web-search] gemini response search_calls=${parsed.webSearchCalls} queries_executed=${parsed.numRequests ?? 0} citations=${parsed.citations.length} sources=${parsed.sources.length} output_chars=${parsed.text.length}`,
  );
  return parsed;
}

type Rec = Record<string, unknown>;

function asRec(v: unknown): Rec | null {
  return typeof v === "object" && v !== null ? (v as Rec) : null;
}

function asStr(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

/**
 * Pure response parsing — exported for tests. Accepts the documented
 * Interactions-API shape (`interaction.steps[]`) and, defensively, the
 * legacy generateContent shape (`candidates[]` + `groundingMetadata`).
 *
 * Billable unit: total EXECUTED search queries across all
 * `google_search_call` steps (official billing rule: empty queries are
 * ignored by Google — we ignore them too).
 */
export function parseGeminiPayload(payload: unknown): WebDiscoveryResult {
  const citations: SearchCitation[] = [];
  const sources: string[] = [];
  const sourceImages: Record<string, string> = {};
  const queries: string[] = [];
  const seenCitation = new Set<string>();
  const seenSource = new Set<string>();
  let searchCalls = 0;
  const textParts: string[] = [];

  const addSource = (u: string): void => {
    if (!seenSource.has(u)) {
      seenSource.add(u);
      sources.push(u);
    }
  };
  const addCitation = (u: string, title: string, image: string | null): void => {
    if (!seenCitation.has(u)) {
      seenCitation.add(u);
      citations.push(image ? { url: u, title, image } : { url: u, title });
    }
  };

  const root = asRec(payload);
  if (!root) {
    return { text: "", citations, sources, sourceImages, queries, numRequests: 0, webSearchCalls: 0 };
  }

  const readAnnotations = (ann: Rec): void => {
    const type = asStr(ann.type) ?? asStr(ann.citationType);
    if (type && type !== "url_citation" && type !== "URL_CITATION") return;
    const nested = asRec(ann.url_citation) ?? ann;
    const u = asStr(nested.url) ?? asStr(nested.uri);
    if (!u) return;
    const title = asStr(nested.title) ?? "";
    const img = asStr(nested.image) ?? asStr(nested.image_url) ?? null;
    addCitation(u, title, img);
    addSource(u);
  };

  const readTextBlock = (block: Rec): void => {
    const t = asStr(block.text) ?? asStr(block.content);
    if (t) textParts.push(t);
    const anns = block.annotations;
    if (Array.isArray(anns)) for (const a of anns) {
      const ar = asRec(a);
      if (ar) readAnnotations(ar);
    }
  };

  const readStep = (step: Rec): void => {
    const type = asStr(step.type);
    if (type === "google_search_call") {
      searchCalls += 1;
      const args = asRec(step.arguments) ?? step;
      const qs = args.queries;
      if (Array.isArray(qs)) for (const q of qs) {
        const s = asStr(q);
        if (s) queries.push(s); // empty queries are billable-ignored
      }
      const single = asStr(args.query);
      if (single) queries.push(single);
    } else if (type === "model_output" || type === "message") {
      const content = step.content;
      if (Array.isArray(content)) for (const c of content) {
        const cr = asRec(c);
        if (cr) readTextBlock(cr);
      }
    } else if (type === "search") {
      // Defensive: some surfaces wrap the result list here.
      const result = step.result;
      if (Array.isArray(result)) for (const r of result) {
        const rr = asRec(r);
        if (!rr) continue;
        const u = asStr(rr.url) ?? asStr(rr.uri);
        if (u) addSource(u);
      }
    }
  };

  // 1) Documented Interactions-API shape: payload.interaction.steps[]
  //    (flat payload.steps[] accepted defensively).
  const interaction = asRec(root.interaction) ?? root;
  const steps = interaction.steps;
  if (Array.isArray(steps)) {
    for (const s of steps) {
      const sr = asRec(s);
      if (sr) readStep(sr);
    }
  }

  // 2) Defensive legacy shape: candidates[] + groundingMetadata.
  const candidates = root.candidates;
  if (Array.isArray(candidates)) {
    for (const c of candidates) {
      const cr = asRec(c);
      if (!cr) continue;
      const content = asRec(cr.content);
      const parts = content?.parts;
      if (Array.isArray(parts)) for (const p of parts) {
        const pr = asRec(p);
        if (pr) readTextBlock(pr);
      }
      const gm = asRec(cr.groundingMetadata) ?? asRec(root.groundingMetadata);
      if (gm) {
        const chunks = gm.groundingChunks;
        if (Array.isArray(chunks)) for (const ch of chunks) {
          const chr = asRec(ch);
          if (!chr) continue;
          const web = asRec(chr.web);
          if (!web) continue;
          const u = asStr(web.uri) ?? asStr(web.url);
          if (u) {
            const title = asStr(web.title) ?? "";
            const img = asStr(web.thumbnail_url) ?? asStr(web.image_url) ?? null;
            addCitation(u, title, img);
            addSource(u);
          }
        }
        const gmQueries = gm.searchQueries ?? gm.googleSearchQueries;
        if (Array.isArray(gmQueries)) for (const q of gmQueries) {
          const s = asStr(q);
          if (s) {
            queries.push(s);
            searchCalls += 1;
          }
        }
      }
    }
  }

  // 3) Fallback: if no structured citations surfaced, harvest http(s)
  //    URLs from the model text (they are the model's own output — still
  //    real provider results, and the pipeline's acceptance rules apply
  //    unchanged). Dedupe against already-seen.
  const fullText = textParts.join("");
  if (citations.length === 0 && fullText.length > 0) {
    const urlRe = /https?:\/\/[^\s"'<>)\]]+/gi;
    let m: RegExpExecArray | null;
    while ((m = urlRe.exec(fullText)) !== null) {
      // Trailing sentence punctuation (".", ",") is not part of the URL.
      const cleaned = m[0].replace(/[.,;:!?]+$/u, "");
      if (cleaned.length > 8) addSource(cleaned);
    }
  }

  const executedQueries = queries.length;
  return {
    text: fullText,
    citations,
    sources,
    sourceImages,
    queries,
    numRequests: executedQueries,
    webSearchCalls: searchCalls,
  };
}
