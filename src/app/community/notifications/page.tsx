import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { COMMUNITY_COMING_SOON } from "@/lib/community/availability";
import { fetchNotifications, fetchViewerSettings } from "@/lib/community/social";
import { loadSocialPageContext } from "@/lib/community/social-pages";
import { CommunityShell } from "@/components/community/community-shell";
import { NotificationsView } from "@/components/community/notifications-view";
import { CommunityOnboarding } from "@/components/community-onboarding";
import { CommunityComingSoon } from "@/components/community-coming-soon";
import { SocialUnavailable } from "@/components/community/social-unavailable";

export const dynamic = "force-dynamic";

export function generateMetadata(): Metadata {
  if (!COMMUNITY_COMING_SOON) return {};
  return { title: { absolute: "Community — Coming Soon" } };
}

/**
 * /community/notifications — the Phase 3 notification center.
 *
 * The server loads the FIRST cursor page (ONE invoker RPC — RLS is the
 * visibility boundary: own + global rows) plus the viewer's settings for
 * the shell. The rest of the feed loads client-side via the cursor
 * "load more" action (no polling, no offset scans); live inserts stream
 * over the shell's ONE notifications channel (the view consumes the
 * in-page bus, never a second channel).
 */
export default async function CommunityNotificationsPage() {
  if (COMMUNITY_COMING_SOON) return <CommunityComingSoon />;

  const ctx = await loadSocialPageContext();
  if (ctx.status === "login") redirect("/login");
  if (ctx.status === "onboarding") return <CommunityOnboarding />;
  if (ctx.status === "unavailable") return <SocialUnavailable />;

  const { supabase, me, categories, unread, socialUnread } = ctx;

  const [notifications, viewer] = await Promise.all([
    fetchNotifications(supabase, me.userId),
    fetchViewerSettings(supabase, me.userId),
  ]);

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
      <NotificationsView
        me={{ userId: me.userId }}
        categories={categories}
        initial={notifications.items}
        cursor={notifications.cursor}
        unavailable={notifications.unavailable}
      />
    </CommunityShell>
  );
}
