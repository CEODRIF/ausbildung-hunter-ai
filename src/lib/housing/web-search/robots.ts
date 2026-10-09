import "server-only";

import { FETCH_USER_AGENT, LIMITS } from "./config";

/**
 * robots.txt compliance for the on-demand verification fetch.
 *
 * Policy (fail-closed): we fetch a page only when robots.txt EXPLICITLY does
 * not disallow it. A missing robots.txt (HTTP 404/405) means "no published
 * restrictions" → allowed. ANY other failure (timeout, 5xx, undecodable
 * body) means "unknown" → treated as disallowed for this run, so a broken
 * robots.txt can never accidentally open a prohibited page.
 *
 * We identify as a non-browser agent (FETCH_USER_AGENT); if the site has an
 * entry for our agent we follow it, otherwise the `User-agent: *` group.
 */

export type RobotsVerdict = "allowed" | "disallowed" | "unknown";

interface Rule {
  allow: string[];
  disallow: string[];
}

interface RobotsGroups {
  agent: Rule; // rules for our specific agent (may be empty)
  star: Rule; // rules for the * group
}

/**
 * The agent token we look for in robots.txt (lowercased). MUST equal
 * the first token of FETCH_USER_AGENT ("AusbildungsWegBot/1.0 …") — a test
 * pins this so a rename can never silently disable agent-specific groups.
 */
export const ROBOT_AGENT = "ausbildungswegbot";

/** Per-host cache of the parsed robots state (re-evaluated per path). */
const robotsCache = new Map<
  string,
  { at: number; state: RobotsGroups | "none" | "unknown" }
>();

/** Tests only. */
export function clearRobotsCache(): void {
  robotsCache.clear();
}

function pathPrefixMatches(pattern: string, path: string): boolean {
  // robots.txt patterns: '*' wildcard support is minimal here — we match
  // exact prefix on the non-wildcard prefix; a pattern containing '*' is
  // treated as matching if its literal prefix (before '*') matches.
  const starIdx = pattern.indexOf("*");
  if (starIdx !== -1) {
    const prefix = pattern.slice(0, starIdx);
    return path.startsWith(prefix);
  }
  // Trailing '$' = exact match.
  if (pattern.endsWith("$")) return path === pattern.slice(0, -1);
  return path === pattern || path.startsWith(pattern);
}

function evaluate(groups: RobotsGroups, path: string): RobotsVerdict {
  const rule =
    groups.agent.allow.length > 0 || groups.agent.disallow.length > 0
      ? groups.agent
      : groups.star;
  if (rule.allow.some((p) => pathPrefixMatches(p, path))) return "allowed";
  if (rule.disallow.some((p) => pathPrefixMatches(p, path))) return "disallowed";
  return "allowed";
}

export function parseRobotsTxt(body: string): RobotsGroups {
  const groups: RobotsGroups = {
    agent: { allow: [], disallow: [] },
    star: { allow: [], disallow: [] },
  };
  let current: "none" | "agent" | "star" = "none";
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.split("#", 1)[0].trim();
    if (line === "") continue;
    const sep = line.indexOf(":");
    if (sep === -1) continue;
    const field = line.slice(0, sep).trim().toLowerCase();
    const value = line.slice(sep + 1).trim();
    if (field === "user-agent") {
      current = value.toLowerCase() === ROBOT_AGENT ? "agent" : value === "*" ? "star" : "none";
    } else if (current === "agent" || current === "star") {
      const target = groups[current];
      if (field === "allow") target.allow.push(value);
      else if (field === "disallow" && value !== "") target.disallow.push(value);
    }
  }
  return groups;
}

/**
 * Decide whether `url` may be fetched.
 * `fetchImpl` is injectable for tests; `now` for cache TTL.
 */
export async function robotsVerdictForUrl(
  url: URL,
  options: { fetchImpl?: typeof fetch; now?: () => number } = {},
): Promise<RobotsVerdict> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const hostKey = url.host.toLowerCase().replace(/^www\./, "");
  const path = (url.pathname || "/").replace(/\/+$/, "") || "/";

  const cached = robotsCache.get(hostKey);
  if (cached && now() - cached.at <= LIMITS.robotsCacheTtlMs) {
    if (cached.state === "none") return "allowed";
    if (cached.state === "unknown") return "unknown";
    return evaluate(cached.state, path);
  }

  let res: Response;
  try {
    res = await fetchImpl(`https://${hostKey}/robots.txt`, {
      headers: { "user-agent": FETCH_USER_AGENT },
      signal: AbortSignal.timeout(LIMITS.robotsTimeoutMs),
      cache: "no-store",
    });
  } catch {
    return "unknown"; // fail closed — cannot verify permission
  }
  if (res.status === 404 || res.status === 405) {
    // No robots.txt published → no published restrictions.
    robotsCache.set(hostKey, { at: now(), state: "none" });
    return "allowed";
  }
  if (!res.ok) return "unknown";
  let body: string;
  try {
    body = (await res.text()).slice(0, 10 * 1024);
  } catch {
    return "unknown";
  }

  const groups = parseRobotsTxt(body);
  robotsCache.set(hostKey, { at: now(), state: groups });
  return evaluate(groups, path);
}
