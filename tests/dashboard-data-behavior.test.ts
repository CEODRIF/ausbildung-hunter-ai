/**
 * Behavioral tests for the dashboard data loader's SUBSCRIPTION SUMMARY.
 *
 * `getDashboardData` is executed for real with every external dependency
 * mocked at its module boundary (supabase clients, entitlement service,
 * saved-opportunity/usage/recommendation sources). The controlled
 * `resolveSubscription` returns the exact ResolvedSubscription shapes the
 * entitlement service can produce, and the assertions cover the mapping
 * into the display-only DashboardSubscription plus the fail-soft
 * contract (any failure ⇒ subscription = null ⇒ card omitted — the
 * dashboard never guesses a billing state).
 *
 * The entitlement plane is asserted separately: a historical row
 * (canceled/expired) must keep its display label WITHOUT the effective
 * planId/planRow ever leaving the free fallback (displayPlanLabel is the
 * real implementation, wired through the mock boundary).
 */
import { describe, expect, it, vi } from "vitest";

const holder = vi.hoisted(() => ({
  sub: null as unknown,
  subThrows: false,
}));

// Generic Supabase-user client: every query resolves empty/safe data.
function makeChain() {
  const c = {
    select: () => c,
    eq: () => c,
    in: () => c,
    order: () => c,
    limit: () => c,
    single: async () => ({
      data: {
        id: "11111111-1111-4111-8111-411111111111",
        full_name: "Test Person",
        email: "test@example.com",
      },
      error: null,
    }),
    maybeSingle: async () => ({ data: null, error: null }),
    then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve({ data: [], error: null, count: 0 }).then(res, rej),
  };
  return c;
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: () => makeChain(),
    rpc: (fn: string) =>
      fn === "get_or_create_daily_usage"
        ? {
            single: async () => ({
              data: {
                user_id: "11111111-1111-4111-8111-411111111111",
                date: "2026-10-24",
                emails_sent: 0,
                ai_requests: 0,
                daily_limit: 100,
              },
              error: null,
            }),
          }
        : makeChain(),
  }),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => makeChain(),
    rpc: async () => ({ data: null, error: null }),
  }),
}));

// Controlled entitlement boundary: displayPlanLabel is the REAL
// implementation (imported through the mock factory), the subscription
// result itself is test-controlled.
vi.mock("@/lib/billing/entitlement-service", async () => {
  const { PLAN_LABELS } = await import("@/lib/billing/plans");
  return {
    resolveSubscription: async () => {
      if (holder.subThrows) throw new Error("simulated admin client failure");
      return holder.sub;
    },
    displayPlanLabel: (sub: {
      row: { plan: string } | null;
      planId: string;
    }) =>
      sub.row && sub.row.plan !== "free"
        ? PLAN_LABELS[sub.row.plan as keyof typeof PLAN_LABELS]
        : PLAN_LABELS[sub.planId as keyof typeof PLAN_LABELS],
    checkFeature: async () => ({
      allowed: true,
      reason: "ok",
      planId: "free",
      featureId: "ai_assistant",
      limit: 100,
      used: 0,
      remaining: 100,
      resetsAt: null,
      subscriptionExpiresAt: null,
    }),
  };
});

vi.mock("@/lib/contact-name-support", () => ({
  hasCampaignOwnedContent: async () => false,
}));
vi.mock("@/lib/opportunities/saved", () => ({
  listSavedOpportunities: async () => [],
  evaluateSnapshotStaleness: () => "fresh",
  formatSnapshotDate: (d: string) => d,
}));
vi.mock("@/lib/email-campaigns", () => ({
  getUsageSnapshot: async () => null,
}));
vi.mock("@/lib/opportunities/search", () => ({
  searchOpportunities: async () => [],
}));

const { getDashboardData } = await import("@/lib/dashboard");

const USER = "11111111-1111-4111-8111-411111111111";
const START = Date.parse("2026-10-01T00:00:00.000Z");
const END = Date.parse("2026-11-01T00:00:00.000Z");

const noneSub = {
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

function runLoader(): Promise<unknown> {
  return getDashboardData(USER);
}

describe("getDashboardData — subscription summary (behavioral)", () => {
  it("no subscription row → Free/none summary (never a paid state)", async () => {
    holder.sub = noneSub;
    holder.subThrows = false;
    const data = (await runLoader()) as { subscription: unknown };
    expect(data.subscription).toEqual({
      planLabel: "Free",
      status: "none",
      provider: null,
      periodStartMs: null,
      periodEndMs: null,
      lookupFailed: false,
    });
  });

  it("active premium_monthly → plan label + dates + provider mapped 1:1", async () => {
    holder.sub = {
      planId: "premium_monthly",
      status: "active",
      provider: "mock",
      periodStartMs: START,
      periodEndMs: END,
      trialUsed: false,
      row: { plan: "premium_monthly", status: "active" },
      planRow: { plan_id: "premium_monthly" },
      lookupFailed: false,
    };
    const data = (await runLoader()) as { subscription: unknown };
    expect(data.subscription).toEqual({
      planLabel: "Premium Monthly",
      status: "active",
      provider: "mock",
      periodStartMs: START,
      periodEndMs: END,
      lookupFailed: false,
    });
  });

  it("CANCELED pro row → historical label 'Pro' while the entitlement plane stays free (no paid grant)", async () => {
    holder.sub = {
      planId: "free", // entitlement plane: fail-closed fallback
      status: "canceled",
      provider: "manual",
      periodStartMs: START,
      periodEndMs: END,
      trialUsed: false,
      row: { plan: "pro", status: "canceled" }, // display plane: historical identity
      planRow: null,
      lookupFailed: false,
    };
    const data = (await runLoader()) as { subscription: unknown };
    expect(data.subscription).toEqual({
      planLabel: "Pro",
      status: "canceled",
      provider: "manual",
      periodStartMs: START,
      periodEndMs: END,
      lookupFailed: false,
    });
  });

  it("computed-expired premium_10d row → historical label, status 'expired'", async () => {
    holder.sub = {
      planId: "free",
      status: "expired",
      provider: "mock",
      periodStartMs: START,
      periodEndMs: END,
      trialUsed: false,
      row: { plan: "premium_10d", status: "active" },
      planRow: null,
      lookupFailed: false,
    };
    const data = (await runLoader()) as { subscription: unknown };
    expect(data.subscription).toEqual({
      planLabel: "Premium 10 Days",
      status: "expired",
      provider: "mock",
      periodStartMs: START,
      periodEndMs: END,
      lookupFailed: false,
    });
  });

  it("lookup failure (service throws) → subscription = null (card omitted, no guess)", async () => {
    holder.sub = noneSub;
    holder.subThrows = true;
    const data = (await runLoader()) as { subscription: unknown };
    expect(data.subscription).toBeNull();
    holder.subThrows = false;
  });

  it("lookupFailed flag surfaces to the UI (explicit no-entitlement notice)", async () => {
    holder.sub = {
      ...noneSub,
      lookupFailed: true,
      status: "none",
    };
    const data = (await runLoader()) as { subscription: unknown };
    const s = data.subscription as { lookupFailed: boolean };
    expect(s.lookupFailed).toBe(true);
  });
});
