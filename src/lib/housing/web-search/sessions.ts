import "server-only";

import { randomUUID } from "node:crypto";

import type { HousingListing } from "@/lib/housing/types";

import { PROVIDER_LIMITS } from "./config";

/**
 * In-memory search SESSIONS for "load more" (2026-10-10 high-coverage
 * engine task).
 *
 * A whole-web run may validate far more candidates than one page shows.
 * The first response serves page 1 and returns a session token; "load
 * more" calls resume from the token and page through the ALREADY
 * DISCOVERED + VALIDATED candidates (plus lazy page-fetch enrichment for
 * the next page only — no new paid search calls).
 *
 * Deliberately in-memory (consistent with the 15-min result cache):
 *   - No Supabase schema change, no persistence of search work products
 *     (enterprise Bing TOU §3(c) restricts persistent storage of search
 *     output; a short in-process TTL is the approved pattern).
 *   - Vercel serverless may cold-miss a token across instances; that
 *     degrades to a clear "session expired — start a new search" UI state
 *     (never a silent paid re-run, never stale data as fresh).
 */

export interface SearchSession {
  token: string;
  createdAt: number;
  /** Everything that survived validation (city, title, rental, …). */
  candidates: HousingListing[];
  /** Index of the next candidate to serve. */
  servedCount: number;
  /** Which enrichment (page fetch) slots were already consumed. */
  enrichedUrls: Set<string>;
}

const sessions = new Map<string, SearchSession>();

/** Prune expired + over-cap entries (called on every access). */
function prune(nowMs: number): void {
  if (sessions.size <= PROVIDER_LIMITS.sessionMaxEntries) {
    // still prune expired
    for (const [k, s] of sessions) {
      if (nowMs - s.createdAt > PROVIDER_LIMITS.sessionTtlMs) sessions.delete(k);
    }
    return;
  }
  for (const [k, s] of sessions) {
    if (nowMs - s.createdAt > PROVIDER_LIMITS.sessionTtlMs) sessions.delete(k);
  }
  // Still over cap → drop oldest first.
  if (sessions.size > PROVIDER_LIMITS.sessionMaxEntries) {
    const oldest = [...sessions.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt);
    for (const [k] of oldest) {
      if (sessions.size <= PROVIDER_LIMITS.sessionMaxEntries) break;
      sessions.delete(k);
    }
  }
}

export interface SessionResult {
  token: string;
  hasMore: boolean;
  remaining: number;
}

/** Create a session when a run produced more candidates than one page. */
export function createSession(candidates: HousingListing[], nowMs: number): SessionResult {
  prune(nowMs);
  const capped = candidates.slice(0, PROVIDER_LIMITS.sessionMaxCandidates);
  const token = randomUUID();
  sessions.set(token, {
    token,
    createdAt: nowMs,
    candidates: capped,
    servedCount: PROVIDER_LIMITS.pageSize,
    enrichedUrls: new Set<string>(),
  });
  const remaining = capped.length - PROVIDER_LIMITS.pageSize;
  return { token, hasMore: remaining > 0, remaining: Math.max(0, remaining) };
}

/** Claim the next page for a continuation. Returns null when the token
 *  is unknown/expired (cold instance or TTL) — the caller must degrade
 *  to a clear "start a new search" state, never re-run paid searches. */
export function claimNextPage(
  token: string,
  limit: number,
  nowMs: number,
): { page: HousingListing[]; servedCount: number; hasMore: boolean; remaining: number } | null {
  prune(nowMs);
  const s = sessions.get(token);
  if (!s) return null;
  if (nowMs - s.createdAt > PROVIDER_LIMITS.sessionTtlMs) {
    sessions.delete(token);
    return null;
  }
  const take = Math.max(1, Math.min(limit, 48));
  const page = s.candidates.slice(s.servedCount, s.servedCount + take);
  s.servedCount += page.length;
  const remaining = s.candidates.length - s.servedCount;
  if (remaining <= 0) sessions.delete(token);
  return { page, servedCount: s.servedCount, hasMore: remaining > 0, remaining: Math.max(0, remaining) };
}

/** Drop a session explicitly (e.g. error paths). */
export function dropSession(token: string): void {
  sessions.delete(token);
}

/** Test helper. */
export function __resetSessions(): void {
  sessions.clear();
}

/** Mark which candidate URLs a continuation already enriched. */
export function markEnriched(token: string, url: string): void {
  const s = sessions.get(token);
  if (s) s.enrichedUrls.add(url);
}

export function wasEnriched(token: string, url: string): boolean {
  return sessions.get(token)?.enrichedUrls.has(url) ?? false;
}
