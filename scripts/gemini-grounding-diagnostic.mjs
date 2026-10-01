#!/usr/bin/env node
/**
 * Standalone Google-Search-Grounding diagnostic (AI Search 2.2).
 *
 * Runs EXACTLY ONE grounding call (a second call only when the configured
 * model 404s — mirroring production's one-shot fallback) with the same
 * request shape as `src/lib/web-search/index.ts`, and prints a SAFE
 * diagnostic. It is independent of the rest of AI Search (no Next.js,
 * no server-only modules) so the provider problem can be isolated from
 * the sources/pipeline problem.
 *
 * Usage:
 *   GEMINI_GROUNDING_API_KEY=*** npm run gemini:diag
 *   GEMINI_API_KEY=*** npm run gemini:diag
 *
 * The grounding MODEL is pinned in code to gemini-3.5-flash-lite (identical
 * to the production provider) — this script deliberately does not honor
 * GEMINI_GROUNDING_MODEL, so it always tests what production actually sends.
 *
 * Never prints: the API key, the full prompt, any credential, any
 * personal data. Prints: key presence, model, HTTP status, Gemini
 * error code/status/message (scrubbed + truncated), duration, whether
 * grounding metadata came back and how many URLs were extracted.
 *
 * Exit code: 0 = grounding works, 1 = it does not (with the reason).
 */

const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";
/** PINNED — identical to the production provider (src/lib/web-search/index.ts).
 *  GEMINI_GROUNDING_MODEL is ignored there, so it is ignored here too: the
 *  diagnostic must test exactly what production sends. */
const PINNED_MODEL = "gemini-3.5-flash-lite";
const TIMEOUT_MS = 20_000;
const QUERY = "Kaufmann im E-Commerce Ausbildung 2027 Deutschland";

function log(line) {
  process.stdout.write(`[GEMINI_DIAG] ${line}\n`);
}

