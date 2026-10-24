import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

const { createClient } = await import("@/lib/supabase/server");
const { createAdminClient } = await import("@/lib/supabase/admin");
const { POST } = await import("@/app/api/admin/users/[id]/route");
const { GET } = await import("@/app/api/admin/users/route");
const webhookRoute = await import("@/app/api/billing/webhook/route");
const { executeAdminAction, isMissingFunctionError, sanitizeDbDiagnostic } =
  await import("@/lib/billing/admin");

const ADMIN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TARGET_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const RANDOM_USER_ID = "eeeeeeee-eeee-4eee-8eeee-eeeeeeeeeeee";

interface Filters {
  [key: string]: unknown;
}

interface DbErr {
  code?: string;
  message?: string;
}

/** Chain mock supporting select/eq/in/upsert/update/insert/delete +
 *  terminals, recording every call (including writes). */
function makeMock(handlers: {
  single?: (table: string, filters: Filters) => Record<string, unknown> | null;
  list?: (
    table: string,
    filters: Filters,
  ) => Array<Record<string, unknown>> | null;
  rpc?: (
    name: string,
    args: Record<string, unknown>,
  ) => Record<string, unknown> | null;
  /** PostgREST-style RPC error (e.g. PGRST202 function does not exist). */
  rpcError?: (name: string, args: Record<string, unknown>) => DbErr | null;
  /** Client-level throw for one RPC. */
  rpcThrow?: (name: string, args: Record<string, unknown>) => Error | null;
  /** Row-operation error for a terminal then (e.g. audit insert failure). */
  rowError?: (table: string, filters: Filters) => DbErr | null;
}) {
  const calls: Array<{
    table: string;
    op: string;
    args: unknown[];
    filters: Filters;
  }> = [];
  const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const make = (table: string) => {
    const filters: Filters = {};
    const record = (op: string, args: unknown[] = []) =>
      calls.push({ table, op, args, filters: { ...filters } });
    const chain: Record<string | symbol, unknown> = new Proxy(
      {},
      {
        get(_t, prop) {
          if (typeof prop !== "string") return undefined;
          if (prop === "maybeSingle" || prop === "single")
            return async () => {
              record(prop);
              return {
                data: handlers.single?.(table, filters) ?? null,
                error: null,
              };
            };
          if (prop === "select")
            return (...a: unknown[]) => {
              filters["select"] = a[0];
              return chain;
            };
          if (prop === "eq")
            return (f: string, v: unknown) => {
              filters[f] = v;
              return chain;
            };
          if (prop === "in")
            return (f: string, v: unknown[]) => {
              filters[`in:${f}`] = v;
              return chain;
            };
          if (prop === "order" || prop === "limit" || prop === "ilike")
            return (...a: unknown[]) => {
              filters[prop] = a;
              return chain;
            };
          // Write + terminal-await ops.
          if (prop === "then")
            return (onF?: unknown) => {
              record(prop === "then" ? "await" : prop);
              return Promise.resolve({
                data: handlers.list?.(table, filters) ?? null,
                error: handlers.rowError?.(table, filters) ?? null,
              }).then(onF as never);
            };
          if (prop === "upsert" || prop === "insert" || prop === "update")
            return (...a: unknown[]) => {
              record(prop, a);
              return chain;
            };
          if (prop === "delete")
            return () => {
              record("delete");
              return chain;
            };
          if (prop === "rpc") return undefined;
          return (...a: unknown[]) => {
            record(prop, a);
            return chain;
          };
        },
      },
    );
    return chain;
  };
  return {
    client: {
      from: make,
      // Faithful to the real Supabase client: .rpc() is directly awaitable
      // and resolves to { data, error } (the codebase awaits it that way).
      rpc: (name: string, args: Record<string, unknown>) => {
        rpcCalls.push({ name, args: { ...args } });
        const thrown = handlers.rpcThrow?.(name, args);
        if (thrown) return Promise.reject(thrown);
        return Promise.resolve({
          data: handlers.rpc?.(name, args) ?? null,
          error: handlers.rpcError?.(name, args) ?? null,
        });
      },
    },
    calls,
    rpcCalls,
  };
}

function mockSession(userId: string | null) {
  vi.mocked(createClient).mockResolvedValue({
    auth: {
      getUser: async () => ({
        data: { user: userId ? { id: userId } : null },
      }),
    },
  } as never);
}

