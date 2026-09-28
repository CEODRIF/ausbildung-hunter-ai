import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

const { createClient } = await import("@/lib/supabase/server");
const { createAdminClient } = await import("@/lib/supabase/admin");
const { POST } = await import("@/app/api/admin/users/[id]/route");
const { GET } = await import("@/app/api/admin/users/route");
const webhookRoute = await import("@/app/api/billing/webhook/route");

const ADMIN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TARGET_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const RANDOM_USER_ID = "eeeeeeee-eeee-4eee-8eeee-eeeeeeeeeeee";

interface Filters {
  [key: string]: unknown;
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
}) {
  const calls: Array<{
    table: string;
    op: string;
    args: unknown[];
    filters: Filters;
  }> = [];
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
                error: null,
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
      rpc: (name: string, args: Record<string, unknown>) => ({
        single: async () => ({
          data: handlers.rpc?.(name, args) ?? null,
          error: null,
        }),
      }),
    },
    calls,
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
        single: (table, filters) =>
          table === "subscriptions" && filters["user_id"] === TARGET_ID
            ? null
            : null,
      }),
    );
    const response = await post({
      action: "set_plan",
      plan: "pro",
      periodDays: 30,
    });
    expect(response.status).toBe(200);
    const upsert = mock.calls.find(
      (c) => c.table === "subscriptions" && c.op === "upsert",
    );
    expect(upsert).toBeDefined();
    const payload = upsert?.args[0] as Record<string, unknown>;
    expect(payload.user_id).toBe(TARGET_ID); // target from URL param
    expect(payload.plan).toBe("pro");
    expect(payload.created_by).toBe(ADMIN_ID); // actor from session
    const audit = mock.calls.find(
      (c) => c.table === "admin_audit_log" && c.op === "insert",
    );
    const auditPayload = audit?.args[0] as Record<string, unknown>;
    expect(auditPayload).toMatchObject({
      actor_id: ADMIN_ID,
      target_user_id: TARGET_ID,
      action: "set_plan",
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
    [{ action: "set_plan", plan: "plus", periodDays: 30, user_id: OTHER_ID }],
    [
      {
        action: "set_plan",
        plan: "plus",
        periodDays: 30,
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

  it("cancel without a subscription → 409", async () => {
    mockSession(ADMIN_ID);
    mockAdminData(
      adminLookupHandlers({
        single: (table, filters) =>
          table === "subscriptions" && filters["user_id"] === TARGET_ID
            ? null
            : null,
      }),
    );
    const response = await post({ action: "cancel_subscription" });
    expect(response.status).toBe(409);
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
      rpc: () => ({
        date: "2026-10-01",
        emails_sent: 1,
        emails_reserved: 0,
        daily_limit: 500,
        remaining: 499,
      }),
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
