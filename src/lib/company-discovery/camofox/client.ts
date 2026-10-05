/**
 * Camofox client — the browser engine of the research pipeline.
 *
 * Talks to an EXTERNAL `camofox-browser` server (the anti-detection Firefox
 * / Camoufox REST API) over HTTP. The app never launches a browser in-process:
 * it is a plain client, which keeps the serverless route compatible and makes
 * the whole module testable with an injected `fetch`.
 *
 * What this gives the discovery engine:
 *  - rendered HTML + visible text for JavaScript-heavy pages (career portals,
 *    job boards, "load more" listings) that the plain-HTTP fetcher only sees
 *    as an empty shell (`js_protected`) or a bot wall (`bot_challenge`);
 *  - a real browsing session per run (`discovery:<runId>`), with one reusable
 *    tab per company deep crawl (session reuse, not a new context per page);
 *  - accessibility snapshots with stable element refs (e1, e2, …) for
 *    interactions (click "Mehr anzeigen", "Load more", next page);
 *  - C++-level fingerprint spoofing that gets past most bot detection
 *    (Cloudflare, DataDome, …) without any custom "solver".
 *
 * Security model (the same discipline as the HTTP path):
 *  - `http`/`https` only, never a credentialed URL;
 *  - the hostname is DNS-resolved and checked as PUBLIC (loopback / private /
 *    link-local / metadata refused) BEFORE the browser is asked to load it —
 *    the local Camofox process must never be steered at internal resources
 *    (SSRF);
 *  - the FINAL url the browser landed on is re-checked the same way, so a
 *    page that redirects to a private address is dropped, not used;
 *  - robots.txt is respected by the CALLER (guardedFetch runs the robots gate
 *    before it may escalate to the browser) — this client never bypasses it.
 *
 * Reliability: the client is FAIL-SOFT. Any network failure marks the engine
 * `unavailable` for the rest of the run (a per-run circuit breaker) and the
 * pipeline continues with Tavily + plain HTTP. A 404 on a page is NOT a
 * browser failure (it is `notFound: true`, no breaker).
 */
import "server-only";

import { assertPublicTarget } from "@/lib/web-search/fetch-page";

/** The rendered content of ONE page the browser loaded. */
export interface RenderedPage {
  /** The URL that was requested. */
  url: string;
  /** Where the browser actually landed (after redirects). */
  finalUrl: string;
  /** The navigation HTTP status (0 when the engine did not report one). */
  status: number;
  /** true when the navigation answered 404 (page_not_found, not a block). */
  notFound: boolean;
  title: string | null;
  /** Rendered DOM markup, capped (JSON-LD, links, structured data). */
  html: string;
  /** Rendered VISIBLE text (what a human sees), capped. */
  text: string;
  /** Absolute http(s) links on the rendered page. */
  links: string[];
  /**
   * The VISIBLE LABEL of each link (url → text), when the engine exposes it.
   * On a search-result page this is the result title (how a company presents
   * itself — used for company-name extraction, never guessed otherwise).
   */
  linkTitles?: Record<string, string>;
}

export interface CamofoxConfig {
  /** The browser server root, e.g. `http://127.0.0.1:9377`. */
  baseUrl: string;
  /** Bearer key when the server runs behind `CAMOFOX_ACCESS_KEY` (else null). */
  accessKey: string | null;
  /** Per-request timeout in ms. */
  timeoutMs: number;
}

/**
 * Read the browser configuration from the environment. Returns `null` when
 * the operator explicitly disabled the engine (`CAMOFOX_URL=` empty or
 * `disabled`) — the pipeline then runs HTTP-only, exactly as before.
 * Server-side only (env access).
 */
const DEFAULT_CAMOFOX_URL = "http://127.0.0.1:9377";

/** The env surface this module reads (a plain map keeps tests simple). */
type CamofoxEnv = Record<string, string | undefined>;

