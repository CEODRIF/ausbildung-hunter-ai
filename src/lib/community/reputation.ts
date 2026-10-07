import "server-only";

import { createClient } from "@/lib/supabase/server";

/**
 * Community Phase 5 — lightweight reputation.
 *
 * Events are written ONLY by the server-side accept flow (qa.ts) with
 * FIXED point values (the client can never submit points). The table has a
 * unique (event_type, entity_type, entity_id, user_id) constraint, so
 * retries / re-runs can never double-award. Self-awarding is impossible:
 * the accept flow never awards when the answer author is the question
 * author, and no other write path exists.
 *
 * This module is READ-ONLY: the profile-card stats (reputation, questions,
 * answers, accepted answers) — all public community numbers.
 */

type SessionClient = Awaited<ReturnType<typeof createClient>>;

export interface ReputationSummary {
  /** Sum of all reputation points (public). */
  reputation: number;
  /** Questions this user authored. */
  questions: number;
  /** Answers this user authored (not removed by moderation). */
  answers: number;
  /** Answers of this user marked as accepted. */
  accepted: number;
}

export const EMPTY_REPUTATION: ReputationSummary = {
  reputation: 0,
  questions: 0,
  answers: 0,
  accepted: 0,
};

/**
 * Public Q&A stats for ONE member (four bounded queries, no N+1).
 * Never throws: a read failure degrades to zeros (stats are chrome).
 */
export async function fetchReputationSummary(
  supabase: SessionClient,
  userId: string,
): Promise<ReputationSummary> {
  try {
    const [pointsRes, questionsRes, answersRes, acceptedRes] = await Promise.all([
      supabase
        .from("community_reputation_events")
        .select("points")
        .eq("user_id", userId),
      supabase
        .from("community_questions")
        .select("id", { count: "exact", head: true })
        .eq("author_id", userId),
      supabase
        .from("community_answers")
        .select("id", { count: "exact", head: true })
        .eq("author_id", userId)
        .is("deleted_at", null),
      supabase
        .from("community_answers")
        .select("id", { count: "exact", head: true })
        .eq("author_id", userId)
        .eq("accepted", true)
        .is("deleted_at", null),
    ]);
    const points = (pointsRes.data ?? []) as Array<{ points: number }>;
    return {
      reputation: points.reduce((sum, p) => sum + (Number(p.points) || 0), 0),
      questions: questionsRes.count ?? 0,
      answers: answersRes.count ?? 0,
      accepted: acceptedRes.count ?? 0,
    };
  } catch (error) {
    console.error("[community] reputation summary threw:", error);
    return { ...EMPTY_REPUTATION };
  }
}
