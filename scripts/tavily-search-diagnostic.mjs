#!/usr/bin/env node
/**
 * Standalone Tavily web-search diagnostic.
 *
 * Runs EXACTLY ONE Tavily search request (the same endpoint, auth header and
 * request shape as `src/lib/web-search/index.ts`) and prints a SAFE
 * diagnostic. Independent of the rest of AI Search (no Next.js, no
 * server-only modules) so a provider problem can be isolated from the
 * sources/pipeline.
 *
 * Usage:
 *   TAVILY_API_KEY=*** npm run tavily:diag
 *
 * Never prints: the API key, the full query, any credential or personal
 * data. Prints: key presence, HTTP status, duration, result count, the first
 * few public result URLs, and Tavily's own error text (scrubbed).
 *
 * Exit code: 0 = the provider works, 1 = it does not (with the reason),
 * 2 = no key configured (nothing was called).
 */

const TAVILY_SEARCH_URL = "https://api.tavily.com/search";
const TIMEOUT_MS = 20_000;
const MAX_RESULTS = 10;
const QUERY = "Kaufmann im E-Commerce Ausbildung 2027 Deutschland";

function log(line) {
  process.stdout.write(`[TAVILY_DIAG] ${line}\n`);
}

/** Never let a key-shaped token reach stdout. */
function scrub(value) {
  return String(value ?? "").replace(/tvly-[A-Za-z0-9_-]{6,}/gi, "[key-redacted]");
}
function truncate(value, max = 200) {
  const text = scrub(value).replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function isPlaceholder(value) {
  const lowered = String(value).toLowerCase();
  return (
    value.length < 8 ||
    lowered.startsWith("your-") ||
    lowered.startsWith("your_") ||
    lowered.includes("placeholder") ||
    lowered === "changeme" ||
    lowered === "tvly-your-api-key"
  );
}

function resolveKey() {
  const key = process.env.TAVILY_API_KEY?.trim();
  if (!key || isPlaceholder(key)) return null;
  return key;
}

async function main() {
  const key = resolveKey();
  log(`key=${key ? "present" : "MISSING"} source=TAVILY_API_KEY endpoint=${TAVILY_SEARCH_URL}`);
  if (!key) {
    log(
      "VERDICT: CANNOT TEST — no usable TAVILY_API_KEY. Set it in the environment (Vercel → Production) and re-run. Nothing was called.",
    );
    return 2;
  }
  const startedAt = Date.now();
  let response;
  try {
    response = await fetch(TAVILY_SEARCH_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        query: QUERY,
        search_depth: "basic",
        max_results: MAX_RESULTS,
        include_answer: false,
        include_raw_content: false,
        include_images: false,
        include_usage: true,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });
  } catch (error) {
    log(`network error name=${error instanceof Error ? error.name : "unknown"} (http=n/a)`);
    log(
      "VERDICT: FAILED — network error (egress blocked or timeout). Vercel functions can reach the internet by default; check the region/proxy settings.",
    );
    return 1;
  }
  const durationMs = Date.now() - startedAt;
  if (!response.ok) {
    let message = null;
    let code = null;
    try {
      const body = await response.json();
      const detail = body?.detail;
      if (typeof detail?.error === "string") message = detail.error;
      else if (Array.isArray(detail)) message = detail[0]?.msg ?? null;
      code = response.status;
    } catch {
      /* non-JSON body */
    }
    log(`http=${response.status} durationMs=${durationMs} code=${code ?? "n/a"}`);
    log(`msg="${truncate(message)}"`);
    if (response.status === 401) {
      log(
        "VERDICT: FAILED — the key was rejected (HTTP 401). Create/copy a key at https://app.tavily.com/ and update TAVILY_API_KEY in the environment; the key is the problem, not the code.",
      );
    } else if (response.status === 429) {
      log(
        "VERDICT: FAILED — rate limited (HTTP 429). Reduce request frequency or upgrade the Tavily plan.",
      );
    } else if (response.status === 432 || response.status === 433) {
      log(
        "VERDICT: FAILED — usage/credit limit reached (HTTP " +
          response.status +
          "). Check the Tavily dashboard for plan limits and credit balance.",
      );
    } else if (response.status === 400 || response.status === 422) {
      log(
        "VERDICT: FAILED — the request was rejected (HTTP " +
          response.status +
          "). The message above is the literal cause; report it.",
      );
    } else if (response.status >= 500) {
      log(`VERDICT: FAILED — Tavily is temporarily unavailable (HTTP ${response.status}). Retry in a few minutes.`);
    } else {
      log(`VERDICT: FAILED — unexpected response (HTTP ${response.status}).`);
    }
    return 1;
  }
  const payload = await response.json();
  const results = Array.isArray(payload?.results) ? payload.results : [];
  const credits = payload?.usage?.credits;
  log(
    `http=200 durationMs=${durationMs} results=${results.length}` +
      (typeof credits === "number" ? ` credits=${credits}` : "") +
      ` requestId=${truncate(payload?.request_id, 40) || "n/a"}`,
  );
  for (const item of results.slice(0, 5)) {
    const score = typeof item?.score === "number" ? item.score.toFixed(3) : "n/a";
    log(`result score=${score} title="${truncate(item?.title, 80)}" url=${truncate(item?.url, 160)}`);
  }
  if (results.length === 0) {
    log(
      "VERDICT: PARTIAL — the provider answered but returned 0 results for this query. The provider itself works (HTTP 200).",
    );
    return 0;
  }
  log(
    `VERDICT: OK — Tavily works: ${results.length} result(s) with titles/URLs/snippets/scores (no per-company request needed).`,
  );
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    log(`unexpected crash: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(3);
  },
);
