/**
 * 2026-10-24 critical entitlement fix — boundary tests for the 16 mandated
 * security scenarios (new + existing users, free/paid, canceled/expired,
 * historical labels, invalid data, client tampering, direct API denial,
 * cross-user, service-role/admin paths, stale state, usage limits).
 *
 * The REAL entitlement-service runs in every test; only the Supabase
 * boundary (admin client / user session), the AI providers, and the
 * auth/session helpers are mocked. Route-level tests call the actual
 * NextResponse handlers (POST functions) with a real Request.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const holder = vi.hoisted(() => ({
  admin: null as unknown,
  user: null as unknown,
  requireAdminResult: null as unknown,
  providerImpl: null as null | ((...args: unknown[]) => Promise<unknown>),
  generateFileImpl: null as null | ((...args: unknown[]) => Promise<unknown>),
  reconRows: null as null | Array<Record<string, unknown>>,
  reconProfiles: null as null | Array<Record<string, unknown>>,
  reconPending: null as null | Array<Record<string, unknown>>,
  reconCalls: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => holder.admin,
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => holder.user,
}));
vi.mock("@/lib/ai-service", () => ({
  // The route calls provider() — a factory returning the AI client.
  provider: () => ({
    generateText: (...args: unknown[]) => {
      if (!holder.providerImpl) throw new Error("PROVIDER_MUST_NOT_BE_CALLED");
      return holder.providerImpl(...args);
    },
  }),
}));
vi.mock("@/lib/ai-provider", () => ({
  createAIProvider: () => ({
    generateFile: (...args: unknown[]) => {
      if (!holder.generateFileImpl)
        throw new Error("PROVIDER_MUST_NOT_BE_CALLED");
      return holder.generateFileImpl(...args);
    },
  }),
}));
vi.mock("@/lib/auth", () => ({
  getCurrentUserAndProfile: async () => ({
    user: {
      id: "a0000000-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      email: "a@test.invalid",
    },
    profile: { account_status: "active" },
  }),
}));
vi.mock("@/lib/billing/admin", () => ({
  requireAdmin: async () => holder.requireAdminResult,
}));
vi.mock("@/lib/bewerbung-scanner", async (importOriginal) => ({
  ...((await importOriginal()) as object),
  createScan: vi.fn(async () => "scan-1"),
}));
vi.mock("@/lib/bewerbung-scan", async (importOriginal) => ({
  ...((await importOriginal()) as object),
  runScan: vi.fn(),
}));

const {
  checkFeature,
  classifyRawSubscription,
  classifySubscriptionState,
  getBillingStatus,
  resolveSubscription,
  reserveFeatureOp,
  NON_COMMERCIAL_FEATURE_LIMITS,
} = await import("@/lib/billing/entitlement-service");
const { COMMERCIAL_PLANS } = await import("@/lib/billing/commercial-plans");

const coverLetterRoute = await import("@/app/api/ai/cover-letter/route");
const generateFileRoute = await import("@/app/api/ai/generate-file/route");
const scanRoute = await import("@/app/api/bewerbung-scanner/scan/route");
const { runScan } = await import("@/lib/bewerbung-scan");
const reconRoute =
  await import("@/app/api/admin/subscription-reconciliation/route");

const USER_A = "a0000000-aaaa-4aaa-8aaa-aaaaaaaaaaaa"; // session user
const USER_B = "b0000000-bbbb-4bbb-8bbb-bbbbbbbbbbbb"; // other account
const NOW = Date.parse("2026-10-15T12:00:00.000Z");
const FUTURE_END = "2026-11-15T00:00:00.000Z";
const PAST_END = "2026-10-14T00:00:00.000Z";

const RESTRICTED_FEATURES = [
  "cover_letter",
  "resume_ai",
  "scanner",
  "email_drafts",
  "opportunity_search",
  "saved_opportunities",
  "saved_applications",
] as const;
const RESTRICTED_PLUS_AUTOMATION = [
  ...RESTRICTED_FEATURES,
  "automation",
] as const;

// ---------------------------------------------------------------------------
// Admin mock (Supabase boundary)
// ---------------------------------------------------------------------------

interface RpcSpec {
  data?: unknown;
  error?: { message: string } | null;
  throw?: Error;
}
interface AdminSpec {
  /** subscriptions maybeSingle by filter. */
  subscriptions?: (
    filters: Record<string, unknown>,
  ) => Record<string, unknown> | null;
  plans?: (filters: Record<string, unknown>) => Record<string, unknown> | null;
  conversations?: Record<string, unknown> | null;
  generatedRow?: Record<string, unknown>;
  storageError?: unknown;
  meters?: Record<string, { used: number; resets_at: number | string | null }>;
  rpc?: Record<string, RpcSpec>;
}