const PROFILE_ROW = {
  id: ADMIN_ID,
  email: "admin@example.com",
  full_name: "Admin User",
  avatar_url: null,
  selected_goal: "arbeit",
  daily_email_limit: 50,
  account_status: "active",
  created_at: "2026-09-01T00:00:00.000Z",
  updated_at: "2026-09-01T00:00:00.000Z",
};

function mockAdminData(handlers: Parameters<typeof makeMock>[0]) {
  const mock = makeMock(handlers);
  vi.mocked(createAdminClient).mockReturnValue(mock.client as never);
  return mock;
}

/** requireAdmin needs: admins row for the session user + profiles row. */
function adminLookupHandlers(
  extra: {
    single?: (
      table: string,
      filters: Filters,
    ) => Record<string, unknown> | null;
    rpc?: (
      name: string,
      args: Record<string, unknown>,
    ) => Record<string, unknown> | null;
    rpcError?: (name: string, args: Record<string, unknown>) => DbErr | null;
    rpcThrow?: (name: string, args: Record<string, unknown>) => Error | null;
    rowError?: (table: string, filters: Filters) => DbErr | null;
  } = {},
) {
  return {
    single: (table: string, filters: Filters) => {
      if (table === "admins" && filters["user_id"] === ADMIN_ID)
        return { user_id: ADMIN_ID };
      if (table === "profiles" && filters["id"] === ADMIN_ID)
        return PROFILE_ROW;
      if (table === "profiles" && filters["id"] === OTHER_ID)
        return { ...PROFILE_ROW, id: OTHER_ID, email: "other@example.com" };
      if (table === "profiles" && filters["id"] === TARGET_ID)
        return { ...PROFILE_ROW, id: TARGET_ID, email: "target@example.com" };
      return extra.single?.(table, filters) ?? null;
    },
    rpc: extra.rpc,
    rpcError: extra.rpcError,
    rpcThrow: extra.rpcThrow,
    rowError: extra.rowError,
  };
}

const post = (body: unknown, target = TARGET_ID) =>
  POST(
    new Request("http://localhost/api/admin/users/x", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }) as never,
    { params: Promise.resolve({ id: target }) } as never,
  );

