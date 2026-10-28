import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Deutsch Bibliothek — admin server-action authorization + behavior.
 *
 * Pinned contract (mirrors the repo's incident-regression style):
 *
 *   AUTHZ — the actor is ALWAYS the session-derived administrator:
 *     - unauthenticated                → unauthorized, ZERO privileged calls
 *     - authenticated, no admins row   → forbidden, ZERO privileged calls
 *     - rate-limited admin             → rate_limited, ZERO privileged calls
 *     - a client-supplied "actorId"/"userId" form field is IGNORED
 *
 *   WRITE PATH — every mutation runs on the service-role client:
 *     - create: upload (book-covers) → insert (german_books); a failed
 *       insert removes the uploaded object (no orphan)
 *     - update: scoped to the exact id; a failed update removes the new
 *       object; a success retires the superseded cover
 *     - publish/unpublish: row verified first (unknown id → book_not_found,
 *       never silent success)
 *     - delete: row → cover; unknown id → book_not_found
 *
 *   VALIDATION — the server re-checks everything the form showed:
 *     cover required on create, JPEG/PNG/WebP by content, ≤ 5 MB,
 *     title/category/description length + category allowlist,
 *     http(s)-only download URL (javascript:/data:/file: rejected).
 */

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/billing/admin", () => ({
  diagnoseAdminAccess: vi.fn(),
  requireAdmin: vi.fn(),
}));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(async () => ({
    allowed: true,
    count: 1,
    limit: 30,
    retryAfterSeconds: 0,
  })),
}));

import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { diagnoseAdminAccess } from "@/lib/billing/admin";
import { checkRateLimit } from "@/lib/rate-limit";
import {
  createBookAction,
  updateBookAction,
  setBookPublishedAction,
  deleteBookAction,
} from "@/app/admin/books/actions";

// ---------------------------------------------------------------------------
// Fixtures + mocks
// ---------------------------------------------------------------------------

const ADMIN_ID = "6fa45036-1b86-427a-a7d0-54a3a3904767"; // the configured platform admin
const BOOK_ID = "aaaaaaaa-1111-4111-8111-111111111111";
const OTHER_BOOK = "bbbbbbbb-2222-4222-8222-222222222222";

type Result = { data: unknown; error: { message: string; code?: string } | null };

interface TableRecord {
  table: string;
  ops: string[];
  payload?: unknown;
}

interface AdminMock {
  records: TableRecord[];
  storageCalls: string[];
  uploadError: boolean;
  queue: (table: string, ...results: Result[]) => void;
}

function mockAdminClient(): AdminMock {
  const records: TableRecord[] = [];
  const storageCalls: string[] = [];
  const queues = new Map<string, Result[]>();
  let uploadError = false;
  const state: AdminMock = {
    records,
    storageCalls,
    get uploadError() {
      return uploadError;
    },
    set uploadError(value: boolean) {
      uploadError = value;
    },
    queue: (table, ...results) => queues.set(table, [...(queues.get(table) ?? []), ...results]),
  };

  const from = (table: string) => {
    const rec: TableRecord = { table, ops: [] };
    records.push(rec);
    const next = (): Result => (queues.get(table) ?? []).shift() ?? { data: null, error: null };
    const chain: Record<string, unknown> = {
      select: (sel: unknown) => ((rec.ops.push(`select:${sel}`), chain)),
      eq: (c: string, v: unknown) => ((rec.ops.push(`eq:${c}=${String(v)}`), chain)),
      ilike: (c: string, v: unknown) => ((rec.ops.push(`ilike:${c}~${v}`), chain)),
      order: () => chain,
      range: (a: number, b: number) => ((rec.ops.push(`range:${a}:${b}`), chain)),
      insert: (payload: unknown) => ((rec.payload = payload), chain),
      update: (payload: unknown) => ((rec.payload = payload), chain),
      delete: () => ((rec.ops.push("delete"), chain)),
      maybeSingle: async () => ((rec.ops.push("maybeSingle"), next())),
      single: async () => ((rec.ops.push("single"), next())),
      then: (resolve: (v: unknown) => unknown) => Promise.resolve(next()).then(resolve),
    };
    return chain;
  };

  const client = {
    from,
    storage: {
      from: (bucket: string) => ({
        upload: async (path: string, buffer: Buffer, opts: { contentType: string; upsert: boolean }) => {
          storageCalls.push(`upload:${bucket}:${path}:${opts.contentType}:${buffer.length}`);
          if (uploadError) return { data: null, error: { message: "storage down" } };
          return { data: { path }, error: null };
        },
        remove: async (paths: string[]) => {
          storageCalls.push(`remove:${paths.join(",")}`);
          return { data: null, error: null };
        },
      }),
    },
  };
  vi.mocked(createAdminClient).mockReturnValue(client as never);
  return state;
}