function makeAdmin(spec: AdminSpec = {}) {
  const queries: Array<Record<string, unknown>> = [];
  const rpcs: Array<Record<string, unknown>> = [];
  const from = (table: string) => {
    const filters: Record<string, unknown> = {};
    let inValues: unknown = null;
    let inColumn: string | null = null;
    let limitArg: number | null = null;
    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: (col: string, val: unknown) => {
        filters[col] = val;
        return chain;
      },
      in: (col: string, vals: unknown) => {
        inValues = vals;
        inColumn = col;
        limitArg = -1; // marks the chain terminal (profiles report query)
        return chain;
      },
      order: () => chain,
      limit: (n: number) => {
        limitArg = n;
        return chain;
      },
      maybeSingle: async () => {
        queries.push({ table, filters: { ...filters } });
        if (table === "subscriptions")
          return { data: spec.subscriptions?.(filters) ?? null, error: null };
        if (table === "billing_plans")
          return { data: spec.plans?.(filters) ?? null, error: null };
        return { data: null, error: null };
      },
      single: async () => {
        queries.push({ table, filters: { ...filters } });
        if (table === "ai_conversations") {
          const row =
            spec.conversations &&
            spec.conversations["id"] === filters["id"] &&
            filters["user_id"] === USER_A
              ? spec.conversations
              : null;
          return row
            ? { data: row, error: null }
            : { data: null, error: { message: "PGRST116: no rows" } };
        }
        if (table === "ai_generated_files")
          return { data: spec.generatedRow ?? { id: "gen-1" }, error: null };
        return { data: null, error: { message: "PGRST116: no rows" } };
      },
      insert: (payload: Record<string, unknown>) => {
        chain["__inserted"] = payload;
        return chain;
      },
      then: (
        resolve: (v: unknown) => unknown,
        reject?: (e: unknown) => unknown,
      ) => {
        // Terminal for reconciliation-style awaited chains
        // (select().limit() / select().in()).
        void reject;
        if (limitArg !== null && limitArg !== 0) {
          queries.push({ table, filters: { ...filters }, inValues, limitArg });
          if (table === "subscriptions")
            return resolve({ data: holder.reconRows ?? [], error: null });
          if (table === "profiles") {
            const all = holder.reconProfiles ?? [];
            const vals = (inValues as string[]) ?? [];
            const data =
              inColumn === "email"
                ? all.filter((p) => vals.includes(p.email as string))
                : all.filter((p) => vals.includes(p.id as string));
            return resolve({ data, error: null });
          }
          if (table === "mock_checkouts")
            // Advisory pending-checkout section (2026-10-24 reconciliation v2).
            return resolve({ data: holder.reconPending ?? [], error: null });
        }
        return resolve({
          data: null,
          error: { message: "unexpected terminal" },
        });
      },
    };
    return chain;
  };
  const rpc = async (fn: string, args: Record<string, unknown> = {}) => {
    rpcs.push({ fn, args: { ...args } });
    if (fn === "check_rate_limit")
      return {
        data: { allowed: true, count: 1, limit: 30, retry_after: 0 },
        error: null,
      };
    const rpcSpec = spec.rpc?.[fn];
    if (rpcSpec?.throw) throw rpcSpec.throw;
    if (rpcSpec)
      return { data: rpcSpec.data ?? null, error: rpcSpec.error ?? null };
    if (fn === "feature_quota_status" || fn === "feature_capacity_status") {
      const meter = spec.meters?.[String(args["p_feature_id"] ?? "")] ?? {
        used: 0,
        resets_at: null,
      };
      return {
        data: { used: meter.used, resets_at: meter.resets_at },
        error: null,
      };
    }
    return { data: null, error: { message: `unhandled rpc ${fn}` } };
  };
  const storage = {
    from: () => ({
      upload: async () => ({ error: spec.storageError ?? null }),
    }),
  };
  return {
    from,
    rpc,
    storage,
    queries,
    rpcs,
    subQueries: () => queries.filter((q) => q.table === "subscriptions"),
  };
}

type AdminMock = ReturnType<typeof makeAdmin>;

function installSession(userId: string = USER_A) {
  holder.user = {
    auth: {
      getUser: async () => ({
        data: { user: { id: userId, email: "s@test.invalid" } },
      }),
    },
  };
}

function monthlyPlanRow() {
  const def = COMMERCIAL_PLANS.premium_monthly;
  return {
    plan_id: def.id,
    emails_per_day: def.emailsPerDay,
    ai_requests_per_day: def.aiRequestsPerDay,
    price_cents: def.priceCents,
    duration_kind: "calendar_month",
    duration_value: 1,
    is_commercial: true,
    feature_limits: { ...def.featureLimits },
  };
}

function subRow(over: Record<string, unknown> = {}) {
  return {
    plan: "premium_monthly",
    status: "active",
    provider: "mock",
    current_period_start: "2026-10-01T00:00:00.000Z",
    current_period_end: FUTURE_END,
    canceled_at: null,
    trial_activated_at: null,
    ...over,
  };
}