describe("admin authorization", () => {
  beforeEach(() => vi.clearAllMocks());

  it("no session → 403", async () => {
    mockSession(null);
    const response = await post({ action: "grant_admin" });
    expect(response.status).toBe(403);
  });

  it("non-admin session → 403 (self-elevation impossible: admins table has no user writes)", async () => {
    mockSession(OTHER_ID);
    const mock = mockAdminData(
      adminLookupHandlers({
        single: (table, filters) =>
          table === "admins" && filters["user_id"] === OTHER_ID ? null : null,
      }),
    );
    const response = await post({ action: "grant_admin" });
    expect(response.status).toBe(403);
    // No audit row, no write of any kind.
    expect(
      mock.calls.filter((c) => c.op === "insert" || c.op === "upsert"),
    ).toEqual([]);
  });

  it("admin → action executes with the SESSION actor (never a body actor)", async () => {
    mockSession(ADMIN_ID);
    const mock = mockAdminData(
      adminLookupHandlers({
        // The write happens INSIDE the atomic manage_subscription RPC; the
        // app layer no longer performs its own subscriptions upsert or audit
        // insert (the RPC does both in one transaction).
        rpc: (name) =>
          name === "manage_subscription" ? { status: "ok" } : null,
      }),
    );
    const response = await post({
      action: "set_plan",
      plan: "pro",
      periodDays: 30,
    });
    expect(response.status).toBe(200);
    // No application-level subscriptions write — everything is in the RPC.
    expect(mock.calls.filter((c) => c.table === "subscriptions")).toEqual([]);
    expect(mock.calls.filter((c) => c.table === "admin_audit_log")).toEqual([]);
    const rpc = mock.rpcCalls.find((c) => c.name === "manage_subscription");
    expect(rpc).toBeDefined();
    expect(rpc?.args).toMatchObject({
      p_actor_id: ADMIN_ID, // actor derived from the SESSION
      p_target_id: TARGET_ID, // target from the URL param
      p_action: "set_plan",
      p_plan: "pro",
      p_period_days: 30,
    });
  });

  it("invalid target uuid → 400, no writes", async () => {
    mockSession(ADMIN_ID);
    const mock = mockAdminData(adminLookupHandlers());
    const response = await post({ action: "grant_admin" }, "not-a-uuid");
    expect(response.status).toBe(400);
    expect(
      mock.calls.filter((c) => ["insert", "upsert", "delete"].includes(c.op)),
    ).toEqual([]);
  });

  it("unknown user → 404", async () => {
    mockSession(ADMIN_ID);
    mockAdminData(
      adminLookupHandlers({
        single: (table, filters) =>
          table === "profiles" &&
          filters["id"] === "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
            ? null
            : null,
      }),
    );
    const response = await post(
      { action: "grant_admin" },
      "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    );
    expect(response.status).toBe(404);
  });

  it.each([
    [{ action: "set_plan", plan: "plus", periodDays: 10, user_id: OTHER_ID }],
    [
      {
        action: "set_plan",
        plan: "plus",
        periodDays: 10,
        entitlements: { admin: true },
      },
    ],
    [{ action: "self_elevate" }],
    [{ action: "set_plan", plan: "enterprise", periodDays: 30 }],
    [{ action: "set_plan", plan: "plus", periodDays: 31 }],
  ])("rejects invalid/injected client billing data %# → 400", async (body) => {
    mockSession(ADMIN_ID);
    const mock = mockAdminData(adminLookupHandlers());
    const response = await post(body);
    expect(response.status).toBe(400);
    expect(
      mock.calls.filter((c) => ["insert", "upsert", "delete"].includes(c.op)),
    ).toEqual([]);
  });

  it.each([
    // Unsupported plan/duration pairs (the flat 1|30|365 allowlist is gone):
    [{ action: "set_plan", plan: "plus", periodDays: 30 }],
    [{ action: "set_plan", plan: "pro", periodDays: 10 }],
    [{ action: "set_plan", plan: "plus", periodDays: 1 }],
    [{ action: "set_plan", plan: "pro", periodDays: 365 }],
    // Plan-changing actions require their documented pair — no partials:
    [{ action: "set_plan", plan: "plus" }],
    [{ action: "set_plan", periodDays: 10 }],
    [{ action: "reactivate_subscription", plan: "plus", periodDays: 30 }],
    [{ action: "reactivate_subscription", plan: "pro", periodDays: 10 }],
  ])(
    "rejects an unsupported plan/duration pair %# → 400, nothing reaches the DB",
    async (body) => {
      mockSession(ADMIN_ID);
      const mock = mockAdminData(adminLookupHandlers());
      const response = await post(body);
      expect(response.status).toBe(400);
      expect(
        mock.rpcCalls.filter((c) => c.name === "manage_subscription"),
        "no manage_subscription RPC for an invalid pair",
      ).toEqual([]);
      expect(
        mock.calls.filter((c) => ["insert", "upsert", "delete"].includes(c.op)),
      ).toEqual([]);
    },
  );

  it("cancel without a subscription → 409 (RPC reports no_subscription)", async () => {
    mockSession(ADMIN_ID);
    mockAdminData(
      adminLookupHandlers({
        // The atomic RPC is the source of truth: with no active
        // subscription it returns status 'no_subscription', which the app
        // maps to a 409.
        rpc: (name) =>
          name === "manage_subscription" ? { status: "no_subscription" } : null,
      }),
    );
    const response = await post({ action: "cancel_subscription" });
    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("no_subscription");
  });

  it("self-revocation is blocked (lockout guard)", async () => {
    mockSession(ADMIN_ID);
    const mock = mockAdminData(adminLookupHandlers());
    const response = await post({ action: "revoke_admin" }, ADMIN_ID);
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("self_revoke_blocked");
    expect(
      mock.calls.filter((c) => c.op === "delete" && c.table === "admins"),
    ).toEqual([]);
  });

  it("grant_admin writes the admins table + audit row (cross-user: actor ≠ target)", async () => {
    mockSession(ADMIN_ID);
    const mock = mockAdminData(adminLookupHandlers());
    const response = await post({ action: "grant_admin" });
    expect(response.status).toBe(200);
    const upsert = mock.calls.find(
      (c) => c.table === "admins" && c.op === "upsert",
    );
    expect((upsert?.args[0] as Record<string, unknown>).user_id).toBe(
      TARGET_ID,
    );
    const audit = mock.calls.find(
      (c) => c.table === "admin_audit_log" && c.op === "insert",
    );
    expect(audit).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Per-plan assignment durations (migration 20261128 pairing):
//   Plus = exactly 10 days (canonical premium_10d tier)
//   Pro  = exactly 30 days (preserved intended duration)
// The pairing is enforced at the route (zod) AND in executeAdminAction
// (the service layer) — and, authoritatively, in the RPC itself
// (tests/billing-rls-pg.test.ts, real PostgreSQL).
// ---------------------------------------------------------------------------

describe("per-plan assignment durations (plus=10d, pro=30d)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("set_plan plus + 10 days → 200, the RPC receives p_plan=plus, p_period_days=10", async () => {
    mockSession(ADMIN_ID);
    const mock = mockAdminData(
      adminLookupHandlers({
        rpc: (name) =>
          name === "manage_subscription" ? { status: "ok" } : null,
      }),
    );
    const response = await post({
      action: "set_plan",
      plan: "plus",
      periodDays: 10,
    });
    expect(response.status).toBe(200);
    const rpc = mock.rpcCalls.find((c) => c.name === "manage_subscription");
    expect(rpc?.args).toMatchObject({
      p_action: "set_plan",
      p_plan: "plus",
      p_period_days: 10,
    });
  });

  it("set_plan pro + 30 days → 200 (Pro's intended duration is preserved)", async () => {
    mockSession(ADMIN_ID);
    const mock = mockAdminData(
      adminLookupHandlers({
        rpc: (name) =>
          name === "manage_subscription" ? { status: "ok" } : null,
      }),
    );
    const response = await post({
      action: "set_plan",
      plan: "pro",
      periodDays: 30,
    });
    expect(response.status).toBe(200);
    const rpc = mock.rpcCalls.find((c) => c.name === "manage_subscription");
    expect(rpc?.args).toMatchObject({
      p_action: "set_plan",
      p_plan: "pro",
      p_period_days: 30,
    });
  });

  it("reactivate_subscription plus + 10 / pro + 30 → 200 (per-plan reactivation)", async () => {
    mockSession(ADMIN_ID);
    const mock = mockAdminData(
      adminLookupHandlers({
        rpc: (name) =>
          name === "manage_subscription" ? { status: "ok" } : null,
      }),
    );
    const r1 = await post({
      action: "reactivate_subscription",
      plan: "plus",
      periodDays: 10,
    });
    expect(r1.status).toBe(200);
    const r2 = await post({
      action: "reactivate_subscription",
      plan: "pro",
      periodDays: 30,
    });
    expect(r2.status).toBe(200);
    const rpcs = mock.rpcCalls.filter((c) => c.name === "manage_subscription");
    expect(rpcs).toHaveLength(2);
    expect(rpcs[0]?.args).toMatchObject({
      p_action: "reactivate_subscription",
      p_plan: "plus",
      p_period_days: 10,
    });
    expect(rpcs[1]?.args).toMatchObject({
      p_action: "reactivate_subscription",
      p_plan: "pro",
      p_period_days: 30,
    });
  });

  it.each([
    [{ plan: "plus", periodDays: 30 }],
    [{ plan: "pro", periodDays: 10 }],
    [{ plan: "plus", periodDays: 1 }],
    [{ plan: "plus", periodDays: 365 }],
    [{ plan: "pro", periodDays: 365 }],
    [{ plan: "plus", periodDays: undefined }],
  ])(
    "executeAdminAction rejects %# with invalid_period and NEVER calls the RPC",
    async (params) => {
      const mock = mockAdminData(
        adminLookupHandlers({
          rpcThrow: (name) =>
            name === "manage_subscription"
              ? new Error("RPC MUST NOT BE CALLED FOR AN INVALID PAIR")
              : null,
        }),
      );
      const result = await executeAdminAction(
        ADMIN_ID,
        TARGET_ID,
        "set_plan",
        params,
      );
      expect(result).toEqual({ ok: false, reason: "invalid_period" });
      expect(
        mock.rpcCalls.filter((c) => c.name === "manage_subscription"),
      ).toEqual([]);
      expect(
        mock.calls.filter((c) => ["insert", "upsert", "delete"].includes(c.op)),
      ).toEqual([]);
    },
  );
});

// ---------------------------------------------------------------------------
// Error transparency — production incident 2026-10-25
//
// The deployed admin UI showed an opaque "db_error" for every subscription
// action. Root cause (reproduced on a disposable PostgreSQL mirror of the
// production schema state): the `manage_subscription` RPC (migration
// 20261126) had never been applied to the production database, so PostgREST
// answered PGRST202 "function ... does not exist" and the app mapped every
// such failure to the undifferentiated reason "db_error".
//
// These tests pin the repaired behavior: the missing-function case gets a
// DISTINCT reason (rpc_unavailable → 503) with a useful per-language UI
// message, the real PostgREST error is recorded server-side (sanitized),
// and no personal data ever reaches the log or the browser.
// ---------------------------------------------------------------------------

describe("admin action error transparency (incident 2026-10-25)", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    consoleSpy.mockRestore();
  });

  const logged = () =>
    consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");

  it("ORIGINAL FAILURE REPRODUCED: manage_subscription missing (PGRST202) → 503 rpc_unavailable, NOT an opaque 400 db_error; the real error is logged server-side", async () => {
    mockSession(ADMIN_ID);
    mockAdminData(
      adminLookupHandlers({
        rpcError: (name) =>
          name === "manage_subscription"
            ? {
                code: "PGRST202",
                message:
                  "function public.manage_subscription(uuid, uuid, text, text, integer, text) does not exist",
              }
            : null,
      }),
    );
    const response = await post({
      action: "set_plan",
      plan: "plus",
      periodDays: 10,
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "rpc_unavailable" });
    // The browser sees only the coarse reason — never the raw SQL error:
    // (asserted by the json above) — while the server log carries the
    // diagnostic signal (code + function name + cause):
    expect(logged()).toContain("PGRST202");
    expect(logged()).toContain("manage_subscription");
    expect(logged()).toContain("does not exist");
    expect(logged()).toContain('action "set_plan"');
    // ...and no personal data (ids are never part of the diagnostic):
    expect(logged()).not.toContain(ADMIN_ID);
    expect(logged()).not.toContain(TARGET_ID);
  });

  it("other database errors stay db_error (400) but are logged with PII REDACTED", async () => {
    const piiUuid = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    const piiEmail = "victim@example.com";
    mockSession(ADMIN_ID);
    mockAdminData(
      adminLookupHandlers({
        rpcError: () => ({
          code: "23503",
          message: `insert or update on table "subscriptions" violates FK for user ${piiUuid} admin ${piiEmail}`,
        }),
      }),
    );
    const response = await post({
      action: "set_plan",
      plan: "pro",
      periodDays: 30,
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "db_error" });
    const out = logged();
    expect(out).toContain("23503");
    expect(out).not.toContain(piiUuid);
    expect(out).not.toContain(piiEmail);
    expect(out).toContain("[uuid]");
    expect(out).toContain("[email]");
  });

  it("a throwing RPC client → db_error (400), still logged (client_exception)", async () => {
    mockSession(ADMIN_ID);
    mockAdminData(
      adminLookupHandlers({
        rpcThrow: (name) =>
          name === "manage_subscription"
            ? new Error("fetch failed (network down)")
            : null,
      }),
    );
    const response = await post({
      action: "cancel_subscription",
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "db_error" });
    expect(logged()).toContain("client_exception");
    expect(logged()).toContain("fetch failed");
  });

  it("grant_admin whose AUDIT insert fails → 500 audit_failed (never a false success)", async () => {
    mockSession(ADMIN_ID);
    const mock = mockAdminData(
      adminLookupHandlers({
        rowError: (table) =>
          table === "admin_audit_log"
            ? { code: "55000", message: "audit insert failed" }
            : null,
      }),
    );
    const response = await post({ action: "grant_admin" });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "audit_failed" });
    // The grant itself WAS committed (the upsert ran) — and the failure is
    // logged with the committed-state caveat:
    expect(
      mock.calls.find((c) => c.table === "admins" && c.op === "upsert"),
    ).toBeDefined();
    expect(logged()).toContain("AUDIT WRITE FAILED");
    expect(logged()).toContain("grant_admin");
  });

  it("revoke_admin whose AUDIT insert fails → 500 audit_failed (never a false success)", async () => {
    mockSession(ADMIN_ID);
    const mock = mockAdminData(
      adminLookupHandlers({
        rowError: (table) =>
          table === "admin_audit_log"
            ? { code: "55000", message: "audit insert failed" }
            : null,
      }),
    );
    const response = await post({ action: "revoke_admin" });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "audit_failed" });
    expect(
      mock.calls.find((c) => c.table === "admins" && c.op === "delete"),
    ).toBeDefined();
    expect(logged()).toContain("revoke_admin");
  });

  it("sanitizeDbDiagnostic: redacts UUIDs + e-mails, collapses whitespace, truncates", () => {
    const s = sanitizeDbDiagnostic(
      `  error for ${ADMIN_ID} and ${TARGET_ID} admin@example.com\nsecond line`,
    );
    expect(s).toBe("error for [uuid] and [uuid] [email] second line");
    expect(s).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/i);
    expect(s).not.toContain("@");
    const long = sanitizeDbDiagnostic("x".repeat(1000));
    expect(long.length).toBeLessThanOrEqual(300);
  });

  it("isMissingFunctionError: PGRST202 / 42883 / the 42883 message shape → true; everything else → false", () => {
    expect(isMissingFunctionError({ code: "PGRST202" })).toBe(true);
    expect(isMissingFunctionError({ code: "42883" })).toBe(true);
    expect(
      isMissingFunctionError({
        message:
          "function public.manage_subscription(uuid, uuid, text, text, integer, text) does not exist",
      }),
    ).toBe(true);
    expect(
      isMissingFunctionError({
        message: "function  public.activate_trial ( uuid ) does not exist",
      }),
    ).toBe(true);
    expect(
      isMissingFunctionError({ code: "23503", message: "FK violation" }),
    ).toBe(false);
    expect(
      isMissingFunctionError({ message: 'relation "x" does not exist' }),
    ).toBe(false);
    expect(isMissingFunctionError({})).toBe(false);
  });
});

