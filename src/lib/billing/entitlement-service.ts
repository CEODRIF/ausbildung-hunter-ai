/**
 * Phase 12 — the central server-side entitlement & quota service.
 *
 * This is the ONLY place where "may this user do this?" is decided. Metered
 * feature routes resolve their entitlement here instead of re-reading
 * subscriptions / plan limits locally.
 *
 * Trust model:
 *   - The authenticated user comes from the server session (Supabase JWT);
 *     no plan id, price, quota value, or entitlement flag is ever accepted
 *     from the browser.
 *   - Limits are read from the database (`billing_plans.feature_limits` for
 *     commercial plans, legacy columns for plus/pro) — the TypeScript
 *     catalogue in `commercial-plans.ts` is display-only.
 *   - Fail closed: any lookup failure denies metered features
 *     (`reason: "lookup_error"`). Only the quota-free salary calculator and
 *     the upload size cap (legacy 10 MB fallback) stay available — a lookup
 *     failure must never upgrade anyone.
 *
 * Effective plan resolution (documented migration decision):
 *   - A subscription row is VALID when status is 'active' and the period
 *     end (when set) is still in the future. Only a valid row with a known
 *     plan id grants that plan; everything else (no row, canceled, expired,
 *     unknown plan) falls back to the internal 'free' state.
 *   - Commercial plans (trial / premium_10d / premium_monthly): per-feature
 *     limits come from the plan row's `feature_limits` jsonb. A missing or
 *     null key means "unmetered" (no plan quota); 0 means "disabled".
 *   - Legacy plus/pro (and the free fallback): ai_assistant uses the
 *     `billing_plans.ai_requests_per_day` column (free fallback 100),
 *     deckblatt keeps its historic 2/day, the upload cap keeps 10 MB, and
 *     all other spec features are unmetered (preserving today's behavior).
 *     Application Automation is 0 (disabled) for every non-commercial
 *     state — it is a commercial-plan feature only.
 *
 * Quota families (write path):
 *   - ai_assistant -> existing `reserve_ai_request` (daily_usage) plus the
 *     new `release_ai_request` for failed operations (no run id: the meter
 *     is a plain daily counter; the ai path ignores the passed run id).
 *   - deckblatt    -> existing USER-session RPCs (granted to `authenticated`
 *     with an auth.uid() guard, plan-aware after migration
 *     20261121000000). These calls require an active request context
 *     (cookies) and must be invoked from route handlers / server actions.
 *   - everything else -> new service-role RPCs `reserve_feature_op` /
 *     `complete_feature_op` / `release_feature_op` (run-ledger based,
 *     idempotent per run id).
 */
import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

import {
  DECKBLATT_LEGACY_DAILY_LIMIT,
  FREE_PLAN_LIMITS,
  isPlanId,
  PLAN_LABELS,
  type PlanId,
} from "./plans";
import {
  FEATURE_QUOTA_KIND,
  isCommercialPlanId,
  isFeatureId,
  LEGACY_UPLOAD_MB,
  ONE_MB,
  type FeatureId,
} from "./commercial-plans";
import type { SubscriptionState } from "./entitlements";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type FeatureReason =
  | "ok"
  | "ok_legacy_unmetered"
  | "unknown_feature"
  | "plan_expired"
  | "feature_disabled"
  | "quota_exhausted"
  | "lookup_error";

export interface FeatureEntitlement {
  allowed: boolean;
  reason: FeatureReason;
  planId: PlanId;
  featureId: FeatureId;
  /** null = unmetered (no plan quota); 0 = explicitly disabled. */
  limit: number | null;
  used: number;
  /** null = unmetered / not applicable. */
  remaining: number | null;
  /** When the counter resets (epoch ms, UTC); null when it never resets. */
  resetsAt: number | null;
  /** End of the current subscription period (epoch ms); null when none. */
  subscriptionExpiresAt: number | null;
}

