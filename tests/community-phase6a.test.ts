/**
 * Community Phase 6A — production hardening: GDPR community-image
 * deletion (A-1), GDPR export (A-2), per-user upload quota (A-3) and
 * storage-janitor coverage (A-4).
 *
 * Everything is exercised with a scripted service-role admin client that
 * RECORDS every DB/storage operation — the assertions prove ownership
 * semantics (only the deleted/exporting user's objects are touched),
 * the DM-path handling (conversation-prefixed, non-user-prefixed), the
 * quota gate (server-side, pre-upload, all endpoints), and the janitor
 * safety model (dry-run default, row-reference proof, strict gates,
 * retry-safe).
 *
 * Plus source guards for the v7 migration (additive, service-role-only
 * RPC, no destructive statements, no 6B/6C/6F content).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/auth", () => ({ getCurrentUserAndProfile: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true, count: 1, limit: 100, retry_after: 0 })),
  rateLimitHeaders: () => ({}),
  tooManyRequests: () =>
    new Response(JSON.stringify({ error: "rate_limited" }), {
      status: 429,
      headers: { "content-type": "application/json" },
    }),
}));
vi.mock("@/lib/community/social", () => ({
  createSocialNotification: vi.fn(async () => ({ ok: true })),
  socialSendKey: (a: string, b: string) => `${a}:${b}`,
  notifyMentions: vi.fn(async () => undefined),
  loadDmConversation: vi.fn(),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("server-only", () => ({}));

const { createClient } = await import("@/lib/supabase/server");
const { createAdminClient } = await import("@/lib/supabase/admin");
const { getCurrentUserAndProfile } = await import("@/lib/auth");
const { deleteUserAccount, exportUserData } = await import("@/lib/account-data");
const {
  checkCommunityImageQuota,
  COMMUNITY_USER_IMAGE_QUOTA_BYTES,
} = await import("@/lib/community/image-quota");
const { reconcileStorage } = await import("@/lib/storage-reconcile");
const { POST: questionPOST } = await import("@/app/api/community/questions/route");

// ---------------------------------------------------------------------------
// Fixtures + scripted admin client
// ---------------------------------------------------------------------------

const ALICE = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const DEAD = "99999999-9999-4999-8999-999999999999"; // not a live user
const CONV = "b1000000-0000-4000-8000-000000000002";
const MSG = "33333333-3333-4333-8333-333333333333";
const QID = "44444444-4444-4444-8444-444444444444";

interface Term {
  data: unknown;
  error: { message: string; code?: string } | null;
}
const ok = (data: unknown = null): Term => ({ data, error: null });
const fail = (message: string, code?: string): Term => ({ data: null, error: { message, code } });

interface Call {
  kind: "table" | "rpc" | "list" | "remove" | "upload" | "deleteUser";
  detail: string;
  args: unknown[];
}

interface AdminScript {
  tables?: Record<string, Term[]>;
  rpc?: Array<Term | ((fn: string, args: Record<string, unknown>) => Term)>;
  lists?: Record<string, Array<{ data: unknown[]; error?: unknown }>>;
  removes?: Record<string, Array<{ error?: unknown }>>;
  authDeleteError?: unknown;
}

function mockAdmin(script: AdminScript = {}): Call[] {
  const calls: Call[] = [];
  const from = (table: string) => {
    const tables = (script.tables ??= {});
    const queue = (tables[table] ??= []);
    const base: Record<string, unknown> = {};
    const op = (name: string) =>
      (...args: unknown[]) => {
        calls.push({ kind: "table", detail: `${table}.${name}`, args });
        return base;
      };
    base.select = op("select");
    base.eq = op("eq");
    base.in = op("in");
    base.order = op("order");
    base.limit = op("limit");
    base.range = op("range");
    base.delete = op("delete");
    base.update = op("update");
    base.insert = op("insert");
    const consume = (): Term => (queue.length > 0 ? (queue.shift() as Term) : ok(null));
    base.maybeSingle = () => {
      const r = consume();
      const data = Array.isArray(r.data) ? ((r.data as unknown[])[0] ?? null) : r.data;
      return Promise.resolve({ data, error: r.error ?? null });
    };
    base.single = () => Promise.resolve(consume());
    base.then = (onF?: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
      Promise.resolve(consume()).then(onF as never, onR as never);
    return base;
  };
  const rpcQueue = (script.rpc ??= []);
  const rpc = (fn: string, args?: Record<string, unknown>) => {
    calls.push({ kind: "rpc", detail: fn, args: [args] });
    const next = rpcQueue.length > 0 ? rpcQueue.shift() : ok(null);
    const term =
      typeof next === "function"
        ? (next as (f: string, a: Record<string, unknown>) => Term)(fn, args ?? {})
        : (next as Term);
    return Promise.resolve(term);
  };
  const storageFrom = (bucket: string) => {
    const listQueue = (script.lists ??= {})[bucket] ?? ((script.lists![bucket] = []));
    const removeQueue = (script.removes ??= {})[bucket] ?? ((script.removes![bucket] = []));
    return {
      list: async (_path: string, opts?: { search?: string; limit?: number; offset?: number }) => {
        calls.push({ kind: "list", detail: `${bucket}::${opts?.search ?? ""}`, args: [opts] });
        const r = listQueue.shift() ?? { data: [] as unknown[] };
        return { data: r.data, error: r.error ?? null };
      },
      remove: async (paths: string[]) => {
        calls.push({ kind: "remove", detail: bucket, args: [paths] });
        const r = removeQueue.shift() ?? { error: null };
        return { error: r.error ?? null };
      },
      upload: async (p: string) => {
        calls.push({ kind: "upload", detail: `${bucket}::${p}`, args: [] });
        return { data: { path: p }, error: null };
      },
    };
  };
  const client = {
    from,
    rpc,
    storage: { from: storageFrom },
    auth: {
      admin: {
        deleteUser: async (id: string) => {
          calls.push({ kind: "deleteUser", detail: id, args: [] });
          return { error: script.authDeleteError ?? null };
        },
      },
    },
  };
  vi.mocked(createAdminClient).mockReturnValue(client as never);
  return calls;
}

/** Minimal session client (route tests): per-table FIFO + storage upload. */
function mockSession(queues: Record<string, Term[]>) {
  const calls: Call[] = [];
  const from = (table: string) => {
    const queue = (queues[table] ??= []);
    const base: Record<string, unknown> = {};
    const op = (name: string) =>
      (...args: unknown[]) => {
        calls.push({ kind: "table", detail: `${table}.${name}`, args });
        return base;
      };
    base.select = op("select");
    base.eq = op("eq");
    base.in = op("in");
    base.order = op("order");
    base.limit = op("limit");
    base.not = op("not");
    base.is = op("is");
    base.update = op("update");
    base.insert = op("insert");
    base.delete = op("delete");
    const consume = (): Term => (queue.length > 0 ? (queue.shift() as Term) : ok(null));
    base.maybeSingle = () => {
      const r = consume();
      const data = Array.isArray(r.data) ? ((r.data as unknown[])[0] ?? null) : r.data;
      return Promise.resolve({ data, error: r.error ?? null });
    };
    base.single = () => Promise.resolve(consume());
    base.then = (onF?: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
      Promise.resolve(consume()).then(onF as never, onR as never);
    return base;
  };
  vi.mocked(createClient).mockResolvedValue({
    from,
    calls,
    auth: { getUser: () => Promise.resolve({ data: { user: { id: ALICE } }, error: null }) },
    storage: {
      from: () => ({
        upload: async (p: string) => {
          calls.push({ kind: "upload", detail: `session::${p}`, args: [] });
          return { data: { path: p }, error: null };
        },
      }),
    },
  } as never);
  return calls;
}

function asUser(id: string) {
  vi.mocked(getCurrentUserAndProfile).mockResolvedValue({ user: { id } } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// A-1 — GDPR account deletion (community images)
// ---------------------------------------------------------------------------

describe("A-1: GDPR deletion — community images", () => {
  const communityTables = (overrides: Record<string, Term[]> = {}) => ({
    community_messages: [ok([])],
    community_questions: [ok([])],
    community_direct_messages: [ok([])],
    application_drafts: [ok(null)],
    ...overrides,
  });

  it("deletes room message images (DB-referenced + prefix backstop)", async () => {
    const calls = mockAdmin({
      tables: communityTables({
        community_messages: [ok([{ image_path: `${ALICE}/${MSG}/image.png` }])],
      }),
      lists: { "community-images": [{ data: [{ name: `${ALICE}/${MSG}/image.png` }] }] },
    });
    const res = await deleteUserAccount(ALICE);
    expect(res).toEqual({ ok: true, storageSwept: true });
    const removed = calls
      .filter((c) => c.kind === "remove" && c.detail === "community-images")
      .flatMap((c) => c.args[0] as string[]);
    expect(removed).toContain(`${ALICE}/${MSG}/image.png`);
    expect(calls.some((c) => c.kind === "deleteUser" && c.detail === ALICE)).toBe(true);
  });

  it("deletes question images", async () => {
    const calls = mockAdmin({
      tables: communityTables({
        community_questions: [ok([{ image_path: `${ALICE}/${QID}/image.png` }])],
      }),
    });
    const res = await deleteUserAccount(ALICE);
    expect(res.ok).toBe(true);
    const removed = calls
      .filter((c) => c.kind === "remove" && c.detail === "community-images")
      .flatMap((c) => c.args[0] as string[]);
    expect(removed).toContain(`${ALICE}/${QID}/image.png`);
  });

  it("deletes DM images whose paths are NOT user-prefixed", async () => {
    const dmPath = `dm/${CONV}/${ALICE}/${MSG}/image.png`;
    const calls = mockAdmin({
      tables: communityTables({
        community_direct_messages: [ok([{ image_path: dmPath }])],
      }),
    });
    const res = await deleteUserAccount(ALICE);
    expect(res.ok).toBe(true);
    const removed = calls
      .filter((c) => c.kind === "remove" && c.detail === "community-images")
      .flatMap((c) => c.args[0] as string[]);
    expect(removed).toContain(dmPath);
    // The prefix backstop may only search the user's own prefix — never a
    // bare "dm/" (which would enumerate every user's DM images).
    const dmLists = calls.filter((c) => c.kind === "list" && c.detail.endsWith("dm/"));
    expect(dmLists).toEqual([]);
    expect(calls.some((c) => c.kind === "list" && c.detail === `community-images::${ALICE}/`)).toBe(true);
  });

  it("never touches another user's objects (prefix list false-positive filtered)", async () => {
    mockAdmin({
      tables: communityTables({
        community_messages: [ok([{ image_path: `${ALICE}/${MSG}/image.png` }])],
      }),
      // Adversarial: the list returns a foreign object too — the defensive
      // startsWith filter must drop it.
      lists: {
        "community-images": [
          {
            data: [
              { name: `${ALICE}/${MSG}/image.png` },
              { name: `${OTHER}/${MSG}/image.png` },
            ],
          },
        ],
      },
    });
    const res = await deleteUserAccount(ALICE);
    expect(res.ok).toBe(true);
  });

  it("is safe when storage objects are already missing (remove error → flag, no throw)", async () => {
    const calls = mockAdmin({
      tables: communityTables({
        community_messages: [ok([{ image_path: `${ALICE}/${MSG}/image.png` }])],
      }),
      removes: { "community-images": [{ error: { message: "not found" } }, { error: null }] },
    });
    const res = await deleteUserAccount(ALICE);
    expect(res).toEqual({ ok: true, storageSwept: false });
    expect(calls.some((c) => c.kind === "deleteUser")).toBe(true);
  });

  it("is safe when the user has no images at all (no remove calls)", async () => {
    const calls = mockAdmin({ tables: communityTables() });
    const res = await deleteUserAccount(ALICE);
    expect(res).toEqual({ ok: true, storageSwept: true });
    expect(calls.filter((c) => c.kind === "remove")).toEqual([]);
  });

  it("is safe when rows reference null image_path (no phantom paths)", async () => {
    const calls = mockAdmin({
      tables: communityTables({
        community_messages: [ok([{ image_path: null }, { image_path: "" }])],
      }),
    });
    const res = await deleteUserAccount(ALICE);
    expect(res.ok).toBe(true);
    expect(calls.filter((c) => c.kind === "remove")).toEqual([]);
  });

  it("never performs a broad bucket wipe (lists are prefix-searched, removes user-scoped)", async () => {
    const calls = mockAdmin({
      tables: communityTables({
        community_messages: [ok([{ image_path: `${ALICE}/${MSG}/image.png` }])],
      }),
      lists: { "community-images": [{ data: [{ name: `${ALICE}/${MSG}/image.png` }] }] },
    });
    await deleteUserAccount(ALICE);
    const lists = calls.filter((c) => c.kind === "list");
    expect(lists.length).toBeGreaterThan(0);
    for (const l of lists) {
      // detail = `${bucket}::${search}` — a full-bucket list would have an
      // empty search; that must never happen.
      const search = l.detail.split("::")[1] ?? "";
      expect(search.length, `list ${l.detail}`).toBeGreaterThan(0);
    }
    const removed = calls
      .filter((c) => c.kind === "remove")
      .flatMap((c) => c.args[0] as string[]);
    for (const p of removed) {
      expect(p.startsWith(`${ALICE}/`), `removed path ${p}`).toBe(true);
    }
  });

  it("aborts (nothing deleted) when a community reference read fails", async () => {
    const calls = mockAdmin({
      tables: communityTables({ community_questions: [fail("boom")] }),
    });
    await expect(deleteUserAccount(ALICE)).rejects.toThrow(/community reference read/);
    expect(calls.filter((c) => c.kind === "deleteUser")).toEqual([]);
    expect(calls.filter((c) => c.kind === "remove")).toEqual([]);
  });

  it("collects references BEFORE the auth cascade (order guaranteed)", async () => {
    const calls = mockAdmin({
      tables: communityTables({
        community_messages: [ok([{ image_path: `dm/${CONV}/${ALICE}/${MSG}/image.png` }])],
      }),
    });
    await deleteUserAccount(ALICE);
    const collectIdx = calls.findIndex((c) => c.detail === "community_messages.select");
    const draftsIdx = calls.findIndex((c) => c.detail === "application_drafts.delete");
    const cascadeIdx = calls.findIndex((c) => c.kind === "deleteUser");
    expect(collectIdx).toBeGreaterThan(-1);
    expect(collectIdx).toBeLessThan(draftsIdx);
    expect(draftsIdx).toBeLessThan(cascadeIdx);
  });
});

// ---------------------------------------------------------------------------
// A-2 — GDPR export (community images)
// ---------------------------------------------------------------------------

describe("A-2: GDPR export — community images", () => {
  const profileTerm = ok({
    email: "alice@example.com",
    full_name: "Alice",
    selected_goal: null,
    account_status: "active",
    created_at: "2026-01-01T00:00:00Z",
  });

  it("inventories user-prefixed community images with metadata", async () => {
    mockAdmin({
      tables: { profiles: [profileTerm] },
      lists: {
        "community-images": [{ data: [{ name: `${ALICE}/${QID}/image.png`, metadata: { size: 42 } }] }],
      },
    });
    const export_ = await exportUserData(ALICE);
    const entry = (export_.storage_files as Array<Record<string, unknown>>).find(
      (f) => f.bucket === "community-images" && f.name === `${ALICE}/${QID}/image.png`,
    );
    expect(entry).toEqual({ bucket: "community-images", name: `${ALICE}/${QID}/image.png`, size: 42 });
  });

  it("inventories DM images from the owner's own rows (never a bare dm/ list)", async () => {
    const dmPath = `dm/${CONV}/${ALICE}/${MSG}/image.png`;
    const calls = mockAdmin({
      tables: {
        profiles: [profileTerm],
        community_direct_messages: [ok([{ image_path: dmPath }])],
      },
      lists: {
        // call 1: user-prefix list; call 2: own DM sender folder
        "community-images": [
          { data: [] },
          { data: [{ name: dmPath, metadata: { size: 7 } }] },
        ],
      },
    });
    const export_ = await exportUserData(ALICE);
    const entry = (export_.storage_files as Array<Record<string, unknown>>).find(
      (f) => f.name === dmPath,
    );
    expect(entry).toEqual({ bucket: "community-images", name: dmPath, size: 7 });
    const searches = calls.filter((c) => c.kind === "list" && c.detail.startsWith("community-images::"));
    expect(searches.map((c) => c.detail)).toEqual([
      `community-images::${ALICE}/`,
      `community-images::dm/${CONV}/${ALICE}/`,
    ]);
  });

  it("excludes the peer's objects and still reports unconfirmed own paths", async () => {
    const ownPath = `dm/${CONV}/${ALICE}/${MSG}/image.png`;
    const peerPath = `dm/${CONV}/${OTHER}/${MSG}/image.png`;
    mockAdmin({
      tables: {
        profiles: [profileTerm],
        community_direct_messages: [ok([{ image_path: ownPath }, { image_path: null }])],
      },
      lists: {
        "community-images": [
          { data: [] },
          // Adversarial: the folder list also surfaces the peer's object —
          // only the owner's exact paths may be inventoried.
          { data: [{ name: peerPath, metadata: { size: 999 } }, { name: ownPath, metadata: { size: 5 } }] },
        ],
      },
    });
    const export_ = await exportUserData(ALICE);
    const files = export_.storage_files as Array<Record<string, unknown>>;
    expect(files.find((f) => f.name === ownPath)).toEqual({
      bucket: "community-images",
      name: ownPath,
      size: 5,
    });
    expect(files.find((f) => f.name === peerPath)).toBeUndefined();
  });

  it("deletion and export use identical ownership sources (3 tables + owner columns)", async () => {
    const calls = mockAdmin({ tables: { profiles: [profileTerm] } });
    await exportUserData(ALICE);
    const communityReads = calls.filter(
      (c) => c.kind === "table" && c.detail.endsWith(".eq"),
    );
    expect(communityReads.map((c) => c.detail)).toEqual(
      expect.arrayContaining([
        "community_messages.eq",
        "community_questions.eq",
        "community_direct_messages.eq",
      ]),
    );
    const cols = Object.fromEntries(
      communityReads
        .filter((c) => c.detail.includes("community"))
        .map((c) => [c.detail, c.args[0]]), // args[0] = the owner column
    );
    expect(cols["community_messages.eq"]).toBe("user_id");
    expect(cols["community_questions.eq"]).toBe("author_id");
    expect(cols["community_direct_messages.eq"]).toBe("user_id");
  });
});

// ---------------------------------------------------------------------------
// A-3 — per-user upload quota
// ---------------------------------------------------------------------------

describe("A-3: per-user community image quota", () => {
  it("under quota → ok with usage", async () => {
    mockAdmin({ rpc: [ok(10)] });
    const res = await checkCommunityImageQuota(ALICE, 5);
    expect(res).toEqual({ ok: true, usedBytes: 10 });
  });

  it("boundary: used + size === limit → ok", async () => {
    mockAdmin({ rpc: [ok(COMMUNITY_USER_IMAGE_QUOTA_BYTES - 5)] });
    const res = await checkCommunityImageQuota(ALICE, 5);
    expect(res.ok).toBe(true);
  });

  it("over quota → storage_quota with used/limit", async () => {
    mockAdmin({ rpc: [ok(COMMUNITY_USER_IMAGE_QUOTA_BYTES - 4)] });
    const res = await checkCommunityImageQuota(ALICE, 5);
    expect(res).toEqual({
      ok: false,
      code: "storage_quota",
      usedBytes: COMMUNITY_USER_IMAGE_QUOTA_BYTES - 4,
      limitBytes: COMMUNITY_USER_IMAGE_QUOTA_BYTES,
    });
  });

  it("null usage (legacy/missing RPC) → treated as 0", async () => {
    mockAdmin({ rpc: [ok(null)] });
    const res = await checkCommunityImageQuota(ALICE, 1);
    expect(res).toEqual({ ok: true, usedBytes: 0 });
  });

  it("usage query failure → fails CLOSED (no upload possible)", async () => {
    mockAdmin({ rpc: [fail("db down")] });
    const res = await checkCommunityImageQuota(ALICE, 1);
    expect(res).toEqual({ ok: false, code: "quota_check_failed", limitBytes: COMMUNITY_USER_IMAGE_QUOTA_BYTES });
  });

  const PNG = () =>
    new File(
      [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 68, 82, 72])],
      "ok.png",
      { type: "image/png" },
    );
  const formReq = (fields: Record<string, string | File>) => {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) fd.append(k, v);
    return new Request("http://localhost/api/community/questions", { method: "POST", body: fd });
  };
  const good = { title: "Wie beantrage ich ein Visum?", body: "B".repeat(40), room: "fragen-und-antworten" };
  const roomRow = {
    id: "a1000000-0000-4000-8000-000000000001",
    slug: "fragen-und-antworten",
    name: "F&A",
    category_id: "00000000-0000-4000-8000-000000000001",
    description: "d", icon: "Q", position: 1, enabled: true, qna_enabled: true,
  };
  const questionRow = {
    id: QID, room_id: roomRow.id, author_id: ALICE, title: "T", body: "B", tags: [],
    image_path: null, status: "open", accepted_answer_id: null, solved_at: null,
    created_at: "2026-10-02T09:00:00Z", updated_at: "2026-10-02T09:00:00Z",
  };
  const baseRouteMocks = (rpcTerm: Term) => {
    const calls = mockAdmin({
      rpc: [rpcTerm],
      tables: { community_profiles: [ok({ community_suspended: false, community_muted_until: null })] },
    });
    const scalls = mockSession({
      community_rooms: [ok(roomRow)],
      community_questions: [ok(questionRow)],
    });
    asUser(ALICE);
    return { calls, scalls };
  };

  it("server-side: the session user is passed to the usage RPC (201 flow)", async () => {
    const { calls } = baseRouteMocks(ok(0));
    const res = await questionPOST(formReq({ ...good, image: PNG() }));
    expect(res.status).toBe(201);
    const rpcCall = calls.find((c) => c.kind === "rpc" && c.detail === "community_image_storage_usage");
    expect(rpcCall).toBeDefined();
    expect((rpcCall!.args[0] as Record<string, unknown>).p_user).toBe(ALICE);
  });

  it("over quota → 413 storage_quota, no upload, no insert", async () => {
    const { calls, scalls } = baseRouteMocks(ok(COMMUNITY_USER_IMAGE_QUOTA_BYTES - 2));
    const res = await questionPOST(formReq({ ...good, image: PNG() }));
    expect(res.status).toBe(413);
    await expect(res.json()).resolves.toMatchObject({ error: "storage_quota" });
    expect(calls.filter((c) => c.kind === "upload")).toEqual([]);
    expect(scalls.filter((c) => c.detail === "community_questions.insert")).toEqual([]);
  });

  it("quota check failure → 500 quota_check_failed, no upload (fail closed)", async () => {
    const { calls } = baseRouteMocks(fail("db down"));
    const res = await questionPOST(formReq({ ...good, image: PNG() }));
    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toMatchObject({ error: "quota_check_failed" });
    expect(calls.filter((c) => c.kind === "upload")).toEqual([]);
  });

  it("the 2 MB per-image limit is preserved and precedes the quota check", async () => {
    const { calls } = baseRouteMocks(ok(0));
    const big = new File([new Uint8Array(2 * 1024 * 1024 + 1)], "big.png", { type: "image/png" });
    const res = await questionPOST(formReq({ ...good, image: big }));
    expect(res.status).toBe(413);
    await expect(res.json()).resolves.toMatchObject({ error: "image_too_large" });
    // Quota is never consulted for an over-limit file.
    expect(calls.filter((c) => c.kind === "rpc" && c.detail === "community_image_storage_usage")).toEqual([]);
  });

  it("ALL three image endpoints enforce the quota BEFORE their upload (no bypass)", () => {
    const read = (p: string) => readFileSync(path.resolve(process.cwd(), p), "utf8");
    for (const f of [
      "src/app/api/community/questions/route.ts",
      "src/app/api/community/messages/route.ts",
      "src/app/api/community/dm/[conversationId]/messages/route.ts",
    ]) {
      const src = read(f);
      const quotaIdx = src.indexOf("checkCommunityImageQuota(user.id");
      const uploadIdx = src.indexOf(".upload(");
      expect(quotaIdx, f).toBeGreaterThan(-1);
      expect(uploadIdx, f).toBeGreaterThan(-1);
      expect(quotaIdx < uploadIdx, `${f}: quota must run before upload`).toBe(true);
      expect(src, f).toContain('from "@/lib/community/image-quota"');
    }
  });
});

