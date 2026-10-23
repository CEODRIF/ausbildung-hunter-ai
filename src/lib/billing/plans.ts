/**
 * Phase 10 — plan definitions.
 *
 * The canonical limit VALUES live in the database (`billing_plans`,
 * migration 20261001000000) — the entitlement layer reads those rows so
 * admins can adjust limits in one place. These constants are:
 *   1. the documented plan ID / label catalog (referenced by constraints),
 *   2. the FREE-PLAN fallback used when the lookup fails (fail-closed:
 *      the most restrictive limits, never a privilege upgrade).
 *
 * `free` is an INTERNAL FALLBACK STATE ONLY (no subscription row, or an
 * expired/absent entitlement). It is never a purchasable offer.
 *
 * Commercial offers (trial / premium_10d / premium_monthly) are defined
 * in `commercial-plans.ts` (prices, durations, feature quotas) and seeded
 * into `billing_plans` by migration 20261120000000. Activation of those
 * plans goes through server-side RPCs (trial activation, mock checkout)
 * — never through the admin assignment path.
 */

export const PLAN_IDS = [
  "free",
  "plus",
  "pro",
  "trial",
  "premium_10d",
  "premium_monthly",
] as const;
export type PlanId = (typeof PLAN_IDS)[number];
/** Plans that can be assigned via a subscription row (admin action).
 *  Legacy only: commercial plans activate via trial RPC / mock checkout. */
export const ASSIGNABLE_PLANS = ["plus", "pro"] as const;
export type AssignablePlan = (typeof ASSIGNABLE_PLANS)[number];

export const PLAN_LABELS: Record<PlanId, string> = {
  free: "Free",
  plus: "Plus",
  pro: "Pro",
  trial: "Trial",
  premium_10d: "Premium 10 Days",
  premium_monthly: "Premium Monthly",
};

/** Free-plan fallback limits. MUST stay equal to the pre-Phase-10
 *  defaults (profile base 50 emails/day, AI 100 requests/day) so that
 *  free users experience zero behavior change. Guarded by tests. */
export const FREE_PLAN_LIMITS = {
  emailsPerDay: 50,
  aiPerDay: 100,
} as const;

/** Deckblatt limit for legacy/free states. MUST stay equal to the
 *  pre-Phase-11 deckblatt meter default (2 generations/day, enforced in
 *  migration 20261020000000). Commercial plans override it via
 *  billing_plans.feature_limits. The SQL mirror is the
 *  `coalesce(plan_feature_limit(…,'deckblatt'), 2)` fallback in
 *  migration 20261121000000. Guarded by tests. */
export const DECKBLATT_LEGACY_DAILY_LIMIT = 2;

export function isPlanId(value: unknown): value is PlanId {
  return (
    typeof value === "string" && (PLAN_IDS as readonly string[]).includes(value)
  );
}

export function isAssignablePlan(value: unknown): value is AssignablePlan {
  return (
    typeof value === "string" &&
    (ASSIGNABLE_PLANS as readonly string[]).includes(value)
  );
}
