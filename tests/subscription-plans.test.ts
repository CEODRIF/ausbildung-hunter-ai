/**
 * Phase 12 — plan catalogue, duration math, and legacy fallback guards.
 *
 * Pure tests (no Supabase access): they pin the single typed source of truth
 * (`commercial-plans.ts` + `plans.ts` + `duration.ts`) against the agreed
 * spec table, the calendar-month semantics, and the regression-sensitive
 * legacy constants (free 50/100, deckblatt 2/day, upload 10 MB).
 *
 * The DB-seed mirror (migration 20261120000000) is asserted against this
 * catalogue in tests/subscription-migrations.test.ts.
 */
import { describe, expect, it } from "vitest";

import {
  COMMERCIAL_PLAN_IDS,
  COMMERCIAL_PLANS,
  FEATURE_QUOTA_KIND,
  LEGACY_UPLOAD_MB,
  MB_TO_BYTES,
  ONE_MB,
  isCommercialPlanId,
  isFeatureId,
  uploadLimitMbForPlan,
  type FeatureId,
} from "@/lib/billing/commercial-plans";
import { computePeriodEnd, periodDays } from "@/lib/billing/duration";
import {
  ASSIGNABLE_PLANS,
  DECKBLATT_LEGACY_DAILY_LIMIT,
  FREE_PLAN_LIMITS,
  PLAN_IDS,
  PLAN_LABELS,
  isAssignablePlan,
  isPlanId,
} from "@/lib/billing/plans";

