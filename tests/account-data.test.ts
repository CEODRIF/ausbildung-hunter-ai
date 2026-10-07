import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

const { createClient } = await import("@/lib/supabase/server");
const { createAdminClient } = await import("@/lib/supabase/admin");
const { exportUserData, deleteUserAccount } =
  await import("@/lib/account-data");
const { GET } = await import("@/app/api/account/export/route");
const { POST } = await import("@/app/api/account/delete/route");

const USER_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ID = "22222222-2222-4222-8222-222222222222";

const PROFILE = {
  id: USER_ID,
  email: "user@example.com",
  full_name: "Test User",
  selected_goal: "arbeit",
  account_status: "active",
  created_at: "2026-08-01T10:00:00.000Z",
};

interface AdminHandlers {
  maybeSingle?: (
    table: string,
    filters: Record<string, unknown>,
  ) => Record<string, unknown> | null;
  list?: (
    table: string,
    filters: Record<string, unknown>,
  ) => Record<string, unknown>[];
  listError?: (table: string) => string | null;
  del?: (
    table: string,
    filters: Record<string, unknown>,
  ) => { error: { message: string } | null };
  authDelete?: (userId: string) => { error: { message: string } | null };
  storageList?: (
    bucket: string,
  ) => Array<{ name: string; metadata?: Record<string, unknown> }>;
  storageListError?: (bucket: string) => string | null;
  storageRemove?: (
    bucket: string,
    paths: string[],
  ) => { error: { message: string } | null };
}

/** Faithful chain mock: mirrors PostgREST behaviour (search prefixes
 *  filter storage listings; RLS-style scoping is the handler's job). */
function makeAdminMock(handlers: AdminHandlers = {}) {
  const calls: Array<{
    table: string;
    op: string;
    filters: Record<string, unknown>;
  }> = [];
  const authCalls: string[] = [];
  const storageCalls: Array<{
    bucket: string;
    op: string;
    paths?: string[];
  }> = [];

  const from = (table: string) => {
    const filters: Record<string, unknown> = {};
    const ops: string[] = [];
    const chain: Record<string | symbol, unknown> = new Proxy(
      {},
      {
        get(_t, prop) {
          if (typeof prop !== "string") return undefined;
          if (prop === "select" || prop === "order")
            return () => {
              ops.push(prop);
              return chain;
            };
          if (prop === "eq" || prop === "lt" || prop === "gte" || prop === "in")
            return (col: string, val: unknown) => {
              filters[col] = val;
              ops.push(prop);
              return chain;
            };
          if (prop === "limit")
            return (...a: unknown[]) => {
              ops.push("limit");
              filters["limit"] = a[0];
              return chain;
            };
          if (prop === "delete")
            return () => {
              ops.push("delete");
              return chain;
            };
          if (prop === "maybeSingle" || prop === "single")
            return async () => {
              calls.push({ table, op: prop, filters: { ...filters } });
              return {
                data: handlers.maybeSingle?.(table, { ...filters }) ?? null,
                error: null,
              };
            };
          if (prop === "then")
            return (onF?: unknown) => {
              const isDelete = ops.includes("delete");
              const op = isDelete ? "delete" : "list";
              calls.push({ table, op, filters: { ...filters } });
              const result = isDelete
                ? (handlers.del?.(table, { ...filters }) ?? {
                    data: null,
                    error: null,
                  })
                : (() => {
                    const msg = handlers.listError?.(table);
                    if (msg) throw new Error(msg);
                    return {
                      data: handlers.list?.(table, { ...filters }) ?? [],
                      error: null,
                    };
                  })();
              return Promise.resolve(result).then(onF as never);
            };
          return () => {
            ops.push(prop);
            return chain;
          };
        },
      },
    );
    return chain;
  };

  const client = {
    from,
    auth: {
      admin: {
        deleteUser: async (userId: string) => {
          authCalls.push(userId);
          return handlers.authDelete?.(userId) ?? { error: null };
        },
      },
    },
    storage: {
      from: (bucket: string) => ({
        list: async (_prefix: string, opts: { search?: string }) => {
          storageCalls.push({ bucket, op: "list" });
          const msg = handlers.storageListError?.(bucket);
          if (msg) throw new Error(msg);
          const files = handlers.storageList?.(bucket) ?? [];
          const search = opts?.search;
          return {
            data: search
              ? files.filter((f) => f.name.startsWith(search))
              : files,
            error: null,
          };
        },
        remove: async (paths: string[]) => {
          storageCalls.push({ bucket, op: "remove", paths });
          return handlers.storageRemove?.(bucket, paths) ?? { error: null };
        },
      }),
    },
  };
  vi.mocked(createAdminClient).mockReturnValue(client as never);
  return { calls, authCalls, storageCalls };
}