function mockSession(user: { id: string } | null, membership: "found" | "not_found") {
  vi.mocked(createClient).mockResolvedValue({
    auth: { getUser: vi.fn(async () => ({ data: { user }, error: null })) },
  } as never);
  if (!user) {
    vi.mocked(diagnoseAdminAccess).mockResolvedValue({ status: "unauthenticated" });
  } else if (membership === "not_found") {
    vi.mocked(diagnoseAdminAccess).mockResolvedValue({
      status: "forbidden",
      reason: "no_membership",
      userId: user.id,
      diag: { admins: "not_found", profile: "skipped" },
    });
  } else {
    vi.mocked(diagnoseAdminAccess).mockResolvedValue({
      status: "ok",
      profile: { id: user.id, email: "admin@example.com", full_name: "Admin", account_status: "active" } as never,
    });
  }
}

const ADMIN = { id: ADMIN_ID };
const ALICE = { id: "11111111-1111-4111-8111-111111111111" };

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 0x00),
]);

function coverFile(bytes: Buffer = PNG, type = "image/png", name = "cover.png") {
  return new File([new Uint8Array(bytes)], name, { type });
}

function bookForm(overrides: Record<string, string | File> = {}): FormData {
  const body = new FormData();
  body.set("title", "Mittelstufenwortschatz Band 2");
  body.set("category", "wortschatz");
  body.set("description", "Übungsbuch für B1");
  body.set("downloadUrl", "https://example.com/wortschatz-b2.pdf");
  body.set("published", "on");
  for (const [key, value] of Object.entries(overrides)) {
    body.set(key, value);
  }
  return body;
}

function tableRecs(state: AdminMock, table: string): TableRecord[] {
  return state.records.filter((r) => r.table === table);
}

afterEach(() => {
  // clearAllMocks() wipes call history but keeps implementations — reset the
  // rate limiter to its allowed default so one test's override never leaks.
  vi.mocked(checkRateLimit).mockResolvedValue({
    allowed: true,
    count: 1,
    limit: 30,
    retryAfterSeconds: 0,
  });
  vi.clearAllMocks();
  (console.error as unknown as { mockRestore?: () => void }).mockRestore?.();
});

// ---------------------------------------------------------------------------
// Authorization
// ---------------------------------------------------------------------------

describe("authorization (the actor is the session, never the form)", () => {
  it("unauthenticated: unauthorized + zero privileged calls", async () => {
    const state = mockAdminClient();
    mockSession(null, "found");
    const result = await createBookAction({}, bookForm());
    expect(result).toEqual({ error: "unauthorized" });
    expect(state.records).toHaveLength(0);
    expect(state.storageCalls).toHaveLength(0);
  });

  it("authenticated WITHOUT admin membership: forbidden + zero privileged calls", async () => {
    const state = mockAdminClient();
    mockSession(ALICE, "not_found");
    const result = await createBookAction({}, bookForm());
    expect(result).toEqual({ error: "forbidden" });
    expect(state.records).toHaveLength(0);
    expect(state.storageCalls).toHaveLength(0);

    // Every other mutation is gated the same way.
    expect(await setBookPublishedAction(BOOK_ID, true)).toEqual({
      ok: false,
      error: "forbidden",
    });
    expect(await deleteBookAction(BOOK_ID)).toEqual({ ok: false, error: "forbidden" });
    expect(await updateBookAction({}, bookForm({ bookId: BOOK_ID }))).toEqual({
      error: "forbidden",
    });
    expect(state.records).toHaveLength(0);
  });

  it("rate-limited admin: rate_limited before any privileged call", async () => {
    const state = mockAdminClient();
    mockSession(ADMIN, "found");
    vi.mocked(checkRateLimit).mockResolvedValue({
      allowed: false,
      count: 31,
      limit: 30,
      retryAfterSeconds: 42,
    });
    const result = await createBookAction({}, bookForm());
    expect(result).toEqual({ error: "rate_limited" });
    expect(state.records).toHaveLength(0);
  });

  it("a client-supplied actorId/userId is ignored (created_by = session admin)", async () => {
    const state = mockAdminClient();
    mockSession(ADMIN, "found");
    state.queue("german_books", { data: {}, error: null });
    const form = bookForm();
    form.set("actorId", ALICE.id); // attack: impersonate/forge the actor
    form.set("userId", ALICE.id);
    form.set("created_by", ALICE.id);
    form.set("cover", coverFile());
    const result = await createBookAction({}, form);
    expect(result).toEqual({ success: "created" });
    const insert = tableRecs(state, "german_books").find((r) => r.payload !== undefined);
    expect(insert?.payload).toMatchObject({ created_by: ADMIN_ID });
  });
});

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

