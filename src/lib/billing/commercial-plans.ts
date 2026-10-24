/**
 * Commercial plan catalogue — the single TYPED source of truth for the
 * public offers (Trial / Premium 10 Days / Premium Monthly).
 *
 * Relationship to the database:
 *   - The DB rows (`billing_plans`, seeded by migration 20261120000000)
 *     are what the quota RPCs and entitlement service READ at runtime.
 *   - This file mirrors those seeds 1:1 so TypeScript code (UI, tests,
 *     mock checkout price display) can use typed values.
 *   - `tests/subscription-migrations.test.ts` extracts the migration seed
 *     rows and asserts they match this catalogue — a drift in either
 *     direction breaks the build.
 *
 * What this file intentionally does NOT contain:
 *   - Legacy plans (`free`, `plus`, `pro`) — their limits stay in the
 *     original 20261001000000 seed; `free` is an internal fallback state,
 *     never a commercial offer.
 *   - Prices for legacy plans — none exist (manual admin assignment).
 *
 * Quota kinds (how a limit resets / what is counted):
 *   - `per_day`   : resets at 00:00 UTC (a new UTC calendar day).
 *   - `per_cycle` : counted for the whole subscription access window
 *                   (trial 72 h, 10-day purchase, calendar month).
 *   - `items`     : concurrent stored items, not an operation count.
 *   - `none`      : no plan quota (Gross-to-Net calculator).
 *   - `static_mb` : per-file upload size cap (server-enforced).
 *
 * "One operation" definitions (documented counting rules):
 *   - ai_assistant        : one accepted chat turn (one provider call per
 *                           user message; streaming retries of the same
 *                           turn reuse the reservation).
 *   - cover_letter        : one cover-letter generation request that is
 *                           accepted for processing (via ANY endpoint —
 *                           the dedicated route or the general AI chat in
 *                           cover-letter mode).
 *   - resume_ai           : one resume analysis/generation run.
 *   - scanner             : one document scan (the application scanner).
 *   - deckblatt           : one Deckblatt image generation (existing
 *                           2/day meter is superseded by plan-aware limit).
 *   - email_drafts        : one Email Assistant draft created.
 *   - opportunity_search  : one executed opportunity search request.
 *   - automation          : one automation action that EXECUTES (one
 *                           prepared application processed through the
 *                           bew send engine; queued-but-cancelled items
 *                           are released, not counted).
 */

import type { PlanId } from "./plans";

/** Commercial plan IDs (subset of PlanId). */
export const COMMERCIAL_PLAN_IDS = [
  "trial",
  "premium_10d",
  "premium_monthly",
] as const;
export type CommercialPlanId = (typeof COMMERCIAL_PLAN_IDS)[number];

export type FeatureId =
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

export type QuotaKind =
  "per_day" | "per_cycle" | "items" | "none" | "static_mb";

/** How each feature's quota behaves (independent of plan). */
export const FEATURE_QUOTA_KIND: Record<FeatureId, QuotaKind> = {
  ai_assistant: "per_day",
  cover_letter: "per_day",
  resume_ai: "per_cycle",
  scanner: "per_cycle",
  deckblatt: "per_day",
  email_drafts: "per_day",
  opportunity_search: "per_day",
  saved_opportunities: "items",
  saved_applications: "items",
  salary_calculator: "none",
  automation: "per_day",
  upload: "static_mb",
};

export function isFeatureId(value: unknown): value is FeatureId {
  return (
    typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(FEATURE_QUOTA_KIND, value)
  );
}

export type PlanDuration =
  | { kind: "none" }
  | { kind: "fixed_hours"; hours: number }
  | { kind: "fixed_days"; days: number }
  | { kind: "calendar_month"; months: number };

/** Feature limits per commercial plan. `null` = no plan quota (unmetered /
 *  legacy behavior / not applicable for that plan). 0 is meaningful
 *  (explicitly disabled, e.g. trial automation). */
export type FeatureLimits = Partial<Record<FeatureId, number | null>>;

export interface CommercialPlanDef {
  id: CommercialPlanId;
  label: string;
  /** Price in USD cents. 0 = free. */
  priceCents: number;
  currency: "USD";
  duration: PlanDuration;
  /** Legacy per-day counters in billing_plans (used by the email/AI
   *  capacity RPCs). Trial's email floor is documented in the migration:
   *  effective_daily_email_limit() floors at the profile base (50), so a
   *  trial user can still queue up to 50 campaign emails; automation
   *  (the metered spec item) is 0 for trial. */
  emailsPerDay: number;
  aiRequestsPerDay: number;
  featureLimits: FeatureLimits;
  /** Whether this plan is advertised as a commercial offer. */
  isCommercial: boolean;
  /** Marketing blurb (shown on the billing page). */
  marketing: {
    title: string;
    tagline: string;
    bullets: string[];
  };
}

