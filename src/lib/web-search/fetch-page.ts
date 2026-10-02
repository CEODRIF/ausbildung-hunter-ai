import "server-only";

import { lookup } from "node:dns/promises";

/**
 * Guarded public-page fetcher for discovery results.
 *
 * Hard rules (discovery never bypasses anything):
 * - https only, no credentials in the URL, host must resolve to a public IP
 *   (SSRF guard: loopback / private / link-local / unique-local rejected).
 * - robots.txt is fetched once per origin per run and respected: a path
 *   listed under Disallow (for our agent or `*`) is skipped. robots.txt
 *   returning 401/403 → origin treated as fully disallowed; unreachable or
 *   malformed → standard behaviour (allowed). We do NOT retry around
 *   rate limits: 429/403 on the page itself is a permanent skip for the run.
 * - Anti-bot walls (challenge markers, empty shells) → skipped, never solved.
 * - Body capped; only text/html is processed; everything is server-side.
 */

const PAGE_TIMEOUT_MS = 8_000;
const ROBOTS_TIMEOUT_MS = 6_000;
const MAX_BODY_BYTES = 750_000;
export const AGENT = "AusbildungHunterDiscovery/1.0";

export type PageFetchFailure =
  | "http_error"
  | "rate_limited"
  | "blocked_by_robots"
  | "anti_bot"
  | "timeout"
  | "not_html"
  | "too_large"
  | "unsafe_url"
  | "fetch_failed";

export interface FetchedPage {
  url: string;
  finalUrl: string;
  title: string | null;
  metaDescription: string | null;
  siteName: string | null;
  text: string;
  /** Same-origin public links found on the page (hrefs resolved, deduped,
   *  capped). Used to discover a company's contact/career pages from its
   *  homepage instead of relying on fixed paths only. */
  links?: string[];
}

const MAX_PAGE_LINKS = 40;

/** Public same-origin links on a page (http/https, hash + mailto/tel dropped). */
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
    if (resolved.hostname.toLowerCase().replace(/^www\./, "") !== baseHost)
      continue;
    resolved.hash = "";
    const value = resolved.toString();
    if (seen.has(value)) continue;
    seen.add(value);
    links.push(value);
    if (links.length >= MAX_PAGE_LINKS) break;
  }
  return links;
}

export type PageFetchResult =
  | { ok: true; page: FetchedPage }
  | { ok: false; reason: PageFetchFailure };

// ---------------------------------------------------------------------------
// SSRF guard
// ---------------------------------------------------------------------------

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return true;
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 169 && b === 254) return true; // link-local
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a >= 224) return true; // multicast / reserved
  return false;
}

function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === "::" || lower === "::1") return true;
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // ULA
  if (lower.startsWith("fe8")) return true; // link-local
  if (lower.startsWith("::ffff:")) {
    return isPrivateIPv4(lower.slice(7)); // IPv4-mapped
  }
  return false;
}

/** Resolve + reject non-public targets BEFORE any HTTP request. */
export async function assertPublicTarget(hostname: string): Promise<boolean> {
  let addresses: string[];
  try {
    addresses = (await lookup(hostname, { all: true })).map((a) => a.address);
  } catch {
    return false;
  }
  if (addresses.length === 0) return false;
  return addresses.every((ip) =>
    ip.includes(":") ? !isPrivateIPv6(ip) : !isPrivateIPv4(ip),
  );
}

// ---------------------------------------------------------------------------
// robots.txt (per-origin, per-run)
// ---------------------------------------------------------------------------

export interface RobotsPolicy {
  disallowed: string[];
  /** `Crawl-delay` announced for our agent (or `*`), in seconds. */
  crawlDelaySeconds?: number;
}

export async function fetchRobots(
  origin: string,
  cache: Map<string, RobotsPolicy>,
): Promise<RobotsPolicy> {
  const cached = cache.get(origin);
  if (cached) return cached;
  const policy: RobotsPolicy = { disallowed: [] };
  let response: Response;
  try {
    response = await fetch(`${origin}/robots.txt`, {
      signal: AbortSignal.timeout(ROBOTS_TIMEOUT_MS),
      headers: { "user-agent": AGENT },
      cache: "no-store",
    });
  } catch {
    cache.set(origin, policy); // unreachable → allowed (standard behaviour)
    return policy;
  }
  if (response.status === 401 || response.status === 403) {
    const denyAll: RobotsPolicy = { disallowed: [""] };
    cache.set(origin, denyAll);
    return denyAll;
  }
  if (!response.ok) {
    cache.set(origin, policy);
    return policy;
  }
  const body = await response.text().catch(() => "");
  // Minimal parser: User-agent groups; Disallow paths; `*` and our agent.
  const lines = body.split(/\r?\n/);
  let currentAgents: string[] = [];
  let collectForWildcard = false;
  let collectForAgent = false;
  for (const rawLine of lines) {
    const line = rawLine.split("#")[0].trim();
    if (!line) continue;
    const sep = line.indexOf(":");
    if (sep < 0) continue;
    const field = line.slice(0, sep).trim().toLowerCase();
    const value = line.slice(sep + 1).trim();
    if (field === "user-agent") {
      const agent = value.toLowerCase();
      currentAgents.push(agent);
      collectForWildcard = agent === "*";
      collectForAgent =
        AGENT.toLowerCase().startsWith(agent) ||
        agent.startsWith(AGENT.toLowerCase().split("/")[0]);
    } else if (field === "disallow" && (collectForWildcard || collectForAgent)) {
      if (value === "") continue; // Disallow: (empty) = allow
      policy.disallowed.push(value);
      currentAgents = [];
      collectForWildcard = false;
      collectForAgent = false;
    } else if (
      field === "crawl-delay" &&
      (collectForWildcard || collectForAgent)
    ) {
      const seconds = Number(value);
      if (Number.isFinite(seconds) && seconds >= 0) {
        policy.crawlDelaySeconds = seconds;
      }
      currentAgents = [];
      collectForWildcard = false;
      collectForAgent = false;
    }
  }
  cache.set(origin, policy);
  return policy;
}