function mockSession(userId: string | null, profile: Record<string, unknown>) {
  vi.mocked(createClient).mockResolvedValue({
    auth: {
      getUser: async () => ({
        data: { user: userId ? { id: userId } : null },
      }),
    },
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({
            data: table === "profiles" ? profile : null,
            error: null,
          }),
        }),
      }),
    }),
  } as never);
}

const OWN_FILES = [
  { name: `${USER_ID}/a.pdf`, metadata: { size: 100 } },
  { name: `${USER_ID}/sub/b.pdf`, metadata: { size: 200 } },
  { name: `${OTHER_ID}/other.pdf`, metadata: { size: 300 } },
];

const LIST_DATA: Record<string, Record<string, unknown>[]> = {
  candidate_profiles: [{ profile_json: { goal: "arbeit" } }],
  saved_opportunities: [{ opportunity_key: "arbeitsagentur:X", title: "M" }],
  application_drafts: [{ goal: "arbeit", subject: "Bewerbung" }],
  email_campaigns: [{ subject: "C", status: "completed" }],
  email_messages: [{ recipient_email: "x@y.z", status: "sent" }],
  ai_conversations: [{ title: "Hi" }],
  ai_messages: [{ conversation_id: "c1", role: "user", content: "hello" }],
  bewerbung_scans: [{ goal: "arbeit", status: "completed" }],
  subscriptions: [{ plan: "free", status: "active" }],
  daily_usage: [{ date: "2026-09-28", emails_sent: 1, ai_requests: 2 }],
  activity_logs: [{ activity_type: "campaign_created" }],
};

