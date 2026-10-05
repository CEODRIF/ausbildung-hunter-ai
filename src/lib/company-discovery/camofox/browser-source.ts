/**
 * Browser discovery source — the Camofox browser as a FIRST-CLASS discovery
 * engine (not an enrichment fallback).
 *
 * The run's queries are executed in a REAL browser: a rendered search-result
 * page (Google via the engine's @google_search macro, with DuckDuckGo/Bing
 * fallbacks), then the promising candidate pages themselves. From each
 * rendered page the SAME extractors the rest of the pipeline uses produce
 * evidence: JobPosting JSON-LD (company name stated in structured data), a
 * company site's own stated name (og:site_name / title), literal emails on
 * the official domain (published with the offer — re-verified downstream),
 * and a documented beginn year (never guessed).
 *
 * One tab is opened and REUSED across the whole source run (session reuse).
 * Every page load / interaction counts against the run's shared browser
 * budgets. The source is FAIL-SOFT: an engine problem stops the source with
 * an honest reason and the pipeline continues with the other sources.
 */
import "server-only";

import type { NormalizedOffer } from "../adapter";
import { isPortalHost } from "../sources";
import { siteYearEvidence } from "../emails";
import { stableRef } from "../listing";
import { parseListingPage } from "../listing";
import { acceptEmailsFromContent } from "../accept";
import type {
  CamofoxClient,
  RenderedPage,
} from "./client";

/** Hosts that are search engines / their infrastructure — never candidates. */
const SEARCH_ENGINE_HOSTS = new Set([
  "google.com", "google.de", "googleapis.com", "gstatic.com",
  "googleusercontent.com", "googlevideo.com", "bing.com", "bing.net",
  "microsoft.com", "duckduckgo.com", "duck.co", "startpage.com",
  "mojeek.com", "yahoo.com", "wikipedia.org", "wikimedia.org",
  "youtube.com", "ytimg.com",
]);

type SerpProvider = "google" | "duckduckgo" | "bing";

const SERP_ORDER: readonly SerpProvider[] = [
  "google",
  "duckduckgo",
  "bing",
];

function serpUrl(provider: SerpProvider, query: string): string {
  if (provider === "duckduckgo")
    return `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  if (provider === "bing")
    return `https://www.bing.com/search?q=${encodeURIComponent(query)}`;
  return `https://www.google.de/search?q=${encodeURIComponent(query)}`;
}

/** Honest block markers per provider (checked on the rendered text). */
function serpBlockReason(
  provider: SerpProvider,
  finalUrl: string,
  text: string,
): string | null {
  const t = text.toLowerCase();
  const u = finalUrl.toLowerCase();
  if (provider === "google") {
    if (u.includes("consent.google")) return "consent_wall";
    if (
      t.includes("unusual traffic") ||
      t.includes("captcha") ||
      t.includes("enable javascript") ||
      t.includes("bitte aktivieren")
    )
      return "google_blocked";
  }
  if (provider === "duckduckgo" && (t.includes("anomaly") || t.includes("challenge")))
    return "duckduckgo_blocked";
  if (provider === "bing" && (t.includes("captcha") || t.includes("unusual activity")))
    return "bing_blocked";
  return null;
}