export function pathDisallowed(pathname: string, policy: RobotsPolicy): boolean {
  for (const rule of policy.disallowed) {
    if (rule === "") return true; // deny-all marker
    const pattern = rule.replace(/\/\*.*$/, ""); // /path/* → /path
    if (pattern && pathname.startsWith(pattern)) return true;
    if (rule === pathname) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Deterministic HTML → text / meta extraction (no dependencies)
// ---------------------------------------------------------------------------

const ANTI_BOT_MARKERS = [
  "cf-challenge",
  "captcha",
  "unusual traffic",
  "enable javascript and refresh",
  "attention required! | cloudflare",
  "just a moment",
];

function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, code) =>
      Number.isFinite(Number(code))
        ? String.fromCodePoint(Number(code))
        : "",
    );
}

function metaContent(html: string, name: string): string | null {
  const patterns = [
    new RegExp(
      `<meta[^>]+(?:name|property)=["']${name}["'][^>]+content=["']([^"']*)["']`,
      "i",
    ),
    new RegExp(
      `<meta[^>]+content=["']([^"']*)["'][^>]+(?:name|property)=["']${name}["']`,
      "i",
    ),
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) return decodeEntities(match[1].trim()).slice(0, 300);
  }
  return null;
}

function extractTitle(html: string): string | null {
  const titleTag = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleTag?.[1]?.trim())
    return decodeEntities(titleTag[1].replace(/\s+/g, " ").trim()).slice(0, 200);
  return metaContent(html, "og:title");
}

export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<\/(p|div|li|tr|h[1-6]|section|article|br)[^>]*>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/[ \t]+/g, " ")
      .replace(/\n\s*\n+/g, "\n")
      .trim(),
  );
}

// ---------------------------------------------------------------------------
// Public fetch
// ---------------------------------------------------------------------------

/**
 * Fetch one public page with all guards. `robotsCache` is shared per run
 * (one robots.txt fetch per origin).
 */
export async function fetchPublicPage(
  url: string,
  robotsCache: Map<string, RobotsPolicy>,
  textBudget = 6_000,
): Promise<PageFetchResult> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: "unsafe_url" };
  }
  if (parsed.protocol !== "https:")
    return { ok: false, reason: "unsafe_url" };
  if (parsed.username || parsed.password)
    return { ok: false, reason: "unsafe_url" };
  if (!await assertPublicTarget(parsed.hostname))
    return { ok: false, reason: "unsafe_url" };

  const policy = await fetchRobots(parsed.origin, robotsCache);
  if (pathDisallowed(parsed.pathname, policy))
    return { ok: false, reason: "blocked_by_robots" };

  let response: Response;
  try {
    response = await fetch(parsed.toString(), {
      redirect: "follow",
      signal: AbortSignal.timeout(PAGE_TIMEOUT_MS),
      headers: {
        "user-agent": AGENT,
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "de-DE,de;q=0.9,en;q=0.7",
      },
      cache: "no-store",
    });
  } catch (error) {
    return {
      ok: false,
      reason:
        error instanceof Error && error.name === "TimeoutError"
          ? "timeout"
          : "fetch_failed",
    };
  }
  if (response.status === 429)
    return { ok: false, reason: "rate_limited" };
  if (!response.ok) return { ok: false, reason: "http_error" };
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("text/html") && !contentType.includes("html"))
    return { ok: false, reason: "not_html" };

  const contentLength = Number(response.headers.get("content-length") ?? 0);
  if (contentLength > MAX_BODY_BYTES)
    return { ok: false, reason: "too_large" };
  const html = await response
    .text()
    .then((body) => (body.length > MAX_BODY_BYTES ? null : body))
    .catch(() => null);
  if (html === null) return { ok: false, reason: "too_large" };

  const lowerHead = html.slice(0, 4_000).toLowerCase();
  if (ANTI_BOT_MARKERS.some((marker) => lowerHead.includes(marker)))
    return { ok: false, reason: "anti_bot" };

  const text = htmlToText(html);
  if (text.length < 80) return { ok: false, reason: "anti_bot" };

  return {
    ok: true,
    page: {
      url: parsed.toString(),
      finalUrl: response.url || parsed.toString(),
      title: extractTitle(html),
      metaDescription: metaContent(html, "description"),
      siteName: metaContent(html, "og:site_name"),
      text: text.slice(0, textBudget),
      links: extractSameOriginLinks(html, response.url || parsed.toString()),
    },
  };
}
