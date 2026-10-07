/**
 * Community Phase 5 — backend behavior suite.
 *
 * Covers the Phase 5 server libraries with scripted Supabase mocks that
 * RECORD every DB operation — the tests assert what the server sends to the
 * database (the real authorization surface), not just return values:
 *
 *   - Q&A: creation validation, Q&A-room restriction, answer notification
 *     contract (refs + no self-notify), single-accepted invariant (the
 *     clear-then-set order), self-award prevention, fixed idempotent
 *     reputation points, unsolve/close permissions
 *   - Pins: moderator+ gate, room isolation, duplicate pin, audit trail
 *   - Reports: the exact 9-reason whitelist, self/missing-target rejection,
 *     duplicate → 23505 mapping, own-only reporter read path
 *   - Roles: rank hierarchy, no client-supplied roles (re-resolved),
 *     escalation prevention (grant above rank), the owner guard (an admin
 *     cannot demote the owner), self-role, audit
 *   - Moderation: executor behavior (unpin / remove_answer cascade),
 *     audit logging, bounded queue reads, degraded safety
 *   - Reputation: aggregation + zero-degradation
 *   - Search: admin-RPC mapping + answer deep-link ids + degradation
 *   - Events: the pin broadcast payload contract (strict parsers)
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/auth", () => ({ getCurrentUserAndProfile: vi.fn() }));
vi.mock("@/lib/community/social", () => ({
  createSocialNotification: vi.fn(() => Promise.resolve({ ok: true as const })),
  socialSendKey: (a: string, b: string) => `${a}:${b}`,
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("server-only", () => ({}));

const { createClient } = await import("@/lib/supabase/server");
const { createAdminClient } = await import("@/lib/supabase/admin");
const { createSocialNotification } = await import("@/lib/community/social");
const {
  ANSWER_MAX,
  ANSWER_MIN,
  QUESTION_BODY_MAX,
  QUESTION_BODY_MIN,
  QUESTION_TITLE_MAX,
  QUESTION_TITLE_MIN,
  acceptAnswer,
  createAnswer,
  createQuestion,
  parseQuestionTags,
  setQuestionClosed,
  unsolveQuestion,
} = await import("@/lib/community/qa");
const { pinMessage, unpinMessage } = await import("@/lib/community/pins");
const { REPORT_REASONS, createReport, fetchMyReports } = await import("@/lib/community/reports");
const { ROLE_RANK, fetchViewerRole, isModerator, setMemberRole } = await import("@/lib/community/roles");
const {
  TIMEOUT_DURATIONS,
  fetchModerationAudit,
  fetchReportCounts,
  fetchReportQueue,
  performModerationAction,
  setReportStatus,
} = await import("@/lib/community/moderation");
const { EMPTY_REPUTATION, fetchReputationSummary } = await import("@/lib/community/reputation");
const { runCommunitySearch } = await import("@/lib/community/search");
const {
  PIN_BROADCAST_EVENT,
  PIN_REMOVE_BROADCAST_EVENT,
  parsePinBroadcast,
  parsePinRemoveBroadcast,
} = await import("@/lib/community/events");

// ---------------------------------------------------------------------------
// Scripted Supabase mocks (record every operation)
// ---------------------------------------------------------------------------

interface Call {
  table: string;
  op: string;
  args: unknown[];
}

type Terminal = (table: string, op: string) => Promise<{ data: unknown; error: unknown; count?: number }>;

function scriptedAdmin(terminal?: Terminal) {
  const calls: Call[] = [];
  const client = {
    rpc: () =>
      Promise.resolve({ data: { allowed: true, count: 1, limit: 100, retry_after: 0 }, error: null }),
    storage: { from: () => ({ remove: async () => undefined }) },
    from: (table: string) => {
      const base: Record<string, unknown> = {};
      const op = (name: string) => (...args: unknown[]) => {
        calls.push({ table, op: name, args });
        return base;
      };
      base.select = op("select");
      base.eq = op("eq");
      base.in = op("in");
      base.ilike = op("ilike");
      base.or = op("or");
      base.order = op("order");
      base.limit = op("limit");
      base.lt = op("lt");
      base.gte = op("gte");
      base.not = op("not");
      base.is = op("is");
      base.update = op("update");
      base.insert = op("insert");
      base.upsert = op("upsert");
      base.delete = op("delete");
      const terminalFor = (opName: string) => {
        const p = (async () =>
          terminal ? terminal(table, opName) : { data: null, error: null })();
        p.catch(() => undefined); // keep the inner promise settled (no unhandled rejections)
        return p;
      };
      base.maybeSingle = () => terminalFor("maybeSingle");
      base.single = () => terminalFor("single");
      base.then = (
        onF: (v: unknown) => unknown,
        onR: (v: unknown) => unknown,
      ) => terminalFor("select").then(onF as never, onR as never);
      return base;
    },
  };
  vi.mocked(createAdminClient).mockReturnValue(client as never);
  return { calls };
}

function scriptedSession(terminal?: Terminal) {
  const calls: Call[] = [];
  const client = {
    from: (table: string) => {
      const base: Record<string, unknown> = {};
      const op = (name: string) => (...args: unknown[]) => {
        calls.push({ table, op: name, args });
        return base;
      };
      base.select = op("select");
      base.eq = op("eq");
      base.in = op("in");
      base.ilike = op("ilike");
      base.order = op("order");
      base.limit = op("limit");
      base.lt = op("lt");
      base.gte = op("gte");
      base.not = op("not");
      base.is = op("is");
      base.update = op("update");
      base.insert = op("insert");
      base.delete = op("delete");
      const terminalFor = (opName: string) => {
        const p = (async () =>
          terminal ? terminal(table, opName) : { data: null, error: null })();
        p.catch(() => undefined);
        return p;
      };
      base.maybeSingle = () => terminalFor("maybeSingle");
      base.single = () => terminalFor("single");
      base.then = (
        onF: (v: unknown) => unknown,
        onR: (v: unknown) => unknown,
      ) => terminalFor("select").then(onF as never, onR as never);
      return base;
    },
  };
  vi.mocked(createClient).mockResolvedValue(client as never);
  return { calls };
}

const sessionClient = async () =>
  (await (createClient as unknown as () => Promise<unknown>)()) as never;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const AUTHOR_ID = "11111111-1111-4111-8111-111111111111";
const ANSWERER_ID = "22222222-2222-4222-8222-222222222222";
const MODERATOR_ID = "33333333-3333-4333-8333-333333333333";
const ADMIN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OWNER_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const QUESTION_ID = "44444444-4444-4444-8444-444444444444";
const ANSWER_ID = "55555555-5555-4555-8555-555555555555";
const ANSWER_ID_2 = "55555555-5555-4555-8555-555555555556";
const ROOM_ID = "b1000000-0000-4000-8000-000000000002";
const MESSAGE_ID = "66666666-6666-4666-8666-666666666666";
const VALID_TITLE = "Wie beantrage ich ein B1-Visum?";
const VALID_BODY = "Ich brauche Hilfe bei der Visumsantragstellung.";
const VALID_ANSWER = "Hier ist deine Antwort auf die Frage.";

const questionRow = (over: Record<string, unknown> = {}) => ({
  id: QUESTION_ID,
  room_id: ROOM_ID,
  author_id: AUTHOR_ID,
  title: VALID_TITLE,
  body: VALID_BODY,
  tags: ["visa"],
  image_path: null,
  status: "open",
  accepted_answer_id: null,
  solved_at: null,
  created_at: "2026-10-01T10:00:00.000Z",
  ...over,
});

const answerRow = (over: Record<string, unknown> = {}) => ({
  id: ANSWER_ID,
  question_id: QUESTION_ID,
  author_id: ANSWERER_ID,
  body: VALID_ANSWER,
  accepted: false,
  deleted_at: null,
  created_at: "2026-10-02T10:00:00.000Z",
  ...over,
});

const room = (over: Record<string, unknown> = {}) => ({
  id: ROOM_ID,
  slug: "fragen-und-antworten",
  name: "Fragen & Antworten",
  category_id: "b0000000-0000-4000-8000-000000000001",
  description: null,
  icon: "hash",
  position: 1,
  enabled: true,
  qna_enabled: true,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Q&A — question creation
// ---------------------------------------------------------------------------

describe("Phase 5 Q&A — question creation", () => {
  it("enforces the title/body limits without any DB write", async () => {
    const { calls } = scriptedSession();
    const r1 = await createQuestion(await sessionClient(), { id: AUTHOR_ID }, {
      roomId: ROOM_ID,
      room: room() as never,
      title: "zu kurz",
      body: VALID_BODY,
      tags: [],
    });
    expect(r1).toEqual({ ok: false, error: "invalid" });
    const r2 = await createQuestion(await sessionClient(), { id: AUTHOR_ID }, {
      roomId: ROOM_ID,
      room: room() as never,
      title: "x".repeat(QUESTION_TITLE_MAX + 1),
      body: VALID_BODY,
      tags: [],
    });
    expect(r2).toEqual({ ok: false, error: "invalid" });
    const r3 = await createQuestion(await sessionClient(), { id: AUTHOR_ID }, {
      roomId: ROOM_ID,
      room: room() as never,
      title: VALID_TITLE,
      body: "x".repeat(QUESTION_BODY_MIN - 1),
      tags: [],
    });
    expect(r3).toEqual({ ok: false, error: "invalid" });
    expect(QUESTION_TITLE_MIN).toBe(10);
    expect(QUESTION_TITLE_MAX).toBe(120);
    expect(QUESTION_BODY_MIN).toBe(30);
    expect(QUESTION_BODY_MAX).toBe(4000);
    expect(calls.some((c) => c.op === "insert")).toBe(false);
  });

  it("refuses rooms without Q&A mode (server-side)", async () => {
    const { calls } = scriptedSession();
    const res = await createQuestion(await sessionClient(), { id: AUTHOR_ID }, {
      roomId: ROOM_ID,
      room: room({ qna_enabled: false }) as never,
      title: VALID_TITLE,
      body: VALID_BODY,
      tags: [],
    });
    expect(res).toEqual({ ok: false, error: "qna_disabled" });
    expect(calls.some((c) => c.op === "insert")).toBe(false);
  });

  it("refuses a missing room", async () => {
    const res = await createQuestion(await sessionClient(), { id: AUTHOR_ID }, {
      roomId: ROOM_ID,
      room: null,
      title: VALID_TITLE,
      body: VALID_BODY,
      tags: [],
    });
    expect(res).toEqual({ ok: false, error: "room_not_found" });
  });

  it("inserts through the SESSION client with the session user as author", async () => {
    const { calls } = scriptedSession(async (table, op) => {
      if (table === "community_questions" && op === "single")
        return { data: questionRow(), error: null };
      return { data: [], error: null };
    });
    const tags = parseQuestionTags(" Visa , deutschland ,visa") as string[];
    const res = await createQuestion(await sessionClient(), { id: AUTHOR_ID }, {
      roomId: ROOM_ID,
      room: room() as never,
      title: VALID_TITLE,
      body: VALID_BODY,
      tags,
    });
    expect(res.ok).toBe(true);
    const insert = calls.find((c) => c.table === "community_questions" && c.op === "insert");
    expect(insert?.args[0]).toMatchObject({
      room_id: ROOM_ID,
      author_id: AUTHOR_ID,
      tags,
    });
  });

  it("parses tags: trim, lowercase, dedupe, truncate to 5, reject >24 chars", () => {
    expect(parseQuestionTags(" Visa , DEUTSCHLAND ,visa")).toEqual(["visa", "deutschland"]);
    // more than 5 → truncated to the first 5 (the route also validates)
    expect(parseQuestionTags("a,b,c,d,e,f")).toEqual(["a", "b", "c", "d", "e"]);
    expect(parseQuestionTags("x".repeat(25))).toBeNull();
    expect(parseQuestionTags("a b")).toEqual(["a-b"]);
    expect(parseQuestionTags("")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Q&A — answers
// ---------------------------------------------------------------------------

describe("Phase 5 Q&A — answers", () => {
  const answerClient = () => {
    const client = {
      from: () => {
        const base: Record<string, unknown> = {};
        base.select = () => base;
        base.insert = () => base;
        base.single = async () => ({ data: answerRow(), error: null });
        return base;
      },
    };
    return client;
  };

  it("enforces answer length limits", async () => {
    const res = await createAnswer(answerClient() as never, { id: ANSWERER_ID }, {
      question: questionRow() as never,
      room: room() as never,
      body: "short",
    });
    expect(res).toEqual({ ok: false, error: "invalid" });
    const long = await createAnswer(answerClient() as never, { id: ANSWERER_ID }, {
      question: questionRow() as never,
      room: room() as never,
      body: "x".repeat(ANSWER_MAX + 1),
    });
    expect(long).toEqual({ ok: false, error: "invalid" });
    expect(ANSWER_MIN).toBe(10);
    expect(ANSWER_MAX).toBe(4000);
  });

  it("refuses closed questions", async () => {
    const res = await createAnswer(answerClient() as never, { id: ANSWERER_ID }, {
      question: questionRow({ status: "closed" }) as never,
      room: room() as never,
      body: VALID_ANSWER,
    });
    expect(res).toEqual({ ok: false, error: "closed" });
  });

  it("notifies the question author with question/answer refs — never self", async () => {
    const res = await createAnswer(answerClient() as never, { id: ANSWERER_ID }, {
      question: questionRow() as never,
      room: room() as never,
      body: VALID_ANSWER,
    });
    expect(res.ok).toBe(true);
    expect(vi.mocked(createSocialNotification)).toHaveBeenCalledWith(
      expect.objectContaining({
        targetUserId: AUTHOR_ID,
        actorUserId: ANSWERER_ID,
        title: "answer",
        questionId: QUESTION_ID,
        answerId: ANSWER_ID,
      }),
    );

    vi.mocked(createSocialNotification).mockClear();
    const selfRes = await createAnswer(answerClient() as never, { id: AUTHOR_ID }, {
      question: questionRow({ author_id: AUTHOR_ID }) as never,
      room: room() as never,
      body: VALID_ANSWER,
    });
    expect(selfRes.ok).toBe(true);
    expect(vi.mocked(createSocialNotification)).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Q&A — acceptance (the heart of the permission model)
// ---------------------------------------------------------------------------

describe("Phase 5 Q&A — accept answer", () => {
  function acceptFixture(qOver: Record<string, unknown> = {}, aOver: Record<string, unknown> = {}) {
    return scriptedAdmin(async (table, op) => {
      if (table === "community_questions" && op === "maybeSingle")
        return { data: questionRow(qOver), error: null };
      if (table === "community_answers" && op === "maybeSingle")
        return { data: answerRow(aOver), error: null };
      if (table === "community_questions" && op === "single")
        return { data: questionRow({ status: "solved", accepted_answer_id: ANSWER_ID, ...qOver }), error: null };
      return { data: null, error: null };
    });
  }

  it("forbids a plain member who is not the author", async () => {
    acceptFixture();
    const res = await acceptAnswer({
      actorUserId: MODERATOR_ID,
      actorRole: "member",
      questionId: QUESTION_ID,
      answerId: ANSWER_ID,
    });
    expect(res).toEqual({ ok: false, error: "forbidden" });
  });

  it("allows the author and a moderator+", async () => {
    acceptFixture();
    const r1 = await acceptAnswer({
      actorUserId: AUTHOR_ID,
      actorRole: "member",
      questionId: QUESTION_ID,
      answerId: ANSWER_ID,
    });
    expect(r1.ok).toBe(true);

    acceptFixture();
    const r2 = await acceptAnswer({
      actorUserId: MODERATOR_ID,
      actorRole: "moderator",
      questionId: QUESTION_ID,
      answerId: ANSWER_ID,
    });
    expect(r2.ok).toBe(true);
  });

  it("keeps EXACTLY ONE accepted answer (clear-then-set order)", async () => {
    const { calls } = acceptFixture();
    const res = await acceptAnswer({
      actorUserId: AUTHOR_ID,
      actorRole: "member",
      questionId: QUESTION_ID,
      answerId: ANSWER_ID_2,
    });
    expect(res.ok).toBe(true);
    // The answer-table operations in CALL ORDER (the lookup .eq precedes
    // both updates — anchor on the updates themselves).
    const seq = calls.filter((c) => c.table === "community_answers");
    const clearIdx = seq.findIndex(
      (c) => c.op === "update" && (c.args[0] as { accepted?: boolean }).accepted === false,
    );
    const setIdx = seq.findIndex(
      (c) => c.op === "update" && (c.args[0] as { accepted?: boolean }).accepted === true,
    );
    expect(clearIdx).toBeGreaterThanOrEqual(0);
    expect(setIdx).toBeGreaterThan(clearIdx); // clear runs BEFORE set
    const clearEq = seq.slice(clearIdx, setIdx).find((c) => c.op === "eq");
    expect(clearEq?.args).toEqual(["question_id", QUESTION_ID]); // clear by question
    const setEq = seq.slice(setIdx).find((c) => c.op === "eq");
    expect(setEq?.args).toEqual(["id", ANSWER_ID_2]); // set the new answer
    const questionUpdate = calls.find(
      (c) => c.table === "community_questions" && c.op === "update",
    );
    expect(questionUpdate?.args[0]).toMatchObject({ status: "solved", accepted_answer_id: ANSWER_ID_2 });
  });

  it("refuses an answer that belongs to another question (isolation)", async () => {
    acceptFixture({}, { question_id: "99999999-9999-4999-8999-999999999999" });
    const res = await acceptAnswer({
      actorUserId: AUTHOR_ID,
      actorRole: "member",
      questionId: QUESTION_ID,
      answerId: ANSWER_ID,
    });
    expect(res).toEqual({ ok: false, error: "not_found" });
  });

  it("refuses already-accepted answers", async () => {
    acceptFixture({ status: "solved", accepted_answer_id: ANSWER_ID });
    const res = await acceptAnswer({
      actorUserId: AUTHOR_ID,
      actorRole: "member",
      questionId: QUESTION_ID,
      answerId: ANSWER_ID,
    });
    expect(res).toEqual({ ok: false, error: "already_accepted" });
  });

  it("NEVER awards reputation on self-answers (self-award prevention)", async () => {
    const { calls } = acceptFixture({}, { author_id: AUTHOR_ID });
    const res = await acceptAnswer({
      actorUserId: MODERATOR_ID,
      actorRole: "admin",
      questionId: QUESTION_ID,
      answerId: ANSWER_ID,
    });
    expect(res.ok).toBe(true);
    expect(calls.some((c) => c.table === "community_reputation_events")).toBe(false);
    expect(vi.mocked(createSocialNotification)).not.toHaveBeenCalled();
  });

  it("awards FIXED points idempotently (unique-conflict upsert)", async () => {
    const { calls } = acceptFixture();
    const res = await acceptAnswer({
      actorUserId: AUTHOR_ID,
      actorRole: "member",
      questionId: QUESTION_ID,
      answerId: ANSWER_ID,
    });
    expect(res.ok).toBe(true);
    const upsert = calls.find(
      (c) => c.table === "community_reputation_events" && c.op === "upsert",
    );
    expect(upsert).toBeDefined();
    const rows = upsert?.args[0] as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);
    const byType = Object.fromEntries(rows.map((r) => [r.event_type, r]));
    expect(byType.answer_accepted.points).toBe(5);
    expect(byType.question_solved.points).toBe(2);
    expect(byType.answer_accepted.user_id).toBe(ANSWERER_ID);
    expect(byType.question_solved.user_id).toBe(AUTHOR_ID);
    expect(upsert?.args[1]).toEqual({
      onConflict: "event_type,entity_type,entity_id,user_id",
      ignoreDuplicates: true,
    });
  });

  it("notifies the answer author with the answer_accepted kind + refs", async () => {
    acceptFixture();
    const res = await acceptAnswer({
      actorUserId: AUTHOR_ID,
      actorRole: "member",
      questionId: QUESTION_ID,
      answerId: ANSWER_ID,
    });
    expect(res.ok).toBe(true);
    expect(vi.mocked(createSocialNotification)).toHaveBeenCalledWith(
      expect.objectContaining({
        targetUserId: ANSWERER_ID,
        actorUserId: AUTHOR_ID,
        title: "answer_accepted",
        questionId: QUESTION_ID,
        answerId: ANSWER_ID,
      }),
    );
  });
});

describe("Phase 5 Q&A — unsolve + close", () => {
  it("unsolve: author/moderator only, clears acceptance back to open", async () => {
    const { calls } = scriptedAdmin(async (table, op) => {
      if (table === "community_questions" && op === "maybeSingle")
        return { data: questionRow({ status: "solved", accepted_answer_id: ANSWER_ID }), error: null };
      return { data: null, error: null };
    });
    const forbidden = await unsolveQuestion({
      actorUserId: MODERATOR_ID,
      actorRole: "member",
      questionId: QUESTION_ID,
    });
    expect(forbidden).toEqual({ ok: false, error: "forbidden" });

    const ok = await unsolveQuestion({
      actorUserId: AUTHOR_ID,
      actorRole: "member",
      questionId: QUESTION_ID,
    });
    expect(ok.ok).toBe(true);
    const qUpdate = calls.find(
      (c) => c.table === "community_questions" && c.op === "update",
    );
    expect(qUpdate?.args[0]).toEqual({ status: "open", accepted_answer_id: null, solved_at: null });
  });

  it("close/reopen: moderator+ only, never a member", async () => {
    scriptedAdmin(async (table, op) => {
      if (table === "community_questions" && op === "maybeSingle")
        return { data: questionRow(), error: null };
      return { data: null, error: null };
    });
    const memberTry = await setQuestionClosed({
      actorUserId: AUTHOR_ID,
      actorRole: "member",
      questionId: QUESTION_ID,
      closed: true,
    });
    expect(memberTry).toEqual({ ok: false, error: "forbidden" });
    const modTry = await setQuestionClosed({
      actorUserId: MODERATOR_ID,
      actorRole: "moderator",
      questionId: QUESTION_ID,
      closed: true,
    });
    expect(modTry.ok).toBe(true);
    const reopen = await setQuestionClosed({
      actorUserId: ADMIN_ID,
      actorRole: "admin",
      questionId: QUESTION_ID,
      closed: false,
    });
    expect(reopen.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Pins
// ---------------------------------------------------------------------------

describe("Phase 5 pins", () => {
  function pinFixture(over: { messageRoom?: string } = {}) {
    return scriptedAdmin(async (table, op) => {
      if (table === "community_messages" && op === "maybeSingle")
        return {
          data: { id: MESSAGE_ID, room_id: over.messageRoom ?? ROOM_ID },
          error: null,
        };
      if (table === "community_pins" && op === "maybeSingle")
        return { data: null, error: null };
      return { data: null, error: null };
    });
  }

  it("pin: moderator+ only (member is refused before any write)", async () => {
    const { calls } = pinFixture();
    const res = await pinMessage({
      actorUserId: MODERATOR_ID,
      actorRole: "member",
      roomId: ROOM_ID,
      messageId: MESSAGE_ID,
    });
    expect(res).toEqual({ ok: false, error: "forbidden" });
    expect(calls.some((c) => c.table === "community_pins" && c.op === "insert")).toBe(false);
  });

  it("pin: moderator succeeds, room mismatch is not_found (room isolation)", async () => {
    const { calls } = pinFixture();
    const ok = await pinMessage({
      actorUserId: MODERATOR_ID,
      actorRole: "moderator",
      roomId: ROOM_ID,
      messageId: MESSAGE_ID,
    });
    expect(ok).toEqual({ ok: true });
    expect(calls.some((c) => c.table === "community_pins" && c.op === "insert")).toBe(true);
    const insert = calls.find((c) => c.table === "community_pins" && c.op === "insert");
    expect(insert?.args[0]).toEqual({ room_id: ROOM_ID, message_id: MESSAGE_ID, pinned_by: MODERATOR_ID });
    expect(calls.some((c) => c.table === "community_moderation_actions" && c.op === "insert")).toBe(true);

    const otherRoom = "b1000000-0000-4000-8000-000000000099";
    const crossRoom = await pinMessage({
      actorUserId: MODERATOR_ID,
      actorRole: "moderator",
      roomId: otherRoom,
      messageId: MESSAGE_ID,
    });
    expect(crossRoom).toEqual({ ok: false, error: "not_found" });
  });

  it("pin: duplicate → already_pinned (unique constraint)", async () => {
    scriptedAdmin(async (table, op) => {
      if (table === "community_messages" && op === "maybeSingle")
        return { data: { id: MESSAGE_ID, room_id: ROOM_ID }, error: null };
      if (table === "community_pins" && op === "maybeSingle")
        return { data: { id: "pin-1" }, error: null };
      return { data: null, error: null };
    });
    const res = await pinMessage({
      actorUserId: MODERATOR_ID,
      actorRole: "moderator",
      roomId: ROOM_ID,
      messageId: MESSAGE_ID,
    });
    expect(res).toEqual({ ok: false, error: "already_pinned" });
  });

  it("unpin: same permission contract, scoped by room + message", async () => {
    const denied = await (async () => {
      pinFixture();
      return await unpinMessage({
        actorUserId: MODERATOR_ID,
        actorRole: "helper",
        roomId: ROOM_ID,
        messageId: MESSAGE_ID,
      });
    })();
    expect(denied).toEqual({ ok: false, error: "forbidden" });

    const { calls } = pinFixture();
    const ok = await unpinMessage({
      actorUserId: MODERATOR_ID,
      actorRole: "moderator",
      roomId: ROOM_ID,
      messageId: MESSAGE_ID,
    });
    expect(ok.ok).toBe(true);
    const del = calls.find((c) => c.table === "community_pins" && c.op === "delete");
    expect(del).toBeDefined();
    expect(calls.some((c) => c.table === "community_moderation_actions" && c.op === "insert")).toBe(true);
  });

  it("broadcast payloads are metadata-only and strictly parsed", () => {
    expect(PIN_BROADCAST_EVENT).toBe("community_pin");
    expect(PIN_REMOVE_BROADCAST_EVENT).toBe("community_pin_removed");
    const good = { roomId: ROOM_ID, messageId: MESSAGE_ID };
    expect(parsePinBroadcast(good)).toEqual(good);
    expect(parsePinRemoveBroadcast(good)).toEqual(good);
    expect(parsePinBroadcast(null)).toBeNull();
    expect(parsePinBroadcast("x")).toBeNull();
    expect(parsePinBroadcast({ roomId: "nope", messageId: MESSAGE_ID })).toBeNull();
    expect(parsePinBroadcast({ roomId: ROOM_ID, messageId: "short" })).toBeNull();
    // extra (untrusted) fields are stripped — only the two ids survive
    expect(parsePinBroadcast({ roomId: ROOM_ID, messageId: MESSAGE_ID, content: "injected" })).toEqual(
      { roomId: ROOM_ID, messageId: MESSAGE_ID },
    );
    expect(parsePinRemoveBroadcast({ roomId: ROOM_ID })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

describe("Phase 5 reports", () => {
  function reportFixture(opts: { author?: string | null; exists?: boolean } = {}) {
    scriptedAdmin(async (table, op) => {
      if (table === "community_messages" && op === "maybeSingle")
        return {
          data: opts.exists === false ? null : { id: MESSAGE_ID, user_id: opts.author ?? ANSWERER_ID },
          error: null,
        };
      if (table === "community_questions" && op === "maybeSingle")
        return { data: { id: QUESTION_ID, author_id: opts.author ?? ANSWERER_ID }, error: null };
      if (table === "community_answers" && op === "maybeSingle")
        return { data: { id: ANSWER_ID, author_id: opts.author ?? ANSWERER_ID }, error: null };
      if (table === "community_profiles" && op === "maybeSingle")
        return { data: { id: "p-1", user_id: ANSWERER_ID }, error: null };
      return { data: null, error: null };
    });
  }

  it("accepts exactly the 9 backend reasons — and nothing else", () => {
    expect([...REPORT_REASONS].sort()).toEqual(
      [
        "harassment",
        "hate",
        "illegal_content",
        "impersonation",
        "misinformation",
        "other",
        "scam",
        "sexual_content",
        "spam",
      ].sort(),
    );
    expect(REPORT_REASONS).toHaveLength(9);
  });

  it("rejects an unknown reason / target type without any DB write", async () => {
    const { calls } = scriptedSession();
    const res = await createReport(await sessionClient(), AUTHOR_ID, {
      targetType: "message",
      targetId: MESSAGE_ID,
      reason: "trolling",
      details: "",
    });
    expect(res.ok).toBe(false);
    expect(calls.some((c) => c.op === "insert")).toBe(false);
  });

  it("rejects self-reports (authorship verified server-side)", async () => {
    reportFixture({ author: AUTHOR_ID });
    const res = await createReport(await sessionClient(), AUTHOR_ID, {
      targetType: "question",
      targetId: QUESTION_ID,
      reason: "spam",
    });
    expect(res).toEqual({ ok: false, error: "self_report" });
  });

  it("rejects missing targets", async () => {
    reportFixture({ exists: false });
    const res = await createReport(await sessionClient(), AUTHOR_ID, {
      targetType: "message",
      targetId: MESSAGE_ID,
      reason: "spam",
    });
    expect(res).toEqual({ ok: false, error: "target_not_found" });
  });

  it("inserts with the session reporter and maps the duplicate index (23505)", async () => {
    reportFixture();
    const { calls } = scriptedSession(async (table, op) => {
      if (table === "community_reports" && op === "single")
        return { data: { id: "r-1" }, error: { code: "23505", message: "duplicate" } };
      return { data: [], error: null };
    });
    const dup = await createReport(await sessionClient(), AUTHOR_ID, {
      targetType: "message",
      targetId: MESSAGE_ID,
      reason: "spam",
    });
    expect(dup).toEqual({ ok: false, error: "duplicate" });
    const insert = calls.find((c) => c.table === "community_reports" && c.op === "insert");
    expect(insert?.args[0]).toMatchObject({ reporter_id: AUTHOR_ID, target_type: "message", target_id: MESSAGE_ID, reason: "spam" });
  });

  it("all four target types are accepted (message/question/answer/profile)", async () => {
    for (const targetType of ["message", "question", "answer", "profile"] as const) {
      reportFixture();
      scriptedSession(async (table, op) => {
        if (table === "community_reports" && op === "single")
          return { data: { id: `r-${targetType}` }, error: null };
        return { data: [], error: null };
      });
      const res = await createReport(await sessionClient(), AUTHOR_ID, {
        targetType,
        targetId: targetType === "message" ? MESSAGE_ID : targetType === "question" ? QUESTION_ID : ANSWER_ID,
        reason: "harassment",
      });
      expect(res.ok, targetType).toBe(true);
    }
  });

  it("my-reports: the only user-facing read path is own-only + bounded", async () => {
    const rows = [
      {
        id: "r-1",
        reporter_id: AUTHOR_ID,
        target_type: "message",
        target_id: MESSAGE_ID,
        reason: "spam",
        details: null,
        status: "open",
        assigned_to: null,
        created_at: "2026-10-03T10:00:00Z",
        resolved_at: null,
      },
    ];
    const { calls } = scriptedSession(async (table) => {
      if (table === "community_reports") return { data: rows, error: null };
      return { data: [], error: null };
    });
    const mine = await fetchMyReports(await sessionClient(), AUTHOR_ID);
    expect(mine).toHaveLength(1);
    expect(mine[0].status).toBe("open");
    const eq = calls.find((c) => c.table === "community_reports" && c.op === "eq");
    expect(eq?.args).toEqual(["reporter_id", AUTHOR_ID]);
    const limit = calls.find((c) => c.table === "community_reports" && c.op === "limit");
    expect(limit?.args).toEqual([20]);
  });
});

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

describe("Phase 5 roles", () => {
  it("has a strict rank hierarchy", () => {
    expect(ROLE_RANK.member).toBeLessThan(ROLE_RANK.helper);
    expect(ROLE_RANK.helper).toBeLessThan(ROLE_RANK.moderator);
    expect(ROLE_RANK.moderator).toBeLessThan(ROLE_RANK.admin);
    expect(ROLE_RANK.admin).toBeLessThan(ROLE_RANK.owner);
    expect(isModerator("moderator")).toBe(true);
    expect(isModerator("admin")).toBe(true);
    expect(isModerator("owner")).toBe(true);
    expect(isModerator("member")).toBe(false);
    expect(isModerator("helper")).toBe(false);
  });

  it("viewer role degrades to member on any failure", async () => {
    scriptedSession(async () => {
      throw new Error("db down");
    });
    const res = await fetchViewerRole(await sessionClient(), AUTHOR_ID);
    expect(res).toBe("member");
  });

  function roleFixture(actorRole: string, targetRole: string) {
    let membershipQueries = 0;
    return scriptedAdmin(async (table, op) => {
      if (table === "community_memberships" && op === "maybeSingle") {
        // Promise.all order: 1st = the actor, 2nd = the target.
        const role = ++membershipQueries === 1 ? actorRole : targetRole;
        return { data: { user_id: "x", role }, error: null };
      }
      if (table === "community_profiles" && op === "maybeSingle")
        return { data: { user_id: ANSWERER_ID, display_name: "Target" }, error: null };
      return { data: null, error: null };
    });
  }

  it("setMemberRole: the actor role is RE-RESOLVED server-side (a member is refused)", async () => {
    const { calls } = roleFixture("member", "member");
    const res = await setMemberRole({ actorUserId: ADMIN_ID, targetUserId: ANSWERER_ID, role: "moderator" });
    expect(res).toEqual({ ok: false, error: "forbidden" });
    expect(calls.some((c) => c.op === "update")).toBe(false);
  });

  it("setMemberRole: an admin cannot mint an owner (rank_exceeded)", async () => {
    const { calls } = roleFixture("admin", "member");
    const res = await setMemberRole({ actorUserId: ADMIN_ID, targetUserId: ANSWERER_ID, role: "owner" });
    expect(res).toEqual({ ok: false, error: "rank_exceeded" });
    expect(calls.some((c) => c.op === "update")).toBe(false);
  });

  it("setMemberRole: an admin cannot demote the OWNER (hierarchy guard)", async () => {
    const { calls } = roleFixture("admin", "owner");
    const res = await setMemberRole({ actorUserId: ADMIN_ID, targetUserId: ANSWERER_ID, role: "member" });
    expect(res).toEqual({ ok: false, error: "rank_exceeded" });
    expect(calls.some((c) => c.op === "update")).toBe(false);
  });

  it("setMemberRole: self-role changes are impossible", async () => {
    const { calls } = scriptedAdmin(async (table, op) => {
      if (table === "community_memberships" && op === "maybeSingle")
        return { data: { user_id: OWNER_ID, role: "owner" }, error: null };
      if (table === "community_profiles" && op === "maybeSingle")
        return { data: { user_id: OWNER_ID }, error: null };
      return { data: null, error: null };
    });
    const res = await setMemberRole({ actorUserId: OWNER_ID, targetUserId: OWNER_ID, role: "member" });
    expect(res).toEqual({ ok: false, error: "self_role" });
    expect(calls.some((c) => c.op === "update")).toBe(false);
  });

  it("setMemberRole: an invalid role string is refused", async () => {
    const res = await setMemberRole({ actorUserId: OWNER_ID, targetUserId: ANSWERER_ID, role: "superadmin" });
    expect(res).toEqual({ ok: false, error: "invalid_role" });
  });

  it("setMemberRole: a legal grant updates + audits", async () => {
    const { calls } = roleFixture("owner", "member");
    const res = await setMemberRole({ actorUserId: OWNER_ID, targetUserId: ANSWERER_ID, role: "moderator" });
    expect(res.ok).toBe(true);
    const update = calls.find((c) => c.table === "community_memberships" && c.op === "update");
    expect(update?.args[0]).toEqual({ role: "moderator" });
    expect(calls.some((c) => c.table === "community_moderation_actions" && c.op === "insert")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Moderation
// ---------------------------------------------------------------------------

describe("Phase 5 moderation", () => {
  it("timeout durations are the fixed set (1h/24h/7d)", () => {
    expect(Object.keys(TIMEOUT_DURATIONS).sort()).toEqual(["1h", "24h", "7d"]);
    expect(TIMEOUT_DURATIONS["24h"]).toBe(24 * 60 * 60 * 1000);
    expect(TIMEOUT_DURATIONS["7d"]).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it("queue + counts degrade safely (unavailable / null)", async () => {
    // total DB failure: the RPC errors and every table read throws.
    vi.mocked(createAdminClient).mockReturnValue({
      rpc: () => Promise.resolve({ data: null, error: { message: "down" } }),
      from: () => {
        throw new Error("down");
      },
      storage: { from: () => ({ remove: async () => undefined }) },
    } as never);
    const queue = await fetchReportQueue({ status: "open", limit: 20 });
    expect(queue).toEqual({ items: [], cursor: null, unavailable: true });
    const counts = await fetchReportCounts();
    expect(counts).toBeNull();
  });

  it("unpin executor: deletes the pin row + audits", async () => {
    const { calls } = scriptedAdmin(async () => ({ data: null, error: null }));
    const res = await performModerationAction({
      actorId: MODERATOR_ID,
      action: "unpin",
      targetType: "message",
      targetId: MESSAGE_ID,
    });
    expect(res.ok).toBe(true);
    expect(calls.some((c) => c.table === "community_pins" && c.op === "delete")).toBe(true);
    const audit = calls.find((c) => c.table === "community_moderation_actions" && c.op === "insert");
    expect(audit?.args[0]).toMatchObject({ moderator_id: MODERATOR_ID, action: "unpin", target_type: "message" });
  });

  it("remove_answer: soft-delete + cascade the solved state + audit", async () => {
    const { calls } = scriptedAdmin(async (table, op) => {
      if (table === "community_answers" && op === "maybeSingle")
        return { data: { id: ANSWER_ID, question_id: QUESTION_ID, accepted: true }, error: null };
      return { data: null, error: null };
    });
    const res = await performModerationAction({
      actorId: MODERATOR_ID,
      action: "remove_answer",
      targetType: "answer",
      targetId: ANSWER_ID,
    });
    expect(res.ok).toBe(true);
    expect(calls.some((c) => c.table === "community_answers" && c.op === "update")).toBe(true);
    const qUpdate = calls.find((c) => c.table === "community_questions" && c.op === "update");
    expect(qUpdate?.args[0]).toEqual({ status: "open", accepted_answer_id: null, solved_at: null });
  });

  it("action/target type mismatches are refused", async () => {
    scriptedAdmin(async () => ({ data: null, error: null }));
    const res = await performModerationAction({
      actorId: MODERATOR_ID,
      action: "remove_answer",
      targetType: "message", // wrong target type
      targetId: MESSAGE_ID,
    });
    expect(res).toEqual({ ok: false, error: "failed" });
  });

  it("report status transitions record the actor + audit (resolved_at set)", async () => {
    const { calls } = scriptedAdmin(async (table, op) => {
      if (table === "community_reports" && op === "select")
        return {
          data: [{ id: "rep-1", target_type: "message", target_id: MESSAGE_ID }],
          error: null,
        };
      return { data: null, error: null };
    });
    const res = await setReportStatus({ actorId: MODERATOR_ID, reportId: "rep-1", status: "resolved" });
    expect(res.ok).toBe(true);
    const update = calls.find((c) => c.table === "community_reports" && c.op === "update");
    expect(update?.args[0]).toMatchObject({ status: "resolved" });
    expect(typeof (update?.args[0] as Record<string, unknown>).resolved_at).toBe("string");
    expect(calls.some((c) => c.table === "community_moderation_actions" && c.op === "insert")).toBe(true);
  });

  it("audit log reads are bounded (30) and degraded-safe", async () => {
    scriptedAdmin(async () => ({ data: [], error: null }));
    const rows = await fetchModerationAudit(30);
    expect(rows).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Reputation
// ---------------------------------------------------------------------------

describe("Phase 5 reputation", () => {
  it("aggregates points + bounded counts (four parallel reads, no N+1)", async () => {
    const { calls } = scriptedSession(async (table) => {
      if (table === "community_reputation_events")
        return { data: [{ points: 5 }, { points: 2 }, { points: 5 }], error: null };
      if (table === "community_questions") return { data: [], error: null, count: 4 };
      if (table === "community_answers")
        return { data: null, error: null, count: 7 };
      return { data: [], error: null };
    });
    const summary = await fetchReputationSummary(await sessionClient(), AUTHOR_ID);
    expect(summary).toEqual({ reputation: 12, questions: 4, answers: 7, accepted: 7 });
    // Two bounded answer-count queries (all + accepted), one questions, one events.
    expect(calls.filter((c) => c.table === "community_answers" && c.op === "select")).toHaveLength(2);
    expect(calls.filter((c) => c.table === "community_questions" && c.op === "select")).toHaveLength(1);
    // Every eq scope on the count queries is the viewer's user (no cross-user leak).
    const scopes = calls.filter(
      (c) =>
        (c.table === "community_answers" || c.table === "community_questions") &&
        c.op === "eq" &&
        c.args[0] === "author_id",
    );
    expect(scopes.length).toBeGreaterThanOrEqual(3);
    for (const c of scopes) {
      expect(c.args[1]).toBe(AUTHOR_ID);
    }
  });

  it("degrades to zeros on failure (stats are chrome)", async () => {
    scriptedSession(async () => {
      throw new Error("down");
    });
    const summary = await fetchReputationSummary(await sessionClient(), AUTHOR_ID);
    expect(summary).toEqual(EMPTY_REPUTATION);
  });
});

// ---------------------------------------------------------------------------
// Search (server lib)
// ---------------------------------------------------------------------------

describe("Phase 5 search", () => {
  it("maps rows + answer deep-link ids", async () => {
    vi.mocked(createAdminClient).mockReturnValue({
      rpc: () =>
        Promise.resolve({
          data: [
            {
              kind: "answer",
              id: ANSWER_ID,
              room_id: ROOM_ID,
              room_slug: "fragen-und-antworten",
              room_name: "Fragen & Antworten",
              author_id: ANSWERER_ID,
              author_name: "Anna",
              content: "preview",
              created_at: "2026-10-02T10:00:00Z",
              question_id: QUESTION_ID,
            },
          ],
          error: null,
        }),
    } as never);
    const res = await runCommunitySearch({ userId: AUTHOR_ID, query: "visum" });
    expect(res.unavailable).toBe(false);
    expect(res.items).toHaveLength(1);
    expect(res.items[0]).toMatchObject({
      kind: "answer",
      id: ANSWER_ID,
      questionId: QUESTION_ID,
      roomSlug: "fragen-und-antworten",
    });
  });

  it("admin failure degrades to unavailable (empty items)", async () => {
    vi.mocked(createAdminClient).mockReturnValue({
      rpc: () => Promise.resolve({ data: null, error: { message: "down" } }),
    } as never);
    const res = await runCommunitySearch({ userId: AUTHOR_ID, query: "visum" });
    expect(res).toMatchObject({ items: [], unavailable: true });
  });
});
