import "server-only";

import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Phase 12 — API abuse protection.
 *
 * Fixed-window rate limits enforced in Postgres (migration
 * 20261002000000_rate_limits.sql): atomic, shared across app instances,
 * no external dependency. Each scope is keyed `scope:<user_id>` — the user
 * id always comes from the authenticated session, never the request body.
 *
 * Fail-open policy (documented): if the limiter RPC itself errors, the
 * request is allowed. The limiter is protection, not a security gate —
 * every protected route keeps its own authn/authz, and a limiter outage
 * must never take the product down for everyone.
 */

export interface RateLimitResult {
  allowed: boolean;
  /** Requests consumed in the current window (including this one). */
  count: number;
  limit: number;
  /** Seconds until the current window resets (0 when allowed). */
  retryAfterSeconds: number;
}

export type RateLimitScope =
  | "ai_chat"
  | "ai_search"
  | "opportunity_search"
  | "opportunity_save"
  | "company_discovery"
  | "deckblatt_generate"
  | "email_oauth"
  | "account_export"
  | "account_delete"
  | "admin_actions";

/**
 * Per-scope budgets. Rationale:
 * - ai_chat: paid AI calls per user — 20/min keeps interactive use smooth
 *   while capping burst cost.
 * - opportunity_search: the BA API is shared under a public client id;
 *   10/min per user keeps aggregate upstream usage far below provider
 *   abuse thresholds.
 * - opportunity_save: each save re-resolves the offer from the source.
 * - ai_search: one run = an AI planning call + a bounded batch of upstream
 *   search + per-result detail fetches (export re-runs the batch without AI).
  *   4/min caps the heavy batch work per user; it shares no budget with the
  *   per-page opportunity_search limiter.
  * - deckblatt_generate: one request = a slow (10–90 s) diffusion-model
  *   image generation. The 2/day quota is the real gate (DB-side, atomic);
  *   3/min only stops burst spam while the provider is failing (each failed
  *   attempt refunds the quota).
  * - email_oauth: OAuth initiations are cheap but a proxying vector; 5/min.
 * - account_export / account_delete: sensitive GDPR operations, 1 h window.
 * - admin_actions: plan/admin mutations; 30/min is generous for humans.
 */
export const RATE_LIMITS: Record<
  RateLimitScope,
  { max: number; windowSeconds: number }
> = {
  ai_chat: { max: 20, windowSeconds: 60 },
  ai_search: { max: 4, windowSeconds: 60 },
  opportunity_search: { max: 10, windowSeconds: 60 },
  opportunity_save: { max: 10, windowSeconds: 60 },
  // company_discovery: a start spawns a heavy multi-source run (BA batch +
  // per-company page fetches + bounded Tavily); 4/min stops run spam while
  // allowing legitimate re-runs with adjusted parameters.
  company_discovery: { max: 4, windowSeconds: 60 },
  deckblatt_generate: { max: 3, windowSeconds: 60 },
  email_oauth: { max: 5, windowSeconds: 60 },
  account_export: { max: 2, windowSeconds: 3600 },
  account_delete: { max: 5, windowSeconds: 3600 },
  admin_actions: { max: 30, windowSeconds: 60 },
};

export function rateLimitKey(scope: RateLimitScope, userId: string): string {
  return `${scope}:${userId}`;
}

export async function checkRateLimit(
  scope: RateLimitScope,
  userId: string,
): Promise<RateLimitResult> {
  const { max, windowSeconds } = RATE_LIMITS[scope];
  try {
    const admin = createAdminClient();
    const { data, error } = (await admin.rpc("check_rate_limit", {
      limit_key: rateLimitKey(scope, userId),
      max_requests: max,
      window_seconds: windowSeconds,
    })) as {
      data: {
        allowed: boolean;
        count: number;
        limit: number;
        retry_after: number;
      } | null;
      error: { message: string } | null;
    };
    if (error || !data) {
      // Fail-open (see file header).
      return { allowed: true, count: 0, limit: max, retryAfterSeconds: 0 };
    }
    return {
      allowed: data.allowed === true,
      count: Number(data.count) || 0,
      limit: Number(data.limit) || max,
      retryAfterSeconds: Number(data.retry_after) || 0,
    };
  } catch {
    // Fail-open (see file header): any unexpected error in the limiter
    // path must degrade to "allowed", never to a 500 for all users.
    return { allowed: true, count: 0, limit: max, retryAfterSeconds: 0 };
  }
}

/** `x-ratelimit-*` headers for allowed responses (standard, non-secret). */
export function rateLimitHeaders(
  result: RateLimitResult,
): Record<string, string> {
  return {
    "x-ratelimit-limit": String(result.limit),
    "x-ratelimit-remaining": String(Math.max(0, result.limit - result.count)),
  };
}

/** Canonical 429 response for denied requests. */
export function tooManyRequests(result: RateLimitResult): NextResponse {
  return NextResponse.json(
    { error: "Too many requests. Please slow down and try again shortly." },
    {
      status: 429,
      headers: {
        "retry-after": String(Math.max(1, result.retryAfterSeconds)),
        ...rateLimitHeaders(result),
      },
    },
  );
}
