/**
 * Company deep crawl — the browser's research pass over ONE company's site.
 *
 * HTTP-first philosophy: the crawl is only invoked when the plain-HTTP pass
 * is insufficient (JS-heavy site, blocked shell, or the run still needs more
 * evidence for a company). It then browses the company's OWN domain with a
 * priority frontier:
 *
 *   Homepage → Ausbildung / specific occupation (100)
 *            → Karriere (95) → Bewerbung (90) → Jobs/Stellen (85)
 *            → Kontakt / Impressum (80) → other (20)
 *
 * with:
 *  - SESSION REUSE: one tab for the whole company (career → ausbildung →
 *    bewerbung), not a new context per page;
 *  - INTERACTIONS: "Mehr anzeigen" / "Weitere Stellen" / "Load more" /
 *    "Nächste Seite" are clicked when the listing is lazy (bounded per page
 *    and per company);
 *  - BOUNDS: maxDepth, maxPages per company, run-level browser budget,
 *    never an infinite crawl;
 *  - EVIDENCE: every page's rendered content feeds the EXISTING extractors —
 *    JobPosting JSON-LD (offers), literal email acceptance (no guessing),
 *    site-year evidence (beginn, never guessed), application-page detection.
 *  - HONESTY: 404 = page_not_found (no breaker); a rendered page that still
 *    shows a captcha is a block (reason recorded, next source); a browser
 *    failure aborts the crawl and the pipeline continues without it.
 *
 * The crawl NEVER leaves the company's own domain (same-origin frontier) and
 * every URL is SSRF-checked by the client before the browser loads it.
 */
import "server-only";

import type { AcceptedEmail } from "../accept";
import { acceptEmailsFromContent } from "../accept";
import { classifyResponse } from "../classify";
import type { SiteYearEvidence } from "../emails";
import { siteYearEvidence } from "../emails";
import type { NormalizedOffer } from "../adapter";
import { parseListingPage } from "../listing";
import type { RenderedPage } from "./client";
import type { CamofoxClient } from "./client";

// ---------------------------------------------------------------------------
// Frontier
// ---------------------------------------------------------------------------

export type FrontierStatus =
  | "pending"
  | "done"
  | "not_found"
  | "blocked"
  | "skipped";

/** One crawl frontier entry (persisted in the research memory for /continue). */
export interface FrontierEntry {
  url: string;
  /** Depth from the homepage (0 = homepage). */
  depth: number;
  /** Priority (see {@link priorityOf}); higher is crawled first. */
  priority: number;
  status: FrontierStatus;
  /** Why the entry ended in not_found/blocked/skipped (audit). */
  reason?: string;
  /** The path kind for the source attribution (impressum, karriere, …). */
  kind?: string;
}

/** The research frontier: pending URLs ranked by value. */
export class CrawlFrontier {
  private readonly entries = new Map<string, FrontierEntry>();

  constructor(private readonly maxDepth: number) {}

  /** Add a URL when it is worth crawling (bounded, de-duplicated). */
  add(url: string, depth: number, kind: string): boolean {
    if (depth > this.maxDepth) return false;
    const key = normalizeCrawlUrl(url);
    if (!key || this.entries.has(key)) return false;
    this.entries.set(key, {
      url,
      depth,
      kind,
      priority: priorityOf(kind, url),
      status: "pending",
    });
    return true;
  }

  /** Restore a persisted frontier (a /continue resumes where it stopped). */
  restore(entries: FrontierEntry[]): void {
    for (const entry of entries) {
      if (!entry || typeof entry.url !== "string") continue;
      const key = normalizeCrawlUrl(entry.url);
      if (!key || this.entries.has(key)) continue;
      this.entries.set(key, {
        url: entry.url,
        depth:
          typeof entry.depth === "number" && entry.depth >= 0
            ? Math.floor(entry.depth)
            : 0,
        kind: typeof entry.kind === "string" ? entry.kind : "other",
        priority:
          typeof entry.priority === "number"
            ? entry.priority
            : priorityOf(typeof entry.kind === "string" ? entry.kind : "other", entry.url),
        status: entry.status === "pending" ? "pending" : "skipped",
        reason: entry.status === "pending" ? undefined : "restored",
      });
    }
  }