describe("createBookAction", () => {
  it("authorized admin: uploads the cover, then inserts with the session actor", async () => {
    const state = mockAdminClient();
    mockSession(ADMIN, "found");
    state.queue("german_books", { data: {}, error: null });
    const form = bookForm();
    form.set("cover", coverFile());
    const result = await createBookAction({}, form);
    expect(result).toEqual({ success: "created" });

    expect(state.storageCalls).toHaveLength(1);
    expect(state.storageCalls[0]).toMatch(/^upload:book-covers:covers\/[0-9a-f-]{36}\.png:image\/png:/);

    const insert = tableRecs(state, "german_books")[0];
    expect(insert.payload).toMatchObject({
      title: "Mittelstufenwortschatz Band 2",
      category: "wortschatz",
      description: "Übungsbuch für B1",
      download_url: "https://example.com/wortschatz-b2.pdf",
      published: true,
      created_by: ADMIN_ID,
    });
    expect(String((insert.payload as { cover_path: string }).cover_path)).toMatch(
      /^covers\/[0-9a-f-]{36}\.png$/,
    );
    expect((insert.payload as { cover_mime: string }).cover_mime).toBe("image/png");
  });

  it("unchecked 'publish' saves a DRAFT (published: false)", async () => {
    const state = mockAdminClient();
    mockSession(ADMIN, "found");
    state.queue("german_books", { data: {}, error: null });
    const form = bookForm();
    form.delete("published"); // no checkbox = draft
    form.set("cover", coverFile());
    const result = await createBookAction({}, form);
    expect(result).toEqual({ success: "created" });
    expect((tableRecs(state, "german_books")[0].payload as { published: boolean }).published).toBe(false);
  });

  it("missing cover → cover_required, nothing written", async () => {
    const state = mockAdminClient();
    mockSession(ADMIN, "found");
    const result = await createBookAction({}, bookForm());
    expect(result).toEqual({ error: "cover_required" });
    expect(state.records).toHaveLength(0);
    expect(state.storageCalls).toHaveLength(0);
  });

  it("renamed PDF as .png → invalid_cover (content sniffing), no upload/insert", async () => {
    const state = mockAdminClient();
    mockSession(ADMIN, "found");
    const pdf = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(64, 0x20)]);
    const form = bookForm();
    form.set("cover", coverFile(pdf, "image/png", "buch.png"));
    const result = await createBookAction({}, form);
    expect(result).toEqual({ error: "invalid_cover" });
    expect(state.storageCalls).toHaveLength(0);
    expect(state.records).toHaveLength(0);
  });

  it("oversized cover (> 5 MB) → invalid_cover", async () => {
    const state = mockAdminClient();
    mockSession(ADMIN, "found");
    const big = Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024, 0x00)]);
    const form = bookForm();
    form.set("cover", coverFile(big, "image/png"));
    const result = await createBookAction({}, form);
    expect(result).toEqual({ error: "invalid_cover" });
    expect(state.storageCalls).toHaveLength(0);
  });

  it("field validation: bad URL / title / category / description → stable codes, nothing written", async () => {
    const state = mockAdminClient();
    mockSession(ADMIN, "found");
    const cases: Array<[Record<string, string>, string]> = [
      [{ downloadUrl: "javascript:alert(1)" }, "invalid_url"],
      [{ downloadUrl: "data:text/html,hi" }, "invalid_url"],
      [{ downloadUrl: "not-a-url" }, "invalid_url"],
      [{ title: "" }, "invalid_title"],
      [{ title: "x".repeat(201) }, "invalid_title"],
      [{ category: "roman" }, "invalid_category"],
      [{ description: "x".repeat(2001) }, "invalid_description"],
    ];
    for (const [overrides, expected] of cases) {
      const form = bookForm(overrides);
      form.set("cover", coverFile());
      const result = await createBookAction({}, form);
      expect(result, JSON.stringify(overrides)).toEqual({ error: expected });
    }
    expect(state.records).toHaveLength(0);
    expect(state.storageCalls).toHaveLength(0);
  });

  it("failed insert after upload → orphan is removed, db_error reported", async () => {
    const state = mockAdminClient();
    mockSession(ADMIN, "found");
    state.queue("german_books", { data: null, error: { message: "relation does not exist", code: "42P01" } });
    const form = bookForm();
    form.set("cover", coverFile());
    const result = await createBookAction({}, form);
    expect(result).toEqual({ error: "db_error" });
    // Upload happened, then the cleanup removed the same object.
    expect(state.storageCalls).toHaveLength(2);
    expect(state.storageCalls[0]).toMatch(/^upload:book-covers:covers\/[0-9a-f-]{36}\.png/);
    const uploadedPath = state.storageCalls[0].split(":")[2];
    expect(state.storageCalls[1]).toBe(`remove:${uploadedPath}`);
  });

  it("failed storage upload → storage_error, no insert", async () => {
    const state = mockAdminClient();
    mockSession(ADMIN, "found");
    state.uploadError = true;
    const form = bookForm();
    form.set("cover", coverFile());
    const result = await createBookAction({}, form);
    expect(result).toEqual({ error: "storage_error" });
    expect(state.records).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

describe("updateBookAction", () => {
  const existing = { id: BOOK_ID, cover_path: "covers/old-uuid.png" };

  it("edits fields scoped to the exact book id", async () => {
    const state = mockAdminClient();
    mockSession(ADMIN, "found");
    state.queue("german_books", { data: existing, error: null }, { data: null, error: null });
    const form = bookForm({ bookId: BOOK_ID, title: "Neuer Titel" });
    const result = await updateBookAction({}, form);
    expect(result).toEqual({ success: "updated" });
    const update = tableRecs(state, "german_books").find((r) => r.ops.includes("delete") === false && r.payload && (r.ops as string[]).some((o) => o.startsWith("eq:id=")));
    expect(update?.ops).toContain(`eq:id=${BOOK_ID}`);
    expect(update?.payload).toMatchObject({
      title: "Neuer Titel",
      download_url: "https://example.com/wortschatz-b2.pdf",
    });
    // No cover submitted → the stored cover is untouched.
    expect(update?.payload).not.toHaveProperty("cover_path");
    expect(state.storageCalls).toHaveLength(0);
  });

  it("unknown book id → book_not_found", async () => {
    const state = mockAdminClient();
    mockSession(ADMIN, "found");
    state.queue("german_books", { data: null, error: null });
    const result = await updateBookAction({}, bookForm({ bookId: OTHER_BOOK }));
    expect(result).toEqual({ error: "book_not_found" });
  });

  it("malformed book id → book_not_found without a database round-trip", async () => {
    const state = mockAdminClient();
    mockSession(ADMIN, "found");
    const result = await updateBookAction({}, bookForm({ bookId: "not-a-uuid" }));
    expect(result).toEqual({ error: "book_not_found" });
    expect(state.records).toHaveLength(0);
  });

  it("replacing the cover: new object uploaded, row updated, old object retired", async () => {
    const state = mockAdminClient();
    mockSession(ADMIN, "found");
    state.queue("german_books", { data: existing, error: null }, { data: null, error: null });
    const form = bookForm({ bookId: BOOK_ID });
    form.set("cover", coverFile(PNG, "image/png", "neu.png"));
    const result = await updateBookAction({}, form);
    expect(result).toEqual({ success: "updated" });
    expect(state.storageCalls[0]).toMatch(/^upload:book-covers:covers\/[0-9a-f-]{36}\.png/);
    const newPath = state.storageCalls[0].split(":")[2];
    expect(state.storageCalls[1]).toBe(`remove:covers/old-uuid.png`);
    const update = tableRecs(state, "german_books").find((r) => r.payload && r.ops.some((o) => o.startsWith("eq:id=")));
    expect((update?.payload as { cover_path: string }).cover_path).toBe(newPath);
  });

  it("failed update after new cover upload → new object removed (no orphan), row untouched", async () => {
    const state = mockAdminClient();
    mockSession(ADMIN, "found");
    state.queue(
      "german_books",
      { data: existing, error: null },
      { data: null, error: { message: "boom" } },
    );
    const form = bookForm({ bookId: BOOK_ID });
    form.set("cover", coverFile(PNG, "image/png"));
    const result = await updateBookAction({}, form);
    expect(result).toEqual({ error: "db_error" });
    expect(state.storageCalls[0]).toMatch(/^upload:book-covers:covers\//);
    const newPath = state.storageCalls[0].split(":")[2];
    expect(state.storageCalls[1]).toBe(`remove:${newPath}`);
    // The OLD cover must NOT be removed (the book still uses it).
    expect(state.storageCalls).not.toContain("remove:covers/old-uuid.png");
  });
});

// ---------------------------------------------------------------------------
// Publish / unpublish / delete
// ---------------------------------------------------------------------------

describe("publish + delete", () => {
  const existingWithCover = { id: BOOK_ID, cover_path: "covers/old-uuid.png" };

  it("publish: updates exactly the addressed row", async () => {
    const state = mockAdminClient();
    mockSession(ADMIN, "found");
    state.queue("german_books", { data: { id: BOOK_ID }, error: null }, { data: null, error: null });
    const result = await setBookPublishedAction(BOOK_ID, true);
    expect(result).toEqual({ ok: true });
    const update = tableRecs(state, "german_books").find((r) => r.payload !== undefined);
    expect(update?.payload).toEqual({ published: true });
    expect(update?.ops).toContain(`eq:id=${BOOK_ID}`);
  });

  it("unpublish: published=false", async () => {
    const state = mockAdminClient();
    mockSession(ADMIN, "found");
    state.queue("german_books", { data: { id: BOOK_ID }, error: null }, { data: null, error: null });
    const result = await setBookPublishedAction(BOOK_ID, false);
    expect(result).toEqual({ ok: true });
    const update = tableRecs(state, "german_books").find((r) => r.payload !== undefined);
    expect(update?.payload).toEqual({ published: false });
  });

  it("publish of an unknown id → book_not_found (no silent success)", async () => {
    const state = mockAdminClient();
    mockSession(ADMIN, "found");
    state.queue("german_books", { data: null, error: null });
    const result = await setBookPublishedAction(OTHER_BOOK, true);
    expect(result).toEqual({ ok: false, error: "book_not_found" });
    expect(tableRecs(state, "german_books").every((r) => r.payload === undefined)).toBe(true);
  });

  it("delete: removes the row, then the cover object", async () => {
    const state = mockAdminClient();
    mockSession(ADMIN, "found");
    state.queue("german_books", { data: existingWithCover, error: null }, { data: null, error: null });
    const result = await deleteBookAction(BOOK_ID);
    expect(result).toEqual({ ok: true });
    const deleteRec = tableRecs(state, "german_books").find((r) => r.ops.includes("delete"));
    expect(deleteRec?.ops).toContain(`eq:id=${BOOK_ID}`);
    expect(state.storageCalls).toEqual(["remove:covers/old-uuid.png"]);
  });

  it("delete without a cover: row deleted, no storage call", async () => {
    const state = mockAdminClient();
    mockSession(ADMIN, "found");
    state.queue("german_books", { data: { id: BOOK_ID, cover_path: null }, error: null }, { data: null, error: null });
    const result = await deleteBookAction(BOOK_ID);
    expect(result).toEqual({ ok: true });
    expect(state.storageCalls).toHaveLength(0);
  });

  it("delete of an unknown id → book_not_found", async () => {
    const state = mockAdminClient();
    mockSession(ADMIN, "found");
    state.queue("german_books", { data: null, error: null });
    const result = await deleteBookAction(OTHER_BOOK);
    expect(result).toEqual({ ok: false, error: "book_not_found" });
    expect(tableRecs(state, "german_books").every((r) => !r.ops.includes("delete"))).toBe(true);
  });

  it("delete database failure → db_error", async () => {
    const state = mockAdminClient();
    mockSession(ADMIN, "found");
    state.queue(
      "german_books",
      { data: existingWithCover, error: null },
      { data: null, error: { message: "deadlock" } },
    );
    const result = await deleteBookAction(BOOK_ID);
    expect(result).toEqual({ ok: false, error: "db_error" });
    expect(state.storageCalls).toHaveLength(0);
  });
});