export const LEGACY_UPLOAD_MB = 10;

export const COMMERCIAL_PLANS: Record<CommercialPlanId, CommercialPlanDef> = {
  trial: {
    id: "trial",
    label: "Trial",
    priceCents: 0,
    currency: "USD",
    duration: { kind: "fixed_hours", hours: 72 },
    emailsPerDay: 3,
    aiRequestsPerDay: 5,
    isCommercial: false,
    featureLimits: {
      ai_assistant: 5,
      cover_letter: 1,
      resume_ai: 1,
      scanner: 1,
      deckblatt: 1,
      email_drafts: 3,
      opportunity_search: 5,
      saved_opportunities: 3,
      saved_applications: 3,
      salary_calculator: null,
      automation: 0,
      upload: 2,
    },
    marketing: {
      title: "Free for 3 Days",
      tagline: "72 hours of full access to try the platform.",
      bullets: [
        "72 hours from activation",
        "Limited AI and document processing",
        "No Application Automation",
        "No card required",
        "One trial per eligible account",
      ],
    },
  },
  premium_10d: {
    id: "premium_10d",
    label: "Premium 10 Days",
    priceCents: 1000,
    currency: "USD",
    duration: { kind: "fixed_days", days: 10 },
    emailsPerDay: 100,
    aiRequestsPerDay: 100,
    isCommercial: true,
    featureLimits: {
      ai_assistant: 100,
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
    marketing: {
      title: "Premium 10 Days",
      tagline: "Everything, intensively, for two weeks.",
      bullets: [
        "10-day access from confirmed purchase",
        "100 Application Automation operations/day",
        "Expanded AI and document limits",
        "No automatic renewal",
      ],
    },
  },
  premium_monthly: {
    id: "premium_monthly",
    label: "Premium Monthly",
    priceCents: 2000,
    currency: "USD",
    duration: { kind: "calendar_month", months: 1 },
    emailsPerDay: 250,
    aiRequestsPerDay: 200,
    isCommercial: true,
    featureLimits: {
      ai_assistant: 200,
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
    marketing: {
      title: "Premium Monthly",
      tagline: "The full package for a calendar month.",
      bullets: [
        "One calendar month from confirmed purchase",
        "250 Application Automation operations/day",
        "Higher quotas on every feature",
        "No automatic renewal until explicitly configured and approved",
      ],
    },
  },
};

export function isCommercialPlanId(value: unknown): value is CommercialPlanId {
  return (
    typeof value === "string" &&
    (COMMERCIAL_PLAN_IDS as readonly string[]).includes(value)
  );
}

export function getCommercialPlan(id: CommercialPlanId): CommercialPlanDef {
  return COMMERCIAL_PLANS[id];
}

/**
 * DISPLAY-ONLY canonical mapping: the legacy admin-granted plan ids
 * (plus/pro) to the commercial offer each one corresponds to.
 *
 * This is the documented D1 decision (plans.ts + docs/
 * subscription-system-design-2026-10-24.md): Plus mirrors the
 * Premium-10d feature set and Pro mirrors the Premium-Monthly feature
 * set (identical matrices in billing_plans since migration 20261125),
 * with durations aligned by 20261128 (plus = 10 days, pro = 30 days).
 *
 * Used ONLY by the billing page to mark the current offer card. The
 * entitlement plane (resolveSubscription / checkFeature) is unaffected:
 * entitlements always follow the persisted row's own plan.
 */
export const LEGACY_TO_COMMERCIAL: Partial<Record<PlanId, CommercialPlanId>> = {
  plus: "premium_10d",
  pro: "premium_monthly",
};

/**
 * The commercial offer a plan id is displayed as on the billing page:
 * itself for the commercial ids (trial / premium_*), the mapped offer
 * for legacy plus/pro, and null for everything else (free → no card).
 */
export function canonicalCommercialPlanId(
  planId: PlanId,
): CommercialPlanId | null {
  if (
    planId === "trial" ||
    planId === "premium_10d" ||
    planId === "premium_monthly"
  ) {
    return planId;
  }
  return LEGACY_TO_COMMERCIAL[planId] ?? null;
}

/** Effective upload cap in MB for a plan id. Legacy plans and the free
 *  fallback keep the historic 10 MB; unknown ids fail closed to the
 *  legacy value. */
export function uploadLimitMbForPlan(planId: PlanId | "free" | string): number {
  if (isCommercialPlanId(planId)) {
    const mb = COMMERCIAL_PLANS[planId].featureLimits.upload;
    if (typeof mb === "number" && mb > 0) return mb;
  }
  return LEGACY_UPLOAD_MB;
}

export const ONE_MB = 1024 * 1024;
export const MB_TO_BYTES = (mb: number): number => mb * ONE_MB;
