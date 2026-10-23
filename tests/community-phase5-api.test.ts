/**
 * Community Phase 5 — API routes, anti-spam, migration security guards,
 * i18n parity and client invariants.
 *
 * Complements tests/community-phase5.test.ts (server LIBRARY behavior) by
 * driving the REAL route handlers (auth gates, write gates, validation,
 * HTTP status codes) with scripted Supabase mocks that record every DB
 * operation, plus source-level guards:
 *
 *   - GET  /api/community/search: 401, query/date/author/cursor
 *     validation, room slug resolved server-side, full parameter
 *     passthrough into the SQL function, keyset cursor, row mapping,
 *     degradation, rate scope
 *   - POST /api/community/questions: 401, non-form 400, suspended/muted
 *     write gate, room/qna checks, tag validation, image byte validation
 *     (oversized → 413, spoofed magic → 415), server-stamped author,
 *     owner-folder storage path, rate scope
 *   - POST /api/community/questions/:id/answers: 401, UUID gate, 404,
 *     closed → 409, invalid body → 400, author notification contract,
 *     self-answer suppression
 *   - /api/community/reports: 401, invalid fields, suspended, target
 *     existence, self-report, 23505 → 409 duplicate, reporter always the
 *     session user, all four target types (never a DM), own-only GET
 *   - anti-spam: bounded 60s rate scopes for every Phase 5 action,
 *     per-action scopes in the server actions, write gates on all write
 *     routes
 *   - migration guards: RLS on every new table, NO user write policies on
 *     the protected tables, own-only report insert, exactly-one-accepted
 *     invariant, pin uniqueness, pending-report dedupe index, the
 *     community_search identity guard (p_user === auth.uid()), DM tables
 *     never referenced inside community_search, execute grants
 *   - i18n: FULL community-subtree key parity across de/en/fr/ar (479
 *     keys), no empty leaves, explicit Phase 5 keys
 *   - client invariants: no polling/timers/blocks, no
 *     dangerouslySetInnerHTML, no service-role client in the bundle, no
 *     client-side role resolution, report dialog sends only whitelisted
 *     fields, Phase 5 pages are server components
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
  createSocialNotification: vi.fn(() => Promise.resolve({ ok: true as const })),
  socialSendKey: (a: string, b: string) => `${a}:${b}`,
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("server-only", () => ({}));

const { createClient } = await import("@/lib/supabase/server");
const { createAdminClient } = await import("@/lib/supabase/admin");
const { getCurrentUserAndProfile } = await import("@/lib/auth");
const { checkRateLimit } = await import("@/lib/rate-limit");
const { createSocialNotification } = await import("@/lib/community/social");
const { GET: searchGET } = await import("@/app/api/community/search/route");
const { POST: questionPOST } = await import("@/app/api/community/questions/route");
const { POST: answerPOST } = await import("@/app/api/community/questions/[questionId]/answers/route");
const { POST: reportPOST, GET: reportGET } = await import("@/app/api/community/reports/route");
const { dictionaries } = await import("@/lib/i18n/dictionaries");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ALICE = "11111111-1111-4111-8111-111111111111"; // the session user
const CAROL = "33333333-3333-4333-8333-333333333333"; // everyone else
const QUESTION_ID = "44444444-4444-4444-8444-444444444444";
const ANSWER_ID = "55555555-5555-4555-8555-555555555555";
const MESSAGE_ID = "66666666-6666-4666-8666-666666666666";
const ROOM_ID = "b1000000-0000-4000-8000-000000000002";

interface Call {
  table: string;
  op: string;
  args: unknown[];
}
interface Term {
  data: unknown;
  error: { message: string; code?: string } | null;
}
const ok = (data: unknown = null): Term => ({ data, error: null });
const fail = (message: string, code?: string): Term => ({ data: null, error: { message, code } });

const roomRow = (qna = true) => ({
  id: ROOM_ID,
  slug: "fragen-und-antworten",
  name: "Fragen & Antworten",
  category_id: "00000000-0000-4000-8000-000000000001",
  description: "d",
  icon: "Q",
  position: 1,
  enabled: true,
  qna_enabled: qna,
});
const questionRow = (status: "open" | "solved" | "closed" = "open", author: string = CAROL) => ({
  id: QUESTION_ID,
  room_id: ROOM_ID,
  author_id: author,
  title: "Wie beantrage ich ein Visum?",
  body: "Ich möchte in Deutschland studieren und brauche Hilfe mit dem Visum.",
  tags: ["visum"],
  image_path: null,
  status,
  accepted_answer_id: null,
  solved_at: null,
  created_at: "2026-10-02T09:00:00Z",
  updated_at: "2026-10-02T09:00:00Z",
});
const answerRow = (author: string = CAROL) => ({
  id: ANSWER_ID,
  question_id: QUESTION_ID,
  author_id: author,
  body: "Du brauchst einen B1-Nachweis und eine Meldebescheinigung.",
  accepted: false,
  deleted_at: null,
  created_at: "2026-10-02T10:00:00Z",
  updated_at: "2026-10-02T10:00:00Z",
});
const reportRow = (reporter: string = ALICE) => ({
  id: "77777777-7777-4777-8777-777777777777",
  reporter_id: reporter,
  target_type: "message",
  target_id: MESSAGE_ID,
  reason: "spam",
  details: null,
  status: "open",
  assigned_to: null,
  created_at: "2026-10-05T10:00:00Z",
  resolved_at: null,
});
const pngFile = () =>
  new File(
    [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 68, 82, 72])],
    "ok.png",
    { type: "image/png" },
  );

// ---------------------------------------------------------------------------
// Scripted Supabase clients (record every DB operation)
// ---------------------------------------------------------------------------

function makeFrom(calls: Call[], queues: Record<string, Term[]>) {
  return (table: string) => {
    const queue = (queues[table] ??= []);
    const base: Record<string, unknown> = {};
    const op = (name: string) =>
      (...args: unknown[]) => {
        calls.push({ table, op: name, args });
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
      calls.push({ table, op: "maybeSingle", args: [] });
      const r = consume();
      const data = Array.isArray(r.data) ? ((r.data as unknown[])[0] ?? null) : r.data;
      return Promise.resolve({ data, error: r.error ?? null });
    };
    base.single = () => {
      calls.push({ table, op: "single", args: [] });
      return Promise.resolve(consume());
    };
    base.then = (onF?: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
      Promise.resolve(consume()).then(onF as never, onR as never);
    return base;
  };
}

function session(queues: Record<string, Term[]> = {}) {
  const calls: Call[] = [];
  let uploaded: string | null = null;
  const client = {
    from: makeFrom(calls, queues),
    calls,
    auth: { getUser: () => Promise.resolve({ data: { user: { id: ALICE } }, error: null }) },
    storage: {
      from: () => ({
        upload: async (p: string) => {
          uploaded = p;
          return { data: { path: p }, error: null };
        },
        remove: async () => undefined,
      }),
    },
  };
  vi.mocked(createClient).mockResolvedValue(client as never);
  return { calls, path: () => uploaded };
}

function admin(
  queues: Record<string, Term[]> = {},
  rpc?: (fn: string, args: Record<string, unknown>) => Term,
) {
  const calls: Call[] = [];
  const client = {
    from: makeFrom(calls, queues),
    calls,
    rpc: (fn: string, args?: Record<string, unknown>) => {
      calls.push({ table: `rpc:${fn}`, op: "rpc", args: [args] });
      return Promise.resolve(rpc ? rpc(fn, args ?? {}) : ok(null));
    },
    storage: { from: () => ({ remove: async () => undefined }) },
  };
  vi.mocked(createAdminClient).mockReturnValue(client as never);
  return { calls };
}

function asUser(id: string | null) {
  vi.mocked(getCurrentUserAndProfile).mockResolvedValue({ user: id ? { id } : null } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// GET /api/community/search
// ---------------------------------------------------------------------------

const searchUrl = (qs: string) => new Request(`http://localhost/api/community/search?${qs}`);
const searchRow = (i: number, kind: "message" | "answer" = "message") => ({
  kind,
  id: `${String(i).padStart(8, "0")}-0000-4000-8000-000000000000`,
  room_id: ROOM_ID,
  room_slug: "fragen-und-antworten",
  room_name: "F&A",
  author_id: CAROL,
  author_name: "Carol",
  content: `hit ${i}`,
  created_at: `2026-10-0${(i % 9) + 1}T10:00:00Z`,
  question_id: kind === "answer" ? QUESTION_ID : null,
});

describe("GET /api/community/search", () => {
  it("401 when not authenticated", async () => {
    asUser(null);
    expect((await searchGET(searchUrl("q=visum"))).status).toBe(401);
  });

  it("400 for a too-short or too-long query", async () => {
    asUser(ALICE);
    expect((await searchGET(searchUrl("q=x"))).status).toBe(400);
    expect((await searchGET(searchUrl(`q=${"a".repeat(201)}`))).status).toBe(400);
  });

  it("400 for invalid date / author_id / cursor values", async () => {
    asUser(ALICE);
    expect((await searchGET(searchUrl("q=visum&date=bogus"))).status).toBe(400);
    expect((await searchGET(searchUrl("q=visum&author_id=nope"))).status).toBe(400);
    expect((await searchGET(searchUrl("q=visum&before_at=not-a-date"))).status).toBe(400);
    expect((await searchGET(searchUrl("q=visum&before_id=nope"))).status).toBe(400);
  });

  it("400 room_not_found for an unknown room slug (resolved server-side)", async () => {
    asUser(ALICE);
    admin();
    session({ community_rooms: [ok([])] });
    const res = await searchGET(searchUrl("q=visum&room=does-not-exist"));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: "room_not_found" });
  });

  it("passes the session user + every filter into the SQL function", async () => {
    asUser(ALICE);
    const { calls } = admin({}, (fn) => (fn === "community_search" ? ok([searchRow(1)]) : ok(null)));
    session({ community_rooms: [ok(roomRow())] });
    const cursorAt = "2026-10-01T00:00:00.000Z";
    const res = await searchGET(
      searchUrl(
        `q=visum&kind=question&room=fragen-und-antworten&author_id=${CAROL}` +
          `&date=week&before_at=${encodeURIComponent(cursorAt)}&before_id=${MESSAGE_ID}`,
      ),
    );
    expect(res.status).toBe(200);
    const rpcCall = calls.find((c) => c.table === "rpc:community_search") as { args: unknown[] };
    const args = rpcCall.args[0] as Record<string, unknown>;
    expect(args.p_user).toBe(ALICE); // NEVER client-supplied
    expect(args.p_query).toBe("visum");
    expect(args.p_kind).toBe("question");
    expect(args.p_room).toBe(ROOM_ID); // slug → id resolved server-side
    expect(args.p_author).toBe(CAROL);
    expect(typeof args.p_since).toBe("string");
    const sinceMs = Date.now() - Date.parse(args.p_since as string);
    expect(Math.abs(sinceMs - 7 * 86400 * 1000)).toBeLessThan(5 * 60 * 1000);
    expect(args.p_before_at).toBe(cursorAt);
    expect(args.p_before_id).toBe(MESSAGE_ID);
    expect(args.p_limit).toBe(20);
    const body = (await res.json()) as { items: unknown[]; cursor: unknown; more: boolean };
    expect(body.items).toHaveLength(1);
    expect(body.more).toBe(false);
    expect(body.cursor).toBeNull();
  });

  it("an unknown kind degrades to 'all' (no error)", async () => {
    asUser(ALICE);
    const { calls } = admin({}, (fn) => (fn === "community_search" ? ok([]) : ok(null)));
    session();
    const res = await searchGET(searchUrl("q=visum&kind=bogus"));
    expect(res.status).toBe(200);
    const args = (calls.find((c) => c.table === "rpc:community_search") as { args: unknown[] })
      .args[0] as Record<string, unknown>;
    expect(args.p_kind).toBe("all");
  });

  it("a full page (20 rows) yields a keyset cursor + more=true", async () => {
    asUser(ALICE);
    const rows = Array.from({ length: 20 }, (_, i) => searchRow(i + 1));
    admin({}, (fn) => (fn === "community_search" ? ok(rows) : ok(null)));
    session();
    const res = await searchGET(searchUrl("q=visum"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { more: boolean; cursor: { createdAt: string; id: string } };
    expect(body.more).toBe(true);
    expect(body.cursor).toEqual({ createdAt: rows[19].created_at, id: rows[19].id });
  });

  it("maps rows into the API shape (answer deep-link carries questionId)", async () => {
    asUser(ALICE);
    admin({}, (fn) => (fn === "community_search" ? ok([searchRow(1, "answer")]) : ok(null)));
    session();
    const res = await searchGET(searchUrl("q=visum"));
    const body = (await res.json()) as { items: Array<Record<string, unknown>> };
    expect(body.items[0]).toMatchObject({
      kind: "answer",
      questionId: QUESTION_ID,
      authorId: CAROL,
      roomSlug: "fragen-und-antworten",
    });
  });

  it("500 search_failed when the SQL function errors (degraded, empty)", async () => {
    asUser(ALICE);
    admin({}, () => fail("boom"));
    session();
    const res = await searchGET(searchUrl("q=visum"));
    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toMatchObject({ error: "search_failed" });
  });

  it("429 via the rate limit, scope community_search", async () => {
    asUser(ALICE);
    vi.mocked(checkRateLimit).mockResolvedValueOnce({
      allowed: false,
      count: 31,
      limit: 30,
      retry_after: 20,
    } as never);
    const res = await searchGET(searchUrl("q=visum"));
    expect(res.status).toBe(429);
    expect(checkRateLimit).toHaveBeenCalledWith("community_search", ALICE);
  });
});

// ---------------------------------------------------------------------------
// POST /api/community/questions
// ---------------------------------------------------------------------------

const QUESTION_URL = "http://localhost/api/community/questions";
function formReq(fields: Record<string, string | File>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return new Request(QUESTION_URL, { method: "POST", body: fd });
}

describe("POST /api/community/questions", () => {
  const good = { title: "Wie beantrage ich ein Visum?", body: "B".repeat(40), room: "fragen-und-antworten" };

  it("401 when not authenticated", async () => {
    asUser(null);
    expect((await questionPOST(formReq(good))).status).toBe(401);
  });

  it("400 for a non-form body", async () => {
    asUser(ALICE);
    const req = new Request(QUESTION_URL, {
      method: "POST",
      body: "not a form",
      headers: { "content-type": "text/plain" },
    });
    expect((await questionPOST(req)).status).toBe(400);
  });

  it("403 suspended (server-side write gate)", async () => {
    asUser(ALICE);
    admin({ community_profiles: [ok({ community_suspended: true, community_muted_until: null })] });
    const res = await questionPOST(formReq(good));
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({ error: "suspended" });
  });

  it("403 muted until a future server stamp", async () => {
    asUser(ALICE);
    admin({
      community_profiles: [
        ok({ community_suspended: false, community_muted_until: new Date(Date.now() + 3600_000).toISOString() }),
      ],
    });
    const res = await questionPOST(formReq(good));
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({ error: "muted" });
  });

  it("400 room_required → 404 room_not_found → 409 qna_disabled", async () => {
    asUser(ALICE);
    admin();
    session();
    expect((await questionPOST(formReq({ title: good.title, body: good.body }))).status).toBe(400);
    session({ community_rooms: [ok([])] });
    expect((await questionPOST(formReq(good))).status).toBe(404);
    session({ community_rooms: [ok(roomRow(false))] });
    expect((await questionPOST(formReq(good))).status).toBe(409);
  });

  it("400 invalid for an oversized title or an oversized tag", async () => {
    asUser(ALICE);
    admin();
    session({ community_rooms: [ok(roomRow())] });
    expect((await questionPOST(formReq({ ...good, title: "T".repeat(121) }))).status).toBe(400);
    session({ community_rooms: [ok(roomRow())] });
    expect((await questionPOST(formReq({ ...good, tags: "x".repeat(25) }))).status).toBe(400);
  });

  it("413 for an oversized image (checked on the real bytes)", async () => {
    asUser(ALICE);
    admin();
    session({ community_rooms: [ok(roomRow())] });
    const big = new File([new Uint8Array(2 * 1024 * 1024 + 1)], "big.png", { type: "image/png" });
    const res = await questionPOST(formReq({ ...good, image: big }));
    expect(res.status).toBe(413);
    await expect(res.json()).resolves.toMatchObject({ error: "image_too_large" });
  });

  it("415 for spoofed image bytes (magic mismatch)", async () => {
    asUser(ALICE);
    admin();
    session({ community_rooms: [ok(roomRow())] });
    const spoofed = new File([new TextEncoder().encode("definitely not a png")], "x.png", {
      type: "image/png",
    });
    const res = await questionPOST(formReq({ ...good, image: spoofed }));
    expect(res.status).toBe(415);
  });

  it("201: author stamped from the session, image into the owner folder", async () => {
    asUser(ALICE);
    admin();
    const s = session({
      community_rooms: [ok(roomRow())],
      community_questions: [ok(questionRow())],
    });
    const res = await questionPOST(
      formReq({ ...good, tags: "Visum, Studium", image: pngFile() }),
    );
    expect(res.status).toBe(201);
    const insert = s.calls.find(
      (c) => c.table === "community_questions" && c.op === "insert",
    ) as { args: unknown[] };
    const values = insert.args[0] as Record<string, unknown>;
    expect(values.author_id).toBe(ALICE);
    expect(values.tags).toEqual(["visum", "studium"]);
    expect(values.image_path).toBe(s.path());
    // Server-generated path: {session_user_id}/{question_id}/image.png —
    // the client filename is never used.
    expect(s.path()).toMatch(/^11111111-1111-4111-8111-111111111111\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/image\.png$/);
    expect(checkRateLimit).toHaveBeenCalledWith("community_question", ALICE);
  });

  it("429 when rate limited (scope community_question)", async () => {
    asUser(ALICE);
    vi.mocked(checkRateLimit).mockResolvedValueOnce({
      allowed: false,
      count: 11,
      limit: 10,
      retry_after: 10,
    } as never);
    expect((await questionPOST(formReq(good))).status).toBe(429);
  });
});

// ---------------------------------------------------------------------------
// POST /api/community/questions/:id/answers
// ---------------------------------------------------------------------------

const answerUrl = (id: string) => `http://localhost/api/community/questions/${id}/answers`;
const jsonReq = (url: string, body: unknown) =>
  new Request(url, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
const answerParams = (questionId: string) => ({ params: Promise.resolve({ questionId }) });

describe("POST /api/community/questions/:id/answers", () => {
  const body = "Du brauchst einen B1-Nachweis und eine Meldebescheinigung.";

  it("401 when not authenticated", async () => {
    asUser(null);
    const res = await answerPOST(jsonReq(answerUrl(QUESTION_ID), { body }), answerParams(QUESTION_ID));
    expect(res.status).toBe(401);
  });

  it("400 for a non-UUID question id", async () => {
    asUser(ALICE);
    const res = await answerPOST(jsonReq(answerUrl("nope"), { body }), answerParams("nope"));
    expect(res.status).toBe(400);
  });

  it("404 when the question does not exist (RLS-scoped read)", async () => {
    asUser(ALICE);
    admin();
    session({ community_questions: [ok([])] });
    const res = await answerPOST(jsonReq(answerUrl(QUESTION_ID), { body }), answerParams(QUESTION_ID));
    expect(res.status).toBe(404);
  });

  it("409 when the question is closed", async () => {
    asUser(ALICE);
    admin();
    session({ community_questions: [ok(questionRow("closed"))], community_rooms: [ok(roomRow())] });
    const res = await answerPOST(jsonReq(answerUrl(QUESTION_ID), { body }), answerParams(QUESTION_ID));
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({ error: "question_closed" });
  });

  it("403 muted (server-side write gate)", async () => {
    asUser(ALICE);
    admin({
      community_profiles: [
        ok({ community_suspended: false, community_muted_until: new Date(Date.now() + 3600_000).toISOString() }),
      ],
    });
    const res = await answerPOST(jsonReq(answerUrl(QUESTION_ID), { body }), answerParams(QUESTION_ID));
    expect(res.status).toBe(403);
  });

  it("400 for an invalid (too short) body", async () => {
    asUser(ALICE);
    admin();
    session({ community_questions: [ok(questionRow())], community_rooms: [ok(roomRow())] });
    const res = await answerPOST(jsonReq(answerUrl(QUESTION_ID), { body: "kurz" }), answerParams(QUESTION_ID));
    expect(res.status).toBe(400);
  });

  it("201 + notifies the question author with full refs (never the self-answearer)", async () => {
    asUser(ALICE);
    admin();
    session({
      community_questions: [ok(questionRow("open", CAROL))],
      community_rooms: [ok(roomRow())],
      community_answers: [ok(answerRow(ALICE))],
    });
    const res = await answerPOST(jsonReq(answerUrl(QUESTION_ID), { body }), answerParams(QUESTION_ID));
    expect(res.status).toBe(201);
    expect(createSocialNotification).toHaveBeenCalledTimes(1);
    expect(vi.mocked(createSocialNotification).mock.calls[0][0]).toMatchObject({
      targetUserId: CAROL,
      actorUserId: ALICE,
      title: "answer",
      content: "Wie beantrage ich ein Visum?",
      roomId: ROOM_ID,
      questionId: QUESTION_ID,
      answerId: ANSWER_ID,
    });
    expect(checkRateLimit).toHaveBeenCalledWith("community_answer", ALICE);
  });

  it("201 self-answer: no notification at all", async () => {
    asUser(ALICE);
    admin();
    session({
      community_questions: [ok(questionRow("open", ALICE))],
      community_rooms: [ok(roomRow())],
      community_answers: [ok(answerRow(ALICE))],
    });
    const res = await answerPOST(jsonReq(answerUrl(QUESTION_ID), { body }), answerParams(QUESTION_ID));
    expect(res.status).toBe(201);
    expect(createSocialNotification).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// /api/community/reports
// ---------------------------------------------------------------------------

const REPORT_URL = "http://localhost/api/community/reports";
const reportReq = (body: Record<string, unknown>) => jsonReq(REPORT_URL, body);

describe("/api/community/reports", () => {
  it("POST 401 when not authenticated", async () => {
    asUser(null);
    expect((await reportPOST(reportReq({ target_type: "message", target_id: MESSAGE_ID, reason: "spam" }))).status).toBe(401);
  });

  it("POST 400 for an unknown reason or a non-UUID target", async () => {
    asUser(ALICE);
    admin();
    expect(
      (await reportPOST(reportReq({ target_type: "message", target_id: MESSAGE_ID, reason: "bogus" }))).status,
    ).toBe(400);
    expect(
      (await reportPOST(reportReq({ target_type: "message", target_id: "nope", reason: "spam" }))).status,
    ).toBe(400);
  });

  it("POST 403 suspended — filing reports is not self-service while suspended", async () => {
    asUser(ALICE);
    admin({ community_profiles: [ok({ community_suspended: true, community_muted_until: null })] });
    expect((await reportPOST(reportReq({ target_type: "message", target_id: MESSAGE_ID, reason: "spam" }))).status).toBe(403);
  });

  it("POST 404 when the target does not exist", async () => {
    asUser(ALICE);
    admin({ community_messages: [ok([])] });
    const res = await reportPOST(reportReq({ target_type: "message", target_id: MESSAGE_ID, reason: "spam" }));
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toMatchObject({ error: "target_not_found" });
  });

  it("POST 403 self_report (own content)", async () => {
    asUser(ALICE);
    admin({ community_messages: [ok({ id: MESSAGE_ID, user_id: ALICE })] });
    const res = await reportPOST(reportReq({ target_type: "message", target_id: MESSAGE_ID, reason: "spam" }));
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({ error: "self_report" });
  });

  it("POST 409 duplicate (23505 from the partial unique index)", async () => {
    asUser(ALICE);
    admin({ community_messages: [ok({ id: MESSAGE_ID, user_id: CAROL })] });
    session({ community_reports: [fail("duplicate key", "23505")] });
    const res = await reportPOST(reportReq({ target_type: "message", target_id: MESSAGE_ID, reason: "spam" }));
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({ error: "already_reported" });
  });

  it("POST 201: the reporter is always the session user; empty details → null", async () => {
    asUser(ALICE);
    admin({ community_messages: [ok({ id: MESSAGE_ID, user_id: CAROL })] });
    const s = session({ community_reports: [ok(reportRow())] });
    const res = await reportPOST(
      reportReq({ target_type: "message", target_id: MESSAGE_ID, reason: "spam", details: "   " }),
    );
    expect(res.status).toBe(201);
    const insert = s.calls.find(
      (c) => c.table === "community_reports" && c.op === "insert",
    ) as { args: unknown[] };
    const values = insert.args[0] as Record<string, unknown>;
    expect(values.reporter_id).toBe(ALICE);
    expect(values.target_type).toBe("message");
    expect(values.reason).toBe("spam");
    expect(values.details).toBeNull();
    expect(checkRateLimit).toHaveBeenCalledWith("community_report", ALICE);
  });

  it("POST accepts exactly the four target types — 'dm' is not one of them", async () => {
    asUser(ALICE);
    const targets: Array<{ type: string; table: string; queue: Term }> = [
      { type: "message", table: "community_messages", queue: ok({ id: MESSAGE_ID, user_id: CAROL }) },
      { type: "question", table: "community_questions", queue: ok({ id: QUESTION_ID, author_id: CAROL }) },
      { type: "answer", table: "community_answers", queue: ok({ id: ANSWER_ID, author_id: CAROL }) },
      { type: "profile", table: "community_profiles", queue: ok({ id: "88888888-8888-4888-8888-888888888888", user_id: CAROL }) },
    ];
    for (const t of targets) {
      // community_profiles[0] is consumed by the route's write-gate read;
      // for a profile target the validation read needs a second entry.
      const queues: Record<string, Term[]> = { community_profiles: [ok(null)], [t.table]: [t.queue] };
      if (t.table === "community_profiles") queues.community_profiles = [ok(null), t.queue];
      admin(queues);
      session({ community_reports: [ok(reportRow())] });
      const res = await reportPOST(reportReq({ target_type: t.type, target_id: MESSAGE_ID, reason: "spam" }));
      expect(res.status, t.type).toBe(201);
    }
    admin({});
    expect((await reportPOST(reportReq({ target_type: "dm", target_id: MESSAGE_ID, reason: "spam" }))).status).toBe(400);
  });

  it("GET 401 when not authenticated", async () => {
    asUser(null);
    expect((await reportGET()).status).toBe(401);
  });

  it("GET returns the reporter's OWN rows only (scope = session user)", async () => {
    asUser(ALICE);
    admin();
    const s = session({ community_reports: [ok([reportRow(), reportRow()])] });
    const res = await reportGET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[] };
    expect(body.items).toHaveLength(2);
    const eq = s.calls.find(
      (c) => c.table === "community_reports" && c.op === "eq",
    ) as { args: unknown[] };
    expect(eq.args).toEqual(["reporter_id", ALICE]);
    expect(checkRateLimit).toHaveBeenCalledWith("community_profile", ALICE);
  });
});

// ---------------------------------------------------------------------------
// Anti-spam: bounded per-action rate scopes + write gates
// ---------------------------------------------------------------------------

describe("anti-spam: bounded, per-action rate scopes", () => {
  const rateSrc = readFileSync(path.resolve(process.cwd(), "src/lib/rate-limit.ts"), "utf8");

  it("every Phase 5 action has a bounded 60s scope", () => {
    const scopes: Array<[string, number]> = [
      ["community_search", 30],
      ["community_question", 10],
      ["community_answer", 20],
      ["community_report", 5],
      ["community_pin", 10],
      ["community_moderation", 30],
      ["community_role", 10],
      ["community_room_settings", 10],
      ["community_profile", 30],
    ];
    for (const [scope, max] of scopes) {
      expect(rateSrc, scope).toContain(`${scope}: { max: ${max}, windowSeconds: 60 }`);
    }
  });

  it("the server actions re-resolve the role and apply their own scope", () => {
    const actions = readFileSync(path.resolve(process.cwd(), "src/app/community/advanced-actions.ts"), "utf8");
    expect(actions).toContain('checkRateLimit("community_pin"');
    expect(actions).toContain('checkRateLimit("community_moderation"');
    expect(actions).toContain('checkRateLimit("community_role"');
    expect(actions).toContain('checkRateLimit("community_room_settings"');
    expect(actions).toContain('checkRateLimit("community_question"');
    expect(actions).toContain("fetchViewerRole(");
  });

  it("every community write route runs the suspended/muted gate before any insert", () => {
    for (const f of [
      "src/app/api/community/questions/route.ts",
      "src/app/api/community/questions/[questionId]/answers/route.ts",
      "src/app/api/community/reports/route.ts",
    ]) {
      expect(readFileSync(path.resolve(process.cwd(), f), "utf8"), f).toContain("fetchCommunityWriteGate");
    }
  });
});

// ---------------------------------------------------------------------------
// i18n: 4-locale community parity
// ---------------------------------------------------------------------------

describe("i18n: 4-locale community parity", () => {
  const LOCALES = ["de", "en", "fr", "ar"] as const;
  const communityOf = (lang: string): unknown =>
    (dictionaries as Record<string, { community: unknown }>)[lang].community;

  function keyPaths(value: unknown, prefix = ""): string[] {
    if (value !== null && typeof value === "object") {
      return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) =>
        keyPaths(v, prefix ? `${prefix}.${k}` : k),
      );
    }
    return [prefix];
  }
  function leafStrings(value: unknown, prefix = ""): Array<[string, string]> {
    if (typeof value === "string") return [[prefix, value]];
    if (value !== null && typeof value === "object") {
      return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) =>
        leafStrings(v, prefix ? `${prefix}.${k}` : k),
      );
    }
    return [];
  }

  const deKeys = keyPaths(communityOf("de")).sort();

  it("all four locales have the identical community key set", () => {
    expect(deKeys.length).toBeGreaterThanOrEqual(400);
    for (const lang of LOCALES) {
      const keys = keyPaths(communityOf(lang)).sort();
      expect(keys.join("\n"), `${lang} key set differs from de`).toBe(deKeys.join("\n"));
    }
  });

  it("every community leaf is a non-empty translation in every locale", () => {
    for (const lang of LOCALES) {
      const empty = leafStrings(communityOf(lang)).filter(([, v]) => v.trim().length === 0);
      expect(empty, `${lang} empty leaves: ${empty.map(([k]) => k).join(", ")}`).toEqual([]);
    }
  });

  it("the new Phase 5 keys exist and resolve in all four locales", () => {
    const lookup = (obj: unknown, p: string): unknown =>
      p.split(".").reduce((o, k) => ((o as Record<string, unknown> | null)?.[k] ?? null), obj);
    const phase5 = [
      "community.myReports",
      "community.statsReputation",
      "community.statsQuestionsLabel",
      "community.statsAcceptedLabel",
      "community.cancel",
      "community.loading",
      "community.searchClearFilters",
    ];
    for (const lang of LOCALES) {
      for (const key of phase5) {
        const root = (dictionaries as unknown as Record<string, Record<string, unknown>>)[lang];
        const v = lookup(root, key);
        expect(typeof v, `${lang}:${key}`).toBe("string");
        expect((v as string).trim().length, `${lang}:${key}`).toBeGreaterThan(0);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Migration guards (v6 SQL) — the DB line of defense
// ---------------------------------------------------------------------------

describe("migration guards (v6 SQL)", () => {
  const sql = readFileSync(
    path.resolve(
      process.cwd(),
      "supabase/migrations/20261031000000_community_v6_advanced.sql",
    ),
    "utf8",
  );
  const flat = sql.replace(/\s+/g, " ");
  const NEW_TABLES = [
    "community_memberships",
    "community_questions",
    "community_answers",
    "community_pins",
    "community_reports",
    "community_moderation_actions",
    "community_reputation_events",
  ];

  it("RLS is enabled on every new table", () => {
    for (const t of NEW_TABLES) {
      expect(flat, t).toContain(`alter table public.${t} enable row level security;`);
    }
  });

  it("NO user write policies on the protected tables (memberships / pins / audit / reputation)", () => {
    for (const t of [
      "community_memberships",
      "community_pins",
      "community_moderation_actions",
      "community_reputation_events",
    ]) {
      expect(new RegExp(`on public\\.${t} for (insert|update|delete)`).test(flat), t).toBe(false);
    }
    // Reports: users may only file + read their OWN rows — no status/assignment
    // writes from the client at all.
    expect(new RegExp(`on public\\.community_reports for (update|delete)`).test(flat)).toBe(false);
  });

  it("report insert is own-only (with check reporter_id = auth.uid())", () => {
    expect(flat).toContain(
      `on public.community_reports for insert to authenticated with check (reporter_id = auth.uid());`,
    );
    expect(flat).toContain(
      `on public.community_reports for select to authenticated using (reporter_id = auth.uid());`,
    );
  });

  it("exactly one accepted answer per question (DB-level invariant)", () => {
    expect(flat).toContain(
      "create unique index community_answers_question_accepted_uq on public.community_answers (question_id) where accepted = true;",
    );
  });

  it("a message can be pinned at most once (unique message_id)", () => {
    expect(flat).toContain("message_id uuid not null unique");
  });

  it("one pending report per (reporter, target) — partial unique index", () => {
    expect(flat).toContain(
      "create unique index community_reports_pending_uq on public.community_reports (reporter_id, target_type, target_id) where status in ('open', 'reviewing');",
    );
  });

  it("community_search: p_user must be the session user (identity never client-supplied)", () => {
    const start = sql.indexOf("create or replace function public.community_search(");
    const fn = sql.slice(start, sql.indexOf("$$;", start));
    expect(fn).toContain("if auth.uid() is null or auth.uid() <> p_user then");
    expect(fn).toContain("raise exception 'community_search: p_user must be the session user';");
  });

  it("community_search never references a DM table (no DM leakage into global search)", () => {
    const start = sql.indexOf("create or replace function public.community_search(");
    const fn = sql.slice(start, sql.indexOf("$$;", start));
    expect(fn).not.toMatch(/community_direct_messages|community_dm_/);
  });

  it("community_search: execute granted to authenticated + service_role only", () => {
    const sig = "uuid, text, text, uuid, uuid, timestamptz, timestamptz, uuid, integer";
    expect(flat, "revoke").toMatch(
      new RegExp(`revoke execute on function public\\.community_search\\( ${sig} \\) from public, anon;`),
    );
    expect(flat, "grant").toMatch(
      new RegExp(`grant execute on function public\\.community_search\\( ${sig} \\) to authenticated, service_role;`),
    );
  });

  it("role hierarchy functions exist for the RLS policies", () => {
    for (const f of ["community_user_role()", "community_is_moderator()", "community_is_admin()"]) {
      expect(flat, f).toContain(`create or replace function public.${f}`);
    }
  });

  it("the report reason + target-type whitelists live in the DB (no 'dm' target)", () => {
    for (const r of [
      "spam",
      "harassment",
      "hate",
      "scam",
      "misinformation",
      "sexual_content",
      "illegal_content",
      "impersonation",
      "other",
    ]) {
      expect(flat, r).toContain(`'${r}'`);
    }
    const targetCheck = flat.match(/check \(target_type in \(([^)]*)\)/);
    expect(targetCheck?.[1]).toBe("'message', 'question', 'answer', 'profile'");
    expect(flat).not.toContain("'dm'");
  });
});

// ---------------------------------------------------------------------------
// Client invariants (the Phase 5 surface)
// ---------------------------------------------------------------------------

describe("client invariants (Phase 5 surface)", () => {
  const read = (p: string) => readFileSync(path.resolve(process.cwd(), p), "utf8");
  const COMPONENTS = [
    "src/components/community/search-view.tsx",
    "src/components/community/moderation-view.tsx",
    "src/components/community/question-create.tsx",
    "src/components/community/question-detail.tsx",
    "src/components/community/report-dialog.tsx",
    "src/components/community/profile-card.tsx",
    "src/components/community/community-settings.tsx",
  ];
  const PAGES = [
    "src/app/community/search/page.tsx",
    "src/app/community/questions/new/page.tsx",
    "src/app/community/questions/[id]/page.tsx",
    "src/app/community/[room]/questions/page.tsx",
    "src/app/community/moderation/page.tsx",
  ];
  const ALL = [...COMPONENTS, ...PAGES, "src/components/community/room-chat.tsx"];

  it("no polling: no setInterval / EventSource / busy loops in the new components", () => {
    for (const p of COMPONENTS) {
      const src = read(p);
      expect(src, p).not.toMatch(/setInterval\s*\(/);
      expect(src, p).not.toContain("EventSource");
      expect(src, p).not.toMatch(/while\s*\(\s*true\s*\)/);
    }
  });

  it("room-chat has exactly ONE timer: the typing prune (no polling)", () => {
    const src = read("src/components/community/room-chat.tsx");
    // The typing prune (local-only, never hits the network) is the ONLY
    // timer — the realtime stream is the transport; reconnects and
    // visibility returns run ONE targeted resync (event-driven). No
    // interval ever inlines a fetch call.
    expect(src.match(/setInterval\s*\(/g)).toHaveLength(1);
    expect(src).toContain("window.setInterval(refreshTyping, TYPING_PRUNE_INTERVAL_MS)");
    expect(src).not.toContain("window.setInterval(tick, 1000)");
    expect(src).not.toMatch(/setInterval\([^)]*fetch/);
  });

  it("no dangerouslySetInnerHTML anywhere in the Phase 5 surface", () => {
    for (const p of ALL) {
      expect(read(p), p).not.toContain("dangerouslySetInnerHTML");
    }
  });

  it("the service-role client never reaches the client bundle", () => {
    for (const p of ALL) {
      expect(read(p), p).not.toContain("@/lib/supabase/admin");
    }
  });

  it("no client-side role resolution: components receive authorization as props", () => {
    for (const p of COMPONENTS) {
      const src = read(p);
      expect(src, p).not.toContain('from "@/lib/community/roles"');
      expect(src, p).not.toContain('from "@/lib/supabase/server"');
    }
  });

  it("the moderation page guards access server-side (role re-resolved + redirect)", () => {
    const src = read("src/app/community/moderation/page.tsx");
    expect(src).toContain("fetchViewerRole");
    expect(src).toContain("isModerator");
    expect(src).toContain('from "next/navigation"');
  });

  it("the report dialog sends only whitelisted fields (no client identity)", () => {
    const src = read("src/components/community/report-dialog.tsx");
    expect(src).not.toContain("reporter_id");
    expect(src).not.toContain("user.id");
  });

  it("the Phase 5 pages are server components (authorization stays server-side)", () => {
    for (const p of PAGES) {
      expect(read(p), p).not.toContain('"use client"');
    }
  });
});