/** CAMOFOX_TIMEOUT_MS clamped into (0, 120000], else the 45s default. */
function camofoxTimeoutMs(env: CamofoxEnv): number {
  const raw = (env.CAMOFOX_TIMEOUT_MS ?? "").trim();
  const value = Number(raw);
  return raw && Number.isFinite(value) && value > 0
    ? Math.min(Math.floor(value), 120_000)
    : 45_000;
}

/** CAMOFOX_ACCESS_KEY, or null when unset/blank. */
function camofoxAccessKey(env: CamofoxEnv): string | null {
  const key = (env.CAMOFOX_ACCESS_KEY ?? "").trim();
  return key ? key : null;
}

export function camofoxConfigFromEnv(
  env: CamofoxEnv = process.env,
): CamofoxConfig | null {
  // UNSET → the local default (the engine is probed at run time, so a local
  // URL without a running server degrades gracefully). EXPLICITLY EMPTY or
  // `disabled` → the operator turned the engine off.
  const rawUrl = env.CAMOFOX_URL;
  let baseUrl: string;
  if (rawUrl === undefined) {
    baseUrl = DEFAULT_CAMOFOX_URL;
  } else {
    const trimmed = rawUrl.trim();
    if (trimmed === "" || /^disabled$/i.test(trimmed)) return null;
    baseUrl = trimmed.replace(/\/+$/, "");
  }
  return {
    baseUrl,
    accessKey: camofoxAccessKey(env),
    timeoutMs: camofoxTimeoutMs(env),
  };
}

export interface CamofoxClientDeps {
  /** Injectable fetch (tests). */
  fetchImpl?: typeof fetch;
  /** SSRF gate — resolves the hostname and rejects non-public targets. */
  isPublicHost?: (hostname: string) => Promise<boolean>;
  /** Injectable clock/sleep (tests). */
  nowMs?: () => number;
}

export interface CamofoxClientOptions {
  /** The run's budget for browser-rendered pages (per run). */
  maxPages: number;
  /** The run's budget for in-page interactions (per run). */
  maxInteractions: number;
  deps?: CamofoxClientDeps;
}

const MAX_LINKS_PER_PAGE = 240;

/** The shape `renderExpression` produces in the page. */
interface RenderedEval {
  title?: string | null;
  href?: string;
  status?: number;
  html?: string;
  text?: string;
  /** `url\u0000label` pairs (see renderExpression). */
  links?: unknown[];
}

/**
 * One client instance = ONE research run. It owns the run's Camofox session
 * (session isolation: cookies/storage are scoped to `discovery:<runId>`), the
 * run's browser budget, and the run's circuit breaker. Never share a client
 * between runs.
 */
export class CamofoxClient {
  readonly config: CamofoxConfig;
  /** The Camofox session id for this run (session isolation). */
  readonly userId: string;
  /** Measured: browser pages loaded so far (budget accounting). */
  pagesUsed = 0;
  /** Measured: in-page interactions (clicks/scrolls) so far. */
  interactionsUsed = 0;
  /** The run's circuit breaker (a network failure closes the engine). */
  unavailable = false;
  unavailableReason: string | null = null;
  private readonly fetchImpl: typeof fetch;
  private readonly isPublicHost: (hostname: string) => Promise<boolean>;
  private probed = false;

  constructor(
    config: CamofoxConfig,
    userId: string,
    options: CamofoxClientOptions,
  ) {
    this.config = config;
    this.userId = userId;
    this.fetchImpl = options.deps?.fetchImpl ?? fetch;
    this.isPublicHost = options.deps?.isPublicHost ?? assertPublicTarget;
    this.maxPages = Math.max(0, Math.floor(options.maxPages));
    this.maxInteractions = Math.max(0, Math.floor(options.maxInteractions));
  }

  /** The run's page budget (clamped ≥ 0). */
  private readonly maxPages: number;
  /** The run's interaction budget (clamped ≥ 0). */
  private readonly maxInteractions: number;