describe("admin user list (cross-user isolation)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("non-admin → 403", async () => {
    mockSession(OTHER_ID);
    mockAdminData(adminLookupHandlers());
    const response = await GET(
      new Request("http://localhost/api/admin/users") as never,
    );
    expect(response.status).toBe(403);
  });

  it("admin → bounded server-derived list (no raw storage/tokens)", async () => {
    mockSession(ADMIN_ID);
    mockAdminData({
      ...adminLookupHandlers(),
      list: (table) => {
        if (table === "profiles")
          return [
            {
              id: TARGET_ID,
              email: "target@example.com",
              full_name: "Target User",
              selected_goal: "ausbildung",
              account_status: "active",
              created_at: "2026-09-02T00:00:00.000Z",
            },
          ];
        if (table === "subscriptions")
          return [
            {
              user_id: TARGET_ID,
              plan: "pro",
              status: "active",
              current_period_end: "2026-11-01T00:00:00.000Z",
            },
          ];
        if (table === "admins") return [];
        return null;
      },
      // Name-aware: the rate limiter reads a different shape than the
      // usage snapshot (the mock is faithful — both are awaited directly).
      rpc: (name) => {
        if (name === "check_rate_limit")
          return { allowed: true, count: 1, limit: 30, retry_after: 0 };
        return {
          date: "2026-10-01",
          emails_sent: 1,
          emails_reserved: 0,
          daily_limit: 500,
          remaining: 499,
        };
      },
    });
    const response = await GET(
      new Request("http://localhost/api/admin/users") as never,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      users: Array<Record<string, unknown>>;
    };
    expect(body.users).toHaveLength(1);
    expect(body.users[0]).toMatchObject({
      id: TARGET_ID,
      email: "target@example.com",
      is_admin: false,
      subscription: { plan: "pro", status: "active" },
    });
    // No token/secret fields may ever appear.
    expect(JSON.stringify(body)).not.toMatch(/token|secret|password/i);
  });
});

describe("billing webhook seam", () => {
  it("always answers 501 provider_not_configured and writes nothing", async () => {
    const mock = mockAdminData({});
    const response = await webhookRoute.POST(
      new Request("http://localhost/api/billing/webhook", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          event: "subscription.created",
          user_id: RANDOM_USER_ID,
        }),
      }) as never,
    );
    expect(response.status).toBe(501);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.error).toBe("billing_provider_not_configured");
    // No database activity at all while unconfigured.
    expect(
      mock.calls.filter((c) =>
        ["insert", "upsert", "update", "delete"].includes(c.op),
      ),
    ).toEqual([]);
  });
});