export interface PlanRow {
  plan_id: string;
  emails_per_day: number | null;
  ai_requests_per_day: number | null;
  price_cents: number | null;
  duration_kind: string | null;
  duration_value: number | null;
  is_commercial: boolean | null;
  /** Per-feature limits (commercial plans). null = legacy row without a
   *  feature matrix. */
  feature_limits: Record<string, number | null> | null;
}

export interface ResolvedSubscription {
  /** The plan that actually grants entitlements (fallback: 'free'). */
  planId: PlanId;
  status: "none" | "active" | "canceled" | "expired";
  provider: string | null;
  periodStartMs: number | null;
  periodEndMs: number | null;
  /** True once a trial has ever been activated (never cleared). */
  trialUsed: boolean;
  /** The persisted subscription row (any status), or null. */
  row: SubscriptionState | null;
  /** The billing_plans row for the effective plan, or null (free fallback
   *  or lookup failure). */
  planRow: PlanRow | null;
  /** True when the subscription/plan lookup itself failed — all metered
   *  features must be denied (fail closed). */
  lookupFailed: boolean;
}

export type ReserveOutcome =
  | "reserved"
  | "already_reserved"
  | "quota_exhausted"
  | "unmetered"
  | "feature_disabled"
  | "error";

export interface QuotaOperationResult {
  outcome: ReserveOutcome;
  /** Safe, user-displayable message when outcome is 'error'. */
  message?: string;
}

export interface BillingStatus {
  planId: PlanId;
  planLabel: string;
  status: ResolvedSubscription["status"];
  provider: string | null;
  periodStartMs: number | null;
  periodEndMs: number | null;
  trialUsed: boolean;
  lookupFailed: boolean;
  /** Server-side mock-payment gate (never client-supplied). */
  mockPaymentsEnabled: boolean;
  /** Legacy daily counters (billing_plans columns, free fallback). */
  aiPerDay: number;
  emailsPerDay: number;
  emailsUsedToday: number;
  /** Per-feature entitlements (undefined = could not be resolved). */
  features: Partial<Record<FeatureId, FeatureEntitlement>>;
}

/** Billing-page iteration order (matches the spec's quota table). */
export const ALL_FEATURE_IDS: FeatureId[] = [
  "ai_assistant",
  "cover_letter",
  "resume_ai",
  "scanner",
  "deckblatt",
  "email_drafts",
  "opportunity_search",
  "saved_opportunities",
  "saved_applications",
  "salary_calculator",
  "automation",
  "upload",
];

// ---------------------------------------------------------------------------
// UTC helpers (single reset policy: 00:00 UTC)
// ---------------------------------------------------------------------------