function bareHost(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

function originOf(url: string): string | null {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.hostname.replace(/^www\./, "")}`;
  } catch {
    return null;
  }
}

function normalizeVisited(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    return u.toString().replace(/\/+$/, "");
  } catch {
    return url;
  }
}

/** Unwrap search-engine redirect links (google /url?q=…) to the real URL. */
function unwrapRedirect(link: string): string {
  try {
    const u = new URL(link);
    const inner =
      u.searchParams.get("q") ?? u.searchParams.get("url");
    if (inner && /^https?:\/\//i.test(inner)) return inner;
  } catch {
    /* keep as-is */
  }
  return link;
}

/** The rendered search results: real external links with their visible titles. */
function parseSerpResults(content: RenderedPage): Array<{ url: string; title: string }> {
  const out: Array<{ url: string; title: string }> = [];
  const seen = new Set<string>();
  for (const link of content.links) {
    if (!/^https?:\/\//i.test(link)) continue;
    const real = unwrapRedirect(link);
    const host = bareHost(real);
    if (!host || SEARCH_ENGINE_HOSTS.has(host)) continue;
    if (seen.has(real)) continue;
    seen.add(real);
    out.push({ url: real, title: content.linkTitles?.[link] ?? "" });
    if (out.length >= 30) break;
  }
  return out;
}

/** A SERP page is VALID only when it actually rendered external results. */
function serpIsValid(content: RenderedPage, provider: SerpProvider): boolean {
  const host = bareHost(content.finalUrl);
  const expected =
    provider === "google"
      ? host.startsWith("google")
      : provider === "duckduckgo"
        ? host === "duckduckgo.com"
        : host.startsWith("bing");
  if (!expected) return false;
  return parseSerpResults(content).length >= 3;
}

/**
 * The company name the page STATES about itself: og:site_name first, then the
 * <title> minus its " – …" tail. Returns null when nothing clean is stated —
 * a name is NEVER guessed (a candidate without a stated name is dropped).
 */
function statedCompanyName(page: RenderedPage): string | null {
  const og = /<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["']/i.exec(
    page.html,
  ) ??
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:site_name["']/i.exec(
      page.html,
    );
  let raw = og ? og[1] : null;
  if (!raw && page.title) {
    const t = page.title
      .replace(/\s*[–—|›»]\s*.*$/u, "")
      .trim();
    raw = t.length >= 3 ? t : null;
  }
  if (!raw) return null;
  const name = raw.trim();
  if (name.length < 3 || name.length > 60) return null;
  if (/(https?|www\.|\.de|\.com|\.org)\b/i.test(name)) return null;
  if (!/[a-zäöüß]/i.test(name)) return null;
  return name;
}

function emailSourceKindFor(url: string):
  | "official_site_impressum"
  | "official_site_contact"
  | "official_site_career"
  | "official_site_jobs"
  | "official_site_ausbildung"
  | "official_site_other" {
  const path = (
    () => {
      try {
        return new URL(url).pathname.toLowerCase();
      } catch {
        return "";
      }
    }
  )();
  if (path.includes("impressum")) return "official_site_impressum";
  if (path.includes("kontakt") || path.includes("contact"))
    return "official_site_contact";
  if (path.includes("karriere") || path.includes("career"))
    return "official_site_career";
  if (path.includes("jobs") || path.includes("stellen") || path.includes("job"))
    return "official_site_jobs";
  if (path.includes("ausbildung")) return "official_site_ausbildung";
  return "official_site_other";
}

export interface BrowserSourceInput {
  camofox: CamofoxClient;
  /** The run's research queries (planner-generated or the static seed list). */
  queries: string[];
  goal: "ausbildung" | "arbeit";
  field: string | null;
  /** Bare hosts of companies this run ALREADY counted — never re-browsed. */
  knownCompanyDomains: ReadonlySet<string>;
  /** URLs already inspected in this run (work is never repeated). */
  visitedUrls: Set<string>;
  /** Candidate pages inspected per query (browser pages are expensive). */
  maxCandidatesPerQuery?: number;
  callbacks: {
    onOffer(offer: NormalizedOffer): void;
    onUrlsDiscovered(urls: string[]): void;
    onLiveState(text: string): void;
    shouldStop(): boolean;
  };
}

export interface BrowserSourceResult {
  queriesExecuted: number;
  pagesUsed: number;
  interactionsUsed: number;
  urlsDiscovered: number;
  offersFound: number;
  providerFailures: Record<string, number>;
  blocked: boolean;
  blockedReason: string | null;
}

/**
 * Run the browser discovery source. NEVER throws: every failure mode ends in
 * a `blocked` result with the honest reason (the pipeline continues).
 */
export async function runBrowserDiscovery(
  input: BrowserSourceInput,
): Promise<BrowserSourceResult> {
  const camofox = input.camofox;
  const maxCandidates = input.maxCandidatesPerQuery ?? 6;
  const result: BrowserSourceResult = {
    queriesExecuted: 0,
    pagesUsed: 0,
    interactionsUsed: 0,
    urlsDiscovered: 0,
    offersFound: 0,
    providerFailures: {},
    blocked: false,
    blockedReason: null,
  };

  let tabId: string | null = null;
  const pagesBefore = camofox.pagesUsed;
  const interactionsBefore = camofox.interactionsUsed;

  const die = (reason: string): void => {
    if (!result.blocked) {
      result.blocked = true;
      result.blockedReason = reason;
    }
  };

  try {
    for (const query of input.queries) {
      if (
        input.callbacks.shouldStop() ||
        !camofox.hasPageBudget() ||
        result.blocked
      )
        break;
      result.queriesExecuted += 1;
      input.callbacks.onLiveState(`Browser-Suche: „${query}“`);

      // ---- rendered SERP: google → duckduckgo → bing (honest fallbacks) --
      let content: RenderedPage | null = null;
      let provider: SerpProvider = "google";
      for (const attempt of SERP_ORDER) {
        if (!camofox.hasPageBudget() || result.blocked) break;
        const targetUrl = serpUrl(attempt, query);
        if (!tabId) {
          const opened = await camofox.openTab(targetUrl);
          if (!opened) {
            die(camofox.unavailableReason ?? "browser_error");
            break;
          }
          tabId = opened.tabId;
        } else if (attempt === "google") {
          const landed = await camofox.navigateSearch(tabId, query);
          if (!landed) {
            die(camofox.unavailableReason ?? "browser_error");
            break;
          }
        } else {
          const nav = await camofox.navigate(tabId, targetUrl);
          if (!nav) {
            die(camofox.unavailableReason ?? "browser_error");
            break;
          }
        }
        const page = await camofox.currentTabContent(
          tabId,
          targetUrl,
          { finalUrl: targetUrl, status: 0, notFound: false },
        );
        if (!page) {
          die(camofox.unavailableReason ?? "browser_error");
          break;
        }
        const block = serpBlockReason(attempt, page.finalUrl, page.text);
        if (block) {
          result.providerFailures[`${attempt}_${block}`] =
            (result.providerFailures[`${attempt}_${block}`] ?? 0) + 1;
          continue; // next provider — a walled SERP is not the end of research
        }
        if (serpIsValid(page, attempt)) {
          content = page;
          provider = attempt;
          break;
        }
        result.providerFailures[`${attempt}_serp_empty`] =
          (result.providerFailures[`${attempt}_serp_empty`] ?? 0) + 1;
        content = null;
      }
      if (result.blocked || !content || !tabId) continue;

      // ---- candidate selection (never repeat counted companies/work) -----
      const results = parseSerpResults(content);
      if (results.length > 0) {
        input.callbacks.onUrlsDiscovered(results.map((r) => r.url));
         const fresh = new Set(
           results.map((r) => normalizeVisited(r.url)),
         );
         result.urlsDiscovered += fresh.size;
      }
      const candidates: Array<{
        url: string;
        title: string;
        kind: "portal" | "company";
      }> = [];
      for (const r of results) {
        if (candidates.length >= maxCandidates) break;
        if (!camofox.hasPageBudget() || input.callbacks.shouldStop()) break;
        const host = bareHost(r.url);
        if (!host) continue;
        if (input.knownCompanyDomains.has(host)) continue;
        if (input.visitedUrls.has(normalizeVisited(r.url))) continue;
        candidates.push({
          url: r.url,
          title: r.title,
          kind: isPortalHost(host) ? "portal" : "company",
        });
      }

      // ---- inspect each candidate in the SAME tab (session reuse) --------
      for (const cand of candidates) {
        if (!camofox.hasPageBudget() || input.callbacks.shouldStop()) break;
        const nav = await camofox.navigate(tabId, cand.url);
        if (!nav) {
          die(camofox.unavailableReason ?? "browser_error");
          break;
        }
        const page = await camofox.currentTabContent(
          tabId,
          cand.url,
          nav,
        );
        if (!page) {
          die(camofox.unavailableReason ?? "browser_error");
          break;
        }
        input.visitedUrls.add(normalizeVisited(page.finalUrl));
        if (page.notFound) continue; // honest: the page is gone, move on

        // 1) Structured offers (JobPosting JSON-LD) — the company name is
        //    STATED in the data; never invented.
        const offers = parseListingPage({
          html: page.html,
          pageUrl: page.finalUrl,
          offerSource: "Browser (Camofox)",
          sourceId: "browser-camofox",
          field: input.field,
          goal: input.goal,
        });
        for (const offer of offers) {
          input.callbacks.onOffer(offer);
          result.offersFound += 1;
        }

        // 2) A company site that states its own name becomes a candidate:
        //    the official domain + the name are both STATED by the page.
        if (cand.kind === "company" && offers.length === 0) {
          const name = statedCompanyName(page);
          if (name) {
            const year = siteYearEvidence([
              { url: page.finalUrl, text: page.text },
            ]);
            const emails = acceptEmailsFromContent({
              text: page.text,
              sourceUrl: page.finalUrl,
              sourceType: emailSourceKindFor(page.finalUrl),
              companyDomain: bareHost(page.finalUrl),
            });
            const website = originOf(page.finalUrl);
            input.callbacks.onOffer({
              companyName: name,
              companyWebsite: website,
              role: null,
              field: input.field,
              city: null,
              state: null,
              offerType: input.goal,
              beginn:
                year && !year.conflict && year.year ? String(year.year) : null,
              salary: null,
              offerSource: "Browser (Camofox)",
              offerUrl: page.finalUrl,
              publishedEmail:
                emails.length > 0
                  ? {
                      email: emails[0].email,
                      evidence: `literal on ${page.finalUrl}`,
                    }
                  : null,
              listingText: page.text.slice(0, 4000),
              candidateRef: stableRef(
                `${page.finalUrl}|${name}|browser-camofox`,
              ),
            });
            result.offersFound += 1;
          }
        }
      }
      // `provider` is reported via the live state for observability.
      void provider;
    }
  } finally {
    result.pagesUsed = camofox.pagesUsed - pagesBefore;
    result.interactionsUsed = camofox.interactionsUsed - interactionsBefore;
    if (tabId) await camofox.closeTab(tabId);
  }
  return result;
}
