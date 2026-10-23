import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { COMMUNITY_COMING_SOON } from "@/lib/community/availability";
import { loadSocialPageContext } from "@/lib/community/social-pages";
import { fetchViewerSettings } from "@/lib/community/social";
import { CommunityShell } from "@/components/community/community-shell";
import { QuestionCreate } from "@/components/community/question-create";
import { CommunityOnboarding } from "@/components/community-onboarding";
import { CommunityComingSoon } from "@/components/community-coming-soon";
import { SocialUnavailable } from "@/components/community/social-unavailable";

export const dynamic = "force-dynamic";

export function generateMetadata(): Metadata {
  if (!COMMUNITY_COMING_SOON) return {};
  return { title: { absolute: "Community — Coming Soon" } };
}

/**
 * /community/questions/new?room={slug} — ask a question (Phase 5).
 *
 * The room LIST sent to the client already contains ONLY enabled rooms with
 * Q&A mode on — the rest is filtered out server-side (the create API re-checks
 * each of those conditions against the database anyway; the select is UX,
 * not authorization).
 */
export default async function NewQuestionPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (COMMUNITY_COMING_SOON) return <CommunityComingSoon />;

  const ctx = await loadSocialPageContext();
  if (ctx.status === "login") redirect("/login");
  if (ctx.status === "onboarding") return <CommunityOnboarding />;
  if (ctx.status === "unavailable") return <SocialUnavailable />;

  const { supabase, me, categories, unread, socialUnread } = ctx;
  const viewer = await fetchViewerSettings(supabase, me.userId);

  const raw = await searchParams;
  const roomSlugParam =
    typeof raw.room === "string" ? raw.room.trim().toLowerCase().slice(0, 64) : "";

  const qnaRooms = categories
    .flatMap((g) => g.rooms)
    .filter((r) => r.enabled && r.qna_enabled)
    .map((r) => ({ id: r.id, slug: r.slug, name: r.name }));

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
      <QuestionCreate rooms={qnaRooms} defaultRoomSlug={roomSlugParam} />
    </CommunityShell>
  );
}
