import "server-only";

import {
  AGENT,
  assertPublicTarget,
  fetchRobots,
  htmlToText,
  pathDisallowed,
  type RobotsPolicy,
} from "@/lib/web-search/fetch-page";
import { classifyResponse, type BlockedReason } from "./classify";
import type { RenderedPage } from "./camofox/client";
import type { SourceAttempt } from "./types";

/**
 * The ONE guarded fetcher every outbound request of the discovery goes
 * through (§4.3, §4.7, §7).
 *
 * Guarantees, in the order they are enforced:
 *  1. `http`/`https` only, no credentials in the URL;
 *  2. DNS is resolved and loopback / private / link-local / unique-local /
 *     cloud-metadata targets are refused — before any request, and again after
 *     EVERY redirect hop (a redirect to a private address is the classic SSRF);
 *  3. `robots.txt` is fetched once per origin per run and respected — a
 *     disallowed path is never requested at all;
 *  4. politeness: at most one in-flight request per host, at least
 *     {@link MIN_HOST_INTERVAL_MS} between requests to the same host, and
 *     `Crawl-delay` honored when the host announces a bigger one;
 *  5. bounded: {@link REQUEST_TIMEOUT_MS} per attempt, {@link MAX_REDIRECTS}
 *     hops, {@link MAX_BODY_BYTES} body, `text/html` only;
 *  6. the central classifier runs on the response BEFORE any extraction, and
 *     any block opens a per-host circuit breaker for the rest of the run — no
 *     retry with different headers, no proxy, no solver.
 *
 * Every attempt is recorded as a {@link SourceAttempt} so a run can explain
 * itself. The context is per run: caches, pacing and breakers never leak
 * between runs.
 */

export const REQUEST_TIMEOUT_MS = 10_000;
export const MAX_REDIRECTS = 5;
export const MAX_BODY_BYTES = 1_500_000;
/** At most one concurrent request per host (§4.7). */
export const MAX_HOST_CONCURRENCY = 1;
/** Minimum spacing between two requests to the same host (§4.7). */
export const MIN_HOST_INTERVAL_MS = 1_000;
/** Transient failures retry at most this many times (§4.3). */
export const MAX_TRANSIENT_ATTEMPTS = 3;
/** Raw markup kept for structured-data parsing (memory bound, never stored). */
export const MAX_RAW_HTML_CHARS = 800_000;

export interface GuardedPage {
  url: string;
  finalUrl: string;
  status: number;
  title: string | null;
  /** Visible text (scripts/styles removed). */
  text: string;
  /**
   * The raw body, capped. Needed for structured data (JSON-LD lives inside
   * `<script>`), which the visible text deliberately strips. Never stored and
   * never rendered — it is parsed in memory and discarded.
   */
  html: string;
  /** Same-origin links, resolved and capped. */
  links: string[];
}

export type GuardedFetchResult =
  | { ok: true; page: GuardedPage }
  | { ok: false; kind: "blocked"; reason: BlockedReason; status: number | null }
  | { ok: false; kind: "unsafe"; message: string }
  | { ok: false; kind: "error"; message: string; status: number | null };

export interface FetchDependencies {
  fetchImpl: typeof fetch;
  /** SSRF gate — must resolve the hostname and reject non-public targets. */
  isPublicHost: (hostname: string) => Promise<boolean>;
  sleep: (ms: number) => Promise<void>;
  nowIso: () => string;
  nowMs: () => number;
  /**
   * OPTIONAL browser escalation: when plain HTTP classifies a page as
   * `js_protected`, `bot_challenge` or `captcha` (content the HTML shell
   * cannot serve), the guarded fetcher MAY render the page with the anti-
   * detection browser and re-evaluate the rendered content. Absent (the
   * default, and on a run without a configured browser) the block stays
   * terminal exactly as before. Must be fail-soft: null on any failure.
   * It NEVER runs for `robots_disallow`, `forbidden`, `login_required` or
   * `rate_limited` (policy/technical blocks, not render problems).
   */
  renderFallback?: (
    ctx: FetchContext,
    url: string,
    reason: BlockedReason,
  ) => Promise<RenderedPage | null>;
}

export interface FetchContext {
  readonly robots: Map<string, RobotsPolicy>;
  readonly nextAllowedAt: Map<string, number>;
  /** host → the block that closed it for this run. */
  readonly blockedHosts: Map<string, BlockedReason>;
  readonly hostChains: Map<string, Promise<void>>;
  readonly attempts: SourceAttempt[];
  readonly deps: FetchDependencies;
  /** Number of real HTTP requests issued (budget accounting). */
  requests: number;
}

