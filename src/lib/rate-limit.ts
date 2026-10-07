import "server-only";

import { createHash } from "node:crypto";
import { headers } from "next/headers";
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
  | "admin_actions"
  // Expensive AI / upload endpoints that previously had no burst protection
  // (their daily quota is a separate, DB-side gate; this only caps bursts).
  | "ai_upload"
  | "ai_generate_file"
  | "scanner_scan"
  // Paid third-party web lookups issued by the Germany copilot chat.
  | "web_search"
  // Unauthenticated auth flows — keyed by a hashed client IP, never a user id
  // (there is no session yet). See clientIpKey().
  | "register"
  | "login"
  | "verify_resend"
  // Community (per session user).
  | "community_message"
  | "community_history"
  // Community — 1s background poll of the ACTIVE room's newest page
  // (realtime fallback). Higher ceiling than community_history so a
  // 1 req/s poll (60/min, ~240/min with headroom for several tabs) works.
  | "community_poll"
  // Voice connect-failure reports (diagnostic channel, safe metadata only).
  | "community_voice_diagnostic"
  | "community_onboarding"
  // Community v2 — message-level actions (per session user).
  | "community_edit"
  | "community_react"
  | "community_delete"
  // Community Phase 2 — the social layer (per session user).
  | "community_friend"
  | "community_block"
  | "community_profile"
  | "community_presence"
  | "community_dm_send"
  | "community_dm_history"
  | "community_dm_edit"
  | "community_dm_react"
  | "community_dm_delete"
  // Community Phase 3 — preference + mute changes (rare human gestures).
  | "community_prefs"
  // Community Phase 4 — voice join tokens + count sync (per session user).
  | "community_voice"
  // Community Phase 5 — advanced community (per session user).
  | "community_search"
  | "community_question"
  | "community_answer"
  | "community_report"
  | "community_pin"
  | "community_moderation"
  | "community_role"
  | "community_room_settings";

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
 * - community_message: 20/min per user — comfortably above normal human
 *   typing in a group chat, far below a flooding rate (also caps the
 *   downstream realtime fan-out and storage writes per user).
  * - community_history: "load older" pagination fetches; 30/min.
  * - community_poll: 1s background refresh of the active room (realtime
  *   fallback); 240/min so a 1 req/s poll (60/min) works, with headroom for
  *   several open tabs, while still bounding a runaway client.
  * - community_onboarding: one-time profile completion upserts; 5/min.
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
  // ai_upload: each upload is buffered in memory and content-sniffed, then
  // stored. 30 per 10 min is far above interactive use while capping an
  // authenticated flood of 10 MB bodies.
  ai_upload: { max: 30, windowSeconds: 600 },
  // ai_generate_file: one request = a paid AI file generation + a storage
  // write. 15 per 10 min.
  ai_generate_file: { max: 15, windowSeconds: 600 },
  // scanner_scan: one request = up to 10 documents analysed by the vision
  // model in a single synchronous run. 6 per 10 min.
  scanner_scan: { max: 6, windowSeconds: 600 },
  // web_search: one live lookup per question that needs current information.
  // Generous for a real conversation, but a cap on third-party spend.
  web_search: { max: 20, windowSeconds: 600 },
  // Unauthenticated auth flows (per client IP, 10-minute window). These are a
  // thin app-level layer on top of Supabase Auth's own built-in limits — they
  // stop invitation-code brute force and signup/login/resend spam from a
  // single origin without getting in the way of legitimate humans (8 signups,
  // 15 sign-ins or 5 resends per 10 minutes is far above normal use).
  register: { max: 8, windowSeconds: 600 },
  login: { max: 15, windowSeconds: 600 },
  verify_resend: { max: 5, windowSeconds: 600 },
  // Community (per session user): 20 messages/min is comfortably above
  // normal human typing in a group chat and far below a flooding rate
  // (it also caps the realtime fan-out and storage writes per user); 30/min
  // for "load older" / room-directory / member-list reads; 5/min for
  // onboarding + the occasional identity edit (both are rare upserts).
  community_message: { max: 20, windowSeconds: 60 },
  community_history: { max: 30, windowSeconds: 60 },
  community_poll: { max: 240, windowSeconds: 60 },
  community_voice_diagnostic: { max: 30, windowSeconds: 60 },
  community_onboarding: { max: 5, windowSeconds: 60 },
  // Message-level actions: editing is cheap but chatty when spammed
  // (60/min); a reaction toggle is one tiny row — 60/min covers even a
  // reaction-heavy discussion; deletes are rarer and each one fans out to
  // storage cleanup, so 20/min.
  community_edit: { max: 60, windowSeconds: 60 },
  community_react: { max: 60, windowSeconds: 60 },
  community_delete: { max: 20, windowSeconds: 60 },
  // Phase 2 social layer: friend-request lifecycle actions are rare human
  // gestures (20/min stops request spam while never touching normal use);
  // blocking is sensitive and can be weaponized for harassment, so it gets
  // the tightest budget (10/min); profile-card reads are 30/min (same class
  // as room-directory reads); the presence heartbeat fires every ~30 s per
  // open tab, so 60/min per user covers several devices; DM sends are a
  // 1:1 conversation (30/min, slightly above the room budget — no fan-out);
  // DM edit/react/delete mirror the room budgets.
  community_friend: { max: 20, windowSeconds: 60 },
  community_block: { max: 10, windowSeconds: 60 },
  community_profile: { max: 30, windowSeconds: 60 },
  community_presence: { max: 60, windowSeconds: 60 },
  community_dm_send: { max: 30, windowSeconds: 60 },
  community_dm_history: { max: 30, windowSeconds: 60 },
  community_dm_edit: { max: 60, windowSeconds: 60 },
  community_dm_react: { max: 60, windowSeconds: 60 },
  community_dm_delete: { max: 20, windowSeconds: 60 },
  // Phase 3: settings/mute toggles are rare; 30/min stops bulk flipping
  // without ever touching normal use.
  community_prefs: { max: 30, windowSeconds: 60 },
  // Phase 4: voice joins mint a signed SFU token + create the active
  // conversation row; 20/min stops join/leave churning + token spam while
  // leaving plenty of room for legitimate reconnects.
  community_voice: { max: 20, windowSeconds: 60 },
  // Phase 5: every search runs a GIN-indexed FTS across five tables —
  // 30/min is comfortable for interactive use and far below a scraping
  // rate. Questions are the most expensive user write (title + body +
  // tags + optional image + notifications), 10/min. Answers mirror the
  // room-message budget class (20/min — a discussion can be lively, a
  // flood cannot). Reports are a sensitive, moderation-load-bearing
  // action: 5/min stops report flooding without blocking real use.
  // Pins are rare human gestures (10/min). Moderation actions + role +
  // room-setting changes are admin workflows: 30/min and 10/min are
  // generous for humans and tight for scripts.
  community_search: { max: 30, windowSeconds: 60 },
  community_question: { max: 10, windowSeconds: 60 },
  community_answer: { max: 20, windowSeconds: 60 },
  community_report: { max: 5, windowSeconds: 60 },
  community_pin: { max: 10, windowSeconds: 60 },
  community_moderation: { max: 30, windowSeconds: 60 },
  community_role: { max: 10, windowSeconds: 60 },
  community_room_settings: { max: 10, windowSeconds: 60 },
};

export function rateLimitKey(scope: RateLimitScope, userId: string): string {
  return `${scope}:${userId}`;
}

/**
 * Key for the UNAUTHENTICATED auth flows (register / login / verify resend),
 * where no session exists yet.
 *
 * The caller's IP is read from the proxy headers and hashed (sha256, scoped)
 * before it is used as a limiter key: the limiter table then holds no raw IP
 * address, which keeps it free of personal data. Returns null when the
 * deployment provides no usable IP header (e.g. local `next dev`) — callers
 * must then FAIL OPEN rather than lump every visitor into one shared bucket.
 */
export async function clientIpKey(
  scope: RateLimitScope,
): Promise<string | null> {
  const headerStore = await headers();
  const forwarded = headerStore.get("x-forwarded-for");
  const raw =
    forwarded?.split(",")[0]?.trim() ||
    headerStore.get("x-real-ip")?.trim() ||
    "";
  if (!raw) return null;
  return createHash("sha256").update(`rwl:${scope}:${raw}`).digest("hex").slice(0, 40);
}

/** User-facing message for every unauthenticated-flow limiter denial. */
export const AUTH_RATE_LIMIT_MESSAGE =
  "Too many attempts from this device. Please wait a few minutes and try again.";

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
