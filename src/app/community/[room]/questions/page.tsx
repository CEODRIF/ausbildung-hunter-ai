import type { Metadata } from "next";
import { redirect } from "next/navigation";
import Link from "next/link";
import { COMMUNITY_COMING_SOON } from "@/lib/community/availability";
import { loadSocialPageContext } from "@/lib/community/social-pages";
import { fetchViewerSettings } from "@/lib/community/social";
import { fetchRoomQuestions } from "@/lib/community/qa";
import { CommunityShell } from "@/components/community/community-shell";
import { AdminBadge } from "@/components/community/admin-badge";
import { CommunityOnboarding } from "@/components/community-onboarding";
import { CommunityComingSoon } from "@/components/community-coming-soon";
import { SocialUnavailable } from "@/components/community/social-unavailable";
import { Card } from "@/components/ui";
import { Icon } from "@/components/icon";
import { getRequestLang, getServerT } from "@/lib/i18n/server";

export const dynamic = "force-dynamic";

export function generateMetadata(): Metadata {
  if (!COMMUNITY_COMING_SOON) return {};
  return { title: { absolute: "Community — Coming Soon" } };
}

type QuestionFilter = "all" | "open" | "solved";

const STATUS_STYLE: Record<string, string> = {
  open: "bg-accent-soft text-accent",
  solved: "bg-success/10 text-success",
  closed: "bg-surface-2 text-faint",
};

/**
 * /community/[room]/questions — the room's question list (Phase 5).
 *
 * Fully server-rendered: the FILTER and the KEYSET cursor live in the URL
 * (shareable, no client state to forge). "Load more" is a plain link to the
 * next cursor — no polling, no offset, no client fetch loop. The room is
 * resolved from the SERVER directory (an unknown slug never reaches the
 * query), and the Q&A capability is the room's own column (server truth).
 */