  /** True when the engine is usable: probed ok (or not needed) + not broken. */
  get available(): boolean {
    return !this.unavailable;
  }

  /** Page budget left for this run. */
  hasPageBudget(): boolean {
    return this.pagesUsed < this.maxPages;
  }

  /** Interaction budget left for this run. */
  hasInteractionBudget(): boolean {
    return this.interactionsUsed < this.maxInteractions;
  }

  /**
   * Reach the engine once (`GET /health`). A failure marks the engine
   * unavailable for the run (the pipeline then stays HTTP-only). Cached.
   */
  async probe(): Promise<boolean> {
    if (this.unavailable) return false;
    if (this.probed) return true;
    const res = await this.request("GET", "/health");
    this.probed = true;
    const health = res?.json as { ok?: boolean } | null | undefined;
    if (!res || res.status !== 200 || !health || health.ok !== true) {
      // request() may already have set a MORE specific reason (e.g. a 5xx
      // from the engine) — never overwrite a measured reason. A 200 whose
      // body is not the engine's health object is ALSO a failure (a proxy
      // error page or an empty body is not a healthy engine).
      if (!this.unavailable) {
        this.unavailable = true;
        this.unavailableReason = res
          ? health
            ? `health_http_${res.status}`
            : "health_invalid"
          : "browser_unreachable";
      }
      return false;
    }
    return true;
  }

  /**
   * Load `url` in a FRESH tab and return its rendered content (or null).
   * Consumes one page of the run's budget. SSRF-checked before AND after.
   */
  async openPage(url: string): Promise<RenderedPage | null> {
    if (!this.available || !this.hasPageBudget()) return null;
    const safe = await this.checkUrlSafe(url);
    if (!safe) return null;
    const created = await this.request("POST", "/tabs", {
      userId: this.userId,
      url,
    });
    if (!created || created.status !== 200) {
      this.markUnavailable(created ? `open_tab_http_${created.status}` : "browser_error");
      return null;
    }
    const body = created.json as {
      tabId?: string;
      url?: string;
      httpStatus?: number | null;
      navigationOk?: boolean;
    } | null;
    if (!body || !body.tabId) {
      this.markUnavailable("open_tab_no_tabid");
      return null;
    }
    try {
      return await this.renderedPageOf(body.tabId, url, body);
    } finally {
      await this.closeTab(body.tabId);
    }
  }

  // ---------------------------------------------------------------------
  // Session-reused crawl API (one tab, many pages of one company)
  // ---------------------------------------------------------------------

  /** Open (or reuse) the tab of an in-flight crawl; one page budget. */
  async navigate(
    tabId: string,
    url: string,
  ): Promise<{ finalUrl: string; status: number; notFound: boolean } | null> {
    if (!this.available || !this.hasPageBudget()) return null;
    const safe = await this.checkUrlSafe(url);
    if (!safe) return null;
    const res = await this.request("POST", `/tabs/${tabId}/navigate`, {
      userId: this.userId,
      url,
    });
    if (!res || res.status !== 200) {
      this.markUnavailable(res ? `navigate_http_${res.status}` : "browser_error");
      return null;
    }
    const body = (res.json ?? null) as {
      ok?: boolean;
      url?: string;
      httpStatus?: number | null;
      navigationOk?: boolean;
    } | null;
    if (!body || !body.ok || !body.url) {
      this.markUnavailable("navigate_failed");
      return null;
    }
    // SSRF re-check on the FINAL url (a redirect to a private address is
    // dropped, not used — the classic SSRF).
    const finalSafe = await this.checkUrlSafe(body.url);
    if (!finalSafe) return null;
    this.pagesUsed += 1;
    const status = typeof body.httpStatus === "number" ? body.httpStatus : 0;
    return {
      finalUrl: body.url,
      status,
      notFound: status === 404 || body.navigationOk === false,
    };
  }