  /** Mark a key visited (a URL already crawled in a previous batch). */
  markVisited(url: string, status: FrontierStatus, reason?: string): void {
    const key = normalizeCrawlUrl(url);
    if (!key) return;
    const existing = this.entries.get(key);
    if (existing && existing.status === "pending") {
      existing.status = status;
      if (reason) existing.reason = reason;
    }
  }

  /** The highest-priority pending entry (ties: shallower depth, then FIFO). */
  next(): FrontierEntry | null {
    let best: FrontierEntry | null = null;
    for (const entry of this.entries.values()) {
      if (entry.status !== "pending") continue;
      if (
        !best ||
        entry.priority > best.priority ||
        (entry.priority === best.priority && entry.depth < best.depth)
      ) {
        best = entry;
      }
    }
    return best;
  }

  setOutcome(url: string, status: FrontierStatus, reason?: string): void {
    const key = normalizeCrawlUrl(url);
    const entry = this.entries.get(key);
    if (!entry) return;
    entry.status = status;
    if (reason) entry.reason = reason;
  }

  get pendingCount(): number {
    let count = 0;
    for (const entry of this.entries.values()) {
      if (entry.status === "pending") count += 1;
    }
    return count;
  }

  /** Every entry (for the checkpoint snapshot). */
  all(): FrontierEntry[] {
    return [...this.entries.values()];
  }

  size(): number {
    return this.entries.size;
  }
}

/**
 * The frontier's priority scale (research value of a page kind). A page
 * whose path contains the run's occupation outranks a generic career page:
 * the SPECIFIC occupation page is the most likely to carry the documented
 * Ausbildungsplatz + beginn + application.
 */
export function priorityOf(kind: string, url: string): number {
  const path = urlPath(url).toLowerCase();
  const text = `${kind} ${path}`;
  if (/ausbildung/.test(text)) return 100;
  if (/karriere/.test(text)) return 95;
  if (/bewerb/.test(text)) return 90;
  if (/jobs?|stellen|jobsuche|angebote/.test(text)) return 85;
  if (/kontakt/.test(text)) return 80;
  if (/impressum/.test(text)) return 80;
  if (/^(ausbildungsplaetze|azubi|lehrstelle)/.test(text)) return 90;
  if (kind === "homepage" || path === "" || path === "/") return 70;
  return 20;
}

/** Classify a path into the site-page kinds the email pass already knows. */
export function sitePageKindOf(url: string): string {
  const path = urlPath(url).toLowerCase();
  if (/impressum/.test(path)) return "impressum";
  if (/kontakt|referat/.test(path)) return "kontakt";
  if (/karriere|careers?/.test(path)) return "karriere";
  if (/jobs?|stellen|jobsuche|offene-stellen/.test(path)) return "jobs";
  if (/ausbildung|azubi|lehrstelle/.test(path)) return "ausbildung";
  if (/^\/$/.test(path) || path === "") return "homepage";
  return "other";
}

function urlPath(url: string): string {
  try {
    return new URL(url).pathname.replace(/\/+$/, "");
  } catch {
    return url;
  }
}

/** Canonical crawl key: host (www-stripped, lowercased) + path + query. */
export function normalizeCrawlUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return "";
    parsed.hash = "";
    const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
    const path = parsed.pathname.replace(/\/+$/, "") || "/";
    return `${host}${path}${parsed.search}`.toLowerCase();
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// Crawl
// ---------------------------------------------------------------------------

export interface CrawlLimits {
  /** Link depth from the homepage (0 = homepage only). */
  maxDepth: number;
  /** Pages this company may consume (incl. the homepage). */
  maxPages: number;
  /** In-page interactions this company may consume. */
  maxInteractions: number;
  /** How much visible text to keep per page (evidence budget). */
  textBudget: number;
}

export interface CrawlCallbacks {
  /** A page was rendered + extracted (live progress hook). */
  onPage?: (page: CrawledPage) => void;
  /** New URLs entered the frontier (research discovery hook). */
  onNewUrls?: (urls: string[]) => void;
  /** An in-page interaction happened (click / scroll). */
  onInteraction?: (label: string) => void;
  /** The live "current strategy" line (the company being crawled). */
  onLiveState?: (text: string) => void;
  /** Stop probe (runtime budget / cancellation / target reached). */
  shouldStop?: () => boolean;
}