function exportHandlers(extra: AdminHandlers = {}): AdminHandlers {
  return {
    maybeSingle: (table, filters) =>
      table === "profiles" && filters["id"] === USER_ID ? PROFILE : null,
    list: (table, filters) =>
      filters["user_id"] === USER_ID ? (LIST_DATA[table] ?? []) : [],
    storageList: () => OWN_FILES,
    ...extra,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("exportUserData", () => {
  it("exports the full profile-scoped dataset with an ISO timestamp", async () => {
    makeAdminMock(exportHandlers());
    const result = await exportUserData(USER_ID);

    expect(Number.isNaN(Date.parse(result.exported_at))).toBe(false);
    expect(result.user).toEqual({
      email: PROFILE.email,
      full_name: PROFILE.full_name,
      selected_goal: PROFILE.selected_goal,
      account_status: PROFILE.account_status,
      created_at: PROFILE.created_at,
    });
    expect(result.candidate_profile).toEqual({
      profile_json: { goal: "arbeit" },
    });
    expect(result.saved_opportunities).toHaveLength(1);
    expect(result.application_drafts).toHaveLength(1);
    expect(result.email_campaigns).toHaveLength(1);
    expect(result.email_messages).toHaveLength(1);
    expect(result.ai_conversations).toHaveLength(1);
    expect(result.ai_messages).toHaveLength(1);
    expect(result.bewerbung_scans).toHaveLength(1);
    expect(result.subscriptions).toHaveLength(1);
    expect(result.daily_usage).toHaveLength(1);
    expect(result.activity_logs).toHaveLength(1);
    expect(result.notes).toEqual(
      expect.arrayContaining([expect.stringContaining("OAuth tokens")]),
    );
  });

  it("lists only this user's storage files (metadata only)", async () => {
    const mock = makeAdminMock(exportHandlers());
    const result = await exportUserData(USER_ID);
    // 2 own files × 4 buckets (OTHER_ID's file is filtered out; Phase 6A
    // added the community-images bucket to the user-prefix inventory).
    expect(result.storage_files).toHaveLength(8);
    for (const file of result.storage_files as Array<Record<string, unknown>>) {
      expect(String(file["name"])).toMatch(new RegExp(`^${USER_ID}/`));
      expect(file["size"]).toBeTypeOf("number");
      expect(Object.keys(file).sort()).toEqual(["bucket", "name", "size"]);
    }
    expect(
      (result.storage_files as Array<Record<string, unknown>>)
        .map((f) => String(f["bucket"]))
        .sort(),
    ).toEqual([
      "ai-files",
      "ai-files",
      "application-attachments",
      "application-attachments",
      "avatars",
      "avatars",
      "community-images",
      "community-images",
    ]);
    expect(mock.calls.some((c) => c.table === "email_accounts")).toBe(false);
  });

  it("never queries other users' rows or the encrypted-credential table", async () => {
    const mock = makeAdminMock(
      exportHandlers({
        // Faithful scoping: any cross-user request returns nothing.
        list: (table, filters) =>
          filters["user_id"] === USER_ID ? (LIST_DATA[table] ?? []) : [],
      }),
    );
    await exportUserData(USER_ID);
    // Every table is queried through its own owner column (Phase 6A:
    // community_questions keys ownership on author_id).
    const OWNER_COLUMN: Record<string, string> = {
      profiles: "id",
      community_questions: "author_id",
    };
    for (const call of mock.calls) {
      const column = OWNER_COLUMN[call.table] ?? "user_id";
      expect(call.filters[column]).toBe(USER_ID);
      expect(call.table).not.toBe("email_accounts");
    }
  });

  it("survives a single broken table (best-effort inventory)", async () => {
    makeAdminMock(
      exportHandlers({
        listError: (table) => (table === "ai_conversations" ? "boom" : null),
      }),
    );
    const result = await exportUserData(USER_ID);
    expect(result.ai_conversations).toEqual([]);
    expect(result.saved_opportunities).toHaveLength(1);
  });
});

describe("deleteUserAccount", () => {
  it("inventories community images, deletes drafts, cascades auth, then sweeps storage", async () => {
    const mock = makeAdminMock({ storageList: () => OWN_FILES });
    const result = await deleteUserAccount(USER_ID);

    expect(result).toEqual({ ok: true, storageSwept: true });
    // Phase 6A: the Community image reference inventory runs BEFORE the
    // cascade (its rows attribute the conversation-prefixed DM paths), then
    // drafts, then the auth cascade, then the storage sweeps (existing
    // buckets + the community-images backstop).
    expect(mock.calls[0]).toEqual({
      table: "community_messages",
      op: "list",
      filters: { user_id: USER_ID, limit: 1000 },
    });
    expect(mock.calls[1]).toEqual({
      table: "community_questions",
      op: "list",
      filters: { author_id: USER_ID, limit: 1000 },
    });
    expect(mock.calls[2]).toEqual({
      table: "community_direct_messages",
      op: "list",
      filters: { user_id: USER_ID, limit: 1000 },
    });
    expect(mock.calls[3]).toEqual({
      table: "application_drafts",
      op: "delete",
      filters: { user_id: USER_ID },
    });
    expect(mock.authCalls).toEqual([USER_ID]);
    expect(mock.storageCalls).toEqual([
      { bucket: "ai-files", op: "list" },
      {
        bucket: "ai-files",
        op: "remove",
        paths: [`${USER_ID}/a.pdf`, `${USER_ID}/sub/b.pdf`],
      },
      { bucket: "application-attachments", op: "list" },
      {
        bucket: "application-attachments",
        op: "remove",
        paths: [`${USER_ID}/a.pdf`, `${USER_ID}/sub/b.pdf`],
      },
      { bucket: "avatars", op: "list" },
      {
        bucket: "avatars",
        op: "remove",
        paths: [`${USER_ID}/a.pdf`, `${USER_ID}/sub/b.pdf`],
      },
      // No DB-referenced community paths here (empty inventory) → no exact
      // remove; the user-prefix backstop list + remove still runs.
      { bucket: "community-images", op: "list" },
      {
        bucket: "community-images",
        op: "remove",
        paths: [`${USER_ID}/a.pdf`, `${USER_ID}/sub/b.pdf`],
      },
    ]);
  });

  it("removes only this user's objects (never other tenants' files)", async () => {
    const mock = makeAdminMock({ storageList: () => OWN_FILES });
    await deleteUserAccount(USER_ID);
    for (const call of mock.storageCalls) {
      if (call.op !== "remove") continue;
      for (const path of call.paths ?? [])
        expect(path.startsWith(`${USER_ID}/`)).toBe(true);
    }
  });

  it("aborts before touching storage when the draft delete fails", async () => {
    const mock = makeAdminMock({
      del: (table) =>
        table === "application_drafts"
          ? { error: { message: "fk restriction" } }
          : { error: null },
    });
    await expect(deleteUserAccount(USER_ID)).rejects.toThrow(
      /account_deletion_failed/,
    );
    expect(mock.authCalls).toEqual([]);
    expect(mock.storageCalls).toEqual([]);
  });

  it("aborts before touching storage when the auth delete fails", async () => {
    const mock = makeAdminMock({
      authDelete: () => ({ error: { message: "auth boom" } }),
    });
    await expect(deleteUserAccount(USER_ID)).rejects.toThrow(
      /account_deletion_failed: auth boom/,
    );
    expect(mock.storageCalls).toEqual([]);
  });

  it("reports storageSwept=false when a remove fails (DB already gone)", async () => {
    makeAdminMock({
      storageList: () => OWN_FILES,
      storageRemove: () => ({ error: { message: "denied" } }),
    });
    const result = await deleteUserAccount(USER_ID);
    expect(result).toEqual({ ok: true, storageSwept: false });
  });

  it("reports storageSwept=false when a bucket listing throws", async () => {
    makeAdminMock({
      storageList: () => OWN_FILES,
      storageListError: (bucket) =>
        bucket === "ai-files" ? "bucket down" : null,
    });
    const result = await deleteUserAccount(USER_ID);
    expect(result).toEqual({ ok: true, storageSwept: false });
  });

  it("succeeds with storageSwept=true when there are no files", async () => {
    const mock = makeAdminMock({ storageList: () => [] });
    const result = await deleteUserAccount(USER_ID);
    expect(result).toEqual({ ok: true, storageSwept: true });
    expect(mock.storageCalls.filter((c) => c.op === "remove")).toEqual([]);
  });
});

describe("POST /api/account/delete", () => {
  const post = (body: unknown, raw = false) =>
    POST(
      new Request("http://localhost/api/account/delete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: raw ? String(body) : JSON.stringify(body),
      }),
    );

  it("401 without a session", async () => {
    mockSession(null, PROFILE);
    const res = await post({ confirmEmail: "user@example.com" });
    expect(res.status).toBe(401);
  });

  it("400 on invalid JSON", async () => {
    mockSession(USER_ID, PROFILE);
    const res = await post("{not json", true);
    expect(res.status).toBe(400);
  });

  it("400 when confirmEmail is not an email", async () => {
    mockSession(USER_ID, PROFILE);
    const res = await post({ confirmEmail: "not-an-email" });
    expect(res.status).toBe(400);
  });

  it("400 on extra fields (strict schema rejects user_id injection)", async () => {
    mockSession(USER_ID, PROFILE);
    const res = await post({
      confirmEmail: "user@example.com",
      user_id: OTHER_ID,
    });
    expect(res.status).toBe(400);
  });

  it("400 when the typed email does not match the account", async () => {
    mockSession(USER_ID, PROFILE);
    const mock = makeAdminMock({ storageList: () => OWN_FILES });
    const res = await post({ confirmEmail: "other@example.com" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "Email does not match this account",
    });
    expect(mock.authCalls).toEqual([]);
  });

  it("accepts the email case-insensitively and deletes", async () => {
    mockSession(USER_ID, PROFILE);
    makeAdminMock({ storageList: () => OWN_FILES });
    const res = await post({ confirmEmail: "USER@example.com" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, storageSwept: true });
  });

  it("500 when deletion fails (account stays unchanged)", async () => {
    mockSession(USER_ID, PROFILE);
    makeAdminMock({ authDelete: () => ({ error: { message: "down" } }) });
    const res = await post({ confirmEmail: "user@example.com" });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("unchanged");
  });
});

describe("GET /api/account/export", () => {
  it("401 without a session", async () => {
    mockSession(null, PROFILE);
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it("returns a downloadable JSON attachment of own data", async () => {
    mockSession(USER_ID, PROFILE);
    makeAdminMock(exportHandlers());
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain(
      'attachment; filename="ausbildungsweg-export-',
    );
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as Record<string, unknown>;
    expect((body["user"] as { email: string }).email).toBe("user@example.com");
    expect(body["exported_at"]).toBeTruthy();
    expect(body["saved_opportunities"]).toHaveLength(1);
  });
});