  /**
   * Navigate the tab through a SEARCH MACRO (verified in the deployed v2.4.8
   * source: `@google_search` → `https://www.google.com/search?q=<query>`).
   * The browser performs a REAL search — this is how the discovery engine
   * turns a planner query into a rendered search-result page without any
   * search-API quota. Returns the final (SERP) url.
   */
  async navigateSearch(
    tabId: string,
    query: string,
    macro = "@google_search",
  ): Promise<string | null> {
    if (!this.available || !this.hasPageBudget()) return null;
    const res = await this.request("POST", `/tabs/${tabId}/navigate`, {
      userId: this.userId,
      macro,
      query,
    });
    if (!res || res.status !== 200) {
      this.markUnavailable(res ? `navigate_http_${res.status}` : "browser_error");
      return null;
    }
    const body = (res.json ?? null) as { ok?: boolean; url?: string } | null;
    if (!body || !body.ok || !body.url) {
      this.markUnavailable("navigate_failed");
      return null;
    }
    const finalSafe = await this.checkUrlSafe(body.url);
    if (!finalSafe) return null;
    this.pagesUsed += 1;
    return body.url;
  }

  /**
   * The rendered content of the tab's CURRENT page (no budget — it is not a
   * new page load; the navigation paid for it).
   *
   * ONE evaluate round-trip carries title, final href, the navigation status
   * (from `performance`, because v2.4.8 navigate responses do not report
   * httpStatus), the rendered HTML, the visible text AND the link list with
   * its visible labels (v2.4.8 has no /links endpoint — verified in source).
   * On a parse failure (v2.x 1MB result cap) it retries once with a smaller
   * payload.
   */
  async currentTabContent(
    tabId: string,
    requestedUrl: string,
    nav: { finalUrl: string; status: number; notFound: boolean },
  ): Promise<RenderedPage | null> {
    if (!this.available) return null;
    const evaluated =
      (await this.evaluateRendered(tabId, 500_000, 100_000)) ??
      (await this.evaluateRendered(tabId, 150_000, 40_000));
    if (evaluated === null) return null;
    let links = evaluated.links.filter(
      (link): link is string => typeof link === "string" && link.length > 0,
    );
    const linkTitles: Record<string, string> = {};
    if (evaluated.linkTitles && typeof evaluated.linkTitles === "object") {
      for (const [key, value] of Object.entries(evaluated.linkTitles)) {
        if (typeof value === "string" && value) linkTitles[key] = value;
      }
    }
    // v1.18.1 exposes links with a dedicated endpoint; prefer it when the
    // embedded list is empty (older engines predate the embedded form).
    if (links.length === 0 && Object.keys(linkTitles).length === 0) {
      links = await this.links(tabId);
    }
    links = Array.from(new Set(links)).slice(0, MAX_LINKS_PER_PAGE);
    const status = nav.status || evaluated.status;
    return {
      url: requestedUrl,
      finalUrl: nav.finalUrl,
      status,
      notFound: nav.notFound || status === 404,
      title:
        typeof evaluated.title === "string" && evaluated.title
          ? evaluated.title
          : null,
      html: typeof evaluated.html === "string" ? evaluated.html : "",
      text: typeof evaluated.text === "string" ? evaluated.text : "",
      links,
      linkTitles,
    };
  }