export interface CrawledPage {
  url: string;
  finalUrl: string;
  status: number;
  title: string | null;
  /** Rendered visible text, capped by the text budget. */
  text: string;
  html: string;
  links: string[];
  depth: number;
  priority: number;
  kind: string;
  /** The interactions spent on this page. */
  interactions: number;
}

export interface CrawlInput {
  /** The company's verified official site. */
  websiteUrl: string;
  companyName: string;
  /** The official host (www-stripped) — the same-origin boundary. */
  companyDomain: string;
  /** The run's role (specific-occupation pages get top priority). */
  role: string | null;
  field: string | null;
  goal: "ausbildung" | "arbeit";
  limits: CrawlLimits;
  callbacks?: CrawlCallbacks;
  /** A frontier restored from the run's checkpoint (continue). */
  frontier?: FrontierEntry[];
  /** URLs already visited before the checkpoint (never re-fetched). */
  visitedUrls?: Iterable<string>;
}

export interface CrawlResult {
  pages: CrawledPage[];
  /** JobPosting offers extracted from the rendered pages. */
  offers: NormalizedOffer[];
  /** Literally published emails found on the company's own pages. */
  emails: AcceptedEmail[];
  /** The company's documented start-year evidence (never a guess). */
  siteYear: SiteYearEvidence;
  /** A verified application page on the company's own domain, or null. */
  applicationUrl: string | null;
  pagesFetched: number;
  interactionsUsed: number;
  /** The browser failed / a hard block ended the crawl. */
  blocked: boolean;
  blockedReason: string | null;
  /** The frontier still pending at stop (the /continue checkpoint). */
  pendingFrontier: FrontierEntry[];
}

/** Lazy-loading markers (rendered text) that justify an interaction. */
const LOAD_MORE_RE =
  /mehr anzeigen|weitere stellen|weitere angebote|weitere (ausbildungs)?plaetze|load more|n[aä]chste seite|nächste seite|show more|jobs anzeigen|alle stellen anzeigen|weiter(e)? (anzeigen|stellen)/i;
/** The clickable labels tried, in order (accent-insensitive in the client). */
const LOAD_MORE_LABELS: readonly string[] = [
  "Mehr anzeigen",
  "Weitere Stellen",
  "Weitere Angebote",
  "Weitere Ausbildungsplätze",
  "Nächste Seite",
  "Load more",
  "Show more",
  "Jobs anzeigen",
];
/** Two interaction attempts per page — a click that reveals nothing new is
 *  not worth a third (bounded, never grinding). */
const MAX_INTERACTIONS_PER_PAGE = 2;

const SOURCE_ID = "company-websites";
const SOURCE_NAME = "Company websites (browser)";

/**
 * Crawl ONE company's site with the browser. Fails soft: any hard failure
 * returns `{ blocked: true, … }` with what was already extracted — the
 * pipeline keeps the evidence and moves on.
 */
