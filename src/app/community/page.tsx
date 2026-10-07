import type { Metadata } from "next";
import { redirect } from "next/navigation";
import Link from "next/link";
import { getCurrentUserAndProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { getCommunityMemberCount } from "@/lib/community/server";
import {
  fetchCommunityRoomGroups,
  fetchHomeActivity,
  fetchHomeAnnouncements,
  fetchHomeOnlineCount,
  fetchHomeRecent,
  fetchRoomUnreadMap,
} from "@/lib/community/rooms";
import { fetchHomeQuestionFeeds, type QuestionListItem } from "@/lib/community/qa";
import { fetchViewerRole, isModerator } from "@/lib/community/roles";
import {
  buildViewerSettings,
  fetchSocialBadges,
  VIEWER_SETTINGS_SELECT,
} from "@/lib/community/social";
import { COMMUNITY_COMING_SOON } from "@/lib/community/availability";
import { getServerT } from "@/lib/i18n/server";
import { Card } from "@/components/ui";
import { Icon } from "@/components/icon";
import { CommunityShell } from "@/components/community/community-shell";
import { CommunityHome } from "@/components/community/community-home";
import { CommunityOnboarding } from "@/components/community-onboarding";
import { CommunityComingSoon } from "@/components/community-coming-soon";

export const dynamic = "force-dynamic";

/**
 * /community — the Community home: welcome, room directory and recent
 * activity, inside the Discord-inspired shell (room nav + main + members).
 *
 * First visit: the identity screen (generated username + one of the four
 * predefined avatars). Everything below is degraded-safe: a database hiccup
 * (or an incomplete server environment) must NEVER escalate into the global
 * error boundary — that is what produced the post-onboarding "This page
 * could not load" screen.
 */
export function generateMetadata(): Metadata {
  if (!COMMUNITY_COMING_SOON) return {};
  // `absolute` so the title is exactly the Coming Soon one; the root layout's
  // global metadata (and its template for every other page) is untouched.
  return { title: { absolute: "Community — Coming Soon" } };
}

export default async function CommunityPage() {
  if (COMMUNITY_COMING_SOON) return <CommunityComingSoon />;

  const { user, profile } = await getCurrentUserAndProfile();
  if (!user || !profile || profile.account_status !== "active")
    redirect("/login");

  const supabase = await createClient();

  type ProfileRow = {
    display_name: string;
    avatar_id: string;
  } & Parameters<typeof buildViewerSettings>[0];
  let communityProfile: ProfileRow | null = null;
  let lookupFailed = false;
  try {
    const { data, error } = await supabase
      .from("community_profiles")
      .select(`display_name,avatar_id,${VIEWER_SETTINGS_SELECT}`)
      .eq("user_id", user.id)
      .maybeSingle();
    if (error) {
      lookupFailed = true;
      console.error("[community] profile lookup failed:", error.message);
    } else {
      communityProfile = (data as ProfileRow | null) ?? null;
    }
  } catch (error) {
    // Network/DB outage: logged for the server logs, never thrown onward.
    lookupFailed = true;
    console.error("[community] profile lookup threw:", error);
  }

  // A failed lookup is NOT "no profile yet": rendering onboarding here would
  // invite a second (doomed) profile write, so show a retryable state instead.
  if (lookupFailed) return <CommunityUnavailable />;
  if (!communityProfile) return <CommunityOnboarding />;

  const [
    directory,
    unread,
    memberCount,
    recent,
    socialUnread,
    activity,
    onlineCount,
    announcements,
    questionFeeds,
    viewerRole,
  ] = await Promise.all([
    fetchCommunityRoomGroups(supabase),
    fetchRoomUnreadMap(user.id),
    getCommunityMemberCount(supabase),
    fetchHomeRecent(supabase),
    fetchSocialBadges(supabase, user.id),
    fetchHomeActivity(),
    fetchHomeOnlineCount(supabase),
    fetchHomeAnnouncements(supabase),
    fetchHomeQuestionFeeds(supabase, {
      id: user.id,
      displayName: communityProfile.display_name,
      avatarId: communityProfile.avatar_id,
    }),
    fetchViewerRole(supabase, user.id),
  ]);

  const me = {
    userId: user.id,
    displayName: communityProfile.display_name,
    avatarId: communityProfile.avatar_id,
  };
  // Phase 3: presence + notification preferences (own row, one query).
  const viewer = buildViewerSettings(communityProfile);
  // Phase 5: flatten the server question rows to the home's structural shape
  // (the client component never imports the server-only qa module).
  const toHomeQuestion = (q: QuestionListItem) => ({
    id: q.id,
    title: q.title,
    status: q.status,
    roomName: q.room?.name ?? "",
    roomSlug: q.room?.slug ?? "",
    answerCount: q.answerCount,
    authorName: q.author?.display_name ?? "",
    createdAt: q.created_at,
  });
  const homeQuestionFeeds = {
    recent: questionFeeds.recent.map(toHomeQuestion),
    unanswered: questionFeeds.unanswered.map(toHomeQuestion),
    solved: questionFeeds.solved.map(toHomeQuestion),
  };

  return (
    <CommunityShell
      me={me}
      categories={directory.groups}
      unread={unread}
      activeSlug={null}
      socialUnread={socialUnread}
      settings={viewer}
      mutedRooms={viewer.mutedRooms}
      viewerIsModerator={isModerator(viewerRole)}
    >
      <CommunityHome
        me={me}
        categories={directory.groups}
        roomsUnavailable={directory.unavailable}
        memberCount={memberCount}
        recent={recent}
        activity={activity}
        onlineCount={onlineCount}
        announcements={announcements}
        questionFeeds={homeQuestionFeeds}
      />
    </CommunityShell>
  );
}

/**
 * Non-fatal, retryable state for an unreadable community profile. Uses the
 * shared error copy + the same card tokens as the rest of the app.
 */
async function CommunityUnavailable() {
  const t = await getServerT();
  return (
    <div className="mx-auto flex w-full max-w-md flex-1 flex-col items-center justify-center px-4 py-10 text-center sm:px-6">
      <Card className="w-full">
        <div className="flex flex-col items-center gap-3 p-6 sm:p-8">
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-danger-soft text-danger">
            <Icon name="alert" size={22} />
          </span>
          <h2 className="text-lg font-bold text-ink">{t("common.error")}</h2>
          <p className="text-sm leading-6 text-muted">{t("common.errorHint")}</p>
          <Link
            href="/community"
            className="mt-1 text-sm font-semibold text-accent underline underline-offset-4"
          >
            {t("common.retry")}
          </Link>
        </div>
      </Card>
    </div>
  );
}
