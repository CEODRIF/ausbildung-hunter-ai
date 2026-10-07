"use client";

import Link from "next/link";
import { Icon, type IconName } from "@/components/icon";
import { useI18n } from "@/lib/i18n";
import { dictionaries } from "@/lib/i18n/dictionaries";
import {
  communityAvatarUrl,
  type CommunityMessageView,
  type CommunityRoomGroup,
} from "@/lib/community";

/**
 * The community home — the landing state (§27): a calm welcome with the real
 * member count, the room directory as browsable cards, and the latest few
 * messages across ALL rooms ("recent activity"). Deliberately NOT a noisy
 * feed: no auto-scrolling, no infinite timeline.
 */

const KNOWN_ICONS: ReadonlySet<string> = new Set([
  "grid", "search", "bookmark", "file", "folder", "settings", "help", "menu",
  "bell", "mail", "spark", "user", "users", "scan", "edit", "send", "activity",
  "target", "briefcase", "plus", "paperclip", "arrowUp", "stop", "x", "image",
  "alert", "arrowLeft", "arrowRight", "arrow", "chevron", "chevronLeft",
  "chevronRight", "check", "sun", "moon", "monitor", "globe", "external",
  "trash", "download", "upload", "lock", "clock", "logout", "chart", "hash",
  "book", "idCard", "message", "at", "smile", "reply", "pin", "mic", "shield",
]);

function roomIcon(icon: string | null | undefined): IconName {
  return icon && KNOWN_ICONS.has(icon) ? (icon as IconName) : "hash";
}