  /**
   * The evaluate expression for `currentTabContent`. Links are returned as
   * `url\u0000label` pairs (label = visible anchor text; on a search-result
   * page that is the result title) so ONE round-trip carries everything.
   */
  private renderExpression(htmlChars: number, textChars: number): string {
    return (
      "(() => { const d = document; const nav = (typeof performance !== 'undefined' && performance.getEntriesByType) ? performance.getEntriesByType('navigation').slice(-1)[0] : null; " +
      "const a = Array.from(d.querySelectorAll ? d.querySelectorAll('a[href]') : []); " +
      "const pairs = []; const seen = new Set(); " +
      "for (const el of a) { try { const u = el.href; if (!u || seen.has(u)) continue; seen.add(u); " +
      "pairs.push(u + '\\u0000' + (el.textContent || '').trim().replace(/[\\u0000\\n]+/g, ' ').slice(0, 200)); " +
      "if (pairs.length >= " + MAX_LINKS_PER_PAGE + ") break; } catch (e) {} } " +
      "return { title: d.title || null, href: location.href, " +
      "status: nav && typeof nav.responseStatus === 'number' ? nav.responseStatus : 0, " +
      "html: (d.documentElement ? d.documentElement.outerHTML : '').slice(0, " + htmlChars + "), " +
      "text: (d.body ? d.body.innerText : '').slice(0, " + textChars + "), " +
      "links: pairs }; })()"
    );
  }

  private async evaluateRendered(
    tabId: string,
    htmlChars: number,
    textChars: number,
  ): Promise<{
    title: string | null;
    status: number;
    html: string;
    text: string;
    links: string[];
    linkTitles: Record<string, string>;
  } | null> {
    const raw = await this.evaluate<RenderedEval>(
      tabId,
      this.renderExpression(htmlChars, textChars),
    );
    // null → the engine call itself failed; a bare string → the v2.x 1MB
    // "[Truncated: …]" marker (unusable). Both: try the smaller retry.
    if (raw === null || typeof raw === "string") return null;
    const linkTitles: Record<string, string> = {};
    const links: string[] = [];
    const pairs: string[] = Array.isArray(raw.links)
      ? raw.links.filter((entry): entry is string => typeof entry === "string")
      : [];
    for (const pair of pairs) {
      const idx = pair.indexOf("\u0000");
      if (idx <= 0) continue;
      const url = pair.slice(0, idx);
      if (!url || links.includes(url)) continue;
      links.push(url);
      const label = pair.slice(idx + 1).trim();
      if (label) linkTitles[url] = label;
    }
    return {
      title: typeof raw.title === "string" && raw.title ? raw.title : null,
      status: typeof raw.status === "number" ? raw.status : 0,
      html: typeof raw.html === "string" ? raw.html : "",
      text: typeof raw.text === "string" ? raw.text : "",
      links,
      linkTitles,
    };
  }

  /** Absolute http(s) links of the current page (pagination-aware fetch). */
  async links(tabId: string): Promise<string[]> {
    const out: string[] = [];
    const seen = new Set<string>();
    let offset = 0;
    for (let round = 0; round < 3 && out.length < MAX_LINKS_PER_PAGE; round += 1) {
      const res = await this.request(
        "GET",
        `/tabs/${tabId}/links?userId=${encodeURIComponent(this.userId)}&limit=100&offset=${offset}`,
      );
      if (!res || res.status !== 200 || !res.json) return out;
      const body = res.json as {
        links?: Array<{ url?: string }>;
        pagination?: { hasMore?: boolean };
      };
      const page = Array.isArray(body.links) ? body.links : [];
      for (const entry of page) {
        const url = typeof entry.url === "string" ? entry.url : null;
        if (!url || seen.has(url)) continue;
        seen.add(url);
        out.push(url);
        if (out.length >= MAX_LINKS_PER_PAGE) break;
      }
      if (body.pagination?.hasMore !== true) break;
      offset += 100;
    }
    return out;
  }

  /** The accessibility snapshot (YAML with stable refs e1, e2, …). */
  async snapshot(tabId: string): Promise<string> {
    const res = await this.request(
      "GET",
      `/tabs/${tabId}/snapshot?userId=${encodeURIComponent(this.userId)}&format=text&includeScreenshot=false`,
    );
    if (!res || res.status !== 200) return "";
    const body = res.json as { snapshot?: string } | null;
    return body && typeof body.snapshot === "string" ? body.snapshot : "";
  }