function post(body: Record<string, unknown>) {
  return new Request("http://localhost/x", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  holder.admin = null;
  holder.requireAdminResult = null;
  holder.providerImpl = null;
  holder.generateFileImpl = null;
  holder.reconRows = null;
  holder.reconProfiles = null;
  holder.reconPending = null;
  holder.reconCalls.length = 0;
  vi.mocked(runScan).mockReset();
});

// ---------------------------------------------------------------------------
// S1/S6 — no verifiable subscription ⇒ no restricted tool access (new or
// existing user: the service resolves from the session id only)
// ---------------------------------------------------------------------------

describe("S1/S6 · no subscription → no restricted access", () => {
  it("every restricted feature is denied for a new account (no row)", async () => {
    const admin = makeAdmin();
    holder.admin = admin;
    for (const f of RESTRICTED_PLUS_AUTOMATION) {
      const e = await checkFeature(USER_A, f, NOW);
      expect(e, f).toMatchObject({
        allowed: false,
        reason: "feature_disabled",
        limit: 0,
      });
    }
  });

  it("an existing account whose only state is a canceled row also gets nothing paid", async () => {
    const admin = makeAdmin({
      subscriptions: (f) =>
        f.user_id === USER_A
          ? subRow({
              status: "canceled",
              canceled_at: "2026-10-10T00:00:00.000Z",
            })
          : null,
    });
    holder.admin = admin;
    for (const f of RESTRICTED_FEATURES) {
      const e = await checkFeature(USER_A, f, NOW);
      expect(e, f).toMatchObject({ allowed: false, limit: 0 });
    }
    // D9: there is NO free fallback — AI is denied too (0). The row exists
    // and is non-active → the limit-0 reason is 'plan_expired' (a no-row /
    // free-row state would instead be 'feature_disabled').
    const ai = await checkFeature(USER_A, "ai_assistant", NOW);
    expect(ai).toMatchObject({
      allowed: false,
      reason: "plan_expired",
      limit: 0,
    });
  });
});

// ---------------------------------------------------------------------------
// S2 — no-entitlement state (D9: the permanent Free plan was removed)
// ---------------------------------------------------------------------------

describe("S2 · the no-entitlement state grants nothing protected", () => {
  it("EVERY protected feature is denied (ai 0, deckblatt 0, restricted 0) — only the 10 MB account upload baseline + quota-free salary calculator remain", async () => {
    holder.admin = makeAdmin();
    expect(await checkFeature(USER_A, "ai_assistant", NOW)).toMatchObject({
      allowed: false,
      reason: "feature_disabled",
      limit: 0,
    });
    expect(await checkFeature(USER_A, "deckblatt", NOW)).toMatchObject({
      allowed: false,
      reason: "feature_disabled",
      limit: 0,
    });
    expect(await checkFeature(USER_A, "upload", NOW)).toMatchObject({
      allowed: true,
      limit: 10,
    });
    expect(await checkFeature(USER_A, "salary_calculator", NOW)).toMatchObject({
      allowed: true,
      limit: null,
    });
    for (const f of RESTRICTED_PLUS_AUTOMATION) {
      expect(await checkFeature(USER_A, f, NOW), f).toMatchObject({
        allowed: false,
        limit: 0,
      });
    }
    // The matrix itself is explicit and fail-closed by construction —
    // deckblatt is now IN the zero matrix (former 2/day free fallback gone).
    for (const f of RESTRICTED_FEATURES) {
      expect(NON_COMMERCIAL_FEATURE_LIMITS[f]).toBe(0);
    }
    expect(NON_COMMERCIAL_FEATURE_LIMITS.deckblatt).toBe(0);
  });

  it("cancellation and expiry never CREATE a free row: the effective plan is the no-entitlement sentinel, the persisted row keeps its own identity", async () => {
    holder.admin = makeAdmin({
      subscriptions: (f) =>
        f.user_id === USER_A
          ? subRow({
              plan: "premium_monthly",
              status: "canceled",
              canceled_at: "2026-10-10T00:00:00.000Z",
              current_period_end: FUTURE_END,
            })
          : null,
    });
    const sub = await resolveSubscription(USER_A, NOW);
    expect(sub).toMatchObject({ planId: "free", status: "canceled" });
    // The ROW still says premium_monthly (history is never overwritten) —
    // 'free' is only the entitlement-plane sentinel, not a written plan.
    expect(sub.row?.plan).toBe("premium_monthly");
    expect(sub.row?.status).toBe("canceled");
    expect(classifySubscriptionState(sub)).toBe("canceled");
  });
});

// ---------------------------------------------------------------------------
// S3 — selecting a paid plan without verified activation grants nothing
// ---------------------------------------------------------------------------