/** Relative time for the home's recent-activity list (compact, localised). */
function timeAgo(iso: string, locale: string): string {
  const diffMs = Date.now() - Date.parse(iso);
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1)
    return locale === "de"
      ? "gerade eben"
      : locale === "fr"
        ? "à l'instant"
        : locale === "ar"
          ? "الآن"
          : "just now";
  if (minutes < 60)
    return locale === "de"
      ? `vor ${minutes} Min.`
      : locale === "fr"
        ? `il y a ${minutes} min`
        : locale === "ar"
          ? `قبل ${minutes} د`
          : `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24)
    return locale === "de"
      ? `vor ${hours} Std.`
      : locale === "fr"
        ? `il y a ${hours} h`
        : locale === "ar"
          ? `قبل ${hours} س`
          : `${hours} h ago`;
  return new Date(iso).toLocaleDateString(locale, { day: "2-digit", month: "2-digit" });
}

export interface HomeRecentItem {
  message: CommunityMessageView;
  roomName: string;
  roomSlug: string;
}

/** Phase 5: one room's 7-day activity (the "active rooms" strip). */
export interface HomeActivityItem {
  roomSlug: string;
  roomName: string;
  messageCount: number;
  questionCount: number;
}

/** Phase 5: a home question strip item (structural mirror of the server
 *  QuestionListItem — this file stays import-safe for the client). */
export interface HomeQuestionItem {
  id: string;
  title: string;
  status: "open" | "solved" | "closed";
  roomName: string;
  roomSlug: string;
  answerCount: number;
  authorName: string;
  createdAt: string;
}

export interface HomeQuestionFeeds {
  recent: HomeQuestionItem[];
  unanswered: HomeQuestionItem[];
  solved: HomeQuestionItem[];
}

export interface HomeAnnouncementItem {
  id: string;
  title: string;
  content: string;
  created_at: string;
}

export interface CommunityHomeProps {
  me: { userId: string; displayName: string; avatarId: string };
  categories: CommunityRoomGroup[];
  roomsUnavailable: boolean;
  memberCount: number;
  recent: HomeRecentItem[];
  /** Phase 5: 7-day per-room activity (popular rooms; empty = none). */
  activity?: HomeActivityItem[];
  /** Phase 5: members online right now (bounded heartbeat window). */
  onlineCount?: number;
  /** Phase 5: latest platform announcements (≤3). */
  announcements?: HomeAnnouncementItem[];
  /** Phase 5: the question strips (recent / unanswered / solved). */
  questionFeeds?: HomeQuestionFeeds;
}

/** Map a home question (any room) to its detail page URL. */
function questionHref(item: HomeQuestionItem): string {
  return `/community/questions/${item.id}`;
}

const EMPTY_QUESTION_FEEDS: HomeQuestionFeeds = {
  recent: [],
  unanswered: [],
  solved: [],
};

const QUESTION_STATUS_STYLE: Record<HomeQuestionItem["status"], string> = {
  open: "bg-accent-soft text-accent",
  solved: "bg-success/10 text-success",
  closed: "bg-surface-2 text-faint",
};

const QUESTION_STATUS_KEY: Record<
  HomeQuestionItem["status"],
  "community.questionStatusOpen" | "community.questionStatusSolved" | "community.questionStatusClosed"
> = {
  open: "community.questionStatusOpen",
  solved: "community.questionStatusSolved",
  closed: "community.questionStatusClosed",
};

/** One question row of the home strips — badge is TEXT + color (never
 *  color alone) and the row is a plain link (keyboard reachable). */
function HomeQuestionRow({ item, locale }: { item: HomeQuestionItem; locale: string }) {
  const { t } = useI18n();
  return (
    <li>
      <Link
        href={questionHref(item)}
        className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-surface-2/60"
      >
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-baseline gap-x-1.5 text-[13px]">
            <span className="font-bold text-ink">{item.title}</span>
            {item.roomName && (
              <span className="text-[11px] font-semibold text-accent">#{item.roomName}</span>
            )}
            <span className="text-[10px] text-faint">
              {new Date(item.createdAt).toLocaleDateString(locale)}
            </span>
          </span>
          <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-faint">
            <span
              className={`rounded-full px-1.5 py-px font-bold ${QUESTION_STATUS_STYLE[item.status]}`}
            >
              {t(QUESTION_STATUS_KEY[item.status])}
            </span>
            <span>
              {item.answerCount === 1
                ? t("community.questionOneAnswer")
                : t("community.questionAnswers", { count: item.answerCount })}
            </span>
            {item.authorName && <span>· {item.authorName}</span>}
          </span>
        </span>
        <Icon name="chevronRight" size={14} className="shrink-0 text-faint rtl:-scale-x-100" />
      </Link>
    </li>
  );
}

export function CommunityHome({
  me,
  categories,
  roomsUnavailable,
  memberCount,
  recent,
  activity = [],
  onlineCount = 0,
  announcements = [],
  questionFeeds = EMPTY_QUESTION_FEEDS,
}: CommunityHomeProps) {
  const { t, lang } = useI18n();
  const locale = lang === "de" ? "de-DE" : lang === "fr" ? "fr-FR" : lang === "ar" ? "ar" : "en-US";
  const totalRooms = categories.reduce((sum, c) => sum + c.rooms.length, 0);

  return (
    <div className="h-full overflow-y-auto overscroll-contain">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-4 py-6 sm:px-6 sm:py-8">
        {/* Welcome */}
        <section className="flex flex-col gap-3 rounded-3xl border border-line bg-gradient-to-br from-accent-soft/60 via-surface to-surface p-6 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-4">
            {/* eslint-disable-next-line @next/next/no-img-element -- avatar: fixed 52px, static public asset */}
            <img
              src={communityAvatarUrl(me.avatarId)}
              alt=""
              width={52}
              height={52}
              className="h-[52px] w-[52px] rounded-2xl object-cover"
            />
            <div>
              <h1 className="text-lg font-bold leading-tight text-ink sm:text-xl">
                {t("community.homeWelcome", { name: me.displayName })}
              </h1>
              <p className="mt-0.5 text-sm text-muted">{t("community.homeSubtitle")}</p>
            </div>
          </div>
          <div className="flex items-center gap-2 sm:flex-col sm:items-end">
            <span className="flex items-center gap-1.5 rounded-full bg-surface px-3 py-1 text-xs font-bold text-ink shadow-sm">
              <span className="h-2 w-2 rounded-full bg-success" aria-hidden="true" />
              {t("community.membersCount", { count: memberCount })}
            </span>
            <span className="text-[11px] font-semibold text-faint">
              {t("community.roomCount", { count: totalRooms })}
            </span>
          </div>
        </section>

        {/* Phase 5: global search CTA + live online count */}
        <section className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <Link
            href="/community/search"
            className="flex min-w-0 flex-1 items-center gap-2.5 rounded-2xl border border-line bg-surface px-4 py-3 text-sm text-muted transition-colors hover:border-accent/50 hover:bg-accent-soft/30 hover:text-ink"
          >
            <Icon name="search" size={16} className="shrink-0 text-accent" />
            <span className="truncate">{t("community.homeSearchCta")}</span>
          </Link>
          {onlineCount > 0 && (
            <span
              className="flex shrink-0 items-center gap-1.5 self-start rounded-full bg-success/10 px-3 py-1.5 text-xs font-bold text-success"
              aria-label={t("community.homeOnline", { count: onlineCount })}
            >
              <span className="h-2 w-2 rounded-full bg-success" aria-hidden="true" />
              {t("community.homeOnline", { count: onlineCount })}
            </span>
          )}
        </section>

        {/* Phase 5: active rooms (7-day activity, top 5) */}
        {activity.length > 0 && (
          <section aria-labelledby="home-active-title">
            <h2 id="home-active-title" className="mb-3 text-sm font-bold text-ink">
              {t("community.homePopularTitle")}
            </h2>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {activity.slice(0, 5).map((room) => (
                <Link
                  key={room.roomSlug}
                  href={`/community/${room.roomSlug}`}
                  className="group flex items-center gap-3 rounded-2xl border border-line bg-surface p-4 transition-colors hover:border-accent/50 hover:bg-accent-soft/30"
                >
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent">
                    <Icon name="hash" size={16} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-bold text-ink">
                      <span aria-hidden="true" className="text-faint"># </span>
                      {room.roomName}
                    </span>
                    <span className="block truncate text-[11px] text-faint">
                      {t("community.homePopularActivity", {
                        count: room.messageCount + room.questionCount,
                      })}
                    </span>
                  </span>
                  <Icon
                    name="chevronRight"
                    size={14}
                    className="shrink-0 text-faint transition-transform group-hover:translate-x-0.5 rtl:-scale-x-100 rtl:group-hover:-translate-x-0.5"
                  />
                </Link>
              ))}
            </div>
          </section>
        )}

        {/* Room directory */}
        <section aria-labelledby="home-rooms-title">
          <h2 id="home-rooms-title" className="mb-3 text-sm font-bold text-ink">
            {t("community.homeRoomsTitle")}
          </h2>
          {roomsUnavailable ? (
            <p className="rounded-2xl border border-line bg-surface p-4 text-sm text-muted">
              {t("community.historyUnavailable")}
            </p>
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {categories.flatMap((category) =>
                category.rooms.map((room) => (
                  <Link
                    key={room.id}
                    href={`/community/${room.slug}`}
                    className="group flex flex-col gap-2 rounded-2xl border border-line bg-surface p-4 transition-colors hover:border-accent/50 hover:bg-accent-soft/30"
                  >
                    <div className="flex items-center gap-2.5">
                      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent">
                        <Icon name={roomIcon(room.icon)} size={16} />
                      </span>
                      <div className="min-w-0">
                        <p className="truncate text-sm font-bold text-ink">
                          <span aria-hidden="true" className="text-faint"># </span>
                          {room.name}
                        </p>
                        <p className="truncate text-[11px] text-faint">
                          {category.name}
                        </p>
                      </div>
                      <Icon
                        name="chevronRight"
                        size={14}
                        className="ms-auto shrink-0 text-faint transition-transform group-hover:translate-x-0.5 rtl:-scale-x-100 rtl:group-hover:-translate-x-0.5"
                      />
                    </div>
                      <p className="line-clamp-2 text-xs leading-5 text-muted">
                        {(dictionaries[lang].community.roomDescriptions as Record<
                          string,
                          string
                        >)[room.slug] ??
                          room.description ??
                          ""}
                      </p>
                  </Link>
                )),
              )}
            </div>
          )}
        </section>

        {/* Phase 5: question strips (recent / unanswered / solved) */}
        {questionFeeds &&
          (questionFeeds.recent.length > 0 ||
            questionFeeds.unanswered.length > 0 ||
            questionFeeds.solved.length > 0) && (
            <section aria-labelledby="home-questions-title">
              <h2 id="home-questions-title" className="mb-3 text-sm font-bold text-ink">
                {t("community.homeQuestionsTitle")}
              </h2>
              <div className="flex flex-col gap-4">
                {questionFeeds.unanswered.length > 0 && (
                  <div>
                    <h3 className="mb-2 text-xs font-semibold text-muted">
                      {t("community.homeUnansweredTitle")}
                    </h3>
                    <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface">
                      {questionFeeds.unanswered.map((item) => (
                        <HomeQuestionRow key={`u-${item.id}`} item={item} locale={locale} />
                      ))}
                    </ul>
                  </div>
                )}
                {questionFeeds.recent.length > 0 && (
                  <div>
                    <h3 className="mb-2 text-xs font-semibold text-muted">
                      {t("community.homeQuestionsTitle")}
                    </h3>
                    <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface">
                      {questionFeeds.recent.map((item) => (
                        <HomeQuestionRow key={`r-${item.id}`} item={item} locale={locale} />
                      ))}
                    </ul>
                  </div>
                )}
                {questionFeeds.solved.length > 0 && (
                  <div>
                    <h3 className="mb-2 text-xs font-semibold text-muted">
                      {t("community.homeSolvedTitle")}
                    </h3>
                    <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface">
                      {questionFeeds.solved.map((item) => (
                        <HomeQuestionRow key={`s-${item.id}`} item={item} locale={locale} />
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            </section>
          )}

        {/* Phase 5: platform announcements (stored copy — the platform rows
            are written by the operator, rendered as TEXT, never as HTML) */}
        <section aria-labelledby="home-announcements-title">
          <h2 id="home-announcements-title" className="mb-3 text-sm font-bold text-ink">
            {t("community.homeAnnouncementsTitle")}
          </h2>
          {announcements.length === 0 ? (
            <p className="rounded-2xl border border-line bg-surface p-4 text-sm text-muted">
              {t("community.homeNoAnnouncements")}
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {announcements.map((item) => (
                <li
                  key={item.id}
                  className="rounded-2xl border border-line bg-surface px-4 py-3"
                >
                  <p className="text-sm font-bold text-ink">{item.title}</p>
                  <p className="mt-0.5 whitespace-pre-line text-xs leading-5 text-muted">
                    {item.content}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Recent activity across all rooms */}
        <section aria-labelledby="home-activity-title">
          <h2 id="home-activity-title" className="mb-3 text-sm font-bold text-ink">
            {t("community.homeActivityTitle")}
          </h2>
          {recent.length === 0 ? (
            <p className="rounded-2xl border border-line bg-surface p-4 text-sm text-muted">
              {t("community.homeActivityEmpty")}
            </p>
          ) : (
            <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface">
              {recent.map((item) => {
                const author = item.message.author;
                const snippet =
                  item.message.message?.trim().slice(0, 120) ??
                  (item.message.image_path ? t("community.imageAlt") : "");
                return (
                  <li key={item.message.id}>
                    <Link
                      href={`/community/${item.roomSlug}`}
                      className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-surface-2/60"
                    >
                      {author?.avatar_id ? (
                        // eslint-disable-next-line @next/next/no-img-element -- avatar: fixed 32px, static public asset
                        <img
                          src={communityAvatarUrl(author.avatar_id)}
                          alt=""
                          width={32}
                          height={32}
                          loading="lazy"
                          className="h-8 w-8 shrink-0 rounded-lg object-cover"
                        />
                      ) : (
                        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-[11px] font-bold text-muted">
                          {(author?.display_name ?? "?").charAt(0).toUpperCase()}
                        </span>
                      )}
                      <div className="min-w-0 flex-1">
                        <p className="flex flex-wrap items-baseline gap-x-1.5 text-[13px]">
                          <span className="font-bold text-ink">
                            {author?.display_name ?? t("community.member")}
                          </span>
                          <span className="text-[11px] font-semibold text-accent">
                            #{item.roomName}
                          </span>
                          <span className="text-[10px] text-faint">
                            {timeAgo(item.message.created_at, locale)}
                          </span>
                        </p>
                        {snippet && (
                          <p className="truncate text-xs text-muted">{snippet}</p>
                        )}
                      </div>
                      <Icon name="chevronRight" size={14} className="shrink-0 text-faint rtl:-scale-x-100" />
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