export default async function RoomQuestionsPage({
  params,
  searchParams,
}: {
  params: Promise<{ room: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (COMMUNITY_COMING_SOON) return <CommunityComingSoon />;

  const slug = (await params).room;
  const ctx = await loadSocialPageContext();
  if (ctx.status === "login") redirect("/login");
  if (ctx.status === "onboarding") return <CommunityOnboarding />;
  if (ctx.status === "unavailable") return <SocialUnavailable />;

  const { supabase, me, categories, unread, socialUnread } = ctx;

  const room = categories.flatMap((g) => g.rooms).find((r) => r.slug === slug) ?? null;
  if (!room) return <RoomQuestionsNotFound />;

  const raw = await searchParams;
  const filterRaw = typeof raw.filter === "string" ? raw.filter : "all";
  const filter: QuestionFilter =
    filterRaw === "open" || filterRaw === "solved" ? filterRaw : "all";
  const beforeAt =
    typeof raw.before === "string" && Number.isFinite(Date.parse(raw.before))
      ? raw.before
      : null;

  const [viewer, page] = await Promise.all([
    fetchViewerSettings(supabase, me.userId),
    fetchRoomQuestions(
      supabase,
      room.id,
      { id: me.userId, displayName: me.displayName, avatarId: me.avatarId },
      {
        status: filter === "all" ? null : filter,
        beforeAt: filter === "all" ? beforeAt : null, // the cursor is per-filter
        limit: 20,
      },
    ),
  ]);

  const t = await getServerT();
  const lang = await getRequestLang();
  const dateLocale =
    lang === "de" ? "de-DE" : lang === "fr" ? "fr-FR" : lang === "ar" ? "ar" : "en-US";
  const hasMore = page.items.length === 20;
  const last = page.items[page.items.length - 1];
  const cursorUrl = (f: QuestionFilter) =>
    `/community/${room.slug}/questions` + (f === "all" ? "" : `?filter=${f}`);
  const moreUrl =
    hasMore && last
      ? cursorUrl(filter) +
        (filter === "all" ? "?" : "&") +
        `before=${encodeURIComponent(last.created_at)}`
      : null;

  return (
    <CommunityShell
      me={me}
      categories={categories}
      unread={unread}
      activeSlug={room.slug}
      socialUnread={socialUnread}
      settings={viewer}
      mutedRooms={viewer?.mutedRooms ?? []}
      viewerIsModerator={ctx.viewerIsModerator}
    >
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 p-4 sm:p-6">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-lg font-bold text-ink sm:text-xl">
              {t("community.questionsTitle")} · #{room.name}
            </h1>
            <p className="mt-0.5 text-sm text-muted">{t("community.questionsSubtitle")}</p>
          </div>
          {room.qna_enabled ? (
            <Link
              href={`/community/questions/new?room=${room.slug}`}
              className="btn-neon inline-flex h-10 items-center gap-2 rounded-2xl px-4 text-sm font-bold text-white"
            >
              <Icon name="plus" size={16} />
              {t("community.questionsNew")}
            </Link>
          ) : null}
        </header>

        {/* Filter tabs (URL-driven — shareable, no client state) */}
        <nav aria-label={t("community.questionsTitle")} className="flex flex-wrap gap-1.5">
          {(
            [
              ["all", t("community.searchKindAll")],
              ["open", t("community.questionStatusOpen")],
              ["solved", t("community.questionStatusSolved")],
            ] as Array<[QuestionFilter, string]>
          ).map(([f, label]) => (
            <Link
              key={f}
              href={cursorUrl(f)}
              aria-current={filter === f ? "page" : undefined}
              className={`rounded-full px-3 py-1.5 text-xs font-bold transition-colors ${
                filter === f
                  ? "bg-accent-soft text-accent"
                  : "bg-surface text-muted hover:bg-surface-2 hover:text-ink"
              }`}
            >
              {label}
            </Link>
          ))}
        </nav>

        {page.unavailable ? (
          <Card className="flex flex-col items-center gap-2 p-8 text-center">
            <Icon name="alert" size={24} className="text-faint" />
            <p className="text-sm font-semibold text-muted">
              {t("community.historyUnavailable")}
            </p>
            <Link href={cursorUrl(filter)} className="text-xs font-bold text-accent hover:underline">
              {t("community.historyUnavailableRetry")}
            </Link>
          </Card>
        ) : page.items.length === 0 ? (
          <Card className="flex flex-col items-center gap-2 p-8 text-center">
            <Icon name="help" size={24} className="text-faint" />
            <p className="text-sm text-muted">{t("community.questionsEmpty")}</p>
          </Card>
        ) : (
          <>
            <ul className="flex flex-col gap-2">
              {page.items.map((item) => (
                <li key={item.id}>
                  <Link
                    href={`/community/questions/${item.id}`}
                    className="group flex items-start gap-3 rounded-2xl border border-line bg-surface p-4 transition-colors hover:border-accent/50 hover:bg-accent-soft/30"
                  >
                    <span
                      className={`mt-0.5 shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold ${STATUS_STYLE[item.status]}`}
                    >
                      {t(
                        item.status === "open"
                          ? "community.questionStatusOpen"
                          : item.status === "solved"
                            ? "community.questionStatusSolved"
                            : "community.questionStatusClosed",
                      )}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-bold text-ink">
                        {item.title}
                      </span>
                      <span className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] text-faint">
                        <span>
                          {item.answerCount === 1
                            ? t("community.questionOneAnswer")
                            : t("community.questionAnswers", { count: item.answerCount })}
                        </span>
                        {item.author?.display_name && (
                          <span className="flex items-center gap-1">
                            · {item.author.display_name}
                            {item.author.platform_admin === true && (
                              <AdminBadge size={12} label={t("community.adminBadge")} />
                            )}
                          </span>
                        )}
                        <span>
                          · {new Date(item.created_at).toLocaleDateString(dateLocale)}
                        </span>
                      </span>
                      {item.tags.length > 0 && (
                        <span className="mt-1 flex flex-wrap gap-1">
                          {item.tags.map((tag) => (
                            <span
                              key={tag}
                              className="rounded-full bg-surface-2 px-1.5 py-px text-[10px] font-semibold text-muted"
                            >
                              #{tag}
                            </span>
                          ))}
                        </span>
                      )}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
            {moreUrl && (
              <div className="flex justify-center">
                <Link
                  href={moreUrl}
                  className="inline-flex h-11 items-center gap-2 rounded-2xl border border-line bg-surface px-4 text-sm font-semibold text-ink transition-colors hover:bg-surface-2"
                >
                  {t("community.questionLoadMore")}
                </Link>
              </div>
            )}
          </>
        )}
      </div>
    </CommunityShell>
  );
}

async function RoomQuestionsNotFound() {
  const t = await getServerT();
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col items-center p-8">
      <Card className="flex w-full flex-col items-center gap-3 p-8 text-center">
        <Icon name="hash" size={28} className="text-faint" />
        <h1 className="text-lg font-bold text-ink">{t("community.questionsEmpty")}</h1>
        <Link href="/community" className="text-sm font-bold text-accent hover:underline">
          {t("community.homeTitle")}
        </Link>
      </Card>
    </div>
  );
}