export async function crawlCompanySite(
  camofox: CamofoxClient,
  input: CrawlInput,
): Promise<CrawlResult> {
  const { limits } = input;
  const callbacks: CrawlCallbacks = input.callbacks ?? {};
  const frontier = new CrawlFrontier(limits.maxDepth);
  if (input.frontier) frontier.restore(input.frontier);
  const visited = new Set<string>();
  for (const url of input.visitedUrls ?? []) {
    const key = normalizeCrawlUrl(url);
    if (key) visited.add(key);
  }

  const companyHost = input.companyDomain.toLowerCase().replace(/^www\./, "");
  const result: CrawlResult = {
    pages: [],
    offers: [],
    emails: [],
    siteYear: { year: null, url: null, conflict: false },
    applicationUrl: null,
    pagesFetched: 0,
    interactionsUsed: 0,
    blocked: false,
    blockedReason: null,
    pendingFrontier: [],
  };

  const homepage = normalizeHomepage(input.websiteUrl);
  if (!homepage) {
    result.blocked = true;
    result.blockedReason = "unsafe_start_url";
    return result;
  }
  frontier.add(homepage, 0, "homepage");

  /** The one tab this company's crawl reuses (session reuse). */
  let tabId: string | null = null;
  /** The navigation facts of the CURRENTLY loaded page. */
  let nav: { finalUrl: string; status: number; notFound: boolean } | null = null;
  try {
    for (;;) {
      if (
        callbacks.shouldStop?.() ||
        result.pagesFetched >= limits.maxPages ||
        !camofox.hasPageBudget()
      ) {
        break;
      }
      const entry = frontier.next();
      if (!entry) break;

      const key = normalizeCrawlUrl(entry.url);
      if (visited.has(key)) {
        frontier.setOutcome(entry.url, "skipped", "already_visited");
        continue;
      }
      // Same-origin boundary: the crawl stays on the company's own domain.
      if (!isSameCompanyHost(entry.url, companyHost)) {
        frontier.setOutcome(entry.url, "skipped", "cross_domain");
        continue;
      }

      // ---- open / reuse the run's single crawl tab (session reuse) -------
      if (!tabId) {
        const opened = await camofox.openTab(entry.url);
        if (!opened) {
          result.blocked = true;
          result.blockedReason = camofox.unavailableReason ?? "browser_error";
          break;
        }
        tabId = opened.tabId;
        nav = { finalUrl: entry.url, status: opened.status, notFound: opened.notFound };
      } else {
        const next = await camofox.navigate(tabId, entry.url);
        if (!next) {
          result.blocked = true;
          result.blockedReason = camofox.unavailableReason ?? "browser_error";
          break;
        }
        nav = next;
      }

       // ---- render + extract ------------------------------------------------
       const content = await camofox.currentTabContent(tabId, entry.url, nav);
       if (!content) {
         result.blocked = true;
         result.blockedReason = camofox.unavailableReason ?? "browser_error";
         break;
       }
       // A 404 is a missing page, NOT a JS block or a browser failure: record
       // it honestly and move on (the circuit breaker stays shut). On v2.4.8
       // the navigate response carries no httpStatus, so the status comes
       // from the page's `performance` entry (see the client).
       if (content.notFound) {
         visited.add(key);
         frontier.setOutcome(entry.url, "not_found", "http_404");
         continue;
       }
      const outcome = await finishPage(
        camofox,
        tabId,
        content,
        entry,
        input,
        limits,
        callbacks,
        visited,
        frontier,
        result,
      );
      if (outcome.kind === "blocked") {
        // A rendered page that still shows a challenge: record the REAL
        // reason (captcha / bot_challenge) and continue with the next URL —
        // one challenged page never ends the whole crawl.
        visited.add(key);
        frontier.setOutcome(entry.url, "blocked", outcome.reason);
        if (entry.kind === "homepage") {
          result.blocked = true;
          result.blockedReason = outcome.reason;
          break;
        }
        continue;
      }
      if (outcome.kind === "empty") {
        visited.add(key);
        frontier.setOutcome(entry.url, "skipped", "empty_page");
        continue;
      }

      visited.add(key);
      result.pagesFetched += 1;
      frontier.setOutcome(entry.url, "done");
      result.pages.push(outcome.page);
      callbacks.onPage?.(outcome.page);
      callbacks.onLiveState?.(
        `Browser-Crawl ${input.companyName} · ${outcome.page.url}`,
      );
    }
  } finally {
    if (tabId) await camofox.closeTab(tabId);
  }

  result.pendingFrontier = frontier
    .all()
    .filter((entry) => entry.status === "pending");
  // Site-year evidence over every rendered page (the same honest matcher the
  // HTTP pass uses — the crawl's pages are documented sources, too).
  result.siteYear = siteYearEvidence(
    result.pages.map((page) => ({ url: page.url, text: page.text })),
  );
  return result;
}

/** The honest outcome of extracting one rendered page. */
type PageOutcome =
  | { kind: "page"; page: CrawledPage }
  | { kind: "blocked"; reason: string }
  | { kind: "empty" };

/**
 * Extract one rendered page into offers + emails + frontier links.
 */
