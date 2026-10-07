import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { COMMUNITY_COMING_SOON } from "@/lib/community/availability";
import { fetchFriendsList, fetchViewerSettings } from "@/lib/community/social";
import { loadSocialPageContext } from "@/lib/community/social-pages";
import { CommunityShell } from "@/components/community/community-shell";
import { FriendsView, type FriendsViewData } from "@/components/community/friends-view";
import { CommunityOnboarding } from "@/components/community-onboarding";
import { CommunityComingSoon } from "@/components/community-coming-soon";
import { SocialUnavailable } from "@/components/community/social-unavailable";

export const dynamic = "force-dynamic";

export function generateMetadata(): Metadata {
  if (!COMMUNITY_COMING_SOON) return {};
  return { title: { absolute: "Community — Coming Soon" } };
}

/**
 * /community/friends — friend requests (in/out), friends by presence and
 * the blocked list (Phase 2).
 *
 * The server fetches ONE snapshot (degraded-safe); the client converges on
 * realtime relationship events (see FriendsView). No polling.
 */
export default async function CommunityFriendsPage() {
  if (COMMUNITY_COMING_SOON) return <CommunityComingSoon />;

  const ctx = await loadSocialPageContext();
  if (ctx.status === "login") redirect("/login");
  if (ctx.status === "onboarding") return <CommunityOnboarding />;
  if (ctx.status === "unavailable") return <SocialUnavailable />;

  const { supabase, me, categories, unread, socialUnread } = ctx;

  const [friends, viewer] = await Promise.all([
    fetchFriendsList(supabase, me.userId),
    fetchViewerSettings(supabase, me.userId),
  ]);

  const initial: FriendsViewData = {
    friends: friends.friends.map((f) => ({
      userId: f.other.userId,
      displayName: f.other.displayName,
      avatarId: f.other.avatarId,
      online: f.other.online,
      presence: f.other.presence,
      lastSeenAt: f.other.lastSeenAt,
      state: f.state,
      friendshipId: f.friendshipId,
    })),
    incoming: friends.incoming.map((f) => ({
      userId: f.other.userId,
      displayName: f.other.displayName,
      avatarId: f.other.avatarId,
      online: f.other.online,
      presence: f.other.presence,
      lastSeenAt: f.other.lastSeenAt,
      state: f.state,
      friendshipId: f.friendshipId,
    })),
    outgoing: friends.outgoing.map((f) => ({
      userId: f.other.userId,
      displayName: f.other.displayName,
      avatarId: f.other.avatarId,
      online: f.other.online,
      presence: f.other.presence,
      lastSeenAt: f.other.lastSeenAt,
      state: f.state,
      friendshipId: f.friendshipId,
    })),
    blocked: friends.blocked.map((b) => ({
      userId: b.userId,
      displayName: b.displayName,
      avatarId: b.avatarId,
      bio: b.bio,
      joinedAt: b.joinedAt,
      online: b.online,
      presence: b.presence,
      lastSeenAt: b.lastSeenAt,
    })),
    unavailable: friends.unavailable,
  };

  return (
    <CommunityShell
      me={me}
      categories={categories}
      unread={unread}
      activeSlug={null}
      socialUnread={socialUnread}
      settings={viewer}
      mutedRooms={viewer?.mutedRooms ?? []}
      viewerIsModerator={ctx.viewerIsModerator}
    >
      <FriendsView me={{ userId: me.userId }} initial={initial} />
    </CommunityShell>
  );
}
