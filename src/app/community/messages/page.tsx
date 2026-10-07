import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { COMMUNITY_COMING_SOON } from "@/lib/community/availability";
import { fetchDmSummary, fetchViewerSettings } from "@/lib/community/social";
import { loadSocialPageContext } from "@/lib/community/social-pages";
import { CommunityShell } from "@/components/community/community-shell";
import { DmInbox } from "@/components/community/dm-inbox";
import { CommunityOnboarding } from "@/components/community-onboarding";
import { CommunityComingSoon } from "@/components/community-coming-soon";
import { SocialUnavailable } from "@/components/community/social-unavailable";

export const dynamic = "force-dynamic";

export function generateMetadata(): Metadata {
  if (!COMMUNITY_COMING_SOON) return {};
  return { title: { absolute: "Community — Coming Soon" } };
}

/**
 * /community/messages — the DM inbox (Phase 2).
 *
 * One SQL summary (conversations + unread + last-message shape) — never a
 * message download. New conversations are created from the Friends page /
 * profile card ("Message" → POST /api/community/dm). Mobile: full-width
 * list → tap → conversation (own header with back) — no nested scrolling.
 */
export default async function CommunityMessagesPage() {
  if (COMMUNITY_COMING_SOON) return <CommunityComingSoon />;

  const ctx = await loadSocialPageContext();
  if (ctx.status === "login") redirect("/login");
  if (ctx.status === "onboarding") return <CommunityOnboarding />;
  if (ctx.status === "unavailable") return <SocialUnavailable />;

  const { supabase, me, categories, unread, socialUnread } = ctx;

  const [summary, viewer] = await Promise.all([
    fetchDmSummary(supabase, me.userId),
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
      <DmInbox
        me={{ userId: me.userId }}
        initial={summary.conversations}
        unavailable={summary.unavailable}
        variant="page"
      />
    </CommunityShell>
  );
}