/** Never let a key-shaped token reach stdout. */
function scrub(value) {
  return String(value ?? "").replace(/AIza[0-9A-Za-z_\-]{10,}/g, "[key-redacted]");
}
function truncate(value, max = 200) {
  const s = scrub(String(value ?? "")).replace(/\s+/g, " ");
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** Same key resolution as the production client:
 *  1. GEMINI_GROUNDING_API_KEY (dedicated grounding key)
 *  2. GEMINI_API_KEY
 *  3. AI_API_KEY when AI_API_URL is a Google AI Studio host */
function resolveKey() {
  const dedicated = process.env.GEMINI_GROUNDING_API_KEY?.trim();
  if (dedicated) return { key: dedicated, source: "GEMINI_GROUNDING_API_KEY" };
  const g = process.env.GEMINI_API_KEY?.trim();
  if (g) return { key: g, source: "GEMINI_API_KEY" };
  const url = process.env.AI_API_URL?.trim();
  const k = process.env.AI_API_KEY?.trim();
  if (k && url) {
    try {
      const host = new URL(url).hostname;
      if (host === "generativelanguage.googleapis.com" || host.endsWith(".googleapis.com"))
        return { key: k, source: "AI_API_KEY (AI_API_URL is a Google endpoint)" };
    } catch {
      /* ignore */
    }
  }
  return { key: null, source: null };
}

async function oneAttempt(key, model) {
  const startedAt = Date.now();
  const body = {
    contents: [
      {
        role: "user",
        parts: [
          {
            text:
              `Search Google for the exact query below, then list the most ` +
              `relevant PUBLIC web pages you found, one URL per line. ` +
              `Query: ${QUERY}\n` +
              `Only list URLs that actually appeared in the Google search ` +
              `results. Never invent, guess, or modify a URL. If nothing ` +
              `relevant is found, answer "none".`,
          },
        ],
      },
    ],
    tools: [{ google_search: {} }],
    generationConfig: { temperature: 0, maxOutputTokens: 256 },
  };
  log(`attempt model=${model} path=generateContent endpoint=/v1beta/models/<model>:generateContent tools=[google_search]`);
  let response;
  try {
    response = await fetch(`${GEMINI_API_BASE}/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      headers: { "x-goog-api-key": key, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });
  } catch (error) {
    log(`network error name=${error instanceof Error ? error.name : "unknown"} (http=n/a)`);
    return { ok: false, network: true };
  }
  const durationMs = Date.now() - startedAt;
  if (!response.ok) {
    let gemini = { code: null, status: null, message: null };
    try {
      const parsed = await response.json();
      const e = parsed?.error;
      gemini = {
        code: typeof e?.code === "number" ? e.code : null,
        status: typeof e?.status === "string" ? e.status : null,
        message: typeof e?.message === "string" ? e.message : null,
      };
    } catch {
      /* non-JSON body */
    }
    log(`http=${response.status} durationMs=${durationMs}`);
    log(`gemini code=${gemini.code ?? "n/a"} status=${gemini.status ?? "n/a"} msg="${truncate(gemini.message)}"`);
    return { ok: false, http: response.status, gemini };
  }
  const data = await response.json();
  const metadata = data?.candidates?.[0]?.groundingMetadata;
  const chunks = metadata?.groundingChunks ?? [];
  const pages = metadata?.searchGroundingMetadata?.dynamicSearchPages;
  const pageList = Array.isArray(pages) ? pages : [];
  const urls = [];
  const seen = new Set();
  const add = (uri) => {
    if (typeof uri !== "string" || !uri) return;
    try {
      const parsed = new URL(uri);
      if (parsed.protocol !== "https:") return;
      const canonical = `${parsed.origin}${parsed.pathname}${parsed.search}`;
      if (!seen.has(canonical)) {
        seen.add(canonical);
        urls.push(canonical);
      }
    } catch {
      /* skip */
    }
  };
  for (const chunk of chunks) add(chunk?.web?.uri);
  for (const page of pageList) add(page);
  log(`http=200 durationMs=${durationMs}`);
  log(`groundingMetadata=${metadata ? "yes" : "NO"} chunks=${chunks.length} pages=${pageList.length} urls=${urls.length}`);
  for (const url of urls.slice(0, 5)) log(`url ${url}`);
  return { ok: metadata != null, urls, metadata: metadata != null };
}

function verdict(result, model) {
  if (result.network) {
    log(`VERDICT: FAILED — network error (egress blocked or timeout). Vercel functions can reach the internet by default; check the key/region or proxy settings.`);
    return 1;
  }
  const { http, gemini } = result;
  const detail = `${gemini?.status ?? ""} ${gemini?.message ?? ""}`.toLowerCase();
  if (http === 404 || /not found|does not exist|unknown model|no such model/.test(detail)) {
    log(`VERDICT: FAILED — HTTP 404 for the PINNED model "${model}". Because the model id is fixed in code, a 404 cannot be a configuration/typo on the app side: Google is rejecting this model for THIS key/project/API version. The literal message above is authoritative — if it says "is not found for API version v1beta, or is not supported for generateContent", the key's project has no access to it (Google AI Studio → the project behind the key → verify the key + billing). Do NOT change the model.`);
    return 1;
  }
  if (http === 401 || http === 403 || /api key not valid|permission denied|not accepted|quota|billing|no access/.test(detail)) {
    log(`VERDICT: FAILED — key/permission/billing (HTTP ${http}). The KEY is the problem, not the model: in Google AI Studio (aistudio.google.com/apikey) verify the key exists and its project has billing enabled; then update GEMINI_GROUNDING_API_KEY (the dedicated grounding key) wherever the environment is configured, and redeploy.`);
    return 1;
  }
  if (http === 429 || /rate limit|resource exhausted/.test(detail)) {
    log(`VERDICT: FAILED — rate limit/quota (HTTP 429). Enable billing for higher quota, or retry later (the model is pinned; changing it is not an option).`);
    return 1;
  }
  if (http && http >= 500) {
    log(`VERDICT: FAILED — Gemini is temporarily unavailable (HTTP ${http}). Retry in a few minutes.`);
    return 1;
  }
  if (http === 400) {
    log(`VERDICT: FAILED — request rejected (HTTP 400). The message above is the literal cause (tool/schema/parameter). Copy it verbatim to the developer.`);
    return 1;
  }
  if (http === 200) {
    if (!result.metadata) {
      log(`VERDICT: FAILED — HTTP 200 but NO grounding metadata: the google_search tool was not accepted for the pinned model "${model}" (or Google returned no pages). The request itself is valid — this is a model/tool-entitlement question on Google's side; report this exact line.`);
      return 1;
    }
    if (result.urls.length === 0) {
      log(`VERDICT: OK — grounding metadata present but 0 extractable URLs for this query (possible, for very narrow queries). The provider IS working.`);
      return 0;
    }
    log(`VERDICT: OK — grounding works: ${result.urls.length} real public URL(s) extracted from Google Search grounding (model=${model}).`);
    return 0;
  }
  log(`VERDICT: FAILED — unexpected response (HTTP ${http ?? "n/a"}).`);
  return 1;
}

async function main() {
  const { key, source } = resolveKey();
  const configured = process.env.GEMINI_GROUNDING_MODEL?.trim();
  log(
    `key=${key ? "present" : "MISSING"} source=${source ?? "none"} ` +
      `model=${PINNED_MODEL} (pinned)${configured && configured !== PINNED_MODEL ? ` GEMINI_GROUNDING_MODEL=${configured} IGNORED` : ""}`,
  );
  if (!key) {
    log(`VERDICT: CANNOT TEST — no key found. Set GEMINI_GROUNDING_API_KEY (dedicated grounding key) or GEMINI_API_KEY in the environment. Nothing was called.`);
    return 2;
  }
  // ONE call, to the pinned model — exactly what production sends.
  const result = await oneAttempt(key, PINNED_MODEL);
  return verdict(result, PINNED_MODEL);
}

main().then(
  (code) => process.exit(code),
  (error) => {
    log(`unexpected crash: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(3);
  },
);