describe("S3 · selected but not activated", () => {
  it("selection only (no row) → free, denied", async () => {
    holder.admin = makeAdmin(); // no subscriptions row at all
    const sub = await resolveSubscription(USER_A, NOW);
    expect(sub).toMatchObject({ planId: "free", status: "none" });
    expect(classifySubscriptionState(sub)).toBe("none");
    expect(await checkFeature(USER_A, "cover_letter", NOW)).toMatchObject({
      allowed: false,
    });
  });

  it("a row exists but the plan row cannot be verified → lookup_failed ⇒ denied (fail closed)", async () => {
    const admin = makeAdmin({
      subscriptions: (f) => (f.user_id === USER_A ? subRow() : null),
      plans: () => null, // billing_plans lookup fails the validity proof
    });
    holder.admin = admin;
    const sub = await resolveSubscription(USER_A, NOW);
    expect(sub.lookupFailed).toBe(true);
    expect(classifySubscriptionState(sub)).toBe("invalid");
    for (const f of ["ai_assistant", "cover_letter"] as const) {
      expect(await checkFeature(USER_A, f, NOW), f).toMatchObject({
        allowed: false,
        reason: "lookup_error",
      });
    }
  });
});

// ---------------------------------------------------------------------------
// S4/S5 — verified subscribers get exactly their plan's matrix
// ---------------------------------------------------------------------------

describe("S4/S5 · verified subscribers", () => {
  it("active premium_monthly → the DB plan matrix (50 cover letters, 250 automation, 15 MB upload)", async () => {
    holder.admin = makeAdmin({
      subscriptions: (f) => (f.user_id === USER_A ? subRow() : null),
      plans: (f) => (f.plan_id === "premium_monthly" ? monthlyPlanRow() : null),
    });
    expect(await checkFeature(USER_A, "cover_letter", NOW)).toMatchObject({
      allowed: true,
      limit: 50,
    });
    expect(await checkFeature(USER_A, "automation", NOW)).toMatchObject({
      allowed: true,
      limit: 250,
    });
    expect(await checkFeature(USER_A, "upload", NOW)).toMatchObject({
      allowed: true,
      limit: 15,
    });
    expect(await checkFeature(USER_A, "saved_applications", NOW)).toMatchObject(
      { allowed: true, limit: 500 },
    );
    const sub = await resolveSubscription(USER_A, NOW);
    expect(classifySubscriptionState(sub)).toBe("active");
  });

  it("existing legacy pro (valid) keeps its defined values (column AI, 2 deckblatt/day) and nothing more", async () => {
    holder.admin = makeAdmin({
      subscriptions: (f) =>
        f.user_id === USER_A
          ? subRow({
              plan: "pro",
              provider: "manual",
              current_period_end: FUTURE_END,
            })
          : null,
      plans: (f) =>
        f.plan_id === "pro"
          ? {
              plan_id: "pro",
              emails_per_day: 200,
              ai_requests_per_day: 300,
              price_cents: null,
              duration_kind: null,
              duration_value: null,
              is_commercial: false,
              feature_limits: null,
            }
          : null,
    });
    expect(await checkFeature(USER_A, "ai_assistant", NOW)).toMatchObject({
      allowed: true,
      planId: "pro",
      limit: 300,
    });
    // D9: matrix-less legacy pro has NO deckblatt fallback (former 2/day
    // free tier removed) — 0 = denied. Post-migration-20261125 rows carry
    // the matrix (15/30) and are covered elsewhere.
    expect(await checkFeature(USER_A, "deckblatt", NOW)).toMatchObject({
      allowed: false,
      reason: "feature_disabled",
      limit: 0,
    });
    for (const f of RESTRICTED_FEATURES) {
      expect(await checkFeature(USER_A, f, NOW), f).toMatchObject({
        allowed: false,
        limit: 0,
      });
    }
  });
});

// ---------------------------------------------------------------------------
// S7 — canceled / expired follow the documented end rules
// ---------------------------------------------------------------------------