/** A new per-run context. Dependencies are injectable so tests stay offline. */
export function createFetchContext(
  deps: Partial<FetchDependencies> = {},
): FetchContext {
  return {
    robots: new Map(),
    nextAllowedAt: new Map(),
    blockedHosts: new Map(),
    hostChains: new Map(),
    attempts: [],
    requests: 0,
    deps: {
      fetchImpl: deps.fetchImpl ?? fetch,
      // The REAL SSRF guard by default: DNS is resolved and loopback/private/
      // link-local/metadata targets are refused. Only tests inject a stub.
      isPublicHost: deps.isPublicHost ?? assertPublicTarget,
      sleep: deps.sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms))),
      nowIso: deps.nowIso ?? (() => new Date().toISOString()),
      nowMs: deps.nowMs ?? (() => Date.now()),
      // Browser escalation (optional): wired by the orchestrator when a
      // Camofox engine is configured for the run; undefined → HTTP-only.
      renderFallback: deps.renderFallback,
    },
  };
}

function record(
  ctx: FetchContext,
  host: string,
  url: string | null,
  outcome: string,
  status: number | null,
): void {
  ctx.attempts.push({
    host,
    url,
    outcome,
    status,
    at: ctx.deps.nowIso(),
  });
}

/**
 * Serialize all work for one host and enforce the spacing window. The host is
 * locked for the whole request, which is what keeps `MAX_HOST_CONCURRENCY` at
 * exactly one even when the caller fans out.
 */
async function withHostSlot<T>(
  ctx: FetchContext,
  host: string,
  task: () => Promise<T>,
): Promise<T> {
  const previous = ctx.hostChains.get(host) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  ctx.hostChains.set(
    host,
    previous.then(() => gate).catch(() => undefined),
  );
  await previous.catch(() => undefined);
  try {
    const waitUntil = ctx.nextAllowedAt.get(host) ?? 0;
    const delay = waitUntil - ctx.deps.nowMs();
    if (delay > 0) await ctx.deps.sleep(delay);
    return await task();
  } finally {
    release();
  }
}

/** Reserve the next allowed start time for a host. */
function reserveHostSlot(
  ctx: FetchContext,
  host: string,
  crawlDelaySeconds: number | undefined,
): void {
  const crawlDelayMs =
    typeof crawlDelaySeconds === "number"
      ? Math.max(0, crawlDelaySeconds * 1_000)
      : 0;
  const spacing = Math.max(MIN_HOST_INTERVAL_MS, crawlDelayMs);
  ctx.nextAllowedAt.set(host, ctx.deps.nowMs() + spacing);
}

/** True when the host's circuit breaker is open for this run. */
export function isHostBlocked(ctx: FetchContext, host: string): boolean {
  return ctx.blockedHosts.has(host);
}

/**
 * The block reasons that are a RENDER problem (the content exists but the
 * plain-HTTP shell cannot see it) and therefore worth one browser escalation.
 * `robots_disallow`, `forbidden`, `login_required` and `rate_limited` are
 * policy/technical decisions and are NEVER escalated — the browser does not
 * (and must not) override a site's stated rules.
 */
export const ESCALABLE_BLOCK_REASONS: ReadonlySet<BlockedReason> = new Set([
  "js_protected",
  "bot_challenge",
  "captcha",
]);

/** A rendered page must actually show content to count as unblocked. */
const MIN_RENDERED_TEXT_LENGTH = 80;

interface HopCheck {
  ok: boolean;
  host: string;
  message: string;
}

/** Scheme, credential and SSRF checks for one hop of the redirect chain. */
async function checkHop(
  ctx: FetchContext,
  candidate: string,
): Promise<HopCheck> {
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return { ok: false, host: "", message: "unparseable url" };
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { ok: false, host: "", message: "scheme not allowed" };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, host: "", message: "credentials in url" };
  }
  const host = parsed.hostname.toLowerCase();
  if (!(await ctx.deps.isPublicHost(host))) {
    return { ok: false, host, message: "non-public target" };
  }
  return { ok: true, host, message: "" };
}

/**
 * Fetch one page with every guard applied. Returns a discriminated result —
 * it never throws, so an adapter can never take down a run.
 */
