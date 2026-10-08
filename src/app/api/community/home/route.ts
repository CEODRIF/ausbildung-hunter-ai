import { NextResponse } from "next/server";
import { getCurrentUserAndProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import {
  checkRateLimit,
  rateLimitHeaders,
  tooManyRequests,
} from "@/lib/rate-limit";
import { getCommunityMemberCount } from "@/lib/community/server";
import {
  fetchHomeActivity,
  fetchHomeAnnouncements,
  fetchHomeOnlineCount,
  fetchHomeRecent,
} from "@/lib/community/rooms";
import {
  fetchHomeQuestionFeeds,
  type QuestionListItem,
} from "@/lib/community/qa";

/**
 * GET /api/community/home — the live slice of the Community home
 * (recent activity, 7-day activity strip, online count, announcements,
 * question feeds, member count). The SAME bounded server queries the
 * /community page runs for its first render — each one small and
 * index-backed, so a 1s poll of the MOUNTED home is cheap.
 *
 * The community home polls this every 1s while mounted (`?poll=1` → the
 * higher community_poll bucket, 240/min). Auth is IDENTICAL to a page
 * visit — a poll can never read more.
 */
export async function GET(request: Request) {
  const { user, profile } = await getCurrentUserAndProfile();
  if (!user || !profile || profile.account_status !== "active") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const isPoll = new URL(request.url).searchParams.get("poll") === "1";
  const limited = await checkRateLimit(
    isPoll ? "community_poll" : "community_profile",
    user.id,
  );
  if (!limited.allowed) return tooManyRequests(limited);

  try {
    const supabase = await createClient();
    // Community identity (same lookup the /community page does — the
    // question feeds highlight the viewer's own rows with it).
    const { data: communityProfile } = await supabase
      .from("community_profiles")
      .select("display_name,avatar_id")
      .eq("user_id", user.id)
      .maybeSingle();
    if (!communityProfile) {
      // No community identity → the page renders onboarding, not the home;
      // nothing to poll. (404 keeps the client's existing state.)
      return NextResponse.json({ error: "community_not_joined" }, { status: 404 });
    }
    const [memberCount, recent, activity, onlineCount, announcements, questionFeeds] =
      await Promise.all([
        getCommunityMemberCount(supabase),
        fetchHomeRecent(supabase),
        fetchHomeActivity(),
        fetchHomeOnlineCount(supabase),
        fetchHomeAnnouncements(supabase),
        fetchHomeQuestionFeeds(supabase, {
          id: user.id,
          displayName: communityProfile.display_name,
          avatarId: communityProfile.avatar_id,
        }),
      ]);

    // Flatten the question rows to the home's structural shape (the SAME
    // mapping /community/page.tsx does — the client stays import-safe).
    const toHomeQuestion = (q: QuestionListItem) => ({
      id: q.id,
      title: q.title,
      status: q.status,
      roomName: q.room?.name ?? "",
      roomSlug: q.room?.slug ?? "",
      answerCount: q.answerCount,
      authorName: q.author?.display_name ?? "",
      authorIsAdmin: q.author?.platform_admin === true,
      createdAt: q.created_at,
    });

    return NextResponse.json(
      {
        memberCount,
        recent,
        activity,
        onlineCount,
        announcements,
        questionFeeds: {
          recent: questionFeeds.recent.map(toHomeQuestion),
          unanswered: questionFeeds.unanswered.map(toHomeQuestion),
          solved: questionFeeds.solved.map(toHomeQuestion),
        },
      },
      { headers: rateLimitHeaders(limited) },
    );
  } catch (error) {
    console.error("[community] home poll threw:", error);
    return NextResponse.json({ error: "Could not load community." }, { status: 500 });
  }
}