describe("S7 · canceled and expired", () => {
  it("canceled: entitlements end at cancellation — a future period end is display-only", async () => {
    holder.admin = makeAdmin({
      subscriptions: (f) =>
        f.user_id === USER_A
          ? subRow({
              status: "canceled",
              canceled_at: "2026-10-12T00:00:00.000Z",
            })
          : null,
    });
    const sub = await resolveSubscription(USER_A, NOW);
    expect(sub.status).toBe("canceled");
    expect(sub.planId).toBe("free");
    expect(sub.periodEndMs).toBe(Date.parse(FUTURE_END)); // retained for display
    expect(classifySubscriptionState(sub)).toBe("canceled");
    expect(await checkFeature(USER_A, "cover_letter", NOW)).toMatchObject({
      allowed: false,
    });
  });

  it("computed expiry: active row with a past period end → expired, denied (no job needed)", async () => {
    holder.admin = makeAdmin({
      subscriptions: (f) =>
        f.user_id === USER_A ? subRow({ current_period_end: PAST_END }) : null,
    });
    const sub = await resolveSubscription(USER_A, NOW);
    expect(sub.status).toBe("expired");
    expect(classifySubscriptionState(sub)).toBe("expired");
    expect(await checkFeature(USER_A, "automation", NOW)).toMatchObject({
      allowed: false,
      reason: "plan_expired",
    });
  });

  it("classifyRawSubscription (pure, used by the report): same mapping on raw rows", () => {
    expect(classifyRawSubscription(null, { nowMs: NOW })).toBe("none");
    expect(
      classifyRawSubscription(
        {
          plan: "premium_monthly",
          status: "active",
          current_period_end: FUTURE_END,
        },
        { nowMs: NOW },
      ),
    ).toBe("active");
    expect(
      classifyRawSubscription(
        { plan: "pro", status: "canceled", current_period_end: FUTURE_END },
        { nowMs: NOW },
      ),
    ).toBe("canceled");
    expect(
      classifyRawSubscription(
        { plan: "premium_10d", status: "active", current_period_end: PAST_END },
        { nowMs: NOW },
      ),
    ).toBe("expired");
    expect(
      classifyRawSubscription(
        {
          plan: "premium_monthly",
          status: "active",
          current_period_end: FUTURE_END,
        },
        { lookupFailed: true },
      ),
    ).toBe("invalid");
    expect(
      classifyRawSubscription(
        {
          plan: "bogus_plan",
          status: "active",
          current_period_end: FUTURE_END,
        },
        { nowMs: NOW },
      ),
    ).toBe("none");
  });
});

// ---------------------------------------------------------------------------
// S8 — a historical plan label never grants entitlements
// ---------------------------------------------------------------------------

describe("S8 · historical 'Pro' label without a valid subscription", () => {
  it("getBillingStatus shows the Pro identity but grants the free state", async () => {
    holder.admin = makeAdmin({
      subscriptions: (f) =>
        f.user_id === USER_A
          ? subRow({
              plan: "pro",
              provider: "manual",
              status: "canceled",
              canceled_at: "2026-09-01T00:00:00.000Z",
              current_period_end: PAST_END,
            })
          : null,
      plans: () => null,
    });
    const s = await getBillingStatus(USER_A, NOW);
    expect(s.planLabel).toBe("Pro"); // display-only identity
    expect(s.rowPlanId).toBe("pro"); // display-only identity
    expect(s.planId).toBe("free"); // entitlement plane (no-entitlement sentinel)
    expect(s.status).toBe("canceled");
    expect(s.aiPerDay).toBe(0); // NO free fallback (D9), and NOT the pro column
    expect(s.features["cover_letter"]).toMatchObject({
      allowed: false,
      limit: 0,
    });
    expect(s.features["automation"]).toMatchObject({
      allowed: false,
      limit: 0,
    });
  });
});

// ---------------------------------------------------------------------------
// S9 — invalid/unavailable data fails closed (stricter than free)
// ---------------------------------------------------------------------------

describe("S9 · unavailable subscription data", () => {
  it("subscription lookup error → every metered feature denied with lookup_error", async () => {
    holder.admin = makeAdmin();
    // Simulate a DB failure on the subscriptions read: the next
    // resolveSubscription must surface lookupFailed (the mock's maybeSingle
    // throws once, like a real client failure).
    const admin = holder.admin as AdminMock;
    const realFrom = admin.from.bind(admin);
    (holder.admin as Record<string, unknown>).from = (table: string) =>
      table === "subscriptions"
        ? {
            select: () => ({
              eq: () => ({
                maybeSingle: async () => {
                  throw new Error("db down");
                },
              }),
            }),
          }
        : realFrom(table);
    const sub = await resolveSubscription(USER_A, NOW);
    expect(sub.lookupFailed).toBe(true);
    expect(classifySubscriptionState(sub)).toBe("invalid");
    for (const f of [
      "ai_assistant",
      "deckblatt",
      "cover_letter",
      "automation",
    ] as const) {
      expect(await checkFeature(USER_A, f, NOW), f).toMatchObject({
        allowed: false,
        reason: "lookup_error",
      });
    }
  });
});

// ---------------------------------------------------------------------------
// S10 — client-supplied plan/identity is never authorization evidence
// ---------------------------------------------------------------------------

