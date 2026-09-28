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
 * No prices are defined here: no payment provider is configured, and
 * inventing billing data is explicitly out of scope.
 */

export const PLAN_IDS = ["free", "plus", "pro"] as const;
export type PlanId = (typeof PLAN_IDS)[number];
/** Plans that can be assigned via a subscription row. */
export const ASSIGNABLE_PLANS = ["plus", "pro"] as const;
export type AssignablePlan = (typeof ASSIGNABLE_PLANS)[number];

export const PLAN_LABELS: Record<PlanId, string> = {
  free: "Free",
  plus: "Plus",
  pro: "Pro",
};

/** Free-plan fallback limits. MUST stay equal to the pre-Phase-10
 *  defaults (profile base 50 emails/day, AI 100 requests/day) so that
 *  free users experience zero behavior change. Guarded by tests. */
export const FREE_PLAN_LIMITS = {
  emailsPerDay: 50,
  aiPerDay: 100,
} as const;

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
