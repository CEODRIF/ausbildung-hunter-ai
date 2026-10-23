/**
 * Mock checkout facade (`src/lib/billing/mock-checkout.ts`).
 *
 * Covers the §8/§14 safety contract:
 *  - the production gate: creation AND completion are impossible in
 *    production with ZERO database calls; only explicit non-production
 *    environments with MOCK_PAYMENTS_ENABLED=true proceed
 *  - server-side plan validation (trial / unknown plans can never be
 *    checked out; only priced commercial plans)
 *  - malformed RPC payloads never surface as a successful checkout or
 *    subscription (fail closed)
 *  - mock ≠ real: a `succeeded` payload is only accepted when
 *    provider === 'mock' AND mock === true
 *  - the read path (`getMockCheckout`) is ungated (a SELECT can never
 *    activate) and performs NO rpc — a success URL alone grants nothing
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const holder = vi.hoisted(() => ({ admin: null as unknown, user: null as unknown }));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    if (holder.admin === "__throw__") throw new Error("no service role env");
    return holder.admin;
  },
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: () => holder.user,
}));

const {
  createMockCheckout,
  completeMockCheckout,
  getMockCheckout,
  isMockCheckoutOutcome,
  isMockCheckoutStatus,
} = await import("@/lib/billing/mock-checkout");
const { mockPaymentsEnabled } = await import("@/lib/billing/entitlement-service");

const USER = "11111111-1111-4111-8111-411111111111";
const CHECKOUT = "22222222-2222-4222-8222-222222222222";
const KEY = "33333333-3333-4333-8333-333333333333";

const EXPIRES_ISO = "2026-11-20T12:15:00.000Z";
const START_ISO = "2026-11-20T12:00:00.000Z";
const END_ISO = "2026-11-30T12:00:00.000Z"; // calendar month from 2026-10-31-style start

type Call =
  | { kind: "rpc"; name: string; args: Record<string, unknown> }
  | { kind: "query"; name: string; filters: Record<string, unknown> };

type RpcRespond = (
  name: string,
  args: Record<string, unknown>,
) => { data?: unknown; error?: unknown };
type QueryRespond = (
  table: string,
  filters: Record<string, unknown>,
) => { data?: unknown; error?: unknown };

function makeAdmin(opts: {
  rpc?: RpcRespond | "throw";
  query?: QueryRespond | "throw";
  calls: Call[];
}) {
  return {
    rpc(name: string, args: Record<string, unknown>) {
      opts.calls.push({ kind: "rpc", name, args });
      if (opts.rpc === "throw") return Promise.reject(new Error("rpc boom"));
      const respond = opts.rpc ?? (() => ({ data: undefined }));
      return Promise.resolve(respond(name, args));
    },
    from(table: string) {
      const filters: Record<string, unknown> = {};
      opts.calls.push({ kind: "query", name: table, filters });
      // The facade chains `.eq(...).eq(...).maybeSingle()` — the real
      // PostgREST builder returns `this` from eq, so the fake must too.
      const builder = {
        eq(col: string, val: unknown) {
          filters[col] = val;
          return builder;
        },
        maybeSingle() {
          if (opts.query === "throw") {
            return Promise.reject(new Error("query boom"));
          }
          const respond = opts.query ?? (() => ({ data: undefined }));
          return Promise.resolve(respond(table, filters));
        },
      };
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      return { select(_cols: string) { return builder; } };
    },
  };
}

let calls: Call[];

// NODE_ENV is managed via vi.stubEnv (vitest's types declare it read-only).
const ENV_KEYS = ["VERCEL_ENV", "MOCK_PAYMENTS_ENABLED"] as const;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  calls = [];
  holder.admin = null;
  holder.user = null;
  savedEnv = {};
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  // Default: gate OFF (unset flag, unambiguous test runtime).
    delete process.env.MOCK_PAYMENTS_ENABLED;
    delete process.env.VERCEL_ENV;
    vi.stubEnv("NODE_ENV", "test");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  holder.admin = null;
  holder.user = null;
});

function enableMockGate() {
  process.env.MOCK_PAYMENTS_ENABLED = "true";
  vi.stubEnv("NODE_ENV", "test");
  delete process.env.VERCEL_ENV;
}

function createdPayload(overrides: Record<string, unknown> = {}) {
  return {
    status: "created",
    checkout: {
      id: CHECKOUT,
      plan_id: "premium_10d",
      plan_label: "Premium 10 Days",
      amount_cents: 1000,
      currency: "USD",
      status: "pending",
      is_mock: true,
      expires_at: EXPIRES_ISO,
      ...overrides,
    },
  };
}

function succeededPayload(overrides: Record<string, unknown> = {}) {
  return {
    status: "succeeded",
    subscription: {
      plan_id: "premium_monthly",
      provider: "mock",
      mock: true,
      current_period_start: START_ISO,
      current_period_end: END_ISO,
      ...overrides,
    },
  };
}

describe("outcome / status allowlists", () => {
  it("accepts exactly the three simulated outcomes", () => {
    expect(isMockCheckoutOutcome("success")).toBe(true);
    expect(isMockCheckoutOutcome("failed")).toBe(true);
    expect(isMockCheckoutOutcome("canceled")).toBe(true);
    expect(isMockCheckoutOutcome("refunded")).toBe(false);
    expect(isMockCheckoutOutcome("SUCCESS")).toBe(false);
    expect(isMockCheckoutOutcome(42)).toBe(false);
  });

  it("accepts exactly the five stored statuses", () => {
    for (const s of [
      "pending",
      "succeeded",
      "failed",
      "canceled",
      "expired",
    ]) {
      expect(isMockCheckoutStatus(s)).toBe(true);
    }
    expect(isMockCheckoutStatus("refunded")).toBe(false);
    expect(isMockCheckoutStatus(null)).toBe(false);
  });
});

describe("production gate — mock activation is impossible in production", () => {
  it("refuses create + complete with NO database call when the flag is unset", async () => {
    const respond: RpcRespond = () => ({ data: createdPayload() });
    holder.admin = makeAdmin({ rpc: respond, calls });
    const create = await createMockCheckout(USER, "premium_10d", KEY);
    const complete = await completeMockCheckout(USER, CHECKOUT, "success");
    expect(create).toEqual({ ok: false, error: "mock_payments_disabled" });
    expect(complete).toEqual({ ok: false, error: "mock_payments_disabled" });
    expect(calls).toEqual([]);
  });

  it("stays OFF in production even with MOCK_PAYMENTS_ENABLED=true (NODE_ENV)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    process.env.MOCK_PAYMENTS_ENABLED = "true";
    holder.admin = makeAdmin({ rpc: () => ({ data: createdPayload() }), calls });
    const res = await createMockCheckout(USER, "premium_10d", KEY);
    expect(res).toEqual({ ok: false, error: "mock_payments_disabled" });
    expect(calls).toEqual([]);
  });

  it("stays OFF in production even with MOCK_PAYMENTS_ENABLED=true (VERCEL_ENV)", async () => {
    process.env.VERCEL_ENV = "production";
    process.env.MOCK_PAYMENTS_ENABLED = "true";
    holder.admin = makeAdmin({ rpc: () => ({ data: createdPayload() }), calls });
    const res = await completeMockCheckout(USER, CHECKOUT, "success");
    expect(res).toEqual({ ok: false, error: "mock_payments_disabled" });
    expect(calls).toEqual([]);
  });

  it("stays OFF in an unrecognized runtime even with the flag set", async () => {
    vi.stubEnv("NODE_ENV", "ci");
    process.env.MOCK_PAYMENTS_ENABLED = "true";
    holder.admin = makeAdmin({ rpc: () => ({ data: createdPayload() }), calls });
    const res = await createMockCheckout(USER, "premium_10d", KEY);
    expect(res).toEqual({ ok: false, error: "mock_payments_disabled" });
    expect(calls).toEqual([]);
  });

  it.each([
    ["test", undefined],
    ["development", undefined],
    ["test", "preview"],
  ])("enables in NODE_ENV=%s (vercel: %s)", (nodeEnv, vercelEnv) => {
    vi.stubEnv("NODE_ENV", nodeEnv);
    if (vercelEnv === undefined) delete process.env.VERCEL_ENV;
    else process.env.VERCEL_ENV = vercelEnv;
    process.env.MOCK_PAYMENTS_ENABLED = "true";
    expect(mockPaymentsEnabled()).toBe(true);
  });
});

describe("createMockCheckout — server-side plan validation", () => {
  it("rejects the trial plan (never purchasable)", async () => {
    enableMockGate();
    holder.admin = makeAdmin({ rpc: () => ({ data: createdPayload() }), calls });
    const res = await createMockCheckout(USER, "trial", KEY);
    expect(res).toEqual({ ok: false, error: "invalid_plan" });
    expect(calls).toEqual([]);
  });

  it("rejects unknown / legacy plan identifiers", async () => {
    enableMockGate();
    holder.admin = makeAdmin({ rpc: () => ({ data: createdPayload() }), calls });
    const res = await createMockCheckout(USER, "plus", KEY);
    expect(res).toEqual({ ok: false, error: "invalid_plan" });
    expect(calls).toEqual([]);
  });

  it("rejects non-UUID userId / idempotency key before any DB call", async () => {
    enableMockGate();
    holder.admin = makeAdmin({ rpc: () => ({ data: createdPayload() }), calls });
    expect(await createMockCheckout("attacker", "premium_10d", KEY)).toEqual({
      ok: false,
      error: "invalid_input",
    });
    expect(await createMockCheckout(USER, "premium_10d", "not-a-key")).toEqual({
      ok: false,
      error: "invalid_input",
    });
    expect(calls).toEqual([]);
  });
});

describe("createMockCheckout — RPC mapping", () => {
  it("maps 'created' and passes server-resolved identity + validated plan", async () => {
    enableMockGate();
    holder.admin = makeAdmin({ rpc: () => ({ data: createdPayload() }), calls });
    const res = await createMockCheckout(USER, "premium_10d", KEY);
    expect(res).toEqual({
      ok: true,
      status: "created",
      checkout: {
        id: CHECKOUT,
        planId: "premium_10d",
        planLabel: "Premium 10 Days",
        amountCents: 1000,
        currency: "USD",
        status: "pending",
        expiresAtMs: Date.parse(EXPIRES_ISO),
        isMock: true,
      },
    });
    expect(calls).toEqual([
      {
        kind: "rpc",
        name: "create_mock_checkout",
        args: { p_user_id: USER, p_plan_id: "premium_10d", p_idempotency_key: KEY },
      },
    ]);
  });

  it("maps 'existing' (idempotent resume with the same key)", async () => {
    enableMockGate();
    holder.admin = makeAdmin({
      rpc: () => ({ data: { ...createdPayload(), status: "existing" } }),
      calls,
    });
    const res = await createMockCheckout(USER, "premium_10d", KEY);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.status).toBe("existing");
  });

  it("uses the monthly price from the server catalogue path (2000 cents)", async () => {
    enableMockGate();
    holder.admin = makeAdmin({
      rpc: () => ({
        data: createdPayload({
          plan_id: "premium_monthly",
          plan_label: "Premium Monthly",
          amount_cents: 2000,
        }),
      }),
      calls,
    });
    const res = await createMockCheckout(USER, "premium_monthly", KEY);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.checkout.amountCents).toBe(2000);
  });

  it("fails on an unknown RPC status", async () => {
    enableMockGate();
    holder.admin = makeAdmin({
      rpc: () => ({ data: { ...createdPayload(), status: "expired" } }),
      calls,
    });
    const res = await createMockCheckout(USER, "premium_10d", KEY);
    expect(res).toEqual({ ok: false, error: "failed" });
  });

  it.each([
    ["zero amount", { amount_cents: 0 }],
    ["negative amount", { amount_cents: -5 }],
    ["non-USD currency", { currency: "EUR" }],
    ["is_mock not true", { is_mock: false }],
    ["missing expires_at", { expires_at: null }],
    ["unparseable expires_at", { expires_at: "garbage" }],
    ["non-UUID checkout id", { id: "nope" }],
    ["empty plan_id", { plan_id: "" }],
    ["missing checkout object", null],
  ])(
    "fails closed on a malformed checkout: %s",
    async (_label, overrides: Record<string, unknown> | null) => {
      enableMockGate();
      holder.admin = makeAdmin({
        rpc: () =>
          overrides === null
            ? { data: { status: "created" } }
            : { data: createdPayload(overrides) },
        calls,
      });
      const res = await createMockCheckout(USER, "premium_10d", KEY);
      expect(res).toEqual({ ok: false, error: "failed" });
    });

  it("fails on RPC error / throw / null data", async () => {
    enableMockGate();
    holder.admin = makeAdmin(
      { rpc: () => ({ error: { message: "idempotency_conflict" } }), calls },
    );
    expect(await createMockCheckout(USER, "premium_10d", KEY)).toEqual({
      ok: false,
      error: "failed",
    });
    holder.admin = makeAdmin({ rpc: "throw", calls });
    expect(await createMockCheckout(USER, "premium_10d", KEY)).toEqual({
      ok: false,
      error: "failed",
    });
    holder.admin = makeAdmin({ rpc: () => ({ data: null }), calls });
    expect(await createMockCheckout(USER, "premium_10d", KEY)).toEqual({
      ok: false,
      error: "failed",
    });
  });
});

describe("completeMockCheckout — RPC mapping", () => {
  it("maps 'succeeded' with a parsed mock subscription", async () => {
    enableMockGate();
    holder.admin = makeAdmin({ rpc: () => ({ data: succeededPayload() }), calls });
    const res = await completeMockCheckout(USER, CHECKOUT, "success");
    expect(res).toEqual({
      ok: true,
      status: "succeeded",
      subscription: {
        planId: "premium_monthly",
        provider: "mock",
        periodStartMs: Date.parse(START_ISO),
        periodEndMs: Date.parse(END_ISO),
        isMock: true,
      },
    });
    expect(calls).toEqual([
      {
        kind: "rpc",
        name: "complete_mock_checkout",
        args: {
          p_checkout_id: CHECKOUT,
          p_user_id: USER,
          p_outcome: "success",
        },
      },
    ]);
  });

  it("maps 'already_succeeded' as an idempotent no-op (no duplicate grant)", async () => {
    enableMockGate();
    holder.admin = makeAdmin({
      rpc: () => ({ data: { status: "already_succeeded" } }),
      calls,
    });
    const res = await completeMockCheckout(USER, CHECKOUT, "success");
    expect(res).toEqual({ ok: true, status: "already_succeeded" });
  });

  it("rejects a non-allowlisted outcome before any DB call", async () => {
    enableMockGate();
    holder.admin = makeAdmin({ rpc: () => ({ data: succeededPayload() }), calls });
    const res = await completeMockCheckout(USER, CHECKOUT, "refunded");
    expect(res).toEqual({ ok: false, error: "invalid_input" });
    expect(calls).toEqual([]);
  });

  it("rejects non-UUID checkout id before any DB call", async () => {
    enableMockGate();
    holder.admin = makeAdmin({ rpc: () => ({ data: succeededPayload() }), calls });
    const res = await completeMockCheckout(USER, "any-string", "success");
    expect(res).toEqual({ ok: false, error: "invalid_input" });
    expect(calls).toEqual([]);
  });

  it("mock ≠ real: refuses a 'succeeded' payload with a real provider", async () => {
    enableMockGate();
    holder.admin = makeAdmin({
      rpc: () => ({ data: succeededPayload({ provider: "stripe" }) }),
      calls,
    });
    const res = await completeMockCheckout(USER, CHECKOUT, "success");
    expect(res).toEqual({ ok: false, error: "failed" });
  });

  it("mock ≠ real: refuses a 'succeeded' payload without mock:true", async () => {
    enableMockGate();
    holder.admin = makeAdmin({
      rpc: () => ({ data: succeededPayload({ mock: false }) }),
      calls,
    });
    const res = await completeMockCheckout(USER, CHECKOUT, "success");
    expect(res).toEqual({ ok: false, error: "failed" });
  });

  it("refuses a 'succeeded' payload whose period is not end > start", async () => {
    enableMockGate();
    holder.admin = makeAdmin({
      rpc: () => ({ data: succeededPayload({ current_period_end: START_ISO }) }),
      calls,
    });
    const res = await completeMockCheckout(USER, CHECKOUT, "success");
    expect(res).toEqual({ ok: false, error: "failed" });
  });

  it.each([
    ["not_found", { status: "not_found" }, "not_found"],
    ["terminal", { status: "terminal" }, "terminal"],
    ["expired", { status: "expired" }, "expired"],
    ["failed", { status: "failed" }, "payment_failed"],
    ["canceled", { status: "canceled" }, "canceled"],
    ["plan_error", { status: "plan_error" }, "failed"],
    ["unknown", { status: "weird" }, "failed"],
  ])("maps %s → %s", async (_label, payload, expected) => {
    enableMockGate();
    holder.admin = makeAdmin({ rpc: () => ({ data: payload }), calls });
    const res = await completeMockCheckout(USER, CHECKOUT, "success");
    expect(res).toEqual({ ok: false, error: expected });
  });

  it("fails on RPC error / throw", async () => {
    enableMockGate();
    holder.admin = makeAdmin(
      { rpc: () => ({ error: { message: "boom" } }), calls },
    );
    expect(await completeMockCheckout(USER, CHECKOUT, "success")).toEqual({
      ok: false,
      error: "failed",
    });
    holder.admin = makeAdmin({ rpc: "throw", calls });
    expect(await completeMockCheckout(USER, CHECKOUT, "success")).toEqual({
      ok: false,
      error: "failed",
    });
  });

  it("a simulated failure or cancellation grants nothing", async () => {
    enableMockGate();
    holder.admin = makeAdmin({ rpc: () => ({ data: { status: "failed" } }), calls });
    const res = await completeMockCheckout(USER, CHECKOUT, "failed");
    expect(res).toEqual({ ok: false, error: "payment_failed" });
    holder.admin = makeAdmin({ rpc: () => ({ data: { status: "canceled" } }), calls });
    const res2 = await completeMockCheckout(USER, CHECKOUT, "canceled");
    expect(res2).toEqual({ ok: false, error: "canceled" });
  });
});

describe("getMockCheckout — read path (ungated, SELECT-only, user-scoped)", () => {
  function validRow(overrides: Record<string, unknown> = {}) {
    return {
      id: CHECKOUT,
      plan_id: "premium_10d",
      amount_cents: 1000,
      currency: "USD",
      status: "succeeded",
      is_mock: true,
      created_at: Date.parse(START_ISO),
      expires_at: Date.parse(EXPIRES_ISO),
      subscription_id: "44444444-4444-4444-8444-444444444444",
      ...overrides,
    };
  }

  it("works with the mock gate OFF (a read can never activate)", async () => {
    // gate intentionally left off by beforeEach defaults
    holder.admin = makeAdmin({ query: () => ({ data: validRow(), error: null }), calls });
    const res = await getMockCheckout(USER, CHECKOUT);
    expect(res).toEqual({
      ok: true,
      checkout: {
        id: CHECKOUT,
        planId: "premium_10d",
        amountCents: 1000,
        currency: "USD",
        status: "succeeded",
        isMock: true,
        createdAtMs: Date.parse(START_ISO),
        expiresAtMs: Date.parse(EXPIRES_ISO),
        subscriptionId: "44444444-4444-4444-8444-444444444444",
      },
    });
    // SELECT-only: no rpc call, user-scoped filters.
    expect(calls).toEqual([
      {
        kind: "query",
        name: "mock_checkouts",
        filters: { id: CHECKOUT, user_id: USER },
      },
    ]);
  });

  it("accepts ISO-string timestamps from PostgREST", async () => {
    holder.admin = makeAdmin({
      query: () => ({
        data: validRow({
          created_at: START_ISO,
          expires_at: EXPIRES_ISO,
        }),
        error: null,
      }),
      calls,
    });
    const res = await getMockCheckout(USER, CHECKOUT);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.checkout.createdAtMs).toBe(Date.parse(START_ISO));
      expect(res.checkout.expiresAtMs).toBe(Date.parse(EXPIRES_ISO));
    }
  });

  it("keeps a null subscription_id as null", async () => {
    holder.admin = makeAdmin({
      query: () => ({ data: validRow({ subscription_id: null }), error: null }),
      calls,
    });
    const res = await getMockCheckout(USER, CHECKOUT);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.checkout.subscriptionId).toBeNull();
  });

  it("resolves not_found for non-mock rows (never rendered as valid)", async () => {
    holder.admin = makeAdmin({
      query: () => ({ data: validRow({ is_mock: false }), error: null }),
      calls,
    });
    expect(await getMockCheckout(USER, CHECKOUT)).toEqual({
      ok: false,
      error: "not_found",
    });
  });

  it("resolves not_found when no row matches (null data)", async () => {
    holder.admin = makeAdmin({ query: () => ({ data: null, error: null }), calls });
    expect(await getMockCheckout(USER, CHECKOUT)).toEqual({
      ok: false,
      error: "not_found",
    });
  });

  it.each([
    ["non-USD row", { currency: "EUR" }],
    ["zero amount row", { amount_cents: 0 }],
    ["bad status row", { status: "refunded" }],
    ["missing expires row", { expires_at: null }],
  ])("resolves not_found for a shape-invalid row: %s", async (_label, overrides) => {
    holder.admin = makeAdmin({
      query: () => ({ data: validRow(overrides), error: null }),
      calls,
    });
    expect(await getMockCheckout(USER, CHECKOUT)).toEqual({
      ok: false,
      error: "not_found",
    });
  });

  it("rejects non-UUID input before any DB call", async () => {
    holder.admin = makeAdmin({ query: () => ({ data: validRow(), error: null }), calls });
    expect(await getMockCheckout("someone-else", CHECKOUT)).toEqual({
      ok: false,
      error: "invalid_input",
    });
    expect(await getMockCheckout(USER, "not-uuid")).toEqual({
      ok: false,
      error: "invalid_input",
    });
    expect(calls).toEqual([]);
  });

  it("fails closed on a query error", async () => {
    holder.admin = makeAdmin({ query: "throw", calls });
    expect(await getMockCheckout(USER, CHECKOUT)).toEqual({
      ok: false,
      error: "failed",
    });
  });
});