describe("S10 · client tampering cannot change resolution", () => {
  it("the resolver queries ONLY the session user id (filter capture)", async () => {
    const admin = makeAdmin();
    holder.admin = admin;
    await resolveSubscription(USER_A, NOW);
    const q = admin.subQueries()[0];
    expect(q.filters).toEqual({ user_id: USER_A });
    // Structural: resolveSubscription accepts no plan/feature argument at all.
    expect(resolveSubscription.length).toBe(1);
  });

  it("a request body claiming plan=pro does not reach the resolver (route uses session only)", async () => {
    const admin = makeAdmin(); // free user A
    holder.admin = admin;
    installSession(USER_A);
    const res = await coverLetterRoute.POST(
      post({
        mode: "generate",
        position: "X",
        company: "Y",
        cv: null,
        plan: "pro",
      }),
    );
    expect(res.status).toBe(403); // denied despite the body's "pro" claim
    expect(admin.subQueries()[0].filters).toEqual({ user_id: USER_A });
  });
});

// ---------------------------------------------------------------------------
// S11 — direct API access to restricted tools is denied
// ---------------------------------------------------------------------------

describe("S11 · direct API denial", () => {
  it("POST /api/ai/cover-letter as a free user → 403 feature_disabled, provider never called", async () => {
    holder.admin = makeAdmin(); // no subscription row
    installSession(USER_A);
    const res = await coverLetterRoute.POST(
      post({
        mode: "generate",
        position: "Entwickler",
        company: "ACME",
        cv: { sections: [] },
      }),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "feature_disabled" });
    expect(holder.providerImpl ?? null).toBeNull(); // provider mock would throw if called
  });

  // Note: generate-file is metered as ai_assistant. Since 2026-10-24 (D9)
  // the no-entitlement states (no plan, expired/canceled trial) carry a
  // daily AI limit of 0 — the reservation short-circuits to
  // 'feature_disabled' BEFORE any meter RPC, and the route maps that to 403
  // WITHOUT ever calling the paid AI provider. A client that bypasses the UI
  // is still denied server-side; nothing is counted against a quota that
  // does not exist.
  it("POST /api/ai/generate-file as a NO-PLAN user → 403 feature_disabled, reserve RPC never reached, AI provider never called", async () => {
    const admin = makeAdmin({
      conversations: { id: "c0000000-0000-4000-8000-000000000000" },
      // Trap: if the zero-limit state ever reached the meter RPC, this
      // spec would turn the outcome into 'quota_exhausted' and the test
      // would fail on the 403/429 + code assertions below.
      rpc: {
        reserve_ai_request: {
          error: { message: "ai_daily_limit_reached (0/0)" },
        },
      },
    });
    holder.admin = admin;
    // generateFileImpl stays NULL: if the route ever reached the paid
    // provider, the mock throws PROVIDER_MUST_NOT_BE_CALLED and the
    // status assertion below can never pass.
    const res = await generateFileRoute.POST(
      post({
        conversationId: "c0000000-0000-4000-8000-000000000000",
        filename: "a.docx",
        mimeType:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        prompt: "p",
      }),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "feature_disabled" });
    expect(
      admin.rpcs.find((r) => r.fn === "reserve_ai_request"),
    ).toBeUndefined();
    expect(holder.generateFileImpl ?? null).toBeNull(); // never called
  });

  it("POST /api/ai/generate-file as an expired-trial user → 403 feature_disabled, AI provider never called (expired plan = 0 AI/day, no free fallback)", async () => {
    const admin = makeAdmin({
      conversations: { id: "c0000000-0000-4000-8000-000000000000" },
      subscriptions: (f) =>
        f.user_id === USER_A
          ? subRow({
              plan: "trial",
              status: "active",
              current_period_end: PAST_END, // already past → computed expired
            })
          : null,
      rpc: {
        reserve_ai_request: {
          error: { message: "ai_daily_limit_reached (0/0)" },
        },
      },
    });
    holder.admin = admin;
    const res = await generateFileRoute.POST(
      post({
        conversationId: "c0000000-0000-4000-8000-000000000000",
        filename: "a.docx",
        mimeType:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        prompt: "p",
      }),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "feature_disabled" });
    expect(
      admin.rpcs.find((r) => r.fn === "reserve_ai_request"),
    ).toBeUndefined();
  });

  it("POST /api/ai/cover-letter as an ACTIVE monthly subscriber → 200 with the provider call", async () => {
    holder.admin = makeAdmin({
      subscriptions: (f) => (f.user_id === USER_A ? subRow() : null),
      plans: (f) => (f.plan_id === "premium_monthly" ? monthlyPlanRow() : null),
      rpc: {
        reserve_feature_op: {
          data: [{ status: "reserved", used: 1, remaining: 49 }],
        },
        complete_feature_op: { data: [{ status: "completed" }] },
      },
    });
    installSession(USER_A);
    holder.providerImpl = async () => "Le corps du courrier." as unknown;
    const res = await coverLetterRoute.POST(
      post({
        mode: "generate",
        position: "Entwickler",
        company: "ACME",
        cv: { sections: [] },
      }),
    );
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// S12 — cross-user: a request can never use another user's subscription
// ---------------------------------------------------------------------------

describe("S12 · cross-user isolation at the boundary", () => {
  it("user A (free) cannot ride user B's premium_monthly row", async () => {
    // The DB holds a valid paid row for B — but ONLY scoped by user_id.
    const admin = makeAdmin({
      subscriptions: (f) => (f.user_id === USER_B ? subRow() : null),
      plans: (f) => (f.plan_id === "premium_monthly" ? monthlyPlanRow() : null),
    });
    holder.admin = admin;
    installSession(USER_A); // the session is A
    const res = await coverLetterRoute.POST(
      post({
        mode: "generate",
        position: "X",
        company: "Y",
        cv: { sections: [] },
        user_id: USER_B,
      }),
    );
    expect(res.status).toBe(403); // A is free; the body's user_id is ignored
    expect(admin.subQueries()[0].filters).toEqual({ user_id: USER_A });
  });

  it("user B (the actual paid owner) IS allowed — scoping is per session, not per denial", async () => {
    holder.admin = makeAdmin({
      subscriptions: (f) => (f.user_id === USER_B ? subRow() : null),
      plans: (f) => (f.plan_id === "premium_monthly" ? monthlyPlanRow() : null),
      rpc: {
        reserve_feature_op: {
          data: [{ status: "reserved", used: 1, remaining: 49 }],
        },
        complete_feature_op: { data: [{ status: "completed" }] },
      },
    });
    installSession(USER_B);
    holder.providerImpl = async () => "ok" as unknown;
    const res = await coverLetterRoute.POST(
      post({
        mode: "generate",
        position: "X",
        company: "Y",
        cv: { sections: [] },
      }),
    );
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// S13/S14 — service-role paths do their own authorization (admin endpoint)
// ---------------------------------------------------------------------------

describe("S13/S14 · reconciliation endpoint (service-role path)", () => {
  const u = (id: string) => id;
  const U1 = u("10000000-0000-4000-8000-000000000001");
  const U2 = u("10000000-0000-4000-8000-000000000002");
  const U3 = u("10000000-0000-4000-8000-000000000003");
  const U4 = u("10000000-0000-4000-8000-000000000004");
  const U5 = u("10000000-0000-4000-8000-000000000005");
  const U6 = u("10000000-0000-4000-8000-000000000006");

  function installReconData() {
    holder.reconRows = [
      subRow({ plan: "premium_monthly", current_period_end: FUTURE_END }),
      subRow({
        plan: "pro",
        provider: "manual",
        status: "canceled",
        canceled_at: "2026-10-12T00:00:00.000Z",
        current_period_end: FUTURE_END,
      }),
      subRow({ plan: "premium_10d", current_period_end: PAST_END }),
      subRow({ plan: "enterprise", current_period_end: FUTURE_END }),
      subRow({ plan: "premium_monthly", current_period_end: FUTURE_END }),
    ].map((r, i) => ({ ...r, user_id: [U1, U2, U3, U4, U5][i] }));
    holder.reconProfiles = [
      {
        id: U1,
        email: "one@test.invalid",
        full_name: "One",
        account_status: "active",
      },
      {
        id: U2,
        email: "two@test.invalid",
        full_name: "Two",
        account_status: "active",
      },
      {
        id: U3,
        email: "three@test.invalid",
        full_name: "Three",
        account_status: "active",
      },
      // U4: NO profile row (orphaned subscription)
      {
        id: U5,
        email: "five@test.invalid",
        full_name: "Five",
        account_status: "active",
      },
      {
        id: U6,
        email: "five@test.invalid",
        full_name: "Six (other account, same email)",
        account_status: "active",
      },
    ];
    holder.admin = makeAdmin();
  }

  it("non-admin → 403 and the database is never touched", async () => {
    const admin = makeAdmin();
    holder.admin = admin;
    holder.requireAdminResult = null;
    const res = await reconRoute.GET();
    expect(res.status).toBe(403);
    expect(admin.queries).toHaveLength(0);
  });

  it("admin → read-only report: correct classification, mis-link flagged, zero writes", async () => {
    installReconData();
    holder.requireAdminResult = { id: USER_A, account_status: "active" };
    const res = await reconRoute.GET();
    expect(res.status).toBe(200);
    interface ReconRow {
      user_id: string;
      flags: string[];
      plan: string;
      status: string;
      classified: string;
    }
    const body = (await res.json()) as {
      read_only: boolean;
      totals: Record<string, number>;
      rows: ReconRow[];
    };
    expect(body.read_only).toBe(true);
    expect(body.totals).toMatchObject({
      active: 2,
      canceled: 1,
      expired: 1,
      none: 1,
      invalid: 0,
    });
    const byUser = Object.fromEntries(body.rows.map((r) => [r.user_id, r]));
    expect(byUser[U2].flags).toContain("canceled_future_end");
    expect(byUser[U4].flags).toEqual(
      expect.arrayContaining(["unknown_plan", "no_profile"]),
    );
    // Mis-link signature: U5 and U6 share one email and U5 holds a sub row.
    expect(byUser[U5].flags).toContain("email_shared_with_other_account");
    // No mutation surface was ever called (the mock exposes only reads).
    // The report reads exactly three tables: subscriptions (the rows),
    // profiles (ownership / mis-link signature) and mock_checkouts (the
    // advisory "pending payment" section, reconciliation v2).
    const admin = holder.admin as AdminMock;
    for (const q of admin.queries)
      expect(["subscriptions", "profiles", "mock_checkouts"]).toContain(
        q.table as string,
      );
  });
});

// ---------------------------------------------------------------------------
// S15 — plan changes / expiration take effect immediately (no stale state)
// ---------------------------------------------------------------------------

describe("S15 · no stale entitlements", () => {
  it("a cancellation between two requests is visible on the very next request", async () => {
    let state: "active" | "canceled" = "active";
    holder.admin = makeAdmin({
      subscriptions: (f) =>
        f.user_id === USER_A
          ? subRow({ status: state === "active" ? "active" : "canceled" })
          : null,
      plans: (f) => (f.plan_id === "premium_monthly" ? monthlyPlanRow() : null),
    });
    const before = await checkFeature(USER_A, "cover_letter", NOW);
    expect(before).toMatchObject({ allowed: true, limit: 50 });
    state = "canceled"; // e.g. an admin cancels the subscription
    const after = await checkFeature(USER_A, "cover_letter", NOW);
    expect(after).toMatchObject({ allowed: false, limit: 0 });
    // Proof of re-resolution per request (no cache): two subscriptions reads.
    expect((holder.admin as AdminMock).subQueries()).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// S16 — usage limits are enforced server-side; repetition cannot bypass
// ---------------------------------------------------------------------------

describe("S16 · server-side usage limits", () => {
  it("exhausted daily meter → 429, provider never called, repeated requests stay denied", async () => {
    holder.admin = makeAdmin({
      subscriptions: (f) => (f.user_id === USER_A ? subRow() : null),
      plans: (f) => (f.plan_id === "premium_monthly" ? monthlyPlanRow() : null),
      rpc: {
        reserve_feature_op: {
          data: [{ status: "quota_exhausted", used: 50, remaining: 0 }],
        },
      },
    });
    installSession(USER_A);
    const r1 = await coverLetterRoute.POST(
      post({
        mode: "generate",
        position: "X",
        company: "Y",
        cv: { sections: [] },
      }),
    );
    expect(r1.status).toBe(429);
    expect(await r1.json()).toMatchObject({ code: "quota_exhausted" });
    const r2 = await coverLetterRoute.POST(
      post({
        mode: "generate",
        position: "X",
        company: "Y",
        cv: { sections: [] },
      }),
    );
    expect(r2.status).toBe(429);
    // The server consulted the meter twice (per request) and the model never ran.
    const admin = holder.admin as AdminMock;
    expect(
      admin.rpcs.filter((r) => r.fn === "reserve_feature_op"),
    ).toHaveLength(2);
  });

  it("reserveFeatureOp surfaces the exhaustion without executing anything", async () => {
    holder.admin = makeAdmin({
      subscriptions: (f) => (f.user_id === USER_A ? subRow() : null),
      plans: (f) => (f.plan_id === "premium_monthly" ? monthlyPlanRow() : null),
      rpc: {
        reserve_feature_op: {
          data: [{ status: "quota_exhausted", used: 50, remaining: 0 }],
        },
      },
    });
    const result = await reserveFeatureOp(USER_A, "cover_letter", "run-1", NOW);
    expect(result).toEqual({ outcome: "quota_exhausted" });
  });
});

// ---------------------------------------------------------------------------
// Scanner route — canonical deny statuses (the 400-consistency fix)
// ---------------------------------------------------------------------------

describe("scanner route · canonical deny statuses", () => {
  async function scanAs(message: string) {
    holder.admin = makeAdmin();
    installSession(USER_A);
    vi.mocked(runScan).mockRejectedValueOnce(new Error(message));
    return scanRoute.POST(
      post({
        goal: "ausbildung",
        files: [
          {
            id: "f0000000-0000-4000-8000-000000000000",
            filename: "cv.pdf",
            mime_type: "application/pdf",
          },
        ],
      }),
    );
  }
  it("quota exhausted → 429 + code", async () => {
    const res = await scanAs("Scanner limit reached for your current plan.");
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ code: "quota_exhausted" });
  });
  it("feature disabled → 403 + code", async () => {
    const res = await scanAs("Scanner is not available on your current plan.");
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "feature_disabled" });
  });
  it("quota unavailable → 503 + code", async () => {
    const res = await scanAs(
      "Scanner quota could not be verified. Please try again later.",
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: "quota_unavailable" });
  });
});