  /**
   * Click the first snapshot element whose text matches one of `labels`
   * (case-insensitive, accent-insensitive). Counts an interaction.
   */
  async clickLabel(
    tabId: string,
    labels: readonly string[],
    waitMs = 1500,
  ): Promise<boolean> {
    if (!this.available || !this.hasInteractionBudget()) return false;
    const snapshot = await this.snapshot(tabId);
    if (!snapshot) return false;
    const ref = this.findRefForLabels(snapshot, labels);
    if (!ref) return false;
    const res = await this.request("POST", `/tabs/${tabId}/click`, {
      userId: this.userId,
      ref,
    });
    if (!res || res.status !== 200) return false;
    this.interactionsUsed += 1;
    await new Promise((done) => setTimeout(done, waitMs));
    return true;
  }

  /** Scroll the current page. Counts an interaction. */
  async scroll(
    tabId: string,
    direction: "down" | "up" = "down",
    amount = 1200,
  ): Promise<boolean> {
    if (!this.available || !this.hasInteractionBudget()) return false;
    const res = await this.request("POST", `/tabs/${tabId}/scroll`, {
      userId: this.userId,
      direction,
      amount,
    });
    if (!res || res.status !== 200) return false;
    this.interactionsUsed += 1;
    return true;
  }

  /** Close one tab of the run's session (best effort). */
  async closeTab(tabId: string): Promise<void> {
    await this.request("DELETE", `/tabs/${tabId}?userId=${encodeURIComponent(this.userId)}`);
  }

  /**
   * Open the tab used for an in-flight crawl (the FIRST page of the crawl is
   * loaded by the tab creation itself). Returns the navigation facts so the
   * caller can distinguish a 404 (page_not_found) from a loaded page.
   */
  async openTab(
    url: string,
  ): Promise<{ tabId: string; status: number; notFound: boolean } | null> {
    if (!this.available || !this.hasPageBudget()) return null;
    const safe = await this.checkUrlSafe(url);
    if (!safe) return null;
    const res = await this.request("POST", "/tabs", { userId: this.userId, url });
    if (!res || res.status !== 200) {
      this.markUnavailable(res ? `open_tab_http_${res.status}` : "browser_error");
      return null;
    }
    const body = (res.json ?? null) as {
      tabId?: string;
      httpStatus?: number | null;
      navigationOk?: boolean;
    } | null;
    if (!body || !body.tabId) {
      this.markUnavailable("open_tab_no_tabid");
      return null;
    }
    this.pagesUsed += 1;
    const status = typeof body.httpStatus === "number" ? body.httpStatus : 0;
    return {
      tabId: body.tabId,
      status,
      notFound: status === 404 || body.navigationOk === false,
    };
  }

  /**
   * Destroy the run's whole Camofox session (cookies, storage, tabs) at the
   * end of the run — the session must not outlive the run. Best effort.
   */
  async destroySession(): Promise<void> {
    await this.request(
      "DELETE",
      `/sessions/${encodeURIComponent(this.userId)}`,
    );
  }

  // ---------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------

  private markUnavailable(reason: string): void {
    if (!this.unavailable) {
      this.unavailable = true;
      this.unavailableReason = reason;
    }
  }

