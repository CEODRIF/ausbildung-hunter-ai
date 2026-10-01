import "server-only";

import { ConcurrencyLimiter, retryWithBackoff } from "@/lib/concurrency";
import {
  fetchPublicPage,
  type FetchedPage,
  type PageFetchFailure,
  type RobotsPolicy,
} from "@/lib/web-search/fetch-page";
import { type WebSearchClient } from "@/lib/web-search";
import { isAggregatorHost, normalizeIdentity } from "../web-discovery";
import { classifyPageUrl, type PageKind } from "./text-extract";

/**
 * Company-site layer of the enrichment pipeline (AI Search 2.0):
 *
 *   COMPANY WEBSITE DISCOVERY  →  CAREER/AUSBILDUNG PAGES  →  (contact
 *   discovery + extraction happen in index.ts on the fetched text)
 *
 * Every fetch goes through the SAME guarded fetcher as discovery:
 * robots.txt respected, SSRF-checked, anti-bot/login/CAPTCHA pages are
 * skipped (never bypassed), timeouts enforced, body size capped.
 * Transient failures (timeout / network) retry with exponential backoff —
 * deliberate blocks (429, robots, anti-bot) are respected immediately.
 */

/** Public paths worth visiting on a company site, in fetch order.
 *  /impressum comes early: it is legally mandated in Germany and is the
 *  most reliable public source of a real contact email. */
const SITE_PAGE_PATHS = [
  "/impressum",
  "/kontakt",
  "/karriere",
  "/ausbildung",
  "/jobs",
  "/stellenangebote",
  "/unternehmen",
] as const;

/** Maximum page fetches per company per run (budget, never unbounded). */
export const MAX_PAGES_PER_COMPANY = 4;
/** Maximum page text passed to extraction (memory bound). */
const MAX_PAGE_TEXT_CHARS = 20_000;

/** Only transient failures are worth a retry. */
const RETRYABLE_FAILURES: ReadonlySet<PageFetchFailure> = new Set([
  "timeout",
  "fetch_failed",
]);

export type SiteFetchResult =
  | { ok: true; page: FetchedPage }
  | { ok: false; reason: PageFetchFailure };

export interface FetchedSitePage {
  url: string;
  kind: PageKind;
  title: string | null;
  siteName: string | null;
  /** Truncated, extraction-ready text (real page content only). */
  text: string;
}

/**
 * Fetch one page through the guarded fetcher with capped exponential
 * backoff. Blocked/robots/rate-limited outcomes are returned immediately
 * (respected, not retried).
 */
export async function fetchSitePage(
  url: string,
  robotsCache: Map<string, RobotsPolicy>,
  limiter: ConcurrencyLimiter,
  options: { maxAttempts?: number } = {},
): Promise<SiteFetchResult> {
  const maxAttempts = options.maxAttempts ?? 3;
  const result = await retryWithBackoff(
    async () => {
      const fetched = await limiter.run(() =>
        fetchPublicPage(url, robotsCache),
      );
      return fetched.ok
        ? ({ ok: true, page: fetched.page } satisfies SiteFetchResult)
        : ({ ok: false, reason: fetched.reason } satisfies SiteFetchResult);
    },
    {
      shouldRetry: (value) =>
        !value.ok && RETRYABLE_FAILURES.has(value.reason),
      maxAttempts,
      baseDelayMs: 500, // 500 ms, 1 s
    },
  );
  return result;
}

function toSitePage(url: string, page: FetchedPage): FetchedSitePage {
  return {
    url: page.finalUrl || page.url,
    kind: classifyPageUrl(page.finalUrl || page.url),
    title: page.title,
    siteName: page.siteName,
    text: page.text.slice(0, MAX_PAGE_TEXT_CHARS),
  };
}

/**
 * Visit the company's public pages (level-2 contact discovery): the site
 * root plus the first available of the standard paths. Stops early when an
 * impressum/kontakt page already yielded text — more pages would only cost
 * budget. Fetch order is fixed; every skipped/blocked page is counted,
 * never faked.
 */
export async function fetchCompanyPages(
  websiteUrl: string,
  robotsCache: Map<string, RobotsPolicy>,
  limiter: ConcurrencyLimiter,
): Promise<{ pages: FetchedSitePage[]; failures: number }> {
  let origin: string;
  try {
    origin = new URL(websiteUrl).origin;
  } catch {
    return { pages: [], failures: 1 };
  }
  const wanted: Array<{ url: string; kind: PageKind }> = [
    { url: origin, kind: "home" },
  ];
  for (const path of SITE_PAGE_PATHS) {
    if (wanted.length >= MAX_PAGES_PER_COMPANY) break;
    wanted.push({ url: `${origin}${path}`, kind: classifyPageUrl(`${origin}${path}`) });
  }

  const pages: FetchedSitePage[] = [];
  let failures = 0;
  for (const target of wanted) {
    const result = await fetchSitePage(target.url, robotsCache, limiter);
    if (!result.ok) {
      failures += 1;
      // A blocked /impressum or /kontakt is not a reason to abort the
      // whole company — keep trying the remaining pages.
      continue;
    }
    pages.push(toSitePage(target.url, result.page));
    // Early stop: the two most authoritative contact pages were checked.
    const kinds = new Set(pages.map((page) => page.kind));
    if (
      pages.length >= 2 &&
      (kinds.has("impressum") || kinds.has("kontakt"))
    )
      break;
  }
  return { pages, failures };
}

/**
 * Discover the company's official website from public search indexes when
 * no source row documented one. Candidate pages are fetched through the
 * guards and ACCEPTED only when the fetched content itself contains the
 * company name — otherwise null (no invention, no guess-by-domain).
 */
export async function discoverCompanyWebsite(
  companyName: string,
  client: WebSearchClient,
  robotsCache: Map<string, RobotsPolicy>,
  limiter: ConcurrencyLimiter,
): Promise<{ url: string; evidenceUrl: string } | null> {
  const query = `"${companyName}" Impressum OR Kontakt OR Ausbildung`;
  let results: Array<{ url: string; title: string; snippet: string }>;
  try {
    results = await client.search(query, 8);
  } catch {
    return null; // provider failure → no website, never a guessed one
  }
  if (!normalizeIdentity(companyName)) return null;
  // Significant words of the company name (≥3 chars) — a candidate page is
  // accepted only when the FIRST word is present and at least half of the
  // words occur in the fetched content.
  const words = companyName
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 3);
  if (words.length === 0) return null;

  for (const result of results.slice(0, 3)) {
    const url = (() => {
      try {
        return new URL(result.url);
      } catch {
        return null;
      }
    })();
    if (!url || url.protocol !== "https:") continue;
    if (isAggregatorHost(result.url)) continue;
    const hostname = url.hostname.toLowerCase().replace(/^www\./, "");
    if (hostname === "arbeitsagentur.de" || hostname.endsWith(".arbeitsagentur.de"))
      continue;
    const fetched = await fetchSitePage(result.url, robotsCache, limiter, {
      maxAttempts: 2,
    });
    if (!fetched.ok) continue;
    const haystack = normalizeIdentity(
      `${fetched.page.title ?? ""} ${fetched.page.siteName ?? ""} ${fetched.page.text.slice(0, 4000)}`,
    );
    const matchCount = words.filter((word) => haystack.includes(word)).length;
    if (!haystack.includes(words[0]) || matchCount < Math.ceil(words.length / 2))
      continue;
    try {
      return { url: url.origin, evidenceUrl: fetched.page.finalUrl || result.url };
    } catch {
      return null;
    }
  }
  return null;
}