export function currentUtcDateMs(nowMs: number): number {
  const d = new Date(nowMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

export function nextUtcMidnightMs(nowMs: number): number {
  return currentUtcDateMs(nowMs) + 24 * 60 * 60 * 1000;
}

export function utcDateKey(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Mock-payment environment gate (server-enforced, fail closed)
// ---------------------------------------------------------------------------

/**
 * Mock payments are available ONLY when explicitly enabled AND the runtime
 * is unambiguously non-production:
 *   MOCK_PAYMENTS_ENABLED === 'true'
 *   AND NODE_ENV !== 'production' AND VERCEL_ENV !== 'production'
 *   AND (NODE_ENV is 'development'/'test' OR VERCEL_ENV is 'preview')
 * Reads process.env at call time so tests can stub it.
 */
export function mockPaymentsEnabled(): boolean {
  const env = process.env;
  if (env.MOCK_PAYMENTS_ENABLED !== "true") return false;
  if (env.NODE_ENV === "production" || env.VERCEL_ENV === "production") {
    return false;
  }
  if (env.NODE_ENV === "development" || env.NODE_ENV === "test") return true;
  if (env.VERCEL_ENV === "preview") return true;
  return false;
}

// ---------------------------------------------------------------------------
// Subscription resolution
// ---------------------------------------------------------------------------

function toMs(value: number | string | null | undefined): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.length > 0) {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

interface RawSubscriptionRow {
  plan: string;
  status: string;
  provider: string | null;
  current_period_start: number | string | null;
  current_period_end: number | string | null;
  canceled_at: number | string | null;
  trial_activated_at: number | string | null;
}

/**
 * Resolve the user's effective subscription. Never throws: lookup problems
 * are reported via `lookupFailed` (fail closed by the callers).
 */
export async function resolveSubscription(
  userId: string,
  nowMs: number = Date.now(),
): Promise<ResolvedSubscription> {
  const none: ResolvedSubscription = {
    planId: "free",
    status: "none",
    provider: null,
    periodStartMs: null,
    periodEndMs: null,
    trialUsed: false,
    row: null,
    planRow: null,
    lookupFailed: false,
  };

  let raw: RawSubscriptionRow | null = null;
  try {
    const admin = createAdminClient();
    const { data, error } = await admin
      .from("subscriptions")
      .select(
        "plan, status, provider, current_period_start, current_period_end, canceled_at, trial_activated_at",
      )
      .eq("user_id", userId)
      .maybeSingle();
    if (error) return { ...none, lookupFailed: true };
    raw = (data as RawSubscriptionRow | null) ?? null;
  } catch {
    return { ...none, lookupFailed: true };
  }

  if (!raw) return none; // No row = never had a subscription. NOT a failure.

  const periodStartMs = toMs(raw.current_period_start);
  const periodEndMs = toMs(raw.current_period_end);
  const trialUsed = toMs(raw.trial_activated_at) !== null;

  let status: ResolvedSubscription["status"] =
    raw.status === "canceled"
      ? "canceled"
      : raw.status === "expired"
        ? "expired"
        : "active";
  // Expiry is checked against the timestamp on every evaluation — no
  // scheduled job is required to revoke access.
  if (status === "active" && periodEndMs !== null && periodEndMs <= nowMs) {
    status = "expired";
  }

  const rowPlanId: PlanId = isPlanId(raw.plan) ? raw.plan : "free";
  const subscription: SubscriptionState = {
    plan: rowPlanId,
    status: status as SubscriptionState["status"],
    provider: raw.provider ?? "manual",
    current_period_start:
      typeof raw.current_period_start === "string"
        ? raw.current_period_start
        : raw.current_period_start
          ? new Date(raw.current_period_start).toISOString()
          : null,
    current_period_end:
      typeof raw.current_period_end === "string"
        ? raw.current_period_end
        : raw.current_period_end
          ? new Date(raw.current_period_end).toISOString()
          : null,
    canceled_at:
      typeof raw.canceled_at === "string"
        ? raw.canceled_at
        : raw.canceled_at
          ? new Date(raw.canceled_at).toISOString()
          : null,
    trial_activated_at:
      typeof raw.trial_activated_at === "string"
        ? raw.trial_activated_at
        : raw.trial_activated_at
          ? new Date(raw.trial_activated_at).toISOString()
          : null,
  };

  const result: ResolvedSubscription = {
    // Effective plan starts at the free fallback; upgraded below only when
    // the row is valid AND its plan is known.
    planId: "free",
    status,
    provider: subscription.provider,
    periodStartMs,
    periodEndMs,
    trialUsed,
    row: subscription,
    planRow: null,
    lookupFailed: false,
  };

  if (status === "active" && rowPlanId !== "free") {
    try {
      const admin = createAdminClient();
      const { data, error } = await admin
        .from("billing_plans")
        .select(
          "plan_id, emails_per_day, ai_requests_per_day, price_cents, duration_kind, duration_value, is_commercial, feature_limits",
        )
        .eq("plan_id", rowPlanId)
        .maybeSingle();
      if (error || !data) return { ...result, lookupFailed: true };
      result.planRow = data as PlanRow;
      result.planId = rowPlanId;
    } catch {
      return { ...result, lookupFailed: true };
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Feature limit policy
// ---------------------------------------------------------------------------

/**
 * The effective limit for one feature on the resolved subscription.
 * `null` = unmetered, `0` = explicitly disabled.
 */
export function effectiveFeatureLimit(
  sub: ResolvedSubscription,
  featureId: FeatureId,
): number | null {
  if (isCommercialPlanId(sub.planId)) {
    // Server-authoritative: the DB row's feature_limits matrix wins.
    // (A missing planRow means lookupFailed, which callers deny first.)
    const limits = sub.planRow?.feature_limits;
    if (limits && Object.prototype.hasOwnProperty.call(limits, featureId)) {
      const value = limits[featureId];
      return typeof value === "number" && Number.isFinite(value) ? value : null;
    }
    return null;
  }
  // Legacy plus / pro / free fallback.
  switch (featureId) {
    case "ai_assistant":
      return sub.planRow?.ai_requests_per_day ?? FREE_PLAN_LIMITS.aiPerDay;
    case "deckblatt":
      return DECKBLATT_LEGACY_DAILY_LIMIT;
    case "automation":
      // Commercial-plan feature only; every legacy state is fail-closed.
      return 0;
    case "upload":
      return LEGACY_UPLOAD_MB;
    default:
      // Unmetered on legacy states (preserves pre-Phase-12 behavior).
      return null;
  }
}

// ---------------------------------------------------------------------------
// Meter reads
// ---------------------------------------------------------------------------

interface MeterReading {
  used: number;
  resetsAtMs: number | null;
}

/** Read a feature's current usage. `null` = unreadable (fail closed). */
async function readMeter(
  featureId: FeatureId,
  userId: string,
  kind: "per_day" | "per_cycle" | "items",
): Promise<MeterReading | null> {
  const rpcName = kind === "items" ? "feature_capacity_status" : "feature_quota_status";
  let admin;
  try {
    admin = createAdminClient();
  } catch {
    return null;
  }
  const { data, error } = await admin.rpc(rpcName, {
    p_user_id: userId,
    p_feature_id: featureId,
  });
  if (error) return null;
  const obj = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null;
  if (!obj || typeof obj !== "object") return null;
  const used = obj["used"];
  if (typeof used !== "number" || !Number.isFinite(used)) return null;
  const resetsRaw = obj["resets_at"];
  let resetsAtMs: number | null = null;
  if (typeof resetsRaw === "number" && Number.isFinite(resetsRaw)) {
    resetsAtMs = resetsRaw;
  } else if (typeof resetsRaw === "string") {
    const parsed = Date.parse(resetsRaw);
    if (!Number.isNaN(parsed)) resetsAtMs = parsed;
  }
  return { used, resetsAtMs };
}

// ---------------------------------------------------------------------------
// Feature check (the main read path)
// ---------------------------------------------------------------------------

/**
 * Decide whether `userId` may use `featureId` right now, with the full
 * structured result the UI can display.
 */
export async function checkFeature(
  userId: string,
  featureId: FeatureId,
  nowMs: number = Date.now(),
): Promise<FeatureEntitlement> {
  const sub = await resolveSubscription(userId, nowMs);
  return checkFeatureFor(userId, sub, featureId, nowMs);
}

/**
 * Same as `checkFeature` but reuses an already-resolved subscription (used
 * by `getBillingStatus` to avoid one lookup per feature).
 */
export async function checkFeatureFor(
  userId: string,
  sub: ResolvedSubscription,
  featureId: FeatureId,
  nowMs: number = Date.now(),
): Promise<FeatureEntitlement> {
  const base = {
    planId: sub.planId,
    featureId,
    subscriptionExpiresAt: sub.periodEndMs,
  };

  if (!isFeatureId(featureId)) {
    return { ...base, allowed: false, reason: "unknown_feature", limit: null, used: 0, remaining: null, resetsAt: null };
  }

  const kind = FEATURE_QUOTA_KIND[featureId];

  if (kind === "none") {
    // Gross-to-Net calculator: never plan-metered (allowed even on
    // lookup failure — it involves no plan state at all).
    return { ...base, allowed: true, reason: "ok", limit: null, used: 0, remaining: null, resetsAt: null };
  }

  if (kind === "static_mb") {
    // Per-file upload cap: always "allowed" (the cap itself is the limit);
    // a lookup failure degrades to the legacy 10 MB, never to an upgrade.
    const limit = sub.lookupFailed
      ? LEGACY_UPLOAD_MB
      : (effectiveFeatureLimit(sub, featureId) ?? LEGACY_UPLOAD_MB);
    return { ...base, allowed: true, reason: "ok", limit, used: 0, remaining: null, resetsAt: null };
  }

  if (sub.lookupFailed) {
    return { ...base, allowed: false, reason: "lookup_error", limit: 0, used: 0, remaining: 0, resetsAt: null };
  }

  const limit = effectiveFeatureLimit(sub, featureId);
  if (limit === null) {
    return { ...base, allowed: true, reason: "ok_legacy_unmetered", limit: null, used: 0, remaining: null, resetsAt: null };
  }

  if (limit === 0) {
    const reason: FeatureReason =
      sub.row !== null && sub.status !== "active" ? "plan_expired" : "feature_disabled";
    return { ...base, allowed: false, reason, limit: 0, used: 0, remaining: 0, resetsAt: null };
  }

  const meter = await readMeter(featureId, userId, kind);
  if (!meter) {
    return { ...base, allowed: false, reason: "lookup_error", limit, used: 0, remaining: 0, resetsAt: null };
  }

  const remaining = Math.max(limit - meter.used, 0);
  const allowed = remaining > 0;
  let resetsAt: number | null = meter.resetsAtMs;
  if (resetsAt === null) {
    if (kind === "per_day") resetsAt = nextUtcMidnightMs(nowMs);
    else if (kind === "per_cycle") resetsAt = sub.periodEndMs;
  }
  return {
    ...base,
    allowed,
    reason: allowed ? "ok" : "quota_exhausted",
    limit,
    used: meter.used,
    remaining,
    resetsAt,
  };
}

// ---------------------------------------------------------------------------
// Quota write operations (reserve / complete / release)
// ---------------------------------------------------------------------------

/** Extract a `status` string from a table-returning RPC payload
 *  (PostgREST returns arrays of row objects) or a single-row object. */
function rpcStatus(data: unknown): string | null {
  const obj = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null;
  if (obj && typeof obj === "object" && "status" in obj) {
    const s = obj["status"];
    if (typeof s === "string") return s;
  }
  return null;
}

/**
 * Reserve one operation of a metered feature.
 *
 * `runId` is a server-generated operation id (`crypto.randomUUID()`, or a
 * stable idempotency id such as the scanner's scan id) — never client-
 * supplied. The ai_assistant meter is a plain daily counter and ignores it
 * (idempotency there is the single reservation per accepted request).
 */
export async function reserveFeatureOp(
  userId: string,
  featureId: FeatureId,
  runId: string,
  nowMs: number = Date.now(),
): Promise<QuotaOperationResult> {
  const kind = FEATURE_QUOTA_KIND[featureId];
  if (kind === "none") return { outcome: "unmetered" };
  if (kind === "items") {
    return {
      outcome: "error",
      message:
        "Capacity-limited features are checked before insert; they are not reserved.",
    };
  }

  const sub = await resolveSubscription(userId, nowMs);
  if (sub.lookupFailed) {
    return { outcome: "error", message: "Subscription state could not be verified." };
  }
  const limit = effectiveFeatureLimit(sub, featureId);
  if (limit === null) return { outcome: "unmetered" };
  if (limit === 0) return { outcome: "feature_disabled" };

  try {
    if (featureId === "ai_assistant") {
      const admin = createAdminClient();
      const { error } = await admin.rpc("reserve_ai_request", {
        target_user_id: userId,
        max_requests: limit,
      });
      if (error) {
        if (
          typeof error.message === "string" &&
          error.message.includes("ai_daily_limit_reached")
        ) {
          return { outcome: "quota_exhausted" };
        }
        return { outcome: "error", message: "AI usage is unavailable." };
      }
      return { outcome: "reserved" };
    }

    if (featureId === "deckblatt") {
      // User-session RPC (auth.uid() guard); requires request context.
      const client = await createClient();
      const { data, error } = await client.rpc("reserve_deckblatt_generation", {
        target_user_id: userId,
        p_run_id: runId,
      });
      if (error) return { outcome: "error", message: "Feature quota is unavailable." };
      const status = rpcStatus(data);
      if (
        status === "reserved" ||
        status === "already_reserved" ||
        status === "quota_exhausted"
      ) {
        return { outcome: status };
      }
      return { outcome: "error", message: "Feature quota is unavailable." };
    }

    const admin = createAdminClient();
    const { data, error } = await admin.rpc("reserve_feature_op", {
      p_user_id: userId,
      p_feature_id: featureId,
      p_run_id: runId,
    });
    if (error) return { outcome: "error", message: "Feature quota is unavailable." };
    const status = rpcStatus(data);
    if (
      status === "reserved" ||
      status === "already_reserved" ||
      status === "quota_exhausted" ||
      status === "unmetered"
    ) {
      return { outcome: status };
    }
    return { outcome: "error", message: "Feature quota is unavailable." };
  } catch {
    return { outcome: "error", message: "Feature quota is unavailable." };
  }
}

/**
 * Mark a reserved operation as executed (the run ledger stays honest; the
 * counter is NOT changed again). The ai path is a no-op: its reservation is
 * final (a failed AI call is refunded via `releaseFeatureOp`).
 */
export async function completeFeatureOp(
  userId: string,
  featureId: FeatureId,
  runId: string,
): Promise<{ outcome: "completed" | "no_op" | "error" }> {
  const kind = FEATURE_QUOTA_KIND[featureId];
  if (kind === "none" || featureId === "ai_assistant") return { outcome: "no_op" };
  try {
    if (featureId === "deckblatt") {
      const client = await createClient();
      const { error } = await client.rpc("complete_deckblatt_generation", {
        target_user_id: userId,
        p_run_id: runId,
      });
      return error ? { outcome: "error" } : { outcome: "completed" };
    }
    const admin = createAdminClient();
    const { data, error } = await admin.rpc("complete_feature_op", {
      p_user_id: userId,
      p_run_id: runId,
    });
    if (error) return { outcome: "error" };
    const status = rpcStatus(data);
    return status === "no_op" ? { outcome: "no_op" } : { outcome: "completed" };
  } catch {
    return { outcome: "error" };
  }
}

/**
 * Refund a reserved operation that FAILED (did not execute). Never fails
 * the caller: when the refund itself cannot be performed the user keeps
 * the consumed quota (conservative, safe for abuse prevention) and the
 * outcome is 'no_op' with a message.
 */
export async function releaseFeatureOp(
  userId: string,
  featureId: FeatureId,
  runId?: string,
): Promise<{ outcome: "released" | "no_op" | "error"; message?: string }> {
  const kind = FEATURE_QUOTA_KIND[featureId];
  if (kind === "none" || kind === "items") return { outcome: "no_op" };

  try {
    if (featureId === "ai_assistant") {
      const admin = createAdminClient();
      const { data, error } = await admin.rpc("release_ai_request", {
        target_user_id: userId,
      });
      if (error) {
        return {
          outcome: "no_op",
          message: "Usage refund failed; the consumed request is retained.",
        };
      }
      return data === "no_op" ? { outcome: "no_op" } : { outcome: "released" };
    }

    if (featureId === "deckblatt") {
      if (!runId) return { outcome: "no_op" };
      const client = await createClient();
      const { data, error } = await client.rpc("release_deckblatt_generation", {
        target_user_id: userId,
        p_run_id: runId,
      });
      if (error) return { outcome: "error" };
      const status = rpcStatus(data);
      return status === "no_op" ? { outcome: "no_op" } : { outcome: "released" };
    }

    if (!runId) return { outcome: "no_op" };
    const admin = createAdminClient();
    const { data, error } = await admin.rpc("release_feature_op", {
      p_user_id: userId,
      p_run_id: runId,
    });
    if (error) return { outcome: "error" };
    const status = rpcStatus(data);
    return status === "no_op" ? { outcome: "no_op" } : { outcome: "released" };
  } catch {
    if (featureId === "ai_assistant") {
      return {
        outcome: "no_op",
        message: "Usage refund failed; the consumed request is retained.",
      };
    }
    return { outcome: "error" };
  }
}

// ---------------------------------------------------------------------------
// Upload size cap (server-enforced)
// ---------------------------------------------------------------------------

/**
 * Effective per-file upload cap in BYTES. Commercial: 2/15/15 MB; legacy
 * plus/pro/free: 10 MB; lookup failure: 10 MB (never an upgrade).
 */
export async function effectiveUploadLimitBytes(
  userId: string,
  nowMs: number = Date.now(),
): Promise<number> {
  const sub = await resolveSubscription(userId, nowMs);
  if (sub.lookupFailed) return LEGACY_UPLOAD_MB * ONE_MB;
  const mb = effectiveFeatureLimit(sub, "upload") ?? LEGACY_UPLOAD_MB;
  return mb * ONE_MB;
}

// ---------------------------------------------------------------------------
// Billing page aggregate (one subscription lookup, not N+1)
// ---------------------------------------------------------------------------

export async function getBillingStatus(
  userId: string,
  nowMs: number = Date.now(),
): Promise<BillingStatus> {
  const sub = await resolveSubscription(userId, nowMs);

  const features: Partial<Record<FeatureId, FeatureEntitlement>> = {};
  await Promise.all(
    ALL_FEATURE_IDS.map(async (featureId) => {
      try {
        features[featureId] = await checkFeatureFor(userId, sub, featureId, nowMs);
      } catch {
        features[featureId] = undefined;
      }
    }),
  );

  let emailsUsedToday = 0;
  try {
    const admin = createAdminClient();
    const { data } = await admin
      .from("daily_usage")
      .select("emails_sent")
      .eq("user_id", userId)
      .eq("date", utcDateKey(nowMs))
      .maybeSingle();
    const row = data as Record<string, unknown> | null;
    if (row && typeof row["emails_sent"] === "number") {
      emailsUsedToday = row["emails_sent"];
    }
  } catch {
    emailsUsedToday = 0; // display-only
  }

  return {
    planId: sub.planId,
    planLabel: PLAN_LABELS[sub.planId],
    status: sub.status,
    provider: sub.provider,
    periodStartMs: sub.periodStartMs,
    periodEndMs: sub.periodEndMs,
    trialUsed: sub.trialUsed,
    lookupFailed: sub.lookupFailed,
    mockPaymentsEnabled: mockPaymentsEnabled(),
    aiPerDay:
      typeof sub.planRow?.ai_requests_per_day === "number"
        ? sub.planRow.ai_requests_per_day
        : FREE_PLAN_LIMITS.aiPerDay,
    emailsPerDay:
      typeof sub.planRow?.emails_per_day === "number"
        ? sub.planRow.emails_per_day
        : FREE_PLAN_LIMITS.emailsPerDay,
    emailsUsedToday,
    features,
  };
}

// ---------------------------------------------------------------------------
// Saved-application capacity (items quota: live content-row count, no reset)
// ---------------------------------------------------------------------------

export type SavedCapacityStatus =
  | "ok"
  | "unmetered"
  | "disabled"
  | "exceeded"
  | "error";

export interface SavedCapacityCheck {
  status: SavedCapacityStatus;
  /** The plan limit (null = unmetered / unknown). */
  planLimit: number | null;
  used: number;
  remaining: number;
}

const SAVED_CAPACITY_FALLBACK: SavedCapacityCheck = {
  status: "error",
  planLimit: null,
  used: 0,
  remaining: 0,
};

/**
 * Advisory, read-only check of the saved_applications capacity (items
 * quota). `newContentCount` = how many CONTENT rows (non-empty company
 * name) the operation would ADD; `replaceCampaignId` = a campaign whose
 * rows the SAME operation deletes first (its slots become free).
 *
 * NEVER throws: any lookup failure yields `status: "error"`, which
 * callers must treat as a denial (fail closed — the same policy as
 * `checkFeature`'s `lookup_error`).
 */
export async function checkSavedApplicationCapacity(
  userId: string,
  newContentCount: number = 0,
  replaceCampaignId: string | null = null,
): Promise<SavedCapacityCheck> {
  let admin;
  try {
    admin = createAdminClient();
  } catch {
    return SAVED_CAPACITY_FALLBACK;
  }
  let data: unknown;
  let rpcError: { message?: string } | null = null;
  try {
    const res = await admin.rpc("check_saved_application_capacity", {
      p_user_id: userId,
      p_new_count: newContentCount,
      p_replace_campaign_id: replaceCampaignId,
    });
    data = res.data;
    rpcError = res.error;
  } catch {
    return SAVED_CAPACITY_FALLBACK;
  }
  if (rpcError) return SAVED_CAPACITY_FALLBACK;
  const row = (Array.isArray(data) ? data[0] : data) as
    | Record<string, unknown>
    | null;
  if (!row || typeof row !== "object") return SAVED_CAPACITY_FALLBACK;
  const status = row["status"];
  if (
    status !== "ok" &&
    status !== "unmetered" &&
    status !== "disabled" &&
    status !== "exceeded"
  ) {
    return SAVED_CAPACITY_FALLBACK;
  }
  const planLimit =
    typeof row["plan_limit"] === "number" && Number.isFinite(row["plan_limit"])
      ? row["plan_limit"]
      : null;
  const used =
    typeof row["used"] === "number" && Number.isFinite(row["used"])
      ? row["used"]
      : 0;
  const remaining =
    typeof row["remaining"] === "number" && Number.isFinite(row["remaining"])
      ? row["remaining"]
      : 0;
  return { status, planLimit, used, remaining };
}

/**
 * The server-side gate for operations that ADD a saved application
 * (a content row). No-op when `newContentCount <= 0` (empty rows consume
 * no capacity). Denies with STABLE codes the bew actions map 1:1:
 *   - plan limit exceeded, or the feature explicitly disabled (0)
 *       → CAPACITY_EXCEEDED
 *   - capacity unreadable (lookup failure) → SAVE_FAILED (fail closed,
 *     a missing reading must never be treated as "plenty of room")
 *
 * This is an ADVISORY pre-check for clean UX. The HARD guarantee is the
 * `enforce_saved_application_capacity` trigger on bew_applications
 * (migration 20261123000000): it serializes per user (lock → limit →
 * count → decide) and raises `saved_application_capacity_exceeded`, so a
 * pre-check→insert race can never commit an over-limit state. The engine
 * maps that marker message to CAPACITY_EXCEEDED in every write path.
 */
export async function assertSavedApplicationCapacity(
  userId: string,
  newContentCount: number,
  replaceCampaignId: string | null = null,
): Promise<void> {
  if (newContentCount <= 0) return;
  const check = await checkSavedApplicationCapacity(
    userId,
    newContentCount,
    replaceCampaignId,
  );
  if (check.status === "exceeded" || check.status === "disabled") {
    throw new Error("CAPACITY_EXCEEDED");
  }
  if (check.status === "error") {
    throw new Error("SAVE_FAILED");
  }
}