const ALL_FEATURES: FeatureId[] = [
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

/** The agreed spec table (Trial / Premium 10 Days / Premium Monthly). */
const SPEC_TABLE: {
  feature: FeatureId;
  trial: number | null;
  ten: number | null;
  monthly: number | null;
}[] = [
  { feature: "ai_assistant", trial: 5, ten: 100, monthly: 200 },
  { feature: "cover_letter", trial: 1, ten: 25, monthly: 50 },
  { feature: "resume_ai", trial: 1, ten: 20, monthly: 60 },
  { feature: "scanner", trial: 1, ten: 20, monthly: 60 },
  { feature: "deckblatt", trial: 1, ten: 15, monthly: 30 },
  { feature: "email_drafts", trial: 3, ten: 60, monthly: 120 },
  { feature: "opportunity_search", trial: 5, ten: 150, monthly: 300 },
  { feature: "saved_opportunities", trial: 3, ten: 200, monthly: 500 },
  { feature: "saved_applications", trial: 3, ten: 200, monthly: 500 },
  { feature: "salary_calculator", trial: null, ten: null, monthly: null },
  { feature: "automation", trial: 0, ten: 100, monthly: 250 },
  { feature: "upload", trial: 2, ten: 15, monthly: 15 },
];

describe("plan catalog and guards", () => {
  it("PLAN_IDS covers legacy and commercial plans", () => {
    expect([...PLAN_IDS]).toEqual([
      "free",
      "plus",
      "pro",
      "trial",
      "premium_10d",
      "premium_monthly",
    ]);
  });

  it("commercial ids are exactly the three public offers", () => {
    expect([...COMMERCIAL_PLAN_IDS]).toEqual([
      "trial",
      "premium_10d",
      "premium_monthly",
    ]);
  });

  it("guard functions accept/reject correctly", () => {
    expect(isPlanId("free")).toBe(true);
    expect(isPlanId("premium_monthly")).toBe(true);
    expect(isPlanId("platinum")).toBe(false);
    expect(isPlanId(42)).toBe(false);
    expect(isCommercialPlanId("trial")).toBe(true);
    expect(isCommercialPlanId("pro")).toBe(false);
    expect(isCommercialPlanId("")).toBe(false);
    expect(isAssignablePlan("plus")).toBe(true);
    expect(isAssignablePlan("pro")).toBe(true);
    // Commercial plans activate via server RPCs (trial / mock checkout),
    // never through the legacy admin assignment path.
    expect(isAssignablePlan("trial")).toBe(false);
    expect(isAssignablePlan("premium_10d")).toBe(false);
    expect(isAssignablePlan("premium_monthly")).toBe(false);
    expect([...ASSIGNABLE_PLANS]).toEqual(["plus", "pro"]);
  });

  it("PLAN_LABELS matches the documented catalog", () => {
    expect(PLAN_LABELS).toEqual({
      free: "Free",
      plus: "Plus",
      pro: "Pro",
      trial: "Trial",
      premium_10d: "Premium 10 Days",
      premium_monthly: "Premium Monthly",
    });
  });

  it("each catalogue entry is keyed by its own id", () => {
    for (const id of COMMERCIAL_PLAN_IDS) {
      expect(COMMERCIAL_PLANS[id].id).toBe(id);
      expect(COMMERCIAL_PLANS[id].currency).toBe("USD");
    }
  });
});

describe("prices, durations, and legacy counters", () => {
  it("trial: $0, exactly 72 hours, no card, not a permanent free tier", () => {
    const p = COMMERCIAL_PLANS.trial;
    expect(p.priceCents).toBe(0);
    expect(p.duration).toEqual({ kind: "fixed_hours", hours: 72 });
    expect(p.isCommercial).toBe(false);
    expect(p.emailsPerDay).toBe(3);
    expect(p.aiRequestsPerDay).toBe(5);
  });

  it("premium_10d: $10, exactly 10 days, commercial", () => {
    const p = COMMERCIAL_PLANS.premium_10d;
    expect(p.priceCents).toBe(1000);
    expect(p.duration).toEqual({ kind: "fixed_days", days: 10 });
    expect(p.isCommercial).toBe(true);
    expect(p.emailsPerDay).toBe(100);
    expect(p.aiRequestsPerDay).toBe(100);
  });

  it("premium_monthly: $20, one CALENDAR month, commercial", () => {
    const p = COMMERCIAL_PLANS.premium_monthly;
    expect(p.priceCents).toBe(2000);
    expect(p.duration).toEqual({ kind: "calendar_month", months: 1 });
    expect(p.isCommercial).toBe(true);
    expect(p.emailsPerDay).toBe(250);
    expect(p.aiRequestsPerDay).toBe(200);
  });
});

describe("spec quota table (one central typed source)", () => {
  it("every plan exposes exactly the 12 spec features", () => {
    for (const id of COMMERCIAL_PLAN_IDS) {
      expect(Object.keys(COMMERCIAL_PLANS[id].featureLimits).sort()).toEqual(
        [...ALL_FEATURES].sort(),
      );
    }
  });

  it("matches the agreed limits for every feature and plan", () => {
    for (const row of SPEC_TABLE) {
      expect(COMMERCIAL_PLANS.trial.featureLimits[row.feature]).toBe(row.trial);
      expect(COMMERCIAL_PLANS.premium_10d.featureLimits[row.feature]).toBe(
        row.ten,
      );
      expect(COMMERCIAL_PLANS.premium_monthly.featureLimits[row.feature]).toBe(
        row.monthly,
      );
    }
  });

  it("salary_calculator is explicitly null (no artificial quota)", () => {
    for (const id of COMMERCIAL_PLAN_IDS) {
      expect(COMMERCIAL_PLANS[id].featureLimits.salary_calculator).toBeNull();
    }
  });
});

describe("quota kinds (reset semantics per feature)", () => {
  it("maps all 12 features", () => {
    expect(FEATURE_QUOTA_KIND).toEqual({
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
    });
  });

  it("isFeatureId rejects unknown ids", () => {
    expect(isFeatureId("ai_assistant")).toBe(true);
    expect(isFeatureId("automation")).toBe(true);
    expect(isFeatureId("bogus")).toBe(false);
    expect(isFeatureId("ai_assistant ")).toBe(false);
    expect(isFeatureId(42)).toBe(false);
    expect(isFeatureId(null)).toBe(false);
  });
});

describe("period math (the only place start+duration becomes an end)", () => {
  it("trial is exactly 72 hours", () => {
    const start = Date.parse("2026-10-14T09:15:00.000Z");
    expect(computePeriodEnd(start, COMMERCIAL_PLANS.trial.duration)).toBe(
      Date.parse("2026-10-17T09:15:00.000Z"),
    );
    expect(periodDays(start, COMMERCIAL_PLANS.trial.duration)).toBe(3);
  });

  it("premium_10d is exactly 10 days", () => {
    const start = Date.parse("2026-10-14T09:15:00.000Z");
    expect(computePeriodEnd(start, COMMERCIAL_PLANS.premium_10d.duration)).toBe(
      Date.parse("2026-10-24T09:15:00.000Z"),
    );
    expect(periodDays(start, COMMERCIAL_PLANS.premium_10d.duration)).toBe(10);
  });

  it("premium_monthly clamps end-of-month (not N days)", () => {
    const monthly = COMMERCIAL_PLANS.premium_monthly.duration;
    // 2026: Jan 31 + 1 month -> Feb 28 (28 days)
    expect(
      computePeriodEnd(Date.parse("2026-01-31T08:30:00.000Z"), monthly),
    ).toBe(Date.parse("2026-02-28T08:30:00.000Z"));
    expect(periodDays(Date.parse("2026-01-31T08:30:00.000Z"), monthly)).toBe(28);
    // 2028 leap year: -> Feb 29 (29 days)
    expect(
      computePeriodEnd(Date.parse("2028-01-31T08:30:00.000Z"), monthly),
    ).toBe(Date.parse("2028-02-29T08:30:00.000Z"));
    expect(periodDays(Date.parse("2028-01-31T08:30:00.000Z"), monthly)).toBe(29);
    // Mar 31 + 1 month -> Apr 30 (30 days)
    expect(
      computePeriodEnd(Date.parse("2026-03-31T12:00:00.000Z"), monthly),
    ).toBe(Date.parse("2026-04-30T12:00:00.000Z"));
    expect(periodDays(Date.parse("2026-03-31T12:00:00.000Z"), monthly)).toBe(30);
  });

  it("preserves the start time of day", () => {
    const monthly = COMMERCIAL_PLANS.premium_monthly.duration;
    expect(computePeriodEnd(Date.parse("2026-06-15T08:30:00.000Z"), monthly)).toBe(
      Date.parse("2026-07-15T08:30:00.000Z"),
    );
  });

  it("rolls over year boundaries", () => {
    const monthly = COMMERCIAL_PLANS.premium_monthly.duration;
    expect(computePeriodEnd(Date.parse("2026-12-15T00:00:00.000Z"), monthly)).toBe(
      Date.parse("2027-01-15T00:00:00.000Z"),
    );
  });

  it("unbounded durations resolve to null", () => {
    const start = Date.parse("2026-10-14T09:15:00.000Z");
    expect(computePeriodEnd(start, { kind: "none" })).toBeNull();
    expect(periodDays(start, { kind: "none" })).toBeNull();
  });
});

describe("marketing copy (spec-mandated strings)", () => {
  it("trial offer", () => {
    const m = COMMERCIAL_PLANS.trial.marketing;
    expect(m.title).toBe("Free for 3 Days");
    expect(m.bullets).toEqual([
      "72 hours from activation",
      "Limited AI and document processing",
      "No Application Automation",
      "No card required",
      "One trial per eligible account",
    ]);
  });

  it("premium 10 days offer", () => {
    const m = COMMERCIAL_PLANS.premium_10d.marketing;
    expect(m.title).toBe("Premium 10 Days");
    expect(m.bullets).toContain("100 Application Automation operations/day");
    expect(m.bullets).toContain("No automatic renewal");
  });

  it("premium monthly offer", () => {
    const m = COMMERCIAL_PLANS.premium_monthly.marketing;
    expect(m.title).toBe("Premium Monthly");
    expect(m.bullets).toContain("250 Application Automation operations/day");
    expect(m.bullets).toContain(
      "No automatic renewal until explicitly configured and approved",
    );
  });
});

describe("legacy fallback constants (regression guards)", () => {
  it("free fallback stays 50 emails / 100 AI — zero behavior change", () => {
    expect(FREE_PLAN_LIMITS).toEqual({ emailsPerDay: 50, aiPerDay: 100 });
  });

  it("deckblatt legacy cap stays 2/day", () => {
    expect(DECKBLATT_LEGACY_DAILY_LIMIT).toBe(2);
  });

  it("upload cap helpers and per-plan values", () => {
    expect(LEGACY_UPLOAD_MB).toBe(10);
    expect(ONE_MB).toBe(1024 * 1024);
    expect(MB_TO_BYTES(15)).toBe(15 * 1024 * 1024);
    expect(uploadLimitMbForPlan("trial")).toBe(2);
    expect(uploadLimitMbForPlan("premium_10d")).toBe(15);
    expect(uploadLimitMbForPlan("premium_monthly")).toBe(15);
    // legacy plans and the free fallback keep the historic 10 MB
    expect(uploadLimitMbForPlan("plus")).toBe(10);
    expect(uploadLimitMbForPlan("pro")).toBe(10);
    expect(uploadLimitMbForPlan("free")).toBe(10);
    // unknown ids fail closed to the legacy value
    expect(uploadLimitMbForPlan("nonexistent")).toBe(10);
  });
});
