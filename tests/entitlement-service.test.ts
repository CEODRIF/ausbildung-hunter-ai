/**
 * Phase 12 — tests for the central entitlement & quota service
 * (`src/lib/billing/entitlement-service.ts`).
 *
 * Everything is mocked at the Supabase client boundary (admin + user
 * session); no network, no database. These tests pin the service's
 * security properties:
 *   - plan resolution is server-side only (no client-supplied identifiers);
 *   - expiry is checked from timestamps on every decision (no job needed);
 *   - lookup failures fail closed (metered features denied, never upgraded);
 *   - non-commercial states (free fallback, legacy plus/pro) keep ONLY the
 *     explicitly defined values (ai 100/day, deckblatt 2/day, upload 10 MB)
 *     and are DISABLED (0) for every other feature — the 2026-10-24 fix
 *     that removed the "unmetered legacy" default;
 *   - reserve/complete/release outcomes map 1:1 to the RPC contracts.
 */
import { describe, expect, it, vi } from "vitest";

const holder = vi.hoisted(() => ({
  admin: null as unknown,
  user: null as unknown,
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => holder.admin,
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: () => holder.user,
}));

const { COMMERCIAL_PLANS } = await import("@/lib/billing/commercial-plans");
const {
  ALL_FEATURE_IDS,
  assertSavedApplicationCapacity,
  checkFeature,
  checkSavedApplicationCapacity,
  completeFeatureOp,
  effectiveUploadLimitBytes,
  getBillingStatus,
  mockPaymentsEnabled,
  nextUtcMidnightMs,
  releaseFeatureOp,
  reserveFeatureOp,
  resolveSubscription,
  utcDateKey,
} = await import("@/lib/billing/entitlement-service");

const USER = "11111111-1111-4111-8111-411111111111";
const NOW = Date.parse("2026-10-15T12:00:00.000Z");
const NEXT_MIDNIGHT = nextUtcMidnightMs(NOW);
const RUN = "22222222-2222-4222-8222-222222222222";
const ONE_MB = 1024 * 1024;
const MONTHLY_END = "2026-11-15T00:00:00.000Z";

// ---------------------------------------------------------------------------
// Mock harness (call-recording Supabase clients)
// ---------------------------------------------------------------------------

interface Call {
  kind: "query" | "rpc";
  name: string;
  filters?: Record<string, unknown>;
  args?: Record<string, unknown>;
}

type MeterSpec =
  { used: number; resets_at: number | string | null } | { error: true };

interface RpcSpec {
  data?: unknown;
  error?: { message: string } | null;
  throw?: Error;
}

interface MockOptions {
  /** Rows to return for maybeSingle lookups (by table name). */
  single?: (
    table: string,
    filters: Record<string, unknown>,
  ) => Record<string, unknown> | null;
  /** Table whose maybeSingle returns a query error. */
  queryErrorTable?: string;
  /** Table whose maybeSingle throws. */
  throwTable?: string;
  /** Meter readings keyed by feature id (feature_quota/capacity_status). */
  meters?: Record<string, MeterSpec>;
  /** Explicit RPC responses keyed by function name. */
  rpc?: Record<string, RpcSpec>;
}

function makeAdmin(opts: MockOptions = {}) {
  const calls: Call[] = [];
  const from = (table: string) => {
    const filters: Record<string, unknown> = {};
    const chain = {
      select: () => chain,
      eq: (col: string, val: unknown) => {
        filters[col] = val;
        return chain;
      },
      in: () => chain,
      maybeSingle: async () => {
        calls.push({ kind: "query", name: table, filters: { ...filters } });
        if (opts.throwTable === table)
          throw new Error("simulated client failure");
        if (opts.queryErrorTable === table)
          return { data: null, error: { message: "simulated query error" } };
        const row = opts.single ? opts.single(table, { ...filters }) : null;
        return { data: row, error: null };
      },
    };
    return chain;
  };
  const rpc = async (fn: string, args: Record<string, unknown> = {}) => {
    calls.push({ kind: "rpc", name: fn, args: { ...args } });
    const spec = opts.rpc?.[fn];
    if (spec?.throw) throw spec.throw;
    if (spec) return { data: spec.data ?? null, error: spec.error ?? null };
    if (fn === "feature_quota_status" || fn === "feature_capacity_status") {
      const meter = opts.meters?.[String(args["p_feature_id"] ?? "")] ?? {
        used: 0,
        resets_at: null,
      };
      if ("error" in meter)
        return { data: null, error: { message: "simulated meter error" } };
      return {
        data: { used: meter.used, resets_at: meter.resets_at },
        error: null,
      };
    }
    return { data: null, error: { message: "unhandled rpc" } };
  };
  return { from, rpc, calls };
}

function makeUserClient(opts: MockOptions = {}) {
  const calls: Call[] = [];
  const rpc = async (fn: string, args: Record<string, unknown> = {}) => {
    calls.push({ kind: "rpc", name: fn, args: { ...args } });
    const spec = opts.rpc?.[fn];
    if (spec?.throw) throw spec.throw;
    if (spec) return { data: spec.data ?? null, error: spec.error ?? null };
    return { data: null, error: { message: "unhandled rpc" } };
  };
  return { rpc, calls };
}

function install(
  admin: ReturnType<typeof makeAdmin>,
  user: ReturnType<typeof makeUserClient>,
) {
  holder.admin = admin;
  holder.user = user;
}

interface SetupOptions extends MockOptions {
  /** Row for the `subscriptions` maybeSingle (null = never subscribed). */
  sub?: Record<string, unknown> | null;
  /** Row for the `billing_plans` maybeSingle (null = not found). */
  plan?: Record<string, unknown> | null;
  /** emails_sent for today's daily_usage row (null = no row). */
  emailsSent?: number | null;
}

function setup(opts: SetupOptions = {}) {
  const { sub = null, plan = null, emailsSent = null, ...rest } = opts;
  const single: NonNullable<MockOptions["single"]> = (table) => {
    if (table === "subscriptions") return sub;
    if (table === "billing_plans") return plan;
    if (table === "daily_usage")
      return emailsSent === null ? null : { emails_sent: emailsSent };
    return null;
  };
  const admin = makeAdmin({ ...rest, single });
  const user = makeUserClient(rest);
  install(admin, user);
  return { admin, user };
}

const rpcCalls = (calls: Call[], fn: string) =>
  calls.filter((c) => c.kind === "rpc" && c.name === fn);
const queryCalls = (calls: Call[], table: string) =>
  calls.filter((c) => c.kind === "query" && c.name === table);

// ---------------------------------------------------------------------------
// Row builders (mirror the DB shapes the service reads)
// ---------------------------------------------------------------------------

function subRow(
  over: {
    plan?: string;
    status?: string;
    provider?: string | null;
    start?: string | number | null;
    end?: string | number | null;
    canceledAt?: string | null;
    trialAt?: string | null;
  } = {},
) {
  return {
    plan: over.plan ?? "premium_monthly",
    status: over.status ?? "active",
    provider: over.provider ?? "mock",
    current_period_start: over.start ?? "2026-10-15T00:00:00.000Z",
    current_period_end: over.end ?? MONTHLY_END,
    canceled_at: over.canceledAt ?? null,
    trial_activated_at: over.trialAt ?? null,
  };
}

function planRow(
  over: {
    planId?: string;
    emails?: number | null;
    ai?: number | null;
    priceCents?: number | null;
    durationKind?: string | null;
    durationValue?: number | null;
    isCommercial?: boolean | null;
    featureLimits?: Record<string, number | null> | null;
  } = {},
) {
  return {
    plan_id: over.planId ?? "premium_monthly",
    emails_per_day: over.emails ?? null,
    ai_requests_per_day: over.ai ?? null,
    price_cents: over.priceCents ?? null,
    duration_kind: over.durationKind ?? null,
    duration_value: over.durationValue ?? null,
    is_commercial: over.isCommercial ?? null,
    feature_limits: over.featureLimits ?? null,
  };
}

/** A billing_plans row mirroring the TypeScript catalogue (drift guard:
 *  the seed migration must match COMMERCIAL_PLANS). */
