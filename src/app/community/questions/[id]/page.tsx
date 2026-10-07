import type { Metadata } from "next";
import { redirect } from "next/navigation";
import Link from "next/link";
import { COMMUNITY_COMING_SOON } from "@/lib/community/availability";
import { loadSocialPageContext } from "@/lib/community/social-pages";
import { fetchViewerSettings } from "@/lib/community/social";
import { fetchQuestionDetail } from "@/lib/community/qa";
import { fetchViewerRole, isModerator } from "@/lib/community/roles";
import { CommunityShell } from "@/components/community/community-shell";
import { QuestionDetail } from "@/components/community/question-detail";
import { CommunityOnboarding } from "@/components/community-onboarding";
import { CommunityComingSoon } from "@/components/community-coming-soon";
import { SocialUnavailable } from "@/components/community/social-unavailable";
import { Card } from "@/components/ui";
import { Icon } from "@/components/icon";
import { getServerT } from "@/lib/i18n/server";

export const dynamic = "force-dynamic";

export function generateMetadata(): Metadata {
  if (!COMMUNITY_COMING_SOON) return {};
  return { title: { absolute: "Community — Coming Soon" } };
}

/**
 * /community/questions/[id] — one question with its answers (Phase 5).
 *
 * The id from the URL is NEVER trusted for identity claims: the row is read
 * with the session client (RLS: enabled room, blocked authors invisible in
 * either direction, removed answers invisible), and the capabilities handed
 * to the client (isAuthor / isModerator) are computed HERE from the session
 * user + the database. `#answer-{id}` deep links are handled by the client
 * (scroll + focus) — the notification and search targets use this shape.
 */
export default async function QuestionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  if (COMMUNITY_COMING_SOON) return <CommunityComingSoon />;

  const questionId = (await params).id;
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!UUID.test(questionId)) {
    return <QuestionNotFound />;
  }

  const ctx = await loadSocialPageContext();
  if (ctx.status === "login") redirect("/login");
  if (ctx.status === "onboarding") return <CommunityOnboarding />;
  if (ctx.status === "unavailable") return <SocialUnavailable />;

  const { supabase, me, categories, unread, socialUnread } = ctx;

  const [viewer, detail, role] = await Promise.all([
    fetchViewerSettings(supabase, me.userId),
    fetchQuestionDetail(supabase, questionId, {
      id: me.userId,
      displayName: me.displayName,
      avatarId: me.avatarId,
    }),
    fetchViewerRole(supabase, me.userId),
  ]);

  if (!detail) return <QuestionNotFound />;

  return (
    <CommunityShell
      me={me}
      categories={categories}
      unread={unread}
      activeSlug={detail.room?.slug ?? null}
      socialUnread={socialUnread}
      settings={viewer}
      mutedRooms={viewer?.mutedRooms ?? []}
      viewerIsModerator={isModerator(role)}
    >
      <QuestionDetail
        questionId={detail.question.id}
        title={detail.question.title}
        body={detail.question.body}
        tags={detail.question.tags}
        status={detail.question.status}
        acceptedAnswerId={detail.question.accepted_answer_id}
        createdAt={detail.question.created_at}
        authorName={detail.author?.display_name ?? null}
        authorId={detail.question.author_id}
        room={
          detail.room ? { slug: detail.room.slug, name: detail.room.name } : null
        }
        imagePath={detail.question.image_path}
        answers={detail.answers.map((a) => ({
          id: a.id,
          body: a.body,
          accepted: a.accepted,
          createdAt: a.created_at,
          authorName: a.author?.display_name ?? null,
          authorId: a.author_id,
        }))}
        me={{ userId: me.userId, displayName: me.displayName }}
        isAuthor={detail.question.author_id === me.userId}
        isModerator={isModerator(role)}
      />
    </CommunityShell>
  );
}

async function QuestionNotFound() {
  const t = await getServerT();
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col items-center gap-4 p-8">
      <Card className="flex w-full flex-col items-center gap-3 p-8 text-center">
        <Icon name="help" size={28} className="text-faint" />
        <h1 className="text-lg font-bold text-ink">{t("community.questionNotFound")}</h1>
        <Link href="/community" className="text-sm font-bold text-accent hover:underline">
          {t("community.questionBackToRoom")}
        </Link>
      </Card>
    </div>
  );
}
