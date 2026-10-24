import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { isPlanId, PLAN_LABELS, type PlanId } from "./plans";

/**
 * Phase 10 — server-side entitlement resolution (LEGACY DAILY COUNTERS).
 *
 * Entitlements are ALWAYS derived from persisted, server-readable state
 * (the user's subscription row + the plan catalog). Nothing is accepted
 * from the browser. When no ACTIVE non-free plan resolves (no row, free row,
 * canceled, expired, unknown plan, or a failed lookup) the effective limits
 * are 0 — there is NO permanent Free plan (removed 2026-10-24, PR #72
 * revision). This never upgrades a state; it only denies.
 */

export interface SubscriptionState {
  plan: PlanId;
  status: "active" | "canceled" | "expired";
  provider: string;
  current_period_start: string | null;
  current_period_end: string | null;
  canceled_at: string | null;
  /** Set once a trial has ever been activated for this account and never
   *  cleared (one trial per account, enforced server-side). Null when the
   *  row predates migration 20261120000000 or no trial was used. */
  trial_activated_at: string | null;
}

export interface Entitlements {
  planId: PlanId;
  planLabel: string;
  /** Effective daily limits (plan catalog values; quota upgrades are
   *  applied by the email quota RPC on top — see migration 13). */
  emailsPerDay: number;
  aiPerDay: number;
  /** The persisted subscription row (any status) or null when the user
   *  has never had a subscription. */
  subscription: SubscriptionState | null;
  /** How the effective plan was derived. */
  source: "subscription" | "default";
}

interface SubscriptionRow {
  plan: string;
  status: string;
  provider: string;
  current_period_start: string | null;
  current_period_end: string | null;
  canceled_at: string | null;
  trial_activated_at: string | null;
}

function isSubscriptionCurrent(row: SubscriptionRow, nowMs: number): boolean {
  if (row.status !== "active") return false;
  if (row.current_period_end) {
    const end = Date.parse(row.current_period_end);
    if (!Number.isNaN(end) && end <= nowMs) return false;
  }
  return true;
}

export async function getEntitlements(
  userId: string,
  nowMs: number = Date.now(),
): Promise<Entitlements> {
  const fallback = (subscription: SubscriptionState | null): Entitlements => ({
    planId: "free",
    planLabel: PLAN_LABELS.free,
    // NO PERMANENT FREE PLAN (2026-10-24): no active trial / Plus / Pro row
    // grants no daily quota at all. `planId: "free"` is a HISTORICAL sentinel
    // state (display + "no entitlements"), never a purchasable free tier.
    emailsPerDay: 0,
    aiPerDay: 0,
    subscription,
    source: "default",
  });

  let row: SubscriptionRow | null = null;
  let planLimits: { emails: number; ai: number } | null = null;
  try {
    const admin = createAdminClient();
    const { data } = await admin
      .from("subscriptions")
       .select(
         "plan, status, provider, current_period_start, current_period_end, canceled_at, trial_activated_at",
       )
      .eq("user_id", userId)
      .maybeSingle();
    row = (data as SubscriptionRow | null) ?? null;
    if (row && row.status === "active" && isPlanId(row.plan)) {
      const { data: plan } = await admin
        .from("billing_plans")
        .select("plan_id, emails_per_day, ai_requests_per_day")
        .eq("plan_id", row.plan)
        .maybeSingle();
      if (
        plan &&
        typeof plan.emails_per_day === "number" &&
        typeof plan.ai_requests_per_day === "number"
      ) {
        planLimits = {
          emails: plan.emails_per_day,
          ai: plan.ai_requests_per_day,
        };
      }
    }
  } catch {
    // Fail closed: free plan.
  }

  const subscription: SubscriptionState | null = row
    ? {
        plan: isPlanId(row.plan) ? row.plan : "free",
        status:
          row.status === "canceled" || row.status === "expired"
            ? row.status
            : "active",
        provider: row.provider ?? "manual",
         current_period_start: row.current_period_start,
         current_period_end: row.current_period_end,
         canceled_at: row.canceled_at,
         trial_activated_at: row.trial_activated_at ?? null,
       }
     : null;

  if (row && isSubscriptionCurrent(row, nowMs) && planLimits) {
    const planId = row.plan as PlanId;
    return {
      planId,
      planLabel: PLAN_LABELS[planId],
      emailsPerDay: planLimits.emails,
      aiPerDay: planLimits.ai,
      subscription,
      source: "subscription",
    };
  }
  return fallback(subscription);
}
