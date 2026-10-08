import { NextResponse } from "next/server";
import { getCurrentUserAndProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import {
  checkRateLimit,
  rateLimitHeaders,
  tooManyRequests,
} from "@/lib/rate-limit";
import { fetchCommunityWriteGate } from "@/lib/community/roles";
import { createAnswer, fetchQuestionDetail } from "@/lib/community/qa";

/**
 * POST /api/community/questions/:questionId/answers — answer a question.
 *
 * JSON body: { body: string }. Authorization chain: session user → write
 * gate (suspended/muted) → question exists (RLS-scoped read) → not closed →
 * RLS insert policy (authorship + open status re-check in the DB).
 * The question author is notified via the existing notification system
 * (never self-notified). Rate limit: community_answer (20/min).
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET /api/community/questions/:questionId/answers — the question's current
 * status + ALL answers (the SAME bounded queries the detail page renders:
 * ≤200 answers, RLS-scoped visibility). The question detail polls this every
 * 1s while mounted (`?poll=1` → the higher community_poll bucket, 240/min);
 * auth is IDENTICAL to a page visit, so a poll can never read more.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ questionId: string }> },
) {
  const { user, profile } = await getCurrentUserAndProfile();
  if (!user || !profile || profile.account_status !== "active") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const questionId = (await params).questionId;
  if (!UUID.test(questionId)) {
    return NextResponse.json({ error: "question_not_found" }, { status: 400 });
  }

  const isPoll = new URL(request.url).searchParams.get("poll") === "1";
  const limited = await checkRateLimit(
    isPoll ? "community_poll" : "community_profile",
    user.id,
  );
  if (!limited.allowed) return tooManyRequests(limited);

  try {
    const supabase = await createClient();
    // Community identity for the "own answer" flag (the page does the same).
    const { data: communityProfile } = await supabase
      .from("community_profiles")
      .select("display_name,avatar_id")
      .eq("user_id", user.id)
      .maybeSingle();
    const detail = await fetchQuestionDetail(supabase, questionId, {
      id: user.id,
      displayName: communityProfile?.display_name ?? "",
      avatarId: communityProfile?.avatar_id ?? "",
    });
    if (!detail) {
      return NextResponse.json({ error: "question_not_found" }, { status: 404 });
    }
    return NextResponse.json(
      {
        status: detail.question.status,
        acceptedAnswerId: detail.question.accepted_answer_id,
        answers: detail.answers.map((a) => ({
          id: a.id,
          body: a.body,
          accepted: a.accepted,
          createdAt: a.created_at,
          authorName: a.author?.display_name ?? null,
          authorId: a.author_id,
          authorIsAdmin: a.author?.platform_admin === true,
        })),
      },
      { headers: rateLimitHeaders(limited) },
    );
  } catch (error) {
    console.error("[community] answers read threw:", error);
    return NextResponse.json({ error: "Could not load answers." }, { status: 500 });
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ questionId: string }> },
) {
  const { user } = await getCurrentUserAndProfile();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const questionId = (await params).questionId;
  if (!UUID.test(questionId)) {
    return NextResponse.json({ error: "question_not_found" }, { status: 400 });
  }

  const limited = await checkRateLimit("community_answer", user.id);
  if (!limited.allowed) return tooManyRequests(limited);

  let bodyText: string;
  try {
    const json = (await request.json()) as { body?: unknown };
    if (typeof json.body !== "string") throw new Error("missing body");
    bodyText = json.body;
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const gate = await fetchCommunityWriteGate(user.id);
  if (!gate.writable) {
    return NextResponse.json({ error: gate.code }, { status: 403 });
  }

  const supabase = await createClient();
  const { data: qRow, error: qErr } = await supabase
    .from("community_questions")
    .select("id,room_id,author_id,title,body,tags,image_path,status,accepted_answer_id,solved_at,created_at,updated_at")
    .eq("id", questionId)
    .maybeSingle();
  if (qErr || !qRow) {
    return NextResponse.json({ error: "question_not_found" }, { status: 404 });
  }
  const question = qRow as {
    id: string;
    room_id: string;
    author_id: string;
    title: string;
    body: string;
    tags: string[];
    image_path: string | null;
    status: "open" | "solved" | "closed";
    accepted_answer_id: string | null;
    solved_at: string | null;
    created_at: string;
    updated_at: string;
  };

  const { data: roomRow } = await supabase
    .from("community_rooms")
    .select("id,slug,name,category_id,description,icon,position,enabled,qna_enabled")
    .eq("id", question.room_id)
    .maybeSingle();

  const result = await createAnswer(supabase, { id: user.id }, {
    question,
    room: roomRow ?? null,
    body: bodyText,
  });
  if (!result.ok) {
    switch (result.error) {
      case "question_not_found":
        return NextResponse.json({ error: "question_not_found" }, { status: 404 });
      case "closed":
        return NextResponse.json({ error: "question_closed" }, { status: 409 });
      case "invalid":
        return NextResponse.json({ error: "invalid" }, { status: 400 });
      default:
        return NextResponse.json({ error: "answer_failed" }, { status: 500 });
    }
  }
  return NextResponse.json(
    { answer: result.answer },
    { status: 201, headers: rateLimitHeaders(limited) },
  );
}
