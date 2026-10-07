import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import type { CommunityRoom } from "@/lib/community";
import { createSocialNotification, socialSendKey } from "@/lib/community/social";
import type { CommunityRole } from "@/lib/community/roles";
import { isModerator } from "@/lib/community/roles";

/**
 * Community Phase 5 — Q&A (questions + answers + accepted/solved).
 *
 * Security model (mirrors the rest of the community):
 *   * READS run on the session client → the v6 RLS policies apply
 *     (enabled rooms, blocked authors in EITHER direction, removed
 *     answers invisible).
 *   * USER WRITES (create question / answer) run on the session client:
 *     RLS enforces authorship + qna_enabled + status independently of
 *     this module (defense in depth).
 *   * STATE TRANSITIONS (accept / unsolve / close / reopen) run on the
 *     ADMIN client after a server-side role + authorship check — the DB
 *     has NO user update policies on these tables at all.
 *   * Reputation + notifications are generated HERE, server-side, with
 *     fixed point values and deterministic send keys (idempotent).
 */

type SessionClient = Awaited<ReturnType<typeof createClient>>;

export type QuestionStatus = "open" | "solved" | "closed";

export interface CommunityQuestionRow {
  id: string;
  room_id: string;
  author_id: string;
  title: string;
  body: string;
  tags: string[];
  image_path: string | null;
  status: QuestionStatus;
  accepted_answer_id: string | null;
  solved_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CommunityAnswerRow {
  id: string;
  question_id: string;
  author_id: string;
  body: string;
  accepted: boolean;
  /** Moderation removal (soft delete); removed answers are RLS-invisible. */
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CommunityAuthorLite {
  user_id: string;
  display_name: string;
  avatar_id: string;
}

export interface QuestionListItem extends CommunityQuestionRow {
  author: CommunityAuthorLite | null;
  room: CommunityRoom | null;
  answerCount: number;
}

export interface QuestionDetail {
  question: CommunityQuestionRow;
  author: CommunityAuthorLite | null;
  room: CommunityRoom | null;
  answers: Array<CommunityAnswerRow & { author: CommunityAuthorLite | null }>;
}

const QUESTION_SELECT =
  "id,room_id,author_id,title,body,tags,image_path,status,accepted_answer_id,solved_at,created_at,updated_at";
const ANSWER_SELECT =
  "id,question_id,author_id,body,accepted,deleted_at,created_at,updated_at";
const AUTHOR_SELECT = "user_id,display_name,avatar_id";
const ROOM_SELECT = "id,slug,name,category_id,description,icon,position,enabled,qna_enabled";

function authorsById(rows: CommunityAuthorLite[], mine: { id: string; author: CommunityAuthorLite } | null): Record<string, CommunityAuthorLite> {
  const map: Record<string, CommunityAuthorLite> = {};
  for (const a of rows) map[a.user_id] = a;
  if (mine) map[mine.id] = mine.author;
  return map;
}

// ---------------------------------------------------------------------------
// Reads (session client, RLS-scoped)
// ---------------------------------------------------------------------------

/**
 * One question with its room, author and ALL answers (bounded to 200 —
 * a question with more answers is a degenerate case the page still
 * renders, newest-first within the bound). Never throws.
 */
export async function fetchQuestionDetail(
  supabase: SessionClient,
  questionId: string,
  me: { id: string; displayName: string; avatarId: string },
): Promise<QuestionDetail | null> {
  try {
    const { data: qRow, error: qErr } = await supabase
      .from("community_questions")
      .select(QUESTION_SELECT)
      .eq("id", questionId)
      .maybeSingle();
    if (qErr || !qRow) return null;
    const question = qRow as CommunityQuestionRow;

    const [answersRes, roomRes, authorRes] = await Promise.all([
      supabase
        .from("community_answers")
        .select(ANSWER_SELECT)
        .eq("question_id", questionId)
        .order("created_at", { ascending: true })
        .limit(200),
      supabase
        .from("community_rooms")
        .select(ROOM_SELECT)
        .eq("id", question.room_id)
        .maybeSingle(),
      supabase
        .from("community_profiles")
        .select(AUTHOR_SELECT)
        .eq("user_id", question.author_id)
        .maybeSingle(),
    ]);
    if (answersRes.error) return null;
    const answers = ((answersRes.data ?? []) as CommunityAnswerRow[]);
    const answerAuthorIds = [...new Set(answers.map((a) => a.author_id))];
    let answerAuthors: CommunityAuthorLite[] = [];
    if (answerAuthorIds.length > 0) {
      const { data, error: authorsErr } = await supabase
        .from("community_profiles")
        .select(AUTHOR_SELECT)
        .in("user_id", answerAuthorIds);
      if (authorsErr) return null;
      answerAuthors = (data ?? []) as CommunityAuthorLite[];
    }
    const authorMap = authorsById(
      answerAuthors,
      answers.some((a) => a.author_id === me.id)
        ? { id: me.id, author: { user_id: me.id, display_name: me.displayName, avatar_id: me.avatarId } }
        : null,
    );
    const questionAuthor = (authorRes.data as CommunityAuthorLite | null) ??
      (question.author_id === me.id
        ? { user_id: me.id, display_name: me.displayName, avatar_id: me.avatarId }
        : null);
    return {
      question,
      author: questionAuthor,
      room: (roomRes.data as CommunityRoom | null) ?? null,
      answers: answers
        .map((a) => ({ ...a, author: authorMap[a.author_id] ?? null }))
        .sort((a, b) => {
          // The accepted answer floats to the top, then chronology.
          if (a.accepted !== b.accepted) return a.accepted ? -1 : 1;
          return a.created_at.localeCompare(b.created_at);
        }),
    };
  } catch (error) {
    console.error("[community] question detail threw:", error);
    return null;
  }
}

/**
 * A room's question list (the "Fragen" view) — keyset-ish cursor on
 * created_at, bounded page (20), answer counts batched in one query.
 */
export async function fetchRoomQuestions(
  supabase: SessionClient,
  roomId: string,
  me: { id: string; displayName: string; avatarId: string },
  opts: { beforeAt?: string | null; limit?: number; status?: QuestionStatus | null } = {},
): Promise<{ items: QuestionListItem[]; unavailable: boolean }> {
  const fail = { items: [] as QuestionListItem[], unavailable: true };
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 50);
  try {
    let query = supabase
      .from("community_questions")
      .select(QUESTION_SELECT)
      .eq("room_id", roomId)
      .order("created_at", { ascending: false })
      .limit(limit);
    if (opts.beforeAt) query = query.lt("created_at", opts.beforeAt);
    if (opts.status) query = query.eq("status", opts.status);
    const { data: qRows, error } = await query;
    if (error) return fail;
    const questions = (qRows ?? []) as CommunityQuestionRow[];
    if (questions.length === 0) return { items: [], unavailable: false };

    const ids = questions.map((q) => q.id);
    const authorIds = [...new Set(questions.map((q) => q.author_id))];
    const [authorsRes, roomRes, answerCountsRes] = await Promise.all([
      supabase.from("community_profiles").select(AUTHOR_SELECT).in("user_id", authorIds),
      supabase.from("community_rooms").select(ROOM_SELECT).eq("id", roomId).maybeSingle(),
      supabase
        .from("community_answers")
        .select("question_id")
        .in("question_id", ids)
        .limit(5000),
    ]);
    const counts = new Map<string, number>();
    for (const row of (answerCountsRes.data ?? []) as Array<{ question_id: string }>) {
      counts.set(row.question_id, (counts.get(row.question_id) ?? 0) + 1);
    }
    const authorMap = authorsById(
      (authorsRes.data ?? []) as CommunityAuthorLite[],
      authorIds.includes(me.id)
        ? { id: me.id, author: { user_id: me.id, display_name: me.displayName, avatar_id: me.avatarId } }
        : null,
    );
    const room = (roomRes.data as CommunityRoom | null) ?? null;
    return {
      items: questions.map((q) => ({
        ...q,
        author: authorMap[q.author_id] ?? null,
        room,
        answerCount: counts.get(q.id) ?? 0,
      })),
      unavailable: false,
    };
  } catch (error) {
    console.error("[community] room questions threw:", error);
    return fail;
  }
}

/**
 * The home's question strips: latest (6), unanswered (4 of the latest
 * open ones), recently solved (3). Bounded queries only — the home stays
 * light by design.
 */
export async function fetchHomeQuestionFeeds(
  supabase: SessionClient,
  me: { id: string; displayName: string; avatarId: string },
): Promise<{
  recent: QuestionListItem[];
  unanswered: QuestionListItem[];
  solved: QuestionListItem[];
}> {
  const empty = { recent: [] as QuestionListItem[], unanswered: [] as QuestionListItem[], solved: [] as QuestionListItem[] };
  try {
    const [recentRes, solvedRes] = await Promise.all([
      supabase
        .from("community_questions")
        .select(QUESTION_SELECT)
        .order("created_at", { ascending: false })
        .limit(10),
      supabase
        .from("community_questions")
        .select(QUESTION_SELECT)
        .eq("status", "solved")
        .not("solved_at", "is", null)
        .order("solved_at", { ascending: false })
        .limit(3),
    ]);
    if (recentRes.error && solvedRes.error) return empty;
    const recentRows = (recentRes.data ?? []) as CommunityQuestionRow[];
    const solvedRows = (solvedRes.data ?? []) as CommunityQuestionRow[];
    const allRows = [...recentRows, ...solvedRows.filter((s) => !recentRows.some((r) => r.id === s.id))];
    if (allRows.length === 0) return empty;

    const ids = allRows.map((q) => q.id);
    const roomIds = [...new Set(allRows.map((q) => q.room_id))];
    const authorIds = [...new Set(allRows.map((q) => q.author_id))];
    const [countsRes, roomsRes, authorsRes] = await Promise.all([
      supabase.from("community_answers").select("question_id").in("question_id", ids).limit(10000),
      supabase.from("community_rooms").select(ROOM_SELECT).in("id", roomIds).limit(100),
      supabase.from("community_profiles").select(AUTHOR_SELECT).in("user_id", authorIds).limit(100),
    ]);
    const counts = new Map<string, number>();
    for (const row of (countsRes.data ?? []) as Array<{ question_id: string }>) {
      counts.set(row.question_id, (counts.get(row.question_id) ?? 0) + 1);
    }
    const roomMap = new Map(
      ((roomsRes.data ?? []) as CommunityRoom[]).map((r) => [r.id, r]),
    );
    const authorMap = authorsById(
      (authorsRes.data ?? []) as CommunityAuthorLite[],
      authorIds.includes(me.id)
        ? { id: me.id, author: { user_id: me.id, display_name: me.displayName, avatar_id: me.avatarId } }
        : null,
    );
    const toItem = (q: CommunityQuestionRow): QuestionListItem => ({
      ...q,
      author: authorMap[q.author_id] ?? null,
      room: roomMap.get(q.room_id) ?? null,
      answerCount: counts.get(q.id) ?? 0,
    });
    const recent = recentRows.slice(0, 6).map(toItem);
    const answeredIds = new Set(recentRows.filter((r) => (counts.get(r.id) ?? 0) > 0).map((r) => r.id));
    const unanswered = recentRows
      .filter((r) => r.status === "open" && !answeredIds.has(r.id))
      .slice(0, 4)
      .map(toItem);
    return { recent, unanswered, solved: solvedRows.map(toItem) };
  } catch (error) {
    console.error("[community] home question feeds threw:", error);
    return empty;
  }
}

// ---------------------------------------------------------------------------
// User writes (session client — RLS is the second line of defense)
// ---------------------------------------------------------------------------

export type QuestionCreateError =
  | "forbidden"
  | "room_not_found"
  | "qna_disabled"
  | "invalid"
  | "failed";

export const QUESTION_TITLE_MIN = 10;
export const QUESTION_TITLE_MAX = 120;
export const QUESTION_BODY_MIN = 30;
export const QUESTION_BODY_MAX = 4000;
export const ANSWER_MIN = 10;
export const ANSWER_MAX = 4000;

/** Parse + validate the tags input (comma-separated, ≤5, 1–24 chars each). */
export function parseQuestionTags(raw: string): string[] | null {
  const tags = raw
    .split(",")
    .map((t) => t.trim().toLowerCase().replace(/\s+/g, "-"))
    .filter((t) => t.length > 0)
    .slice(0, 5);
  if (tags.length > 5) return null;
  if (tags.some((t) => t.length < 1 || t.length > 24)) return null;
  return [...new Set(tags)];
}

/**
 * Create a question. The room must exist, be enabled and have Q&A mode ON;
 * the caller must pass a writable gate (suspended/muted check done by the
 * route). The INSERT goes through the SESSION client — RLS independently
 * re-checks authorship + qna_enabled.
 */
export async function createQuestion(
  supabase: SessionClient,
  me: { id: string },
  input: {
    roomId: string;
    room: CommunityRoom | null;
    title: string;
    body: string;
    tags: string[];
    imagePath?: string | null;
  },
): Promise<{ ok: true; question: CommunityQuestionRow } | { ok: false; error: QuestionCreateError }> {
  const title = input.title.trim();
  const body = input.body.trim();
  if (title.length < QUESTION_TITLE_MIN || title.length > QUESTION_TITLE_MAX) {
    return { ok: false, error: "invalid" };
  }
  if (body.length < QUESTION_BODY_MIN || body.length > QUESTION_BODY_MAX) {
    return { ok: false, error: "invalid" };
  }
  if (!input.room) return { ok: false, error: "room_not_found" };
  if (!input.room.qna_enabled) return { ok: false, error: "qna_disabled" };

  const { data, error } = await supabase
    .from("community_questions")
    .insert({
      room_id: input.roomId,
      author_id: me.id,
      title,
      body,
      tags: input.tags,
      image_path: input.imagePath ?? null,
    })
    .select(QUESTION_SELECT)
    .single();
  if (error) {
    console.error("[community] create question failed:", error.message);
    return { ok: false, error: "failed" };
  }
  return { ok: true, question: data as CommunityQuestionRow };
}

export type AnswerCreateError = "forbidden" | "question_not_found" | "closed" | "invalid" | "failed";

/** Create an answer (session-client insert; RLS re-checks the invariants). */
export async function createAnswer(
  supabase: SessionClient,
  me: { id: string },
  input: { question: CommunityQuestionRow; room: CommunityRoom | null; body: string },
): Promise<{ ok: true; answer: CommunityAnswerRow } | { ok: false; error: AnswerCreateError }> {
  const body = input.body.trim();
  if (body.length < ANSWER_MIN || body.length > ANSWER_MAX) {
    return { ok: false, error: "invalid" };
  }
  if (!input.question) return { ok: false, error: "question_not_found" };
  if (!input.room) return { ok: false, error: "question_not_found" };
  if (input.question.status === "closed") return { ok: false, error: "closed" };

  const { data, error } = await supabase
    .from("community_answers")
    .insert({
      question_id: input.question.id,
      author_id: me.id,
      body,
    })
    .select(ANSWER_SELECT)
    .single();
  if (error) {
    console.error("[community] create answer failed:", error.message);
    return { ok: false, error: "failed" };
  }
  // Notify the question author (never self — createSocialNotification
  // suppresses it server-side too).
  if (input.question.author_id !== me.id) {
    void createSocialNotification({
      targetUserId: input.question.author_id,
      actorUserId: me.id,
      title: "answer",
      content: input.question.title,
      roomId: input.question.room_id,
      sendKey: socialSendKey(`answer:${input.question.author_id}`, data.id),
      questionId: input.question.id,
      answerId: data.id,
    });
  }
  return { ok: true, answer: data as CommunityAnswerRow };
}

// ---------------------------------------------------------------------------
// State transitions (admin client, server-authorized)
// ---------------------------------------------------------------------------

export type AcceptError =
  | "forbidden"
  | "not_found"
  | "already_accepted"
  | "failed";

/**
 * Mark ONE answer as the accepted solution:
 *   1. re-resolve the actor's role + the question/answer server-side,
 *   2. authorize: the QUESTION AUTHOR or a moderator+,
 *   3. clear any previous acceptance (the partial-unique index keeps the
 *      "exactly one" invariant at the DB level),
 *   4. set the question solved (status + accepted_answer_id + solved_at),
 *   5. award reputation (fixed points; NEVER when the answer author is
 *      the question author — self-awarding is structurally impossible),
 *   6. notify the answer author.
 */
export async function acceptAnswer(input: {
  actorUserId: string;
  actorRole: CommunityRole;
  questionId: string;
  answerId: string;
}): Promise<{ ok: true; question: CommunityQuestionRow } | { ok: false; error: AcceptError }> {
  const { actorUserId, actorRole, questionId, answerId } = input;
  try {
    const admin = createAdminClient();
    const [qRes, aRes] = await Promise.all([
      admin.from("community_questions").select(QUESTION_SELECT).eq("id", questionId).maybeSingle(),
      admin.from("community_answers").select(ANSWER_SELECT).eq("id", answerId).maybeSingle(),
    ]);
    const question = (qRes.data ?? null) as CommunityQuestionRow | null;
    const answer = (aRes.data ?? null) as CommunityAnswerRow | null;
    if (!question || !answer || answer.question_id !== questionId) {
      return { ok: false, error: "not_found" };
    }
    if (question.accepted_answer_id === answerId && question.status === "solved") {
      return { ok: false, error: "already_accepted" };
    }
    // Authorize: question author or moderator+.
    if (question.author_id !== actorUserId && !isModerator(actorRole)) {
      return { ok: false, error: "forbidden" };
    }
    if (answer.deleted_at !== null) return { ok: false, error: "not_found" };

    // 3+4: converge the acceptance state in order (clear, then set).
    const { error: clearErr } = await admin
      .from("community_answers")
      .update({ accepted: false })
      .eq("question_id", questionId);
    if (clearErr) return { ok: false, error: "failed" };
    const { error: setErr } = await admin
      .from("community_answers")
      .update({ accepted: true })
      .eq("id", answerId);
    if (setErr) return { ok: false, error: "failed" };
    const { data: updatedQ, error: qErr } = await admin
      .from("community_questions")
      .update({ status: "solved", accepted_answer_id: answerId, solved_at: new Date().toISOString() })
      .eq("id", questionId)
      .select(QUESTION_SELECT)
      .single();
    if (qErr || !updatedQ) return { ok: false, error: "failed" };

    // 5: reputation — fixed points, idempotent (unique event key), and
    //    NEVER awarded when the answer author is the question author
    //    (self-awarding), regardless of who performed the acceptance.
    const selfAnswer = answer.author_id === question.author_id;
    if (!selfAnswer) {
      await admin
        .from("community_reputation_events")
        .upsert(
          [
            {
              user_id: answer.author_id,
              actor_id: actorUserId,
              event_type: "answer_accepted",
              entity_type: "answer",
              entity_id: answerId,
              points: 5,
            },
            {
              user_id: question.author_id,
              actor_id: actorUserId,
              event_type: "question_solved",
              entity_type: "question",
              entity_id: questionId,
              points: 2,
            },
          ],
          { onConflict: "event_type,entity_type,entity_id,user_id", ignoreDuplicates: true },
        );
    }

    // 6: notify the answer author (suppressed for self answers + blocked
    //    parties inside createSocialNotification).
    if (!selfAnswer) {
      void createSocialNotification({
        targetUserId: answer.author_id,
        actorUserId,
        title: "answer_accepted",
        content: question.title,
        roomId: question.room_id,
        sendKey: socialSendKey(`answer_accepted:${answer.author_id}`, answerId),
        questionId: questionId,
        answerId,
      });
    }
    return { ok: true, question: updatedQ as CommunityQuestionRow };
  } catch (error) {
    console.error("[community] accept answer threw:", error);
    return { ok: false, error: "failed" };
  }
}

/**
 * Unsolve (author or moderator): clear the acceptance, back to 'open'.
 * Reputation already awarded stays (documented product decision).
 */
export async function unsolveQuestion(input: {
  actorUserId: string;
  actorRole: CommunityRole;
  questionId: string;
}): Promise<{ ok: true } | { ok: false; error: AcceptError }> {
  const { actorUserId, actorRole, questionId } = input;
  try {
    const admin = createAdminClient();
    const { data: qRow, error: qErr } = await admin
      .from("community_questions")
      .select(QUESTION_SELECT)
      .eq("id", questionId)
      .maybeSingle();
    if (qErr || !qRow) return { ok: false, error: "not_found" };
    const question = qRow as CommunityQuestionRow;
    if (question.author_id !== actorUserId && !isModerator(actorRole)) {
      return { ok: false, error: "forbidden" };
    }
    const { error: clearErr } = await admin
      .from("community_answers")
      .update({ accepted: false })
      .eq("question_id", questionId);
    if (clearErr) return { ok: false, error: "failed" };
    const { error } = await admin
      .from("community_questions")
      .update({ status: "open", accepted_answer_id: null, solved_at: null })
      .eq("id", questionId);
    if (error) return { ok: false, error: "failed" };
    return { ok: true };
  } catch (error) {
    console.error("[community] unsolve threw:", error);
    return { ok: false, error: "failed" };
  }
}

/** Close / reopen a question — moderator+ only (server-authorized). */
export async function setQuestionClosed(input: {
  actorUserId: string;
  actorRole: CommunityRole;
  questionId: string;
  closed: boolean;
}): Promise<{ ok: true } | { ok: false; error: AcceptError }> {
  const { actorRole, questionId, closed } = input;
  if (!isModerator(actorRole)) return { ok: false, error: "forbidden" };
  try {
    const admin = createAdminClient();
    const { data: qRow, error: qErr } = await admin
      .from("community_questions")
      .select(QUESTION_SELECT)
      .eq("id", questionId)
      .maybeSingle();
    if (qErr || !qRow) return { ok: false, error: "not_found" };
    const { error } = await admin
      .from("community_questions")
      .update({
        status: closed ? "closed" : "open",
        ...(closed
          ? { accepted_answer_id: null }
          : {}),
      })
      .eq("id", questionId);
    if (error) return { ok: false, error: "failed" };
    if (closed) {
      await admin.from("community_answers").update({ accepted: false }).eq("question_id", questionId);
    }
    return { ok: true };
  } catch (error) {
    console.error("[community] close question threw:", error);
    return { ok: false, error: "failed" };
  }
}
