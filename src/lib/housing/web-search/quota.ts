import "server-only";

/**
 * Housing web-search DAILY QUOTA — strict, per-user, server-side.
 *
 * Default: 20 searches per authenticated user per Europe/Berlin calendar
 * day (configurable via HOUSING_WEB_SEARCH_DAILY_MAX).
 *
 * Every call goes through the security-definer RPCs from migration
 * 20261107000000_housing_web_search_quota.sql — and deliberately uses the
 * USER session client (not the service-role client): the RPCs guard with
 * `auth.uid() <> target_user_id → not_authorized`, and the tables' RLS
 * exposes only SELECT on own rows. A client-side counter can therefore
 * never bypass the quota, and no code path can charge someone else's
 * account.
 *
 * The RPCs are idempotent per run_id:
 *  - reserve  → "reserved" | "already_reserved" (retry) | "quota_exhausted"
 *  - release  → refunds exactly one FAILED / cache-served reserved run
 *               ("no_op" otherwise)
 *  - complete → marks the run as succeeded (quota unchanged)
 *
 * Billing discipline (each paid search is charged exactly once):
 *  - reserve happens BEFORE the provider is called (validation-first);
 *  - a result-cache hit is refunded (no paid call happened);
 *  - a provider failure is refunded (the search never ran);
 *  - a retry with the same run_id is "already_reserved" (never twice).
 */
import { createClient } from "@/lib/supabase/server";

const ROUTE = "/api/housing/web-search";

/** How long a reservation may stay unsettled before it is refunded.
 *  Comfortably longer than any search the route allows (maxDuration 60 s),
 *  short enough that the user's next attempt repairs the day. */
const STALE_RESERVATION_MINUTES = 15;

/** The audience's timezone — the day key and every "resets at" time are
 *  anchored to Berlin so the reset is consistent for all users. */
const BERLIN_TZ = "Europe/Berlin";

// ---------------------------------------------------------------------------
// Berlin calendar-day helpers (pure, exported for tests)
// ---------------------------------------------------------------------------

/** Offset (ms) of a fixed IANA zone at a specific instant (DST-aware). */
export function tzOffsetMs(instant: number, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = Object.fromEntries(
    dtf.formatToParts(instant).map((p) => [p.type, p.value]),
  ) as Record<string, string>;
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour) % 24,
    Number(parts.minute),
    Number(parts.second),
  );
  return asUtc - (instant - (instant % 1000));
}

/** The Europe/Berlin calendar date of an instant, as "YYYY-MM-DD". */
export function berlinCalendarDate(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: BERLIN_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now); // en-CA ⇒ ISO-like YYYY-MM-DD
}

/**
 * The next Europe/Berlin midnight STRICTLY AFTER `now` (the moment the
 * quota resets). DST-safe: EU transitions happen at 02:00/03:00 Berlin
 * time, never at 00:00, so measuring the offset at tomorrow's 00:30
 * Berlin always yields the offset in force at tomorrow's 00:00.
 */
export function nextBerlinMidnight(now: Date = new Date()): Date {
  const [y, m, d] = berlinCalendarDate(now).split("-").map(Number);
  // UTC instant whose Berlin wall clock is (tomorrow 00:30) ± the offset.
  const tomorrow030Utc = Date.UTC(y, m - 1, d + 1, 0, 30);
  const offset = tzOffsetMs(tomorrow030Utc, BERLIN_TZ);
  return new Date(tomorrow030Utc - offset - 30 * 60 * 1000);
}

// ---------------------------------------------------------------------------
// Server-side limit setting (default 20 per user per day)
// ---------------------------------------------------------------------------

export const HOUSING_WEB_SEARCH_DAILY_LIMIT_DEFAULT = 20;

/**
 * The per-user daily limit, read server-side on every call so it stays a
 * runtime setting (no migration per change). Invalid values fall back to
 * the default rather than failing open.
 */
export function getHousingWebSearchDailyLimit(): number {
  const raw = (process.env.HOUSING_WEB_SEARCH_DAILY_MAX ?? "").trim();
  if (raw === "") return HOUSING_WEB_SEARCH_DAILY_LIMIT_DEFAULT;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : HOUSING_WEB_SEARCH_DAILY_LIMIT_DEFAULT;
}

