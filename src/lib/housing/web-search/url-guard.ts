import "server-only";

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

import { LIMITS, type AllowedDomain } from "./config";

/**
 * SSRF guard for the on-demand page fetch (targeted mode, fetchable domains
 * only).
 *
 * The PRIMARY control is the domain allowlist (config.ts) — we only ever
 * fetch hosts we have reviewed. The IP checks below are defense in depth:
 * after DNS resolution, every returned address is validated and private /
 * loopback / link-local / reserved ranges are rejected. Redirects are
 * followed MANUALLY (max 3) and every hop is re-validated, so a public
 * allowlisted host cannot 302 us into an internal service.
 *
 * Known residual risk (documented, accepted): DNS rebinding between the
 * lookup here and the actual fetch. Mitigated by the allowlist (we only
 * resolve hosts we control the policy for) and by the fact that the fetched
 * content is parsed, never executed.
 */

export class UnsafeUrlError extends Error {
  constructor(reason: string) {
    super(`Unsafe URL: ${reason}`);
    this.name = "UnsafeUrlError";
  }
}

/** IPv4 ranges that must never be fetched (private/loopback/link-local/…). */
function isUnsafeIpv4(ip: string): boolean {
  const parts = ip.split(".").map((p) => Number.parseInt(p, 10));
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p))) return true;
  const [a, b] = parts;
  if (a === 0) return true; // 0.0.0.0/8 ("this network")
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local (incl. cloud metadata 169.254.169.254)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
  if (a === 192 && b === 0) return true; // 192.0.0.0/24 + 192.0.2.0/24 (TEST-NET)
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true; // multicast + reserved + broadcast
  return false;
}

/** IPv6 ranges that must never be fetched. */
function isUnsafeIpv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === "::" || lower === "::1") return true;
  // IPv4-mapped (::ffff:a.b.c.d) → validate the embedded IPv4.
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isUnsafeIpv4(mapped[1]);
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // unique local
  if (lower.startsWith("fe8") || lower.startsWith("fe9") || lower.startsWith("fea") || lower.startsWith("feb")) return true; // link-local
  return false;
}

export function isUnsafeIp(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) return isUnsafeIpv4(ip);
  if (version === 6) return isUnsafeIpv6(ip);
  return true; // not an IP at all → reject
}

/** Host must belong to the allowlisted domain (suffix match, www-stripped). */
export function hostBelongsTo(host: string, domain: AllowedDomain): boolean {
  const normalized = host.toLowerCase().replace(/^www\./, "");
  return normalized === domain.domain || normalized.endsWith(`.${domain.domain}`);
}

/**
 * Validate a URL before fetching: https-only, allowlisted host, and every
 * resolved IP public. Throws UnsafeUrlError on any violation.
 */
export async function assertFetchableUrl(
  rawUrl: string,
  domain: AllowedDomain,
  dnsLookup: (host: string) => Promise<string[]> = defaultLookup,
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new UnsafeUrlError("unparseable URL");
  }
  if (url.protocol !== "https:") {
    throw new UnsafeUrlError(`protocol ${url.protocol} (only https)`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new UnsafeUrlError("credentials in URL");
  }
  if (!hostBelongsTo(url.hostname, domain)) {
    throw new UnsafeUrlError("host not in the allowlist");
  }
  let ips: string[];
  try {
    ips = await dnsLookup(url.hostname);
  } catch {
    throw new UnsafeUrlError("DNS lookup failed"); // fail closed — cannot validate
  }
  for (const ip of ips) {
    if (isUnsafeIp(ip)) {
      throw new UnsafeUrlError(`resolves to unsafe address (${ip})`);
    }
  }
  if (ips.length === 0) {
    throw new UnsafeUrlError("no DNS results");
  }
  return url;
}

async function defaultLookup(host: string): Promise<string[]> {
  const results = await lookup(host, { all: true });
  return results.map((r) => r.address);
}

export interface FetchedPage {
  text: string;
  finalUrl: string;
  /** True when the body was truncated at the byte limit. */
  truncated: boolean;
}

/**
 * Fetch a page with manual, re-validated redirects, a timeout, and a body
 * size cap. `fetchImpl` is injectable for tests.
 */
export async function guardedFetch(
  rawUrl: string,
  domain: AllowedDomain,
  options: {
    fetchImpl?: typeof fetch;
    userAgent?: string;
    now?: () => number;
  } = {},
): Promise<FetchedPage> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const userAgent = options.userAgent ?? "AusbildungsWegBot/1.0 (+https://ausbildungsweg.net)";

  let current = rawUrl;
  let finalUrl = current;
  let response: Response | null = null;
  let redirects = 0;

  for (;;) {
    const url = await assertFetchableUrl(current, domain);
    finalUrl = url.toString();
    const res = await fetchImpl(url.toString(), {
      redirect: "manual",
      headers: {
        "user-agent": userAgent,
        accept: "text/html,application/xhtml+xml,application/ld+json;q=0.9",
        "accept-language": "de-DE,de;q=0.9",
      },
      signal: AbortSignal.timeout(LIMITS.fetchTimeoutMs),
      cache: "no-store",
    });
    response = res;
    if (res.status === 301 || res.status === 302 || res.status === 307 || res.status === 308) {
      const location = res.headers.get("location");
      if (!location) throw new UnsafeUrlError("redirect without Location");
      redirects += 1;
      if (redirects > LIMITS.maxRedirects) {
        throw new UnsafeUrlError(`too many redirects (>${LIMITS.maxRedirects})`);
      }
      current = new URL(location, url.toString()).toString();
      continue;
    }
    break;
  }

  if (!response!.ok) {
    throw new Error(`Fetch failed with HTTP ${response!.status}`);
  }
  const contentType = response!.headers.get("content-type") ?? "";
  if (!contentType.includes("html") && !contentType.includes("json")) {
    throw new Error("Not an HTML/JSON document");
  }

  // Size-capped read (streams, so we never hold a huge body in memory).
  const reader = response!.body?.getReader();
  if (!reader) throw new Error("Empty response body");
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > LIMITS.fetchMaxBytes) {
        truncated = true;
        try {
          await reader.cancel();
        } catch {
          // ignore
        }
        break;
      }
      chunks.push(value);
    }
  }
  const decoder = new TextDecoder("utf-8", { fatal: false });
  let text = "";
  for (const chunk of chunks) text += decoder.decode(chunk, { stream: !truncated });
  if (truncated) text += decoder.decode();
  return { text, finalUrl, truncated };
}