export async function guardedFetch(
  ctx: FetchContext,
  url: string,
  options: { maxRedirects?: number; textBudget?: number } = {},
): Promise<GuardedFetchResult> {
  const first = await checkHop(ctx, url);
  if (!first.ok) {
    record(ctx, first.host, url, "unsafe_url", null);
    return { ok: false, kind: "unsafe", message: first.message };
  }
  const host = first.host;

  // Circuit breaker: a blocked host is never contacted again this run, and we
  // do not even spend a request on it.
  if (isHostBlocked(ctx, host)) {
    return {
      ok: false,
      kind: "blocked",
      reason: ctx.blockedHosts.get(host) as BlockedReason,
      status: null,
    };
  }

  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    return { ok: false, kind: "unsafe", message: "unparseable url" };
  }

  return withHostSlot(ctx, host, async () => {
    // robots.txt: once per origin per run.
    let policy: RobotsPolicy;
    try {
      policy = await fetchRobots(origin, ctx.robots);
    } catch {
      policy = { disallowed: [] };
    }
    let pathname: string;
    try {
      pathname = new URL(url).pathname;
    } catch {
      return { ok: false, kind: "unsafe", message: "unparseable url" };
    }
    if (pathDisallowed(pathname, policy)) {
      // Not fetched at all — robots is a policy decision, not a failure.
      record(ctx, host, url, "robots_disallow", null);
      ctx.blockedHosts.set(host, "robots_disallow");
      return { ok: false, kind: "blocked", reason: "robots_disallow", status: null };
    }

    reserveHostSlot(ctx, host, policy.crawlDelaySeconds);

    const maxRedirects = options.maxRedirects ?? MAX_REDIRECTS;
    let currentUrl = url;
    let response: Response | null = null;
    let lastError = "request failed";

    for (let hop = 0; hop <= maxRedirects; hop += 1) {
      const check = await checkHop(ctx, currentUrl);
      if (!check.ok) {
        record(ctx, check.host || host, currentUrl, "unsafe_url", null);
        return { ok: false, kind: "unsafe", message: check.message };
      }
      let hopResponse: Response;
      try {
        ctx.requests += 1;
        hopResponse = await ctx.deps.fetchImpl(currentUrl, {
          redirect: "manual",
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          headers: {
            "user-agent": AGENT,
            Accept: "text/html,application/xhtml+xml",
            "Accept-Language": "de-DE,de;q=0.9,en;q=0.7",
          },
          cache: "no-store",
        });
      } catch (error) {
        lastError =
          error instanceof Error && error.name === "TimeoutError"
            ? "timeout"
            : "fetch_failed";
        record(ctx, host, currentUrl, "error", null);
        return { ok: false, kind: "error", message: lastError, status: null };
      }

      const location = hopResponse.headers.get("location");
      if (hopResponse.status >= 300 && hopResponse.status < 400 && location) {
        if (hop >= maxRedirects) {
          record(ctx, host, currentUrl, "error", hopResponse.status);
          return {
            ok: false,
            kind: "error",
            message: "too_many_redirects",
            status: hopResponse.status,
          };
        }
        // Every hop is re-validated: a redirect to a private address, a
        // non-http(s) scheme or a credentialed URL is refused here.
        currentUrl = new URL(location, currentUrl).toString();
        continue;
      }
      response = hopResponse;
      break;
    }

    if (!response) {
      record(ctx, host, currentUrl, "error", null);
      return { ok: false, kind: "error", message: lastError, status: null };
    }

    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    const contentType = headers["content-type"] ?? null;

    let body = "";
    let bodyTooLarge = false;
    const contentLength = Number(headers["content-length"] ?? 0);
    if (contentLength > MAX_BODY_BYTES) {
      bodyTooLarge = true;
    } else {
      try {
        const raw = await response.text();
        if (raw.length > MAX_BODY_BYTES) bodyTooLarge = true;
        else body = raw;
      } catch {
        body = "";
      }
    }

    const visibleText =
      contentType && contentType.includes("html") ? htmlToText(body) : "";

    // THE classifier runs before any extraction (§4.3).
    const classification = classifyResponse({
      url: response.url || currentUrl,
      status: response.status,
      headers,
      contentType,
      bodyHead: body.slice(0, 4_000),
      visibleTextLength: contentType?.includes("html") ? visibleText.length : undefined,
    });
    if (classification.blocked) {
      // ---- HTTP-first, browser-when-needed --------------------------------
      // A JS shell / bot wall / captcha is a RENDER problem: the page's
      // content exists, plain HTTP just cannot see it. One escalation through
      // the anti-detection browser is attempted (budget- and availability-
      // aware, fail-soft). The rendered content goes through the SAME
      // classifier before it is accepted — a rendered page that still shows a
      // challenge stays blocked, and the breaker opens as before.
      if (
        ESCALABLE_BLOCK_REASONS.has(classification.reason) &&
        ctx.deps.renderFallback
      ) {
        let rendered: RenderedPage | null = null;
        try {
          rendered = await ctx.deps.renderFallback(ctx, currentUrl, classification.reason);
        } catch {
          rendered = null; // fail-soft: the block below stays in force
        }
        if (rendered && !rendered.notFound) {
          const recheck = classifyResponse({
            url: rendered.finalUrl,
            status: rendered.status || 200,
            headers: {},
            contentType: "text/html",
            bodyHead: rendered.html.slice(0, 4_000),
            visibleTextLength: rendered.text.length,
          });
          if (!recheck.blocked && rendered.text.length >= MIN_RENDERED_TEXT_LENGTH) {
            record(ctx, host, currentUrl, "ok_via_browser", rendered.status || null);
            return {
              ok: true,
              page: {
                url,
                finalUrl: rendered.finalUrl,
                status: rendered.status || 200,
                title: rendered.title,
                text: rendered.text.slice(0, options.textBudget ?? 20_000),
                html: rendered.html.slice(0, MAX_RAW_HTML_CHARS),
                links: rendered.links.slice(0, MAX_PAGE_LINKS),
              },
            };
          }
        }
      }
      record(ctx, host, currentUrl, classification.reason, response.status);
      ctx.blockedHosts.set(host, classification.reason);
      return {
        ok: false,
        kind: "blocked",
        reason: classification.reason,
        status: response.status,
      };
    }

    if (!response.ok) {
      record(ctx, host, currentUrl, "error", response.status);
      return {
        ok: false,
        kind: "error",
        message: `http_${response.status}`,
        status: response.status,
      };
    }
    if (bodyTooLarge) {
      record(ctx, host, currentUrl, "error", response.status);
      return {
        ok: false,
        kind: "error",
        message: "too_large",
        status: response.status,
      };
    }
    if (!contentType || !contentType.includes("html")) {
      record(ctx, host, currentUrl, "error", response.status);
      return {
        ok: false,
        kind: "error",
        message: "not_html",
        status: response.status,
      };
    }

    record(ctx, host, currentUrl, "ok", response.status);
    return {
      ok: true,
      page: {
        url,
        finalUrl: response.url || currentUrl,
        status: response.status,
        title: extractTitle(body),
        text: visibleText.slice(0, options.textBudget ?? 20_000),
        html: body.slice(0, MAX_RAW_HTML_CHARS),
        links: extractSameOriginLinks(body, response.url || currentUrl),
      },
    };
  });
}