// ---------------------------------------------------------------------------
// RPC plumbing (same PII discipline as src/lib/deckblatt/usage.ts)
// ---------------------------------------------------------------------------

export type ReserveOutcome =
  | { status: "reserved"; used: number; remaining: number }
  | { status: "already_reserved"; used: number; remaining: number }
  | { status: "quota_exhausted"; used: number; remaining: number };

export interface HousingWebSearchQuotaStatus {
  limit: number;
  used: number;
  remaining: number;
  /** Europe/Berlin calendar day the counter belongs to ("YYYY-MM-DD"). */
  usageDate: string;
  /** ISO instant at which the quota resets (next Berlin midnight). */
  resetsAt: string;
}

interface PostgrestErrorLike {
  message: string;
  code?: string;
}

function logQuotaRpcFailure(
  kind: "rpc" | "threw" | "unauthenticated",
  rpcName: string,
  authenticated: boolean,
  error: PostgrestErrorLike | null,
): void {
  console.error(
    `[housing-web-search] quota ${kind} route=${ROUTE} rpc=${rpcName} auth=${authenticated ? "authenticated" : "unauthenticated"} postgrest_code=${error?.code ?? "n/a"} message=${error?.message ?? "unknown"}`,
  );
}

interface RpcRow {
  status: string;
  used: number;
  remaining: number;
}

async function callQuotaRpc(
  name: string,
  args: Record<string, unknown>,
  authenticated: boolean,
): Promise<RpcRow | null> {
  try {
    const supabase = await createClient();
    const { data, error } = (await supabase.rpc(name, args)) as {
      data: unknown;
      error: PostgrestErrorLike | null;
    };
    if (error) {
      logQuotaRpcFailure("rpc", name, authenticated, error);
      return null;
    }
    const row = Array.isArray(data) ? data[0] : data;
    if (!row || typeof row !== "object") {
      logQuotaRpcFailure("rpc", name, authenticated, {
        message: "malformed_rpc_row",
        code: "shape",
      });
      return null;
    }
    const record = row as Record<string, unknown>;
    if (typeof record.status !== "string") {
      logQuotaRpcFailure("rpc", name, authenticated, {
        message: "malformed_rpc_row",
        code: "shape",
      });
      return null;
    }
    return {
      status: record.status,
      used: Number(record.used) || 0,
      remaining: Number(record.remaining) || 0,
    };
  } catch (error) {
    logQuotaRpcFailure("threw", name, authenticated, {
      message: error instanceof Error ? error.message : "unknown",
      code: "transport",
    });
    return null;
  }
}

/** Best-effort stale-reservation recovery (never blocks a search). */
export async function expireStaleHousingWebSearchRuns(): Promise<number> {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return 0;
    const { data, error } = (await supabase.rpc("expire_stale_housing_web_search_runs", {
      target_user_id: user.id,
      p_max_age_minutes: STALE_RESERVATION_MINUTES,
    })) as { data: unknown; error: PostgrestErrorLike | null };
    if (error) {
      logQuotaRpcFailure("rpc", "expire_stale_housing_web_search_runs", true, error);
      return 0;
    }
    const refunded = Number(data);
    if (!Number.isInteger(refunded) || refunded <= 0) return 0;
    console.warn(
      `[housing-web-search] quota recovered stale_reservations=${refunded} window_minutes=${STALE_RESERVATION_MINUTES}`,
    );
    return refunded;
  } catch (error) {
    logQuotaRpcFailure("threw", "expire_stale_housing_web_search_runs", true, {
      message: error instanceof Error ? error.message : "unknown",
      code: "transport",
    });
    return 0;
  }
}

/**
 * Today's quota for the session user, or null when the status RPC failed
 * (migration not applied, network, …). Never throws.
 */