  /** SSRF + scheme gate for ONE url (initial or final). */
  private async checkUrlSafe(url: string): Promise<boolean> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return false;
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
    if (parsed.username || parsed.password) return false;
    return this.isPublicHost(parsed.hostname.toLowerCase());
  }

  private async evaluate<T>(tabId: string, expression: string): Promise<T | null> {
    const res = await this.request("POST", `/tabs/${tabId}/evaluate`, {
      userId: this.userId,
      expression,
    });
    if (!res || res.status !== 200) return null;
    const body = (res.json ?? null) as { ok?: boolean; result?: unknown } | null;
    if (!body || body.ok !== true) return null;
    const raw = body.result;
    // VERSION-ADAPTIVE (verified against deployed v2.4.8 and v1.18.1):
    // v2.x SERIALIZES the evaluated value — an object comes back as a JSON
    // STRING (`resultType: "string"`); v1.x returns the object directly. A
    // v2.x result that exceeds the 1MB cap comes back as a "[Truncated: …]"
    // marker, detected by the parse failure below.
    if (typeof raw === "string") {
      try {
        return JSON.parse(raw) as T;
      } catch {
        return raw as unknown as T;
      }
    }
    return raw as T;
  }

  private async renderedPageOf(
    tabId: string,
    requestedUrl: string,
    body: { url?: string; httpStatus?: number | null; navigationOk?: boolean },
  ): Promise<RenderedPage | null> {
    const finalUrl =
      typeof body.url === "string" && body.url.length > 0
        ? body.url
        : requestedUrl;
    const finalSafe = await this.checkUrlSafe(finalUrl);
    if (!finalSafe) return null;
    const status =
      typeof body.httpStatus === "number" ? body.httpStatus : 0;
    const nav = {
      finalUrl,
      status,
      notFound: status === 404 || body.navigationOk === false,
    };
    this.pagesUsed += 1;
    return this.currentTabContent(tabId, requestedUrl, nav);
  }

  /**
   * Find a snapshot ref whose text matches one of the labels. The snapshot
   * lines look like `- button "Mehr anzeigen" [ref=e42]` (aria format).
   */
  private findRefForLabels(snapshot: string, labels: readonly string[]): string | null {
    const normalized = labels.map(normalizeLabel);
    const lines = snapshot.split("\n");
    for (const line of lines) {
      const refMatch = line.match(/\[ref=(e\d+)\]/);
      if (!refMatch) continue;
      const text = normalizeLabel(line);
      if (normalized.some((label) => text.includes(label))) {
        return refMatch[1];
      }
    }
    return null;
  }

  private async request(
    method: "GET" | "POST" | "DELETE",
    path: string,
    body?: Record<string, unknown>,
  ): Promise<{ status: number; json: unknown } | null> {
    if (this.unavailable) return null;
    const url = `${this.config.baseUrl}${path}`;
    const headers: Record<string, string> = {
      Accept: "application/json",
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (this.config.accessKey) {
      headers["Authorization"] = `Bearer ${this.config.accessKey}`;
    }
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.config.timeoutMs),
        cache: "no-store",
      });
    } catch {
      // Network failure (engine down / timeout): the breaker opens for the
      // rest of the run — the pipeline continues without the browser.
      this.markUnavailable("browser_unreachable");
      return null;
    }
    let json: unknown = null;
    try {
      json = await response.json();
    } catch {
      json = null;
    }
    if (response.status === 403 && !this.unavailable) {
      // The engine is up but REFUSES our key — a misconfigured
      // CAMOFOX_ACCESS_KEY (the deployed Railway service enforces Bearer auth).
      // A distinct, actionable reason so the source row says exactly this.
      this.markUnavailable("auth_forbidden");
      return null;
    }
    if (response.status >= 500 && !this.unavailable) {
      // The engine itself is failing (5xx) — treat as unavailable.
      this.markUnavailable(`engine_http_${response.status}`);
      return null;
    }
    return { status: response.status, json };
  }
}

/** Accent/case-insensitive label normalization for snapshot matching. */
function normalizeLabel(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * One client for a run, or `null` when the browser engine is not configured
 * / available. Central factory so the orchestrator and tests share the
 * wiring.
 */
export function createCamofoxClient(
  runId: string,
  maxPages: number,
  maxInteractions: number,
  deps?: CamofoxClientDeps,
): CamofoxClient | null {
  const config = camofoxConfigFromEnv();
  if (!config) return null;
  return new CamofoxClient(
    config,
    `discovery:${runId}`,
    { maxPages, maxInteractions, deps },
  );
}