// ---------------------------------------------------------------------------
// A-4 — storage janitor (community-images)
// ---------------------------------------------------------------------------

describe("A-4: storage janitor — community images", () => {
  const NOW = new Date("2026-11-02T00:00:00Z");
  const OLD = "2026-10-01T00:00:00Z"; // > 24 h
  const FRESH = "2026-11-01T23:00:00Z"; // < 24 h
  const obj = (name: string, createdAt: string) => ({ name, created_at: createdAt });

  /** Script for a full `reconcileStorage` tick across ALL buckets.
   *  Queues are seeded for the MAXIMUM consumption (execute mode: reference
   *  sets collected twice, user prefixes once per bucket) — unconsumed
   *  entries are harmless. */
  const janitorScript = (overrides: {
    msgRefs?: unknown[];
    dmRefs?: unknown[];
    aliceList?: unknown[];
    otherList?: unknown[];
    dmList?: unknown[];
    users?: unknown[];
  } = {}) => {
    const users = overrides.users ?? [{ id: ALICE }, { id: OTHER }];
    return {
      tables: {
        community_messages: [ok(overrides.msgRefs ?? []), ok(overrides.msgRefs ?? [])],
        community_questions: [ok([]), ok([])],
        community_direct_messages: [ok(overrides.dmRefs ?? []), ok(overrides.dmRefs ?? [])],
        profiles: [ok(users), ok(users), ok(users)],
      },
      lists: {
        // Per-bucket FIFO. ai-files / application-attachments: one list per
        // user (empty). community-images: alice, other, then the dm/ scan.
        "ai-files": [{ data: [] }, { data: [] }],
        "application-attachments": [{ data: [] }, { data: [] }],
        "community-images": [
          { data: overrides.aliceList ?? [] },
          { data: overrides.otherList ?? [] },
          { data: overrides.dmList ?? [] },
        ],
      },
    };
  };

  const communityReport = async (script: AdminScript, opts: { execute?: boolean; maxDeletes?: number } = {}) => {
    mockAdmin(script);
    const report = await reconcileStorage({ now: NOW, ...opts });
    return report.buckets.find((b) => b.bucket === "community-images")!;
  };

  it("dry-run is the DEFAULT: candidates reported, nothing removed", async () => {
    const calls = mockAdmin(
      janitorScript({ aliceList: [obj(`${ALICE}/${MSG}/image.png`, OLD)] }),
    );
    const report = await reconcileStorage({ now: NOW });
    expect(report.dryRun).toBe(true);
    const bucket = report.buckets.find((b) => b.bucket === "community-images")!;
    expect(bucket.wouldDelete).toContain(`${ALICE}/${MSG}/image.png`);
    expect(bucket.orphans).toBe(1);
    expect(calls.filter((c) => c.kind === "remove")).toEqual([]);
  });

  it("a referenced object is preserved (row-reference proof)", async () => {
    const bucket = await communityReport(
      janitorScript({
        msgRefs: [{ image_path: `${ALICE}/${MSG}/image.png` }],
        aliceList: [obj(`${ALICE}/${MSG}/image.png`, OLD)],
      }),
    );
    expect(bucket.referenced).toBe(1);
    expect(bucket.wouldDelete).toEqual([]);
  });

  it("an unreferenced, old, user-prefixed object becomes a candidate", async () => {
    const bucket = await communityReport(
      janitorScript({ aliceList: [obj(`${ALICE}/${MSG}/image.png`, OLD)] }),
    );
    expect(bucket.orphans).toBe(1);
    expect(bucket.wouldDelete).toContain(`${ALICE}/${MSG}/image.png`);
  });

  it("a young object is never a candidate (grace period)", async () => {
    const bucket = await communityReport(
      janitorScript({ aliceList: [obj(`${ALICE}/${MSG}/image.png`, FRESH)] }),
    );
    expect(bucket.tooYoung).toBe(1);
    expect(bucket.wouldDelete).toEqual([]);
  });

  it("an unrecognised name is reported, never deleted (list-level + DM-shape gates)", async () => {
    // (a) a name outside the searched user prefix is dropped by the
    //     defensive list filter and never even counted;
    // (b) a dm/-namespaced object whose segments do not match the strict
    //     dm/{uuid}/{uuid}/… shape is reported as unknownPrefix.
    const bucket = await communityReport(
      janitorScript({
        aliceList: [obj(`${ALICE}/notes.txt`, OLD), obj("weird/object.bin", OLD)],
        dmList: [obj(`dm/not-a-uuid/${ALICE}/x.png`, OLD)],
      }),
    );
    // notes.txt passes the prefix but is unreferenced+old → candidate;
    // the malformed DM name is NOT.
    expect(bucket.wouldDelete).toEqual([`${ALICE}/notes.txt`]);
    expect(bucket.unknownPrefix).toBe(1);
  });

  it("DM: unreferenced, old, live-sender object becomes a candidate", async () => {
    const bucket = await communityReport(
      janitorScript({ dmList: [obj(`dm/${CONV}/${ALICE}/${MSG}/image.png`, OLD)] }),
    );
    expect(bucket.orphans).toBe(1);
    expect(bucket.wouldDelete).toContain(`dm/${CONV}/${ALICE}/${MSG}/image.png`);
  });

  it("DM: object of a non-live sender is never a candidate", async () => {
    const bucket = await communityReport(
      janitorScript({ dmList: [obj(`dm/${CONV}/${DEAD}/${MSG}/image.png`, OLD)] }),
    );
    expect(bucket.unknownPrefix).toBe(1);
    expect(bucket.wouldDelete).toEqual([]);
  });

  it("DM cross-user safety: a row of ANY user referencing the object preserves it", async () => {
    const p = `dm/${CONV}/${ALICE}/${MSG}/image.png`;
    const bucket = await communityReport(
      janitorScript({ dmRefs: [{ image_path: p }], dmList: [obj(p, OLD)] }),
    );
    expect(bucket.referenced).toBe(1);
    expect(bucket.wouldDelete).toEqual([]);
  });

  it("execute: retry-safe (remove error counted, next tick re-detects)", async () => {
    const makeScript = () =>
      ({
        ...janitorScript({
          aliceList: [
            obj(`${ALICE}/${MSG}/image.png`, OLD),
            obj(`${ALICE}/${MSG}/image2.png`, OLD),
          ],
        }),
        removes: { "community-images": [{ error: { message: "storage flake" } }] },
      }) as AdminScript;
    mockAdmin(makeScript());
    const report = await reconcileStorage({ now: NOW, execute: true, maxDeletes: 100 });
    const bucket = report.buckets.find((b) => b.bucket === "community-images")!;
    expect(bucket.deleted).toBe(0);
    expect(bucket.deleteErrors).toBe(2);
    // Retry-safe: a fresh tick (objects still present) still sees both
    // candidates and no partial state leaked.
    mockAdmin(makeScript());
    const retry = await reconcileStorage({ now: NOW });
    const retryBucket = retry.buckets.find((b) => b.bucket === "community-images")!;
    expect(retryBucket.orphans).toBe(2);
  });

  it("execute: a reference appearing between scan and delete wins (double-check)", async () => {
    const p = `${ALICE}/${MSG}/image.png`;
    mockAdmin({
      tables: {
        // first collect: no reference; second collect (pre-delete): reference
        community_messages: [ok([]), ok([{ image_path: p }])],
        community_questions: [ok([]), ok([])],
        community_direct_messages: [ok([]), ok([])],
        profiles: [
          ok([{ id: ALICE }, { id: OTHER }]),
          ok([{ id: ALICE }, { id: OTHER }]),
          ok([{ id: ALICE }, { id: OTHER }]),
        ],
      },
      lists: {
        "ai-files": [{ data: [] }, { data: [] }, { data: [] }, { data: [] }],
        "application-attachments": [{ data: [] }, { data: [] }, { data: [] }, { data: [] }],
        "community-images": [
          { data: [obj(p, OLD)] },
          { data: [] },
          { data: [] },
        ],
      },
    });
    const report = await reconcileStorage({ now: NOW, execute: true });
    const bucket = report.buckets.find((b) => b.bucket === "community-images")!;
    expect(bucket.deleted).toBe(0);
    expect(bucket.deleteErrors).toBe(0);
  });

  it("execute: maxDeletes bounds the per-tick removal", async () => {
    mockAdmin({
      ...janitorScript({
        aliceList: [
          obj(`${ALICE}/${MSG}/a.png`, OLD),
          obj(`${ALICE}/${MSG}/b.png`, OLD),
          obj(`${ALICE}/${MSG}/c.png`, OLD),
        ],
      }),
      removes: { "community-images": [{ error: null }] },
    } as AdminScript);
    const report = await reconcileStorage({ now: NOW, execute: true, maxDeletes: 2 });
    const bucket = report.buckets.find((b) => b.bucket === "community-images")!;
    expect(bucket.orphans).toBe(3);
    expect(bucket.deleted).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// v7 migration guards
// ---------------------------------------------------------------------------

describe("v7 migration guards (additive, service-role-only)", () => {
  const sql = readFileSync(
    path.resolve(process.cwd(), "supabase/migrations/20261101000000_community_v7_image_quota.sql"),
    "utf8",
  );
  const flat = sql.replace(/\s+/g, " ");

  it("creates community_image_storage_usage (security definer, pinned search_path, stable)", () => {
    expect(flat).toContain("create or replace function public.community_image_storage_usage(p_user uuid)");
    expect(flat).toContain("returns bigint");
    expect(flat).toContain("security definer");
    expect(flat).toContain("set search_path = public");
    expect(flat).toContain("stable");
  });

  it("execute is revoked from public/anon and granted to service_role only", () => {
    expect(flat).toMatch(/revoke execute on function public\.community_image_storage_usage\(uuid\) from public, anon;/);
    expect(flat).toMatch(/grant execute on function public\.community_image_storage_usage\(uuid\) to service_role;/);
  });

  it("attributes exactly the three Community path shapes to the owner", () => {
    expect(flat).toContain("o.bucket_id = 'community-images'");
    expect(flat).toContain("strpos(o.name, p_user::text || '/') = 1");
    expect(flat).toContain("o.name like ('dm/%/' || p_user::text || '/%')");
    expect(flat).toContain("coalesce(sum(o.size), 0)::bigint");
  });

  it("is purely additive — no destructive or policy statements", () => {
    // (The documented rollback of the NEW function itself is legitimate;
    // what is forbidden is destruction of pre-existing schema/data.)
    const forbidden = [
      "drop table",
      "drop column",
      "truncate",
      "alter table",
      "create policy",
      "drop policy",
      "drop index",
    ];
    for (const f of forbidden) {
      expect(flat, f).not.toMatch(new RegExp(f, "i"));
    }
  });

  it("contains no Phase 6B/6C/6F content", () => {
    expect(flat).not.toContain("community_voice");
    expect(flat).not.toContain("hide_question");
    expect(flat).not.toContain("for select"); // no storage/row policies in 6A
  });
});