const MAX_PAGE_LINKS = 40;

function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, code) =>
      Number.isFinite(Number(code)) ? String.fromCodePoint(Number(code)) : "",
    );
}

function extractTitle(html: string): string | null {
  const titleTag = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleTag?.[1]?.trim()) {
    return decodeEntities(titleTag[1].replace(/\s+/g, " ").trim()).slice(0, 200);
  }
  return null;
}

/** Public same-origin links on a page (mailto/tel/hash dropped, capped). */
function extractSameOriginLinks(html: string, baseUrl: string): string[] {
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    return [];
  }
  const baseHost = base.hostname.toLowerCase().replace(/^www\./, "");
  const links: string[] = [];
  const seen = new Set<string>();
  const re = /<a\b[^>]*\bhref\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) {
    const raw = (match[2] ?? match[3] ?? match[4] ?? "").trim();
    if (!raw || raw.startsWith("#") || /^(mailto|tel|javascript):/i.test(raw))
      continue;
    let resolved: URL;
    try {
      resolved = new URL(raw, base);
    } catch {
      continue;
    }
    if (resolved.protocol !== "https:" && resolved.protocol !== "http:") continue;
    if (resolved.hostname.toLowerCase().replace(/^www\./, "") !== baseHost) continue;
    resolved.hash = "";
    const value = resolved.toString();
    if (seen.has(value)) continue;
    seen.add(value);
    links.push(value);
    if (links.length >= MAX_PAGE_LINKS) break;
  }
  return links;
}