async function finishPage(
  camofox: CamofoxClient,
  tabId: string,
  content: RenderedPage,
  entry: FrontierEntry,
  input: CrawlInput,
  limits: CrawlLimits,
  callbacks: CrawlCallbacks,
  visited: Set<string>,
  frontier: CrawlFrontier,
  result: CrawlResult,
): Promise<PageOutcome> {
  // A rendered page is re-checked by the SAME classifier: content that still
  // looks like a captcha / bot wall after rendering is a block, not a page.
  const recheck = classifyResponse({
    url: content.finalUrl,
    status: content.status || 200,
    headers: {},
    contentType: "text/html",
    bodyHead: content.html.slice(0, 4_000),
    visibleTextLength: content.text.length,
  });
  if (recheck.blocked) {
    return { kind: "blocked", reason: recheck.reason };
  }
  if (content.text.length < 80) {
    // An empty rendered shell: honest, not a block (the breaker stays shut).
    return { kind: "empty" };
  }

  let interactions = 0;
  let links = content.links;
  let text = content.text;
  let html = content.html;

  // ---- lazy content: one bounded interaction attempt (Load more / next) --
  if (
    LOAD_MORE_RE.test(text) &&
    result.interactionsUsed < limits.maxInteractions &&
    camofox.hasInteractionBudget()
  ) {
    for (let attempt = 0; attempt < MAX_INTERACTIONS_PER_PAGE; attempt += 1) {
      if (result.interactionsUsed >= limits.maxInteractions) break;
      const before = links.length;
      const clicked = await camofox.clickLabel(
        tabId,
        LOAD_MORE_LABELS,
        1200,
      );
      if (!clicked) break;
      interactions += 1;
      result.interactionsUsed += 1;
      callbacks.onInteraction?.("load-more");
      const after = await camofox.links(tabId);
      if (after.length > 0) links = after;
      const refreshed = await camofox.currentTabContent(
        tabId,
        entry.url,
        { finalUrl: content.finalUrl, status: content.status, notFound: false },
      );
      if (refreshed) {
        text = refreshed.text;
        html = refreshed.html;
      }
      if (links.length <= before) break; // nothing new revealed — stop
    }
  }

  const page: CrawledPage = {
    url: entry.url,
    finalUrl: content.finalUrl,
    status: content.status,
    title: content.title,
    text: text.slice(0, limits.textBudget),
    html,
    links,
    depth: entry.depth,
    priority: entry.priority,
    kind: entry.kind ?? "other",
    interactions,
  };

  // ---- offers: the SAME JobPosting parser the HTTP adapters use ----------
  const offers = parseListingPage({
    html,
    pageUrl: page.finalUrl,
    offerSource: SOURCE_NAME,
    sourceId: SOURCE_ID,
    field: input.field,
    goal: input.goal,
  });
  result.offers.push(...offers);

  // ---- emails: literal-presence acceptance on the company's OWN pages ----
  const sourceType =
    entry.kind === "impressum"
      ? "official_site_impressum"
      : entry.kind === "kontakt"
        ? "official_site_contact"
        : entry.kind === "karriere"
          ? "official_site_career"
          : entry.kind === "jobs"
            ? "official_site_jobs"
            : entry.kind === "ausbildung"
              ? "official_site_ausbildung"
              : "official_site_other";
  const emails = acceptEmailsFromContent({
    text,
    sourceUrl: page.finalUrl,
    sourceType,
    companyName: input.companyName,
    companyDomain: input.companyDomain,
  });
  result.emails.push(...emails);

  // ---- application page (verified: a real page on the official domain) --
  if (
    !result.applicationUrl &&
    /bewerb|application/i.test(page.finalUrl)
  ) {
    result.applicationUrl = page.finalUrl;
  }

  // ---- the frontier grows: same-origin links, ranked by page kind --------
  const newUrls: string[] = [];
  for (const link of links) {
    if (!isSameCompanyHost(link, input.companyDomain)) continue;
    const key = normalizeCrawlUrl(link);
    if (!key || visited.has(key)) continue;
    const kind = sitePageKindOf(link);
    // A link containing the run's occupation is the highest-value target.
    const effectiveKind =
      input.role && urlPath(link).toLowerCase().includes(input.role.toLowerCase().replace(/\s+/g, "-"))
        ? "ausbildung"
        : kind;
    if (frontier.add(link, entry.depth + 1, effectiveKind)) {
      newUrls.push(link);
    }
  }
  if (newUrls.length > 0) callbacks.onNewUrls?.(newUrls);

  return { kind: "page", page };
}

function isSameCompanyHost(url: string, host: string): boolean {
  try {
    return new URL(url).hostname
      .toLowerCase()
      .replace(/^www\./, "") === host;
  } catch {
    return false;
  }
}

function normalizeHomepage(websiteUrl: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(websiteUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  parsed.pathname = "/";
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}