function commercialRow(
  id: keyof typeof COMMERCIAL_PLANS,
  over: Record<string, unknown> = {},
) {
  const def = COMMERCIAL_PLANS[id];
  const durationValue =
    def.duration.kind === "fixed_hours"
      ? def.duration.hours
      : def.duration.kind === "fixed_days"
        ? def.duration.days
        : def.duration.kind === "calendar_month"
          ? def.duration.months
          : null;
  return {
    ...planRow({
      planId: id,
      emails: def.emailsPerDay,
      ai: def.aiRequestsPerDay,
      priceCents: def.priceCents,
      durationKind: def.duration.kind,
      durationValue,
      isCommercial: def.isCommercial,
      featureLimits: { ...def.featureLimits } as Record<string, number | null>,
    }),
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Env helper (save/apply/restore, async-safe)
// ---------------------------------------------------------------------------

async function withEnv(
  vars: Record<string, string | undefined>,
  fn: () => unknown,
): Promise<unknown> {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// ---------------------------------------------------------------------------
// resolveSubscription
// ---------------------------------------------------------------------------

describe("resolveSubscription", () => {
  it("no row → 'none' state on the free fallback (NOT a lookup failure)", async () => {
    const { admin } = setup({ sub: null });
    const sub = await resolveSubscription(USER, NOW);
    expect(sub).toMatchObject({
      planId: "free",
      status: "none",
      lookupFailed: false,
      trialUsed: false,
      row: null,
      planRow: null,
      periodStartMs: null,
      periodEndMs: null,
    });
    expect(queryCalls(admin.calls, "subscriptions")).toHaveLength(1);
    expect(queryCalls(admin.calls, "subscriptions")[0].filters).toEqual({
      user_id: USER,
    });
    expect(queryCalls(admin.calls, "billing_plans")).toHaveLength(0);
  });

  it("active premium_monthly with a future end → plan row loaded from DB", async () => {
    const { admin } = setup({
      sub: subRow({ end: MONTHLY_END }),
      plan: commercialRow("premium_monthly"),
    });
    const sub = await resolveSubscription(USER, NOW);
    expect(sub.planId).toBe("premium_monthly");
    expect(sub.status).toBe("active");
    expect(sub.lookupFailed).toBe(false);
    expect(sub.provider).toBe("mock");
    expect(sub.periodEndMs).toBe(Date.parse(MONTHLY_END));
    expect(sub.trialUsed).toBe(false);
    expect(sub.planRow?.feature_limits?.["ai_assistant"]).toBe(200);
    expect(queryCalls(admin.calls, "billing_plans")).toHaveLength(1);
    expect(queryCalls(admin.calls, "billing_plans")[0].filters).toEqual({
      plan_id: "premium_monthly",
    });
  });

  it("trial_activated_at is never cleared → trialUsed true", async () => {
    setup({
      sub: subRow({ plan: "premium_10d", trialAt: "2026-10-01T08:00:00.000Z" }),
      plan: commercialRow("premium_10d"),
    });
    const sub = await resolveSubscription(USER, NOW);
    expect(sub.trialUsed).toBe(true);
    expect(sub.planId).toBe("premium_10d");
  });

  it("active row whose end is already past → 'expired', free fallback, no plan load", async () => {
    const { admin } = setup({
      sub: subRow({ plan: "premium_10d", end: "2026-10-15T11:00:00.000Z" }),
      plan: commercialRow("premium_10d"),
    });
    const sub = await resolveSubscription(USER, NOW);
    expect(sub.status).toBe("expired");
    expect(sub.planId).toBe("free");
    expect(sub.planRow).toBeNull();
    expect(queryCalls(admin.calls, "billing_plans")).toHaveLength(0);
  });

  it("boundary: end exactly at now is already expired (end is exclusive)", async () => {
    setup({
      sub: subRow({
        plan: "premium_monthly",
        end: new Date(NOW).toISOString(),
      }),
      plan: commercialRow("premium_monthly"),
    });
    const sub = await resolveSubscription(USER, NOW);
    expect(sub.status).toBe("expired");
    expect(sub.planId).toBe("free");
  });

  it("'canceled' status is mapped and never loads a plan", async () => {
    const { admin } = setup({
      sub: subRow({
        status: "canceled",
        canceledAt: "2026-10-10T00:00:00.000Z",
      }),
    });
    const sub = await resolveSubscription(USER, NOW);
    expect(sub.status).toBe("canceled");
    expect(sub.planId).toBe("free");
    expect(queryCalls(admin.calls, "billing_plans")).toHaveLength(0);
  });

  it("'expired' DB status is mapped, no plan load", async () => {
    const { admin } = setup({ sub: subRow({ status: "expired" }) });
    const sub = await resolveSubscription(USER, NOW);
    expect(sub.status).toBe("expired");
    expect(sub.planId).toBe("free");
    expect(queryCalls(admin.calls, "billing_plans")).toHaveLength(0);
  });

  it("unknown plan id in a row → free fallback, no plan load", async () => {
    const { admin } = setup({ sub: subRow({ plan: "garbage" }) });
    const sub = await resolveSubscription(USER, NOW);
    expect(sub.status).toBe("active");
    expect(sub.planId).toBe("free");
    expect(queryCalls(admin.calls, "billing_plans")).toHaveLength(0);
  });

  it("subscription query error → lookupFailed (fail closed)", async () => {
    setup({ queryErrorTable: "subscriptions" });
    const sub = await resolveSubscription(USER, NOW);
    expect(sub.lookupFailed).toBe(true);
    expect(sub.planId).toBe("free");
    expect(sub.status).toBe("none");
  });

  it("subscription client throw → lookupFailed (fail closed)", async () => {
    setup({ throwTable: "subscriptions" });
    const sub = await resolveSubscription(USER, NOW);
    expect(sub.lookupFailed).toBe(true);
    expect(sub.planId).toBe("free");
  });

  it("plan-row lookup error on a valid row → lookupFailed, plan stays 'free'", async () => {
    setup({
      sub: subRow({ plan: "pro", provider: "manual" }),
      queryErrorTable: "billing_plans",
    });
    const sub = await resolveSubscription(USER, NOW);
    expect(sub.lookupFailed).toBe(true);
    expect(sub.planId).toBe("free");
    expect(sub.planRow).toBeNull();
  });

  it("numeric (epoch ms) timestamps are parsed", async () => {
    setup({
      sub: subRow({
        start: Date.parse("2026-10-01T00:00:00.000Z"),
        end: Date.parse(MONTHLY_END),
      }),
      plan: commercialRow("premium_monthly"),
    });
    const sub = await resolveSubscription(USER, NOW);
    expect(sub.periodStartMs).toBe(Date.parse("2026-10-01T00:00:00.000Z"));
    expect(sub.periodEndMs).toBe(Date.parse(MONTHLY_END));
  });
});

// ---------------------------------------------------------------------------
// checkFeature — free fallback (no subscription row)
// ---------------------------------------------------------------------------

describe("checkFeature — free fallback", () => {
  it("ai_assistant below the limit → allowed, resets at next UTC midnight", async () => {
    const { admin } = setup({
      meters: { ai_assistant: { used: 3, resets_at: null } },
    });
    const e = await checkFeature(USER, "ai_assistant", NOW);
    expect(e).toMatchObject({
      allowed: true,
      reason: "ok",
      planId: "free",
      featureId: "ai_assistant",
      limit: 100,
      used: 3,
      remaining: 97,
      resetsAt: NEXT_MIDNIGHT,
      subscriptionExpiresAt: null,
    });
    expect(rpcCalls(admin.calls, "feature_quota_status")).toHaveLength(1);
    expect(rpcCalls(admin.calls, "feature_quota_status")[0].args).toEqual({
      p_user_id: USER,
      p_feature_id: "ai_assistant",
    });
  });

  it("honors a server-computed resets_at (string) over the default", async () => {
    setup({
      meters: {
        ai_assistant: { used: 3, resets_at: "2026-10-15T22:00:00.000Z" },
      },
    });
    const e = await checkFeature(USER, "ai_assistant", NOW);
    expect(e.resetsAt).toBe(Date.parse("2026-10-15T22:00:00.000Z"));
  });

  it("ai_assistant at the limit → quota_exhausted, remaining 0", async () => {
    setup({ meters: { ai_assistant: { used: 100, resets_at: null } } });
    const e = await checkFeature(USER, "ai_assistant", NOW);
    expect(e).toMatchObject({
      allowed: false,
      reason: "quota_exhausted",
      limit: 100,
      used: 100,
      remaining: 0,
    });
  });

  it("unreadable meter → lookup_error WITH the known limit (fail closed, not free)", async () => {
    setup({ meters: { ai_assistant: { error: true } } });
    const e = await checkFeature(USER, "ai_assistant", NOW);
    expect(e).toMatchObject({
      allowed: false,
      reason: "lookup_error",
      limit: 100,
      used: 0,
      remaining: 0,
    });
  });

  it("cover_letter on free → feature_disabled (no canonical free value — fail closed)", async () => {
    const { admin } = setup();
    const e = await checkFeature(USER, "cover_letter", NOW);
    expect(e).toMatchObject({
      allowed: false,
      reason: "feature_disabled",
      limit: 0,
      used: 0,
      remaining: 0,
    });
    expect(rpcCalls(admin.calls, "feature_quota_status")).toHaveLength(0);
    expect(rpcCalls(admin.calls, "feature_capacity_status")).toHaveLength(0);
  });

  it("EVERY non-commercial feature is explicitly disabled on free (2026-10-24 fix: Free is never unlimited)", async () => {
    setup();
    for (const featureId of [
      "cover_letter",
      "resume_ai",
      "scanner",
      "email_drafts",
      "opportunity_search",
      "saved_opportunities",
      "saved_applications",
      "automation",
    ] as const) {
      const e = await checkFeature(USER, featureId, NOW);
      expect(e, featureId).toMatchObject({
        allowed: false,
        reason: "feature_disabled",
        limit: 0,
      });
    }
    // The explicitly DEFINED free entitlements stay available:
    const ai = await checkFeature(USER, "ai_assistant", NOW);
    expect(ai).toMatchObject({ allowed: true, limit: 100 });
    const deck = await checkFeature(USER, "deckblatt", NOW);
    expect(deck).toMatchObject({ allowed: true, limit: 2 });
    const upload = await checkFeature(USER, "upload", NOW);
    expect(upload).toMatchObject({ allowed: true, limit: 10 });
    const salary = await checkFeature(USER, "salary_calculator", NOW);
    expect(salary).toMatchObject({ allowed: true, limit: null });
  });

  it("automation on free → feature_disabled (commercial only)", async () => {
    const { admin } = setup();
    const e = await checkFeature(USER, "automation", NOW);
    expect(e).toMatchObject({
      allowed: false,
      reason: "feature_disabled",
      limit: 0,
      used: 0,
      remaining: 0,
    });
    expect(rpcCalls(admin.calls, "feature_quota_status")).toHaveLength(0);
  });

  it("salary_calculator → always allowed, never metered", async () => {
    const { admin } = setup();
    const e = await checkFeature(USER, "salary_calculator", NOW);
    expect(e).toMatchObject({
      allowed: true,
      reason: "ok",
      limit: null,
      used: 0,
      remaining: null,
    });
    expect(rpcCalls(admin.calls, "feature_quota_status")).toHaveLength(0);
    expect(admin.calls.filter((c) => c.kind === "rpc")).toHaveLength(0);
  });

  it("upload on free → allowed with the legacy 10 MB cap", async () => {
    setup();
    const e = await checkFeature(USER, "upload", NOW);
    expect(e).toMatchObject({
      allowed: true,
      reason: "ok",
      limit: 10,
      used: 0,
      remaining: null,
    });
  });

  it("unknown feature id → unknown_feature (never granted)", async () => {
    setup();
    const e = await checkFeature(USER, "bogus" as never, NOW);
    expect(e).toMatchObject({ allowed: false, reason: "unknown_feature" });
  });
});

// ---------------------------------------------------------------------------
// checkFeature — active premium_monthly (limits come from the DB row)
// ---------------------------------------------------------------------------

describe("checkFeature — active premium_monthly", () => {
  const base: SetupOptions = {
    sub: subRow({ end: MONTHLY_END }),
    plan: commercialRow("premium_monthly"),
  };
  const END_MS = Date.parse(MONTHLY_END);

  it("ai_assistant limit comes from feature_limits (200), not the TS catalogue", async () => {
    setup({
      ...base,
      meters: { ai_assistant: { used: 150, resets_at: null } },
    });
    const e = await checkFeature(USER, "ai_assistant", NOW);
    expect(e).toMatchObject({
      allowed: true,
      reason: "ok",
      planId: "premium_monthly",
      limit: 200,
      used: 150,
      remaining: 50,
      resetsAt: NEXT_MIDNIGHT,
      subscriptionExpiresAt: END_MS,
    });
  });

  it("ai_assistant at 200 → quota_exhausted", async () => {
    setup({
      ...base,
      meters: { ai_assistant: { used: 200, resets_at: null } },
    });
    const e = await checkFeature(USER, "ai_assistant", NOW);
    expect(e).toMatchObject({
      allowed: false,
      reason: "quota_exhausted",
      limit: 200,
      remaining: 0,
    });
  });

  it("resume_ai is per-cycle: 60/60 stays exhausted until the period end", async () => {
    setup({ ...base, meters: { resume_ai: { used: 60, resets_at: null } } });
    const e = await checkFeature(USER, "resume_ai", NOW);
    expect(e).toMatchObject({
      allowed: false,
      reason: "quota_exhausted",
      limit: 60,
      used: 60,
      remaining: 0,
      resetsAt: END_MS,
    });
  });

  it("resume_ai 59/60 → one left, resets at the period end", async () => {
    setup({ ...base, meters: { resume_ai: { used: 59, resets_at: null } } });
    const e = await checkFeature(USER, "resume_ai", NOW);
    expect(e).toMatchObject({
      allowed: true,
      reason: "ok",
      remaining: 1,
      resetsAt: END_MS,
    });
  });

  it("saved_opportunities uses the CAPACITY meter (not the quota meter)", async () => {
    const { admin } = setup({
      ...base,
      meters: { saved_opportunities: { used: 2, resets_at: null } },
    });
    const e = await checkFeature(USER, "saved_opportunities", NOW);
    expect(e).toMatchObject({
      allowed: true,
      reason: "ok",
      limit: 500,
      used: 2,
      remaining: 498,
      resetsAt: null,
    });
    expect(rpcCalls(admin.calls, "feature_capacity_status")).toHaveLength(1);
    expect(rpcCalls(admin.calls, "feature_quota_status")).toHaveLength(0);
  });

  it("automation 249/250 → one left; 250/250 → exhausted", async () => {
    setup({ ...base, meters: { automation: { used: 249, resets_at: null } } });
    const almost = await checkFeature(USER, "automation", NOW);
    expect(almost).toMatchObject({ allowed: true, remaining: 1, limit: 250 });

    setup({ ...base, meters: { automation: { used: 250, resets_at: null } } });
    const full = await checkFeature(USER, "automation", NOW);
    expect(full).toMatchObject({
      allowed: false,
      reason: "quota_exhausted",
      limit: 250,
      remaining: 0,
      resetsAt: NEXT_MIDNIGHT,
    });
  });

  it("salary_calculator stays unmetered on commercial plans", async () => {
    setup(base);
    const e = await checkFeature(USER, "salary_calculator", NOW);
    expect(e).toMatchObject({ allowed: true, reason: "ok", limit: null });
  });

  it("upload cap is plan-aware (15 MB monthly)", async () => {
    setup(base);
    const e = await checkFeature(USER, "upload", NOW);
    expect(e).toMatchObject({ allowed: true, limit: 15 });
  });

  it("a missing feature_limits key means UNMETERED, not a crash (legacy-style gap)", async () => {
    setup({
      ...base,
      plan: commercialRow("premium_monthly", { feature_limits: {} }),
    });
    const e = await checkFeature(USER, "cover_letter", NOW);
    expect(e).toMatchObject({
      allowed: true,
      reason: "ok_legacy_unmetered",
      limit: null,
    });
  });
});

// ---------------------------------------------------------------------------
// checkFeature — trial (72 h) and expired-trial revocation
// ---------------------------------------------------------------------------

describe("checkFeature — trial", () => {
  const trialBase: SetupOptions = {
    sub: subRow({
      plan: "trial",
      start: "2026-10-14T09:15:00.000Z",
      end: "2026-10-17T09:15:00.000Z",
      trialAt: "2026-10-14T09:15:00.000Z",
    }),
    plan: commercialRow("trial"),
  };

  it("active trial: AI is metered at 5/day and automation is disabled", async () => {
    setup({
      ...trialBase,
      meters: { ai_assistant: { used: 5, resets_at: null } },
    });
    const ai = await checkFeature(USER, "ai_assistant", NOW);
    expect(ai).toMatchObject({
      allowed: false,
      reason: "quota_exhausted",
      planId: "trial",
      limit: 5,
      used: 5,
      remaining: 0,
    });

    const auto = await checkFeature(USER, "automation", NOW);
    expect(auto).toMatchObject({
      allowed: false,
      reason: "feature_disabled",
      limit: 0,
    });
  });

  it("trial expiry revokes paid features via the timestamp alone (no job)", async () => {
    setup({
      sub: subRow({
        plan: "trial",
        start: "2026-10-12T09:15:00.000Z",
        end: "2026-10-15T11:59:59.000Z", // 1 s before NOW
        trialAt: "2026-10-12T09:15:00.000Z",
      }),
      plan: commercialRow("trial"),
    });
    const ai = await checkFeature(USER, "ai_assistant", NOW);
    expect(ai).toMatchObject({
      allowed: true,
      planId: "free",
      limit: 100, // back on the free fallback
    });

    const auto = await checkFeature(USER, "automation", NOW);
    expect(auto).toMatchObject({
      allowed: false,
      reason: "plan_expired",
      limit: 0,
    });

    const upload = await checkFeature(USER, "upload", NOW);
    expect(upload).toMatchObject({ limit: 10 });
  });

  it("a trial that has run out of time still reports trialUsed (no restart)", async () => {
    const { admin } = setup({
      sub: subRow({
        plan: "trial",
        start: "2026-10-12T09:15:00.000Z",
        end: "2026-10-15T11:59:59.000Z",
        trialAt: "2026-10-12T09:15:00.000Z",
      }),
    });
    const sub = await resolveSubscription(USER, NOW);
    expect(sub.trialUsed).toBe(true);
    expect(sub.status).toBe("expired");
    expect(queryCalls(admin.calls, "subscriptions")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// checkFeature — legacy plus (backward compatibility)
// ---------------------------------------------------------------------------

describe("checkFeature — legacy plus", () => {
  const plusBase: SetupOptions = {
    sub: subRow({
      plan: "plus",
      provider: "manual",
      start: "2026-09-01T00:00:00.000Z",
      end: "2026-10-31T00:00:00.000Z",
    }),
    plan: planRow({ planId: "plus", emails: 150, ai: 400 }),
  };

  it("ai limit comes from the legacy billing_plans column (400)", async () => {
    setup({
      ...plusBase,
      meters: { ai_assistant: { used: 0, resets_at: null } },
    });
    const e = await checkFeature(USER, "ai_assistant", NOW);
    expect(e).toMatchObject({
      allowed: true,
      planId: "plus",
      limit: 400,
      remaining: 400,
    });
  });

  it("deckblatt keeps its historic 2/day on legacy plans", async () => {
    setup({ ...plusBase, meters: { deckblatt: { used: 1, resets_at: null } } });
    const e = await checkFeature(USER, "deckblatt", NOW);
    expect(e).toMatchObject({ allowed: true, limit: 2, used: 1, remaining: 1 });
  });

  it("other spec features are disabled on legacy plus (explicit non-commercial matrix, 2026-10-24 fix)", async () => {
    setup(plusBase);
    for (const featureId of ["cover_letter", "resume_ai", "scanner"] as const) {
      const e = await checkFeature(USER, featureId, NOW);
      expect(e).toMatchObject({
        allowed: false,
        reason: "feature_disabled",
        limit: 0,
      });
    }
  });

  it("automation is disabled on legacy plus (commercial-only feature)", async () => {
    setup(plusBase);
    const e = await checkFeature(USER, "automation", NOW);
    expect(e).toMatchObject({
      allowed: false,
      reason: "feature_disabled",
      limit: 0,
    });
  });

  it("upload keeps the legacy 10 MB on plus", async () => {
    setup(plusBase);
    const e = await checkFeature(USER, "upload", NOW);
    expect(e).toMatchObject({ allowed: true, limit: 10 });
  });

  it("salary_calculator is available on plus", async () => {
    setup(plusBase);
    const e = await checkFeature(USER, "salary_calculator", NOW);
    expect(e).toMatchObject({ allowed: true, reason: "ok", limit: null });
  });
});

// ---------------------------------------------------------------------------
// Fail-closed behavior when the subscription cannot be verified
// ---------------------------------------------------------------------------

describe("fail-closed on lookup failure", () => {
  it("metered features are denied with lookup_error (limit 0, not 'unlimited')", async () => {
    setup({ throwTable: "subscriptions" });
    const e = await checkFeature(USER, "ai_assistant", NOW);
    expect(e).toMatchObject({
      allowed: false,
      reason: "lookup_error",
      planId: "free",
      limit: 0,
      used: 0,
      remaining: 0,
      resetsAt: null,
    });
  });

  it("automation is denied too (a DB failure must not enable it)", async () => {
    setup({ throwTable: "subscriptions" });
    const e = await checkFeature(USER, "automation", NOW);
    expect(e).toMatchObject({
      allowed: false,
      reason: "lookup_error",
      limit: 0,
    });
  });

  it("the quota-free salary calculator stays available", async () => {
    setup({ throwTable: "subscriptions" });
    const e = await checkFeature(USER, "salary_calculator", NOW);
    expect(e).toMatchObject({ allowed: true, reason: "ok", limit: null });
  });

  it("the upload cap degrades to the legacy 10 MB — never an upgrade", async () => {
    setup({ throwTable: "subscriptions" });
    const e = await checkFeature(USER, "upload", NOW);
    expect(e).toMatchObject({ allowed: true, limit: 10 });
  });
});

// ---------------------------------------------------------------------------
// Mock-payment environment gate
// ---------------------------------------------------------------------------

describe("mockPaymentsEnabled", () => {
  it("disabled when the flag is unset", async () => {
    await withEnv(
      {
        MOCK_PAYMENTS_ENABLED: undefined,
        NODE_ENV: "development",
        VERCEL_ENV: undefined,
      },
      () => expect(mockPaymentsEnabled()).toBe(false),
    );
  });

  it("disabled when the flag is not exactly the string 'true' (case-sensitive)", async () => {
    for (const value of ["TRUE", "false", "1", " yes"]) {
      await withEnv(
        {
          MOCK_PAYMENTS_ENABLED: value,
          NODE_ENV: "development",
          VERCEL_ENV: undefined,
        },
        () => expect(mockPaymentsEnabled()).toBe(false),
      );
    }
  });

  it("enabled in a local dev runtime when the flag is set", async () => {
    await withEnv(
      {
        MOCK_PAYMENTS_ENABLED: "true",
        NODE_ENV: "development",
        VERCEL_ENV: undefined,
      },
      () => expect(mockPaymentsEnabled()).toBe(true),
    );
  });

  it("enabled in the test runtime when the flag is set", async () => {
    await withEnv(
      {
        MOCK_PAYMENTS_ENABLED: "true",
        NODE_ENV: "test",
        VERCEL_ENV: undefined,
      },
      () => expect(mockPaymentsEnabled()).toBe(true),
    );
  });

  it("REJECTED in production even if VERCEL_ENV says preview", async () => {
    await withEnv(
      {
        MOCK_PAYMENTS_ENABLED: "true",
        NODE_ENV: "production",
        VERCEL_ENV: "preview",
      },
      () => expect(mockPaymentsEnabled()).toBe(false),
    );
  });

  it("REJECTED when VERCEL_ENV is production, even in a dev runtime", async () => {
    await withEnv(
      {
        MOCK_PAYMENTS_ENABLED: "true",
        NODE_ENV: "development",
        VERCEL_ENV: "production",
      },
      () => expect(mockPaymentsEnabled()).toBe(false),
    );
  });

  it("enabled on a Vercel preview deployment when the flag is set", async () => {
    await withEnv(
      {
        MOCK_PAYMENTS_ENABLED: "true",
        NODE_ENV: undefined,
        VERCEL_ENV: "preview",
      },
      () => expect(mockPaymentsEnabled()).toBe(true),
    );
  });

  it("REJECTED when the runtime is unambiguous only (no dev/test/preview marker)", async () => {
    await withEnv(
      {
        MOCK_PAYMENTS_ENABLED: "true",
        NODE_ENV: undefined,
        VERCEL_ENV: undefined,
      },
      () => expect(mockPaymentsEnabled()).toBe(false),
    );
  });
});

// ---------------------------------------------------------------------------
// reserveFeatureOp
// ---------------------------------------------------------------------------

describe("reserveFeatureOp", () => {
  it("ai (free fallback): success → 'reserved' with server-side args only", async () => {
    const { admin } = setup({
      sub: null,
      rpc: { reserve_ai_request: { data: null } },
    });
    const result = await reserveFeatureOp(USER, "ai_assistant", RUN, NOW);
    expect(result).toEqual({ outcome: "reserved" });
    const calls = rpcCalls(admin.calls, "reserve_ai_request");
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual({ target_user_id: USER, max_requests: 100 });
  });

  it("ai: 'ai_daily_limit_reached' error → 'quota_exhausted'", async () => {
    setup({
      sub: null,
      rpc: {
        reserve_ai_request: {
          error: { message: "ai_daily_limit_reached (100/100)" },
        },
      },
    });
    const result = await reserveFeatureOp(USER, "ai_assistant", RUN, NOW);
    expect(result).toEqual({ outcome: "quota_exhausted" });
  });

  it("ai: any other RPC error → 'error' (never a reservation)", async () => {
    setup({
      sub: null,
      rpc: { reserve_ai_request: { error: { message: "boom" } } },
    });
    const result = await reserveFeatureOp(USER, "ai_assistant", RUN, NOW);
    expect(result).toEqual({
      outcome: "error",
      message: "AI usage is unavailable.",
    });
  });

  it("ai: a throwing RPC client → 'error' via the outer catch", async () => {
    setup({
      sub: null,
      rpc: { reserve_ai_request: { throw: new Error("network") } },
    });
    const result = await reserveFeatureOp(USER, "ai_assistant", RUN, NOW);
    expect(result).toEqual({
      outcome: "error",
      message: "Feature quota is unavailable.",
    });
  });

  it("free cover letter → 'feature_disabled' before any meter RPC (2026-10-24 fix)", async () => {
    const { admin } = setup({ sub: null });
    const result = await reserveFeatureOp(USER, "cover_letter", RUN, NOW);
    expect(result).toEqual({ outcome: "feature_disabled" });
    expect(rpcCalls(admin.calls, "reserve_feature_op")).toHaveLength(0);
    expect(queryCalls(admin.calls, "subscriptions")).toHaveLength(1);
  });

  it("trial: automation is 'feature_disabled' before any meter call", async () => {
    const { admin } = setup({
      sub: subRow({
        plan: "trial",
        start: "2026-10-14T00:00:00.000Z",
        end: "2026-10-17T00:00:00.000Z",
      }),
      plan: commercialRow("trial"),
    });
    const result = await reserveFeatureOp(USER, "automation", RUN, NOW);
    expect(result).toEqual({ outcome: "feature_disabled" });
    expect(rpcCalls(admin.calls, "reserve_feature_op")).toHaveLength(0);
  });

  it("generic (monthly cover letter): 'reserved' with exact server-side args", async () => {
    const { admin } = setup({
      sub: subRow(),
      plan: commercialRow("premium_monthly"),
      rpc: {
        reserve_feature_op: {
          data: [{ status: "reserved", used: 1, remaining: 24 }],
        },
      },
    });
    const result = await reserveFeatureOp(USER, "cover_letter", RUN, NOW);
    expect(result).toEqual({ outcome: "reserved" });
    const calls = rpcCalls(admin.calls, "reserve_feature_op");
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual({
      p_user_id: USER,
      p_feature_id: "cover_letter",
      p_run_id: RUN,
    });
  });

  it.each([["already_reserved"], ["quota_exhausted"], ["unmetered"]])(
    "generic: RPC status %s passes through 1:1",
    async (status) => {
      setup({
        sub: subRow(),
        plan: commercialRow("premium_monthly"),
        rpc: { reserve_feature_op: { data: [{ status }] } },
      });
      const result = await reserveFeatureOp(USER, "cover_letter", RUN, NOW);
      expect(result).toEqual({ outcome: status });
    },
  );

  it("generic: an unknown RPC status → 'error' (fail closed)", async () => {
    setup({
      sub: subRow(),
      plan: commercialRow("premium_monthly"),
      rpc: { reserve_feature_op: { data: [{ status: "weird" }] } },
    });
    const result = await reserveFeatureOp(USER, "cover_letter", RUN, NOW);
    expect(result).toEqual({
      outcome: "error",
      message: "Feature quota is unavailable.",
    });
  });

  it("generic: RPC error → 'error'", async () => {
    setup({
      sub: subRow(),
      plan: commercialRow("premium_monthly"),
      rpc: { reserve_feature_op: { error: { message: "boom" } } },
    });
    const result = await reserveFeatureOp(USER, "cover_letter", RUN, NOW);
    expect(result).toEqual({
      outcome: "error",
      message: "Feature quota is unavailable.",
    });
  });

  it("deckblatt: routed to the USER session client with target_user_id + run_id", async () => {
    const { user } = setup({
      sub: subRow(),
      plan: commercialRow("premium_monthly"),
      rpc: {
        reserve_deckblatt_generation: {
          data: [{ status: "reserved", used: 1, remaining: 29 }],
        },
      },
    });
    const result = await reserveFeatureOp(USER, "deckblatt", RUN, NOW);
    expect(result).toEqual({ outcome: "reserved" });
    const calls = rpcCalls(user.calls, "reserve_deckblatt_generation");
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual({ target_user_id: USER, p_run_id: RUN });
  });

  it("deckblatt: 'quota_exhausted' status passes through", async () => {
    setup({
      sub: subRow(),
      plan: commercialRow("premium_monthly"),
      rpc: {
        reserve_deckblatt_generation: { data: [{ status: "quota_exhausted" }] },
      },
    });
    const result = await reserveFeatureOp(USER, "deckblatt", RUN, NOW);
    expect(result).toEqual({ outcome: "quota_exhausted" });
  });

  it("deckblatt: RPC error → 'error'", async () => {
    setup({
      sub: subRow(),
      plan: commercialRow("premium_monthly"),
      rpc: { reserve_deckblatt_generation: { error: { message: "boom" } } },
    });
    const result = await reserveFeatureOp(USER, "deckblatt", RUN, NOW);
    expect(result).toEqual({
      outcome: "error",
      message: "Feature quota is unavailable.",
    });
  });

  it("items feature → 'error' with the documented reason and ZERO data calls", async () => {
    const { admin, user } = setup({
      sub: subRow(),
      plan: commercialRow("premium_monthly"),
    });
    const result = await reserveFeatureOp(
      USER,
      "saved_opportunities",
      RUN,
      NOW,
    );
    expect(result).toEqual({
      outcome: "error",
      message:
        "Capacity-limited features are checked before insert; they are not reserved.",
    });
    expect(admin.calls).toHaveLength(0);
    expect(user.calls).toHaveLength(0);
  });

  it("salary calculator → 'unmetered' with ZERO data calls", async () => {
    const { admin, user } = setup({
      sub: subRow(),
      plan: commercialRow("premium_monthly"),
    });
    const result = await reserveFeatureOp(USER, "salary_calculator", RUN, NOW);
    expect(result).toEqual({ outcome: "unmetered" });
    expect(admin.calls).toHaveLength(0);
    expect(user.calls).toHaveLength(0);
  });

  it("subscription lookup failure → 'error' (fail closed, never a reservation)", async () => {
    setup({ throwTable: "subscriptions" });
    const result = await reserveFeatureOp(USER, "cover_letter", RUN, NOW);
    expect(result).toEqual({
      outcome: "error",
      message: "Subscription state could not be verified.",
    });
  });
});

// ---------------------------------------------------------------------------
// completeFeatureOp
// ---------------------------------------------------------------------------

describe("completeFeatureOp", () => {
  it("ai: no-op by design (the reservation is final) with ZERO data calls", async () => {
    const { admin, user } = setup({ sub: null });
    const result = await completeFeatureOp(USER, "ai_assistant", RUN);
    expect(result).toEqual({ outcome: "no_op" });
    expect(admin.calls).toHaveLength(0);
    expect(user.calls).toHaveLength(0);
  });

  it("salary: no-op with ZERO data calls", async () => {
    const { admin, user } = setup({ sub: null });
    const result = await completeFeatureOp(USER, "salary_calculator", RUN);
    expect(result).toEqual({ outcome: "no_op" });
    expect(admin.calls).toHaveLength(0);
    expect(user.calls).toHaveLength(0);
  });

  it("generic: RPC status 'completed' → 'completed' with exact args", async () => {
    const { admin } = setup({
      sub: subRow(),
      plan: commercialRow("premium_monthly"),
      rpc: { complete_feature_op: { data: { status: "completed" } } },
    });
    const result = await completeFeatureOp(USER, "cover_letter", RUN);
    expect(result).toEqual({ outcome: "completed" });
    const calls = rpcCalls(admin.calls, "complete_feature_op");
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual({ p_user_id: USER, p_run_id: RUN });
  });

  it("generic: RPC status 'no_op' → 'no_op'", async () => {
    setup({
      sub: subRow(),
      plan: commercialRow("premium_monthly"),
      rpc: { complete_feature_op: { data: { status: "no_op" } } },
    });
    const result = await completeFeatureOp(USER, "cover_letter", RUN);
    expect(result).toEqual({ outcome: "no_op" });
  });

  it("generic: RPC error → 'error'", async () => {
    setup({
      sub: subRow(),
      plan: commercialRow("premium_monthly"),
      rpc: { complete_feature_op: { error: { message: "boom" } } },
    });
    const result = await completeFeatureOp(USER, "cover_letter", RUN);
    expect(result).toEqual({ outcome: "error" });
  });

  it("deckblatt: routed to the USER session client; success → 'completed'", async () => {
    const { user } = setup({
      sub: subRow(),
      plan: commercialRow("premium_monthly"),
      rpc: { complete_deckblatt_generation: { data: null } },
    });
    const result = await completeFeatureOp(USER, "deckblatt", RUN);
    expect(result).toEqual({ outcome: "completed" });
    const calls = rpcCalls(user.calls, "complete_deckblatt_generation");
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual({ target_user_id: USER, p_run_id: RUN });
  });

  it("deckblatt: RPC error → 'error'", async () => {
    setup({
      sub: subRow(),
      plan: commercialRow("premium_monthly"),
      rpc: { complete_deckblatt_generation: { error: { message: "boom" } } },
    });
    const result = await completeFeatureOp(USER, "deckblatt", RUN);
    expect(result).toEqual({ outcome: "error" });
  });
});

// ---------------------------------------------------------------------------
// releaseFeatureOp (failure reconciliation)
// ---------------------------------------------------------------------------

describe("releaseFeatureOp", () => {
  it("ai: refund → 'released' with server-side args only", async () => {
    const { admin } = setup({
      rpc: { release_ai_request: { data: "released" } },
    });
    const result = await releaseFeatureOp(USER, "ai_assistant");
    expect(result).toEqual({ outcome: "released" });
    const calls = rpcCalls(admin.calls, "release_ai_request");
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual({ target_user_id: USER });
  });

  it("ai: RPC 'no_op' (nothing to refund) → 'no_op'", async () => {
    setup({ rpc: { release_ai_request: { data: "no_op" } } });
    const result = await releaseFeatureOp(USER, "ai_assistant");
    expect(result).toEqual({ outcome: "no_op" });
  });

  it("ai: refund error → 'no_op' + retained-usage message (never throws)", async () => {
    setup({ rpc: { release_ai_request: { error: { message: "boom" } } } });
    const result = await releaseFeatureOp(USER, "ai_assistant");
    expect(result).toEqual({
      outcome: "no_op",
      message: "Usage refund failed; the consumed request is retained.",
    });
  });

  it("ai: refund throw → 'no_op' + retained-usage message (outer catch)", async () => {
    setup({ rpc: { release_ai_request: { throw: new Error("network") } } });
    const result = await releaseFeatureOp(USER, "ai_assistant");
    expect(result).toEqual({
      outcome: "no_op",
      message: "Usage refund failed; the consumed request is retained.",
    });
  });

  it("generic without runId → 'no_op' with ZERO data calls", async () => {
    const { admin, user } = setup({
      sub: subRow(),
      plan: commercialRow("premium_monthly"),
    });
    const result = await releaseFeatureOp(USER, "cover_letter");
    expect(result).toEqual({ outcome: "no_op" });
    expect(admin.calls).toHaveLength(0);
    expect(user.calls).toHaveLength(0);
  });

  it("generic with runId: 'released' status → 'released' with exact args", async () => {
    const { admin } = setup({
      sub: subRow(),
      plan: commercialRow("premium_monthly"),
      rpc: { release_feature_op: { data: [{ status: "released" }] } },
    });
    const result = await releaseFeatureOp(USER, "cover_letter", RUN);
    expect(result).toEqual({ outcome: "released" });
    const calls = rpcCalls(admin.calls, "release_feature_op");
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual({ p_user_id: USER, p_run_id: RUN });
  });

  it("generic with runId: 'no_op' status → 'no_op'", async () => {
    setup({
      sub: subRow(),
      plan: commercialRow("premium_monthly"),
      rpc: { release_feature_op: { data: [{ status: "no_op" }] } },
    });
    const result = await releaseFeatureOp(USER, "cover_letter", RUN);
    expect(result).toEqual({ outcome: "no_op" });
  });

  it("generic with runId: RPC error → 'error'", async () => {
    setup({
      sub: subRow(),
      plan: commercialRow("premium_monthly"),
      rpc: { release_feature_op: { error: { message: "boom" } } },
    });
    const result = await releaseFeatureOp(USER, "cover_letter", RUN);
    expect(result).toEqual({ outcome: "error" });
  });

  it("deckblatt: 'released' status via the USER session client", async () => {
    const { user } = setup({
      sub: subRow(),
      plan: commercialRow("premium_monthly"),
      rpc: { release_deckblatt_generation: { data: [{ status: "released" }] } },
    });
    const result = await releaseFeatureOp(USER, "deckblatt", RUN);
    expect(result).toEqual({ outcome: "released" });
    expect(
      rpcCalls(user.calls, "release_deckblatt_generation")[0].args,
    ).toEqual({
      target_user_id: USER,
      p_run_id: RUN,
    });
  });

  it("deckblatt without runId → 'no_op' with ZERO data calls", async () => {
    const { user } = setup({
      sub: subRow(),
      plan: commercialRow("premium_monthly"),
    });
    const result = await releaseFeatureOp(USER, "deckblatt");
    expect(result).toEqual({ outcome: "no_op" });
    expect(user.calls).toHaveLength(0);
  });

  it("deckblatt: RPC error → 'error'", async () => {
    setup({
      sub: subRow(),
      plan: commercialRow("premium_monthly"),
      rpc: { release_deckblatt_generation: { error: { message: "boom" } } },
    });
    const result = await releaseFeatureOp(USER, "deckblatt", RUN);
    expect(result).toEqual({ outcome: "error" });
  });

  it("items and salary features → 'no_op' with ZERO data calls", async () => {
    for (const featureId of [
      "saved_opportunities",
      "salary_calculator",
    ] as const) {
      const { admin, user } = setup({
        sub: subRow(),
        plan: commercialRow("premium_monthly"),
      });
      const result = await releaseFeatureOp(USER, featureId, RUN);
      expect(result).toEqual({ outcome: "no_op" });
      expect(admin.calls).toHaveLength(0);
      expect(user.calls).toHaveLength(0);
    }
  });
});

// ---------------------------------------------------------------------------
// effectiveUploadLimitBytes
// ---------------------------------------------------------------------------

describe("effectiveUploadLimitBytes", () => {
  it("no subscription → legacy 10 MB", async () => {
    setup({ sub: null });
    expect(await effectiveUploadLimitBytes(USER, NOW)).toBe(10 * ONE_MB);
  });

  it("active trial → 2 MB (plan row required)", async () => {
    setup({
      sub: subRow({
        plan: "trial",
        start: "2026-10-14T00:00:00.000Z",
        end: "2026-10-17T00:00:00.000Z",
      }),
      plan: commercialRow("trial"),
    });
    expect(await effectiveUploadLimitBytes(USER, NOW)).toBe(2 * ONE_MB);
  });

  it("active premium_10d → 15 MB", async () => {
    setup({
      sub: subRow({
        plan: "premium_10d",
        start: "2026-10-10T00:00:00.000Z",
        end: "2026-10-20T00:00:00.000Z",
      }),
      plan: commercialRow("premium_10d"),
    });
    expect(await effectiveUploadLimitBytes(USER, NOW)).toBe(15 * ONE_MB);
  });

  it("active premium_monthly → 15 MB", async () => {
    setup({ sub: subRow(), plan: commercialRow("premium_monthly") });
    expect(await effectiveUploadLimitBytes(USER, NOW)).toBe(15 * ONE_MB);
  });

  it("legacy plus → historic 10 MB", async () => {
    setup({ sub: subRow({ plan: "plus" }), plan: planRow({ planId: "plus" }) });
    expect(await effectiveUploadLimitBytes(USER, NOW)).toBe(10 * ONE_MB);
  });

  it("lookup failure → 10 MB fallback (never an upgrade)", async () => {
    setup({ throwTable: "subscriptions" });
    expect(await effectiveUploadLimitBytes(USER, NOW)).toBe(10 * ONE_MB);
  });
});

// ---------------------------------------------------------------------------
// getBillingStatus (billing page aggregate — one lookup, not N+1)
// ---------------------------------------------------------------------------

describe("getBillingStatus", () => {
  it("happy path: full feature matrix from ONE subscriptions lookup", async () => {
    const { admin } = setup({
      sub: subRow({ end: MONTHLY_END }),
      plan: commercialRow("premium_monthly"),
      emailsSent: 7,
      meters: { ai_assistant: { used: 150, resets_at: null } },
    });
    // withEnv returns the callback's value (Promise<unknown>); a single
    // explicit cast from unknown keeps the flow type honest (no null branch).
    const s = (await withEnv(
      {
        MOCK_PAYMENTS_ENABLED: undefined,
        NODE_ENV: "test",
        VERCEL_ENV: undefined,
      },
      () => getBillingStatus(USER, NOW),
    )) as Awaited<ReturnType<typeof getBillingStatus>>;

    expect(s).toMatchObject({
      planId: "premium_monthly",
      planLabel: "Premium Monthly",
      status: "active",
      provider: "mock",
      trialUsed: false,
      lookupFailed: false,
      mockPaymentsEnabled: false,
      aiPerDay: 200,
      emailsPerDay: 250,
      emailsUsedToday: 7,
      periodEndMs: Date.parse(MONTHLY_END),
    });

    // Exactly ONE subscriptions query (no N+1 across the 12 features).
    const subQueries = queryCalls(admin.calls, "subscriptions");
    expect(subQueries).toHaveLength(1);
    // Daily email counter read by UTC date key.
    const usageQueries = queryCalls(admin.calls, "daily_usage");
    expect(usageQueries).toHaveLength(1);
    expect(usageQueries[0].filters).toEqual({
      user_id: USER,
      date: utcDateKey(NOW),
    });

    // Every feature id is present in the matrix.
    for (const id of ALL_FEATURE_IDS) expect(s.features[id]).toBeDefined();

    expect(s.features.ai_assistant).toMatchObject({
      allowed: true,
      reason: "ok",
      limit: 200,
      used: 150,
      remaining: 50,
    });
    expect(s.features.automation).toMatchObject({
      allowed: true,
      limit: 250,
      used: 0,
      remaining: 250,
    });
    expect(s.features.upload).toMatchObject({ allowed: true, limit: 15 });
    expect(s.features.salary_calculator).toMatchObject({
      allowed: true,
      limit: null,
    });
  });

  it("lookup failure: fail-closed aggregate, free labels, zero emails", async () => {
    setup({ throwTable: "subscriptions", emailsSent: null });
    const s = await getBillingStatus(USER, NOW);
    expect(s).toMatchObject({
      planId: "free",
      planLabel: "Free",
      lookupFailed: true,
      aiPerDay: 100,
      emailsPerDay: 50,
      emailsUsedToday: 0,
      trialUsed: false,
    });
    expect(s.features.ai_assistant?.reason).toBe("lookup_error");
    expect(s.features.automation?.allowed).toBe(false);
    expect(s.features.salary_calculator?.allowed).toBe(true);
    expect(s.features.upload).toMatchObject({ allowed: true, limit: 10 });
  });

  // ---------------------------------------------------------------------
  // Subscription visibility (prod incident: one pro/active/manual row
  // existed but the UI showed no subscription). Every state in which a
  // persisted row must remain VISIBLE to its owner is pinned here: the
  // label shows the row's plan; the entitlements stay fail-closed.
  // ---------------------------------------------------------------------

  it("pro/active with a future period end → visible (Pro label, pro entitlements)", async () => {
    const { admin } = setup({
      sub: subRow({
        plan: "pro",
        provider: "manual",
        start: "2026-09-01T00:00:00.000Z",
        end: "2026-12-31T00:00:00.000Z",
      }),
      plan: planRow({ planId: "pro", emails: 500, ai: 1500 }),
    });
    const s = (await withEnv(
      {
        MOCK_PAYMENTS_ENABLED: undefined,
        NODE_ENV: "test",
        VERCEL_ENV: undefined,
      },
      () => getBillingStatus(USER, NOW),
    )) as Awaited<ReturnType<typeof getBillingStatus>>;
    expect(s).toMatchObject({
      planId: "pro",
      planLabel: "Pro",
      rowPlanId: "pro",
      status: "active",
      provider: "manual",
      lookupFailed: false,
    });
    expect(queryCalls(admin.calls, "billing_plans")[0]?.filters).toEqual({
      plan_id: "pro",
    });
  });

  it("computed expiry (DB row still status 'active', period end past) → entitlements stay FREE but the UI keeps the Pro identity", async () => {
    setup({
      sub: subRow({
        plan: "pro",
        provider: "manual",
        start: "2026-09-15T00:00:00.000Z",
        end: "2026-10-15T00:00:00.000Z", // before NOW (2026-10-15T12:00Z)
      }),
      plan: planRow({ planId: "pro", emails: 500, ai: 1500 }),
    });
    const s = await getBillingStatus(USER, NOW);
    // Display: the subscription is still visible as Pro — with the
    // 'expired' status chip and its period dates (the page renders them).
    expect(s).toMatchObject({
      planLabel: "Pro",
      rowPlanId: "pro",
      status: "expired",
      provider: "manual",
      periodEndMs: Date.parse("2026-10-15T00:00:00.000Z"),
    });
    // Access control: effective plan is still the free fallback
    // (the lapsed plan must NOT keep granting pro limits).
    expect(s).toMatchObject({
      planId: "free",
      aiPerDay: 100,
      emailsPerDay: 50,
    });
    expect(s.features.ai_assistant).toMatchObject({
      allowed: true,
      limit: 100,
    });
  });

  it("no row for this user (row.user_id ≠ authenticated id) → 'none', Free, null rowPlanId, no plan lookup", async () => {
    const { admin } = setup({
      sub: null, // the admin query filtered by user_id found nothing
      plan: planRow({ planId: "pro", emails: 500, ai: 1500 }),
    });
    const s = await getBillingStatus(USER, NOW);
    expect(s).toMatchObject({
      planId: "free",
      planLabel: "Free",
      rowPlanId: null,
      status: "none",
      provider: null,
    });
    expect(queryCalls(admin.calls, "billing_plans")).toHaveLength(0);
  });

  it("canceled pro row → Pro identity retained, free entitlements", async () => {
    setup({
      sub: subRow({
        plan: "pro",
        provider: "manual",
        status: "canceled",
        canceledAt: "2026-10-01T00:00:00.000Z",
      }),
    });
    const s = await getBillingStatus(USER, NOW);
    expect(s).toMatchObject({
      planId: "free",
      planLabel: "Pro",
      rowPlanId: "pro",
      status: "canceled",
      aiPerDay: 100,
      emailsPerDay: 50,
    });
  });
});

// ---------------------------------------------------------------------------
// Identifier hygiene — nothing client-shaped reaches the data layer
// ---------------------------------------------------------------------------

describe("server-side identifiers only", () => {
  it("check + reserve only ever use server-side identifier keys", async () => {
    const { admin, user } = setup({
      sub: subRow(),
      plan: commercialRow("premium_monthly"),
      rpc: {
        reserve_feature_op: {
          data: [{ status: "reserved", used: 1, remaining: 49 }],
        },
      },
    });
    await checkFeature(USER, "cover_letter", NOW);
    await reserveFeatureOp(USER, "cover_letter", RUN, NOW);

    const allowedKeys = new Set([
      "user_id",
      "plan_id",
      "date",
      "p_user_id",
      "p_feature_id",
      "p_run_id",
      "target_user_id",
    ]);
    const all = [...admin.calls, ...user.calls];
    expect(all.length).toBeGreaterThan(0);
    for (const call of all) {
      for (const key of [
        ...Object.keys(call.filters ?? {}),
        ...Object.keys(call.args ?? {}),
      ]) {
        expect(
          allowedKeys.has(key),
          `unexpected identifier key "${key}" in ${call.name}`,
        ).toBe(true);
      }
    }
    // The reservation really went through the server-side RPC.
    expect(rpcCalls(admin.calls, "reserve_feature_op")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// checkSavedApplicationCapacity / assertSavedApplicationCapacity (F1 —
// saved_applications items quota, migration 20261123000000)
// ---------------------------------------------------------------------------

const capRow = (over: Record<string, unknown> = {}) => ({
  status: "ok",
  plan_limit: 3,
  used: 2,
  remaining: 1,
  ...over,
});

describe("checkSavedApplicationCapacity — RPC contract", () => {
  it("maps a clean 'ok' row 1:1 and forwards the server-identity args", async () => {
    const { admin } = setup({
      rpc: { check_saved_application_capacity: { data: [capRow()] } },
    });
    const check = await checkSavedApplicationCapacity(USER, 1, "camp-9");
    expect(check).toEqual({
      status: "ok",
      planLimit: 3,
      used: 2,
      remaining: 1,
    });
    const calls = rpcCalls(admin.calls, "check_saved_application_capacity");
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual({
      p_user_id: USER,
      p_new_count: 1,
      p_replace_campaign_id: "camp-9",
    });
  });

  it("maps 'unmetered' (plan_limit null) — no gate, legacy behavior kept", async () => {
    setup({
      rpc: {
        check_saved_application_capacity: {
          data: [
            capRow({
              status: "unmetered",
              plan_limit: null,
              used: 9,
              remaining: null,
            }),
          ],
        },
      },
    });
    const check = await checkSavedApplicationCapacity(USER);
    expect(check).toEqual({
      status: "unmetered",
      planLimit: null,
      used: 9,
      remaining: 0,
    });
  });

  it("maps 'disabled' and 'exceeded'", async () => {
    setup({
      rpc: {
        check_saved_application_capacity: {
          data: [capRow({ status: "disabled", plan_limit: 0, remaining: 0 })],
        },
      },
    });
    expect(await checkSavedApplicationCapacity(USER, 1)).toMatchObject({
      status: "disabled",
      planLimit: 0,
    });
    setup({
      rpc: {
        check_saved_application_capacity: {
          data: [capRow({ status: "exceeded", plan_limit: 3, remaining: 0 })],
        },
      },
    });
    expect(await checkSavedApplicationCapacity(USER, 2)).toMatchObject({
      status: "exceeded",
      planLimit: 3,
    });
  });

  it("an unhandled RPC (no spec) fails closed to 'error', never throws", async () => {
    setup({}); // makeAdmin answers unhandled rpcs with an error
    const check = await checkSavedApplicationCapacity(USER, 1);
    expect(check).toEqual({
      status: "error",
      planLimit: null,
      used: 0,
      remaining: 0,
    });
  });

  it("an unknown status in the payload fails closed to 'error'", async () => {
    setup({
      rpc: {
        check_saved_application_capacity: {
          data: [capRow({ status: "weird" })],
        },
      },
    });
    const check = await checkSavedApplicationCapacity(USER, 1);
    expect(check.status).toBe("error");
  });

  it("an ok-status row with garbage numbers is coerced (status is the gate)", async () => {
    setup({
      rpc: {
        check_saved_application_capacity: {
          data: [capRow({ plan_limit: "x", used: "y", remaining: "z" })],
        },
      },
    });
    const check = await checkSavedApplicationCapacity(USER, 1);
    expect(check).toEqual({
      status: "ok",
      planLimit: null,
      used: 0,
      remaining: 0,
    });
  });
});

describe("assertSavedApplicationCapacity — the server gate", () => {
  it("is a no-op (no RPC) when the operation adds ZERO content rows", async () => {
    const { admin } = setup({});
    await expect(
      assertSavedApplicationCapacity(USER, 0),
    ).resolves.toBeUndefined();
    expect(
      rpcCalls(admin.calls, "check_saved_application_capacity"),
    ).toHaveLength(0);
  });

  it("free state → denied BEFORE the capacity RPC (2026-10-24 RC-1 fix: SQL says 'unmetered' for non-commercial, the app policy says disabled)", async () => {
    const { admin } = setup({
      sub: null,
      rpc: {
        check_saved_application_capacity: {
          data: [capRow({ status: "unmetered" })],
        },
      },
    });
    await expect(assertSavedApplicationCapacity(USER, 1)).rejects.toThrow(
      "CAPACITY_EXCEEDED",
    );
    expect(
      rpcCalls(admin.calls, "check_saved_application_capacity"),
    ).toHaveLength(0);
  });

  it("commercial states reach the RPC and pass 'ok' / 'unmetered'", async () => {
    // 'ok': the plan has a numeric saved_applications limit (500 monthly).
    // 'unmetered': commercial plan whose feature_limits lacks the key —
    // the documented legacy-style gap stays pass-through.
    const cases: Array<{
      status: "ok" | "unmetered";
      plan: Record<string, unknown>;
    }> = [
      { status: "ok", plan: commercialRow("premium_monthly") },
      {
        status: "unmetered",
        plan: commercialRow("premium_monthly", { feature_limits: {} }),
      },
    ];
    for (const c of cases) {
      setup({
        sub: subRow(),
        plan: c.plan,
        rpc: {
          check_saved_application_capacity: {
            data: [capRow({ status: c.status })],
          },
        },
      });
      await expect(
        assertSavedApplicationCapacity(USER, 1),
      ).resolves.toBeUndefined();
    }
  });

  it("denies 'exceeded' with the STABLE code CAPACITY_EXCEEDED", async () => {
    setup({
      rpc: {
        check_saved_application_capacity: {
          data: [capRow({ status: "exceeded" })],
        },
      },
    });
    await expect(assertSavedApplicationCapacity(USER, 1)).rejects.toThrow(
      "CAPACITY_EXCEEDED",
    );
  });

  it("denies 'disabled' with CAPACITY_EXCEEDED (an explicit 0 is a denial, not unmetered)", async () => {
    setup({
      rpc: {
        check_saved_application_capacity: {
          data: [capRow({ status: "disabled" })],
        },
      },
    });
    await expect(assertSavedApplicationCapacity(USER, 1)).rejects.toThrow(
      "CAPACITY_EXCEEDED",
    );
  });

  it("fails CLOSED on a lookup failure: SAVE_FAILED (a missing reading is never 'room')", async () => {
    const failures: Array<Record<string, unknown>> = [
      {
        check_saved_application_capacity: {
          data: null,
          error: { message: "boom" },
        },
      },
      {
        check_saved_application_capacity: {
          data: null,
          throw: new Error("client down"),
        },
      },
      { check_saved_application_capacity: { data: null } },
    ];
    for (const spec of failures) {
      // Commercial state so the capacity RPC is actually consulted.
      setup({
        sub: subRow(),
        plan: commercialRow("premium_monthly"),
        rpc: spec as never,
      });
      await expect(assertSavedApplicationCapacity(USER, 1)).rejects.toThrow(
        "SAVE_FAILED",
      );
    }
    // And when the SUBSCRIPTION itself is unreadable: SAVE_FAILED too.
    setup({ throwTable: "subscriptions" });
    await expect(assertSavedApplicationCapacity(USER, 1)).rejects.toThrow(
      "SAVE_FAILED",
    );
  });
});
