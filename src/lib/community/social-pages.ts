import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { getCurrentUserAndProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { fetchCommunityRoomGroups, fetchRoomUnreadMap } from "./rooms";
import { fetchSocialBadges } from "./social";
import { fetchViewerRole, isModerator } from "./roles";
import type { CommunityRoomGroup } from "../community";

/**
 * Shared, degraded-safe bootstrap for the PHASE 2 SOCIAL PAGES
 * (/community/friends, /community/messages*, /community/notifications).
 *
 * One helper, one source of truth for the shell data every page needs:
 *   - auth + account-status guard (→ login),
 *   - community profile (→ onboarding / retryable unavailable),
 *   - the room directory + per-room unread (the nav),
 *   - the Phase 2 social badges (nav badges; null = chrome hidden).
 *
 * A database hiccup must NEVER escalate into the global error boundary —
 * the same contract as the Phase 1 community pages.
 */

export interface SocialMe {
  userId: string;
  displayName: string;
  avatarId: string;
}

export type SocialPageContext =
  | {
      status: "ok";
      supabase: SupabaseClient;
      me: SocialMe;
      categories: CommunityRoomGroup[];
      roomsUnavailable: boolean;
      unread: Record<string, number>;
      socialUnread: { dms: number; friendRequests: number; notifications: number } | null;
      /** Phase 5: SERVER-derived — the nav reveals Moderation only for this
       *  (degrades to false, never to a client claim). */
      viewerIsModerator: boolean;
    }
  | { status: "login" }
  | { status: "onboarding" }
  | { status: "unavailable" };

export async function loadSocialPageContext(): Promise<SocialPageContext> {
  const { user, profile } = await getCurrentUserAndProfile();
  if (!user || !profile || profile.account_status !== "active") {
    return { status: "login" };
  }

  const supabase = await createClient();

  let communityProfile: { display_name: string; avatar_id: string } | null = null;
  let lookupFailed = false;
  try {
    const { data, error } = await supabase
      .from("community_profiles")
      .select("display_name,avatar_id")
      .eq("user_id", user.id)
      .maybeSingle();
    if (error) {
      lookupFailed = true;
      console.error("[community] social profile lookup failed:", error.message);
    } else {
      communityProfile =
        (data as { display_name: string; avatar_id: string } | null) ?? null;
    }
  } catch (error) {
    lookupFailed = true;
    console.error("[community] social profile lookup threw:", error);
  }

  // A failed lookup is NOT "no profile yet" — never render onboarding here.
  if (lookupFailed) return { status: "unavailable" };
  if (!communityProfile) return { status: "onboarding" };

  const me: SocialMe = {
    userId: user.id,
    displayName: communityProfile.display_name,
    avatarId: communityProfile.avatar_id,
  };

  const [directory, unread, socialUnread, viewerRole] = await Promise.all([
    fetchCommunityRoomGroups(supabase),
    fetchRoomUnreadMap(user.id),
    fetchSocialBadges(supabase, user.id),
    fetchViewerRole(supabase, user.id),
  ]);

  return {
    status: "ok",
    supabase,
    me,
    categories: directory.groups,
    roomsUnavailable: directory.unavailable,
    unread,
    socialUnread,
    viewerIsModerator: isModerator(viewerRole),
  };
}
