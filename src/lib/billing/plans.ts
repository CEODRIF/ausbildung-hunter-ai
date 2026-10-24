/**
 * Phase 10 — plan definitions.
 *
 * The canonical limit VALUES live in the database (`billing_plans`,
 * migration 20261001000000) — the entitlement layer reads those rows so
 * admins can adjust limits in one place. These constants are:
 *   1. the documented plan ID / label catalog (referenced by constraints),
 * 2. the fail-closed NO-ENTITLEMENT fallback used when no active plan
 *      resolves (all protected features denied — zero, never a grant).
 *
 * `free` is a HISTORICAL ROW STATE ONLY (legacy rows from before the
 *  permanent Free plan was removed). It grants nothing, is never a
 *  purchasable offer, and is never written by new code paths.
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

/**
 * NO PERMANENT FREE PLAN (product decision, 2026-10-24 — PR #72 revision).
 *
 * The subscription system has exactly three plan states:
 *   1. Free Trial — one-shot, 72 h (matrix in billing_plans).
 *   2. Plus — paid.
 *   3. Pro — paid.
 *
 * The old permanent "Free" tier (50 emails/day, 100 AI requests/day,
 * 2 Deckblatt/day) has been REMOVED from all entitlement logic. A user
 * with no active trial and no active Plus/Pro subscription holds NO
 * entitlements for protected features. The legacy `free` value in the
 * database remains ONLY as a historical row state (read-only label); it
 * never grants anything and no new code path ever writes it.
 *
 * Every metered feature in the no-entitlement state is granted
 * explicitly with `0` (fail closed). There is deliberately NO shared
 * "free limits" constant to fall back to, so a missing mapping can
 * never silently become a grant.
 */

/**
 * Admin-assigned plus/pro per-feature matrix — TS MIRROR of migration
 * 20261125000000 (drift-guarded by tests/subscription-migrations.test.ts).
 *
 * DECISION D1 (docs/subscription-system-design-2026-10-24.md): no canonical
 * per-feature values for plus/pro existed, so this is a documented
 * PROPOSAL awaiting product sign-off: Plus mirrors the Premium-10d feature
 * set, Pro mirrors the Premium-Monthly feature set, while each plan keeps
 * its own historic (higher) AI/e-mail per-day columns (400/150 AI,
 * 150/500 e-mails — NOT part of this matrix). `ai_assistant` is
 * deliberately absent: the engine reads AI limits from
 * `billing_plans.ai_requests_per_day` for every matrix plan.
 * Changing these values later = edit this constant + one UPDATE on
 * `billing_plans.feature_limits`; no other code path reads plan-specific
 * feature values.
 */
export const PLUS_PRO_FEATURE_LIMITS: Record<
  "plus" | "pro",
  Record<Exclude<FeatureIdLite, "ai_assistant">, number | null>
> = {
  plus: {
    cover_letter: 25,
    resume_ai: 20,
    scanner: 20,
    deckblatt: 15,
    email_drafts: 60,
    opportunity_search: 150,
    saved_opportunities: 200,
    saved_applications: 200,
    salary_calculator: null,
    automation: 100,
    upload: 15,
  },
  pro: {
    cover_letter: 50,
    resume_ai: 60,
    scanner: 60,
    deckblatt: 30,
    email_drafts: 120,
    opportunity_search: 300,
    saved_opportunities: 500,
    saved_applications: 500,
    salary_calculator: null,
    automation: 250,
    upload: 15,
  },
};

/** Local alias so this file does not import the commercial-plans module
 *  (FeatureId is otherwise defined there; keep the plan catalogue
 *  dependency-free). */
type FeatureIdLite =
  | "ai_assistant"
  | "cover_letter"
  | "resume_ai"
  | "scanner"
  | "deckblatt"
  | "email_drafts"
  | "opportunity_search"
  | "saved_opportunities"
  | "saved_applications"
  | "salary_calculator"
  | "automation"
  | "upload";

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