export async function getHousingWebSearchStatus(): Promise<HousingWebSearchQuotaStatus | null> {
  const RPC = "get_housing_web_search_status";
  const limit = getHousingWebSearchDailyLimit();
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      logQuotaRpcFailure("unauthenticated", RPC, false, null);
      return null;
    }
    await expireStaleHousingWebSearchRuns();
    const { data, error } = (await supabase.rpc(RPC, {
      target_user_id: user.id,
      p_daily_limit: limit,
    })) as { data: unknown; error: PostgrestErrorLike | null };
    if (error) {
      logQuotaRpcFailure("rpc", RPC, true, error);
      return null;
    }
    const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null;
    if (!row || typeof row !== "object") {
      logQuotaRpcFailure("rpc", RPC, true, { message: "malformed_rpc_row", code: "shape" });
      return null;
    }
    const used = Number(row.used);
    const remaining = Number(row.remaining);
    if (!Number.isInteger(used) || !Number.isInteger(remaining)) {
      logQuotaRpcFailure("rpc", RPC, true, { message: "malformed_rpc_row", code: "shape" });
      return null;
    }
    return {
      limit,
      used,
      remaining,
      usageDate: String(row.usage_date ?? berlinCalendarDate()),
      resetsAt: nextBerlinMidnight().toISOString(),
    };
  } catch (error) {
    logQuotaRpcFailure("threw", RPC, true, {
      message: error instanceof Error ? error.message : "unknown",
      code: "transport",
    });
    return null;
  }
}

/**
 * Atomically reserve ONE search slot BEFORE the provider is called.
 * `runId` is the idempotency key (a UUID per logical search; a client
 * retry may resend the same id via `request_id`).
 *
 * Returns null when the RPC itself failed (migration not applied, etc.) —
 * the caller must then fail closed (no paid call without a quota slot).
 */
export async function reserveHousingWebSearch(runId: string): Promise<ReserveOutcome | null> {
  const RPC = "reserve_housing_web_search";
  const limit = getHousingWebSearchDailyLimit();
  await expireStaleHousingWebSearchRuns();
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      logQuotaRpcFailure("unauthenticated", RPC, false, null);
      return null;
    }
    const row = await callQuotaRpc(
      RPC,
      { target_user_id: user.id, p_run_id: runId, p_daily_limit: limit },
      true,
    );
    if (!row) return null;
    if (row.status === "already_reserved") {
      return { status: "already_reserved", used: row.used, remaining: row.remaining };
    }
    if (row.status === "quota_exhausted") {
      return { status: "quota_exhausted", used: row.used, remaining: row.remaining };
    }
    if (row.status === "reserved") {
      return { status: "reserved", used: row.used, remaining: row.remaining };
    }
    return null; // unknown status — treat as failure (fail closed)
  } catch (error) {
    logQuotaRpcFailure("threw", RPC, true, {
      message: error instanceof Error ? error.message : "unknown",
      code: "transport",
    });
    return null;
  }
}

/**
 * Refund a reserved slot: the run FAILED (provider error/timeout) or was
 * served from the result cache (no paid call). Idempotent; never throws.
 */
export async function releaseHousingWebSearch(runId: string): Promise<boolean> {
  const RPC = "release_housing_web_search";
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      logQuotaRpcFailure("unauthenticated", RPC, false, null);
      return false;
    }
    const row = await callQuotaRpc(
      RPC,
      { target_user_id: user.id, p_run_id: runId, p_daily_limit: getHousingWebSearchDailyLimit() },
      true,
    );
    return row?.status === "released";
  } catch (error) {
    logQuotaRpcFailure("threw", RPC, true, {
      message: error instanceof Error ? error.message : "unknown",
      code: "transport",
    });
    return false;
  }
}

/** Mark a reserved search as SUCCEEDED (ledger honesty; quota unchanged). */
export async function completeHousingWebSearch(runId: string): Promise<boolean> {
  const RPC = "complete_housing_web_search";
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      logQuotaRpcFailure("unauthenticated", RPC, false, null);
      return false;
    }
    const { error } = (await supabase.rpc(RPC, {
      target_user_id: user.id,
      p_run_id: runId,
    })) as { error: PostgrestErrorLike | null };
    if (error) {
      logQuotaRpcFailure("rpc", RPC, true, error);
      return false;
    }
    return true;
  } catch (error) {
    logQuotaRpcFailure("threw", RPC, true, {
      message: error instanceof Error ? error.message : "unknown",
      code: "transport",
    });
    return false;
  }
}
