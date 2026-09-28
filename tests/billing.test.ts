import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(),
}));

const { createAdminClient } = await import("@/lib/supabase/admin");
const { getEntitlements } = await import("@/lib/billing/entitlements");
const { FREE_PLAN_LIMITS, isAssignablePlan, isPlanId, PLAN_LABELS } =
  await import("@/lib/billing/plans");
const { getBillingProvider, verifyBillingWebhook } =
  await import("@/lib/billing/provider");
const { AI_DAILY_REQUEST_LIMIT } = await import("@/lib/ai-service");

const USER = "11111111-1111-4111-8111-111111111111";
const NOW = Date.parse("2026-10-01T12:00:00.000Z");

interface Filters {
  [key: string]: unknown;
}

function makeAdminMock(handlers: {
  single?: (table: string, filters: Filters) => Record<string, unknown> | null;
  throw?: boolean;
}) {
  const calls: Array<{ table: string; op: string; filters: Filters }> = [];
  const make = (table: string) => {
    const filters: Filters = {};
    const chain: Record<string | symbol, unknown> = new Proxy(
      {},
      {
        get(_t, prop) {
          if (typeof prop !== "string") return undefined;
          if (prop === "maybeSingle" || prop === "single")
            return async () => {
              if (handlers.throw) throw new Error("db down");
              calls.push({ table, op: prop, filters: { ...filters } });
              return {
                data: handlers.single?.(table, filters) ?? null,
                error: null,
              };
            };
          if (prop === "select") return () => chain;
          if (prop === "eq")
            return (f: string, v: unknown) => {
              filters[f] = v;
              return chain;
            };
          return () => chain;
        },
      },
    );
    return chain;
  };
  return { admin: { from: make }, calls };
}

function subRow(overrides: Record<string, unknown> = {}) {
  return {
    plan: "plus",
    status: "active",
    provider: "manual",
    current_period_start: "2026-10-01T00:00:00.000Z",
    current_period_end: "2026-10-31T00:00:00.000Z",
    canceled_at: null,
    ...overrides,
  };
}

describe("plan resolution & entitlements", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("no subscription → free plan with the pre-Phase-10 defaults", async () => {
    const mock = makeAdminMock({ single: () => null });
    vi.mocked(createAdminClient).mockReturnValue(mock.admin as never);
    const result = await getEntitlements(USER, NOW);
    expect(result.planId).toBe("free");
    expect(result.source).toBe("default");
    expect(result.subscription).toBeNull();
    expect(result.emailsPerDay).toBe(50);
    expect(result.aiPerDay).toBe(100);
  });

  it("active subscription within its period → plan entitlements", async () => {
    const mock = makeAdminMock({
      single: (table, filters) => {
        if (table === "subscriptions") return subRow();
        if (table === "billing_plans" && filters["plan_id"] === "plus")
          return {
            plan_id: "plus",
            emails_per_day: 150,
            ai_requests_per_day: 400,
          };
        return null;
      },
    });
    vi.mocked(createAdminClient).mockReturnValue(mock.admin as never);
    const result = await getEntitlements(USER, NOW);
    expect(result.planId).toBe("plus");
    expect(result.source).toBe("subscription");
    expect(result.emailsPerDay).toBe(150);
    expect(result.aiPerDay).toBe(400);
    expect(result.subscription?.status).toBe("active");
  });

  it("expired period → entitlements revert to free (row kept as state)", async () => {
    const mock = makeAdminMock({
      single: (table) =>
        table === "subscriptions"
          ? subRow({
              current_period_end: "2026-09-30T00:00:00.000Z", // before NOW
            })
          : null,
    });
    vi.mocked(createAdminClient).mockReturnValue(mock.admin as never);
    const result = await getEntitlements(USER, NOW);
    expect(result.planId).toBe("free");
    expect(result.source).toBe("default");
    expect(result.subscription?.status).toBe("active"); // row state, not entitlement
    expect(result.emailsPerDay).toBe(50);
  });

  it("canceled subscription → free entitlements, status surfaced", async () => {
    const mock = makeAdminMock({
      single: (table) =>
        table === "subscriptions"
          ? subRow({
              status: "canceled",
              canceled_at: "2026-10-01T09:00:00.000Z",
            })
          : null,
    });
    vi.mocked(createAdminClient).mockReturnValue(mock.admin as never);
    const result = await getEntitlements(USER, NOW);
    expect(result.planId).toBe("free");
    expect(result.subscription?.status).toBe("canceled");
    expect(result.subscription?.canceled_at).toBe("2026-10-01T09:00:00.000Z");
  });

  it("database failure → fail-closed to free (never an upgrade)", async () => {
    const mock = makeAdminMock({ throw: true });
    vi.mocked(createAdminClient).mockReturnValue(mock.admin as never);
    const result = await getEntitlements(USER, NOW);
    expect(result.planId).toBe("free");
    expect(result.source).toBe("default");
    expect(result.emailsPerDay).toBe(FREE_PLAN_LIMITS.emailsPerDay);
  });

  it("is deterministic for the same inputs", async () => {
    const handler = {
      single: (table: string, filters: Filters) => {
        if (table === "subscriptions") return subRow();
        if (table === "billing_plans" && filters["plan_id"] === "plus")
          return {
            plan_id: "plus",
            emails_per_day: 150,
            ai_requests_per_day: 400,
          };
        return null;
      },
    };
    vi.mocked(createAdminClient).mockReturnValue(
      makeAdminMock(handler).admin as never,
    );
    const a = await getEntitlements(USER, NOW);
    vi.mocked(createAdminClient).mockReturnValue(
      makeAdminMock(handler).admin as never,
    );
    const b = await getEntitlements(USER, NOW);
    expect(a).toEqual(b);
  });

  it("free-plan fallback equals the pre-Phase-10 defaults (regression guard)", () => {
    expect(FREE_PLAN_LIMITS.emailsPerDay).toBe(50); // profile base default
    expect(FREE_PLAN_LIMITS.aiPerDay).toBe(100);
    expect(FREE_PLAN_LIMITS.aiPerDay).toBe(AI_DAILY_REQUEST_LIMIT);
    expect(isPlanId("free")).toBe(true);
    expect(isPlanId("enterprise")).toBe(false);
    expect(isAssignablePlan("plus")).toBe(true);
    expect(isAssignablePlan("free")).toBe(false);
    expect(PLAN_LABELS.pro).toBe("Pro");
  });
});

describe("billing provider abstraction (no provider configured)", () => {
  it("the only provider is manual and reports itself not configured", () => {
    const provider = getBillingProvider();
    expect(provider.id).toBe("manual");
    expect(provider.configured).toBe(false);
  });

  it("webhook verification never yields a parsed event while unconfigured", async () => {
    const result = await verifyBillingWebhook(
      { type: "invoice.paid", user_id: USER },
      "fake-signature",
    );
    expect(result).toEqual({ ok: false, reason: "provider_not_configured" });
  });

  it("provider actions refuse to act while unconfigured (no fake calls)", async () => {
    const provider = getBillingProvider();
    const activate = await provider.activateSubscription({
      userId: USER,
      plan: "pro",
      periodDays: 30,
      actorId: USER,
    });
    const cancel = await provider.cancelSubscription({
      userId: USER,
      actorId: USER,
    });
    expect(activate).toEqual({ ok: false, reason: "provider_not_configured" });
    expect(cancel).toEqual({ ok: false, reason: "provider_not_configured" });
    expect(await provider.verifyWebhook({ anything: true }, null)).toBeNull();
  });
});
