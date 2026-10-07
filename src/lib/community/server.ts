import "server-only";

import { createClient } from "@/lib/supabase/server";
import { fetchRoomUnreadMap } from "@/lib/community/rooms";

/** The request-scoped client (RLS-enforced) used for member-readable data. */
type SessionClient = Awaited<ReturnType<typeof createClient>>;

/**
 * Unread community message count for the sidebar badge — the SUM of the
 * per-room unread counters (one SQL summary call, see
 * `fetchRoomUnreadMap`). "Unread" = messages in a room created after the
 * user's last read of that room; a room never read counts fully.
 *
 * Non-critical chrome: any failure degrades to 0 and never breaks the page
 * render.
 */
export async function getCommunityUnreadCount(userId: string): Promise<number> {
  const byRoom = await fetchRoomUnreadMap(userId);
  return Object.values(byRoom).reduce((sum, n) => sum + n, 0);
}

/**
 * Total number of community members (onboarded profiles) for the community
 * header/home. This is a REAL count — not presence (there is no persistent
 * presence in Community v1; it arrives with voice, Phase 3).
 * Non-critical chrome: any failure degrades to 0, never breaks the page.
 */
export async function getCommunityMemberCount(
  supabase: SessionClient,
): Promise<number> {
  try {
    const { count, error } = await supabase
      .from("community_profiles")
      .select("id", { count: "exact", head: true });
    if (error) {
      console.error("[community] member count failed:", error.message);
      return 0;
    }
    return count ?? 0;
  } catch (error) {
    console.error("[community] member count threw:", error);
    return 0;
  }
}
