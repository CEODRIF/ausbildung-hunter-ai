"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Icon, type IconName } from "@/components/icon";
import { Button, ErrorState } from "@/components/ui";
import { useI18n } from "@/lib/i18n";
import {
  loadFirstNotifications,
  loadMoreNotifications,
  markAllNotificationsRead,
  markNotificationRead,
} from "@/app/community/actions";
import type { CommunityRoomGroup } from "@/lib/community";
import {
  onCommunityNotification,
  type BusNotification,
} from "@/lib/community/notification-bus";
import { socialKindOf } from "@/lib/community/notification-kinds";
import { useCommunityShell } from "./community-shell";
import { ActionSpinner, COMMUNITY_PRESS_CLASS, useCommunityToast } from "./action-feedback";
import { AdminBadge } from "./admin-badge";

/**
 * Phase 3 notification center.
 *
 *  - ONE source of realtime truth: the shell's notification channel, surfaced
 *    here through the in-page bus (onCommunityNotification). This view opens
 *    NO channel of its own and NEVER calls window.location.reload().
 *  - The text is CLIENT-RENDERED from the structured row (type + actor +
 *    room), via i18n keys — the stored title/content are only the fallback
 *    for legacy/platform rows. No HTML is ever parsed or injected.
 *  - Pagination is CURSOR-based through the `loadMoreNotifications` server
 *    action (the session is re-derived server-side); "load more" is a
 *    user-initiated bounded RPC, never polling.
 *  - Read state is optimistic with revert: a failed mark-read restores the
 *    previous state and shows a recoverable error (the row is never lost).
 */

/** One notification row as the center renders it (client-safe mirror of the
 *  server's NotificationView — the page passes them through unchanged). */
export interface CenterNotification {
  id: string;
  title: string;
  content: string;
  type: string;
  target_type: "all" | "user";
  created_at: string;
  read: boolean;
  actorId: string | null;
  roomId: string | null;
  roomMessageId: string | null;
  conversationId: string | null;
  dmMessageId: string | null;
  reactionEmoji: string | null;
  /** Phase 5 Q&A refs (null for pre-Phase-5 rows). */
  questionId: string | null;
  answerId: string | null;
}

/** (created_at, id) of the oldest row of the current page — the keyset cursor. */
export interface CenterCursor {
  createdAt: string;
  id: string;
}

interface NotificationsViewProps {
  me: { userId: string };
  /** Room directory — resolves room ids to display names + safe slugs. */
  categories: CommunityRoomGroup[];
  /** First server-loaded page (newest first). */
  initial: CenterNotification[];
  cursor: CenterCursor | null;
  /** The server could not prefetch the first page (DB outage). */
  unavailable?: boolean;
}

/** Per-type icon (the app's existing icon set — no second system). */
function iconFor(kind: string | null): IconName {
  switch (kind) {
    case "friend_request":
      return "user";
    case "friend_accepted":
      return "check";
    case "mention":
      return "at";
    case "reply":
      return "reply";
    case "reaction":
      return "smile";
    case "direct_message":
      return "message";
    case "answer":
      return "help";
    case "answer_accepted":
      return "award";
    default:
      return "bell";
  }
}

type DayGroup = "today" | "yesterday" | "earlier";

/** Deterministic day bucket from a timestamp + the local "now" (pure). */
function dayGroupFor(iso: string, startOfTodayMs: number): DayGroup {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return "earlier";
  if (time >= startOfTodayMs) return "today";
  if (time >= startOfTodayMs - 86_400_000) return "yesterday";
  return "earlier";
}

const DAY_GROUPS: DayGroup[] = ["today", "yesterday", "earlier"];

/** Bus row (snake_case wire shape) → center row. */
function busToItem(n: BusNotification): CenterNotification {
  return {
    id: n.id,
    title: n.title,
    content: n.content,
    type: n.type,
    target_type: n.target_type,
    created_at: n.created_at,
    read: false,
    actorId: n.actor_id,
    roomId: n.room_id,
    roomMessageId: n.room_message_id,
    conversationId: n.conversation_id,
    dmMessageId: n.dm_message_id,
    reactionEmoji: n.reaction_emoji,
    questionId: n.question_id ?? null,
    answerId: n.answer_id ?? null,
  };
}

export function NotificationsView({
  me,
  categories,
  initial,
  cursor: initialCursor,
  unavailable = false,
}: NotificationsViewProps) {
  const { t } = useI18n();
  const router = useRouter();
  const { members } = useCommunityShell();
  const toast = useCommunityToast();

  const [items, setItems] = useState<CenterNotification[]>(initial);
  const [cursor, setCursor] = useState<CenterCursor | null>(initialCursor);
  const [tab, setTab] = useState<"all" | "unread">("all");
  const [loadingMore, setLoadingMore] = useState(false);
  const [markingAll, setMarkingAll] = useState(false);
  // null = fine; "fetch" = no list at all (ErrorState + retry); "load" = an
  // older page failed (inline recoverable banner + retry).
  const [fetchError, setFetchError] = useState<boolean>(unavailable);
  const [loadError, setLoadError] = useState(false);
  // Recoverable read-failure notice (mark one / mark all).
  const [readError, setReadError] = useState(false);

  const knownIds = useRef<Set<string>>(new Set(initial.map((i) => i.id)));
  void me; // the viewer is derived server-side in every action

  // Room directory: id → { name, slug } (display name for text, slug for the
  // URL — destinations are always built from these KNOWN values).
  const rooms = useMemo(() => {
    const map = new Map<string, { name: string; slug: string }>();
    for (const category of categories) {
      for (const room of category.rooms) map.set(room.id, { name: room.name, slug: room.slug });
    }
    return map;
  }, [categories]);

  const actorName = useCallback(
    (id: string | null): string | null =>
      id ? (members.find((m) => m.user_id === id)?.display_name ?? null) : null,
    [members],
  );

  // Phase 10: the actor's badge resolves from the SAME members directory as
  // the name — the flag is server-computed there; no client input involved.
  const actorIsAdmin = useCallback(
    (id: string | null): boolean =>
      id ? (members.find((m) => m.user_id === id)?.platform_admin === true) : false,
    [members],
  );

  // --- Live inserts (shell bus — the ONE notifications channel) -----------
  useEffect(
    () =>
      onCommunityNotification((n) => {
        if (knownIds.current.has(n.id)) return;
        knownIds.current.add(n.id);
        setItems((prev) => [busToItem(n), ...prev]);
      }),
    [],
  );

  // --- Render text (structured → i18n; legacy rows keep stored text) ------
  const textFor = useCallback(
    (item: CenterNotification): { title: string; content: string } => {
      const actor = actorName(item.actorId);
       const room = item.roomId ? (rooms.get(item.roomId)?.name ?? null) : null;
       const kind = socialKindOf(item);
       switch (kind) {
        case "friend_request":
          return actor
            ? {
                title: t("community.notifications.friendRequestTitle"),
                content: t("community.notifications.friendRequestContent", { name: actor }),
              }
            : { title: item.title, content: item.content };
        case "friend_accepted":
          return actor
            ? {
                title: t("community.notifications.friendAcceptedTitle"),
                content: t("community.notifications.friendAcceptedContent", { name: actor }),
              }
            : { title: item.title, content: item.content };
        case "mention":
          return actor && room
            ? {
                title: t("community.notifications.mentionTitle"),
                content: t("community.notifications.mentionContent", { name: actor, room }),
              }
            : { title: item.title, content: item.content };
        case "reply":
          return actor && room
            ? {
                title: t("community.notifications.replyTitle"),
                content: t("community.notifications.replyContent", { name: actor, room }),
              }
            : { title: item.title, content: item.content };
        case "reaction":
          return actor
            ? {
                title: t("community.notifications.reactionTitle"),
                content: t("community.notifications.reactionContent", {
                  name: actor,
                  emoji: item.reactionEmoji ?? "",
                }),
              }
            : { title: item.title, content: item.content };
         case "direct_message":
           return actor
             ? {
                 title: t("community.notifications.dmTitle"),
                 content: t("community.notifications.dmFrom", { name: actor }),
               }
             : { title: item.title, content: item.content };
         case "answer":
           // The stored content is the referenced question's title.
           return actor
             ? {
                 title: t("community.notifications.answerTitle"),
                 content: t("community.notifications.answerContent", {
                   name: actor,
                   title: item.content,
                 }),
               }
             : { title: item.title, content: item.content };
         case "answer_accepted":
           return {
             title: t("community.notifications.acceptedTitle"),
             content: t("community.notifications.acceptedContent", {
               title: item.content,
             }),
           };
         default:
          // Platform / legacy rows: the stored text is the only content.
          return { title: item.title, content: item.content };
      }
    },
    [actorName, rooms, t],
  );

  // --- Navigation (known ids/slugs only — never an arbitrary URL) ---------
  const targetFor = useCallback(
    (item: CenterNotification): string | null => {
      const roomLink = (roomId: string | null, messageId: string | null): string | null => {
        const room = roomId ? rooms.get(roomId) : null;
        if (!room) return null;
        return messageId ? `/community/${room.slug}?message=${messageId}` : `/community/${room.slug}`;
      };
       const kind = socialKindOf(item);
       switch (kind) {
         case "friend_request":
         case "friend_accepted":
           return "/community/friends";
        case "mention":
        case "reply":
          return roomLink(item.roomId, item.roomMessageId);
        case "reaction":
          return item.conversationId
            ? `/community/messages/${item.conversationId}`
            : roomLink(item.roomId, item.roomMessageId);
         case "direct_message":
           return item.conversationId ? `/community/messages/${item.conversationId}` : null;
         case "answer":
           if (!item.questionId) return roomLink(item.roomId, item.roomMessageId);
           // Scroll the question page to the concrete answer when present.
           return item.answerId
             ? `/community/questions/${item.questionId}#answer-${item.answerId}`
             : `/community/questions/${item.questionId}`;
         case "answer_accepted":
           return item.questionId
             ? `/community/questions/${item.questionId}`
             : roomLink(item.roomId, item.roomMessageId);
         default:
           return null;
      }
    },
    [rooms],
  );

  // --- Read state (optimistic + revert) -----------------------------------
  const openItem = useCallback(
    (item: CenterNotification) => {
      const target = targetFor(item);
      if (target) router.push(target);
      if (item.read) return;
      setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, read: true } : i)));
      void markNotificationRead(item.id).catch(() => {
        // Restore the unread state — the notification is never lost.
        setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, read: false } : i)));
        setReadError(true);
      });
    },
    [router, targetFor],
  );

  const markAll = useCallback(async () => {
    if (markingAll) return; // double-submit guard
    setMarkingAll(true);
    const snapshot = items;
    setReadError(false);
    setItems((prev) => prev.map((i) => (i.read ? i : { ...i, read: true })));
    try {
      await markAllNotificationsRead();
      toast.notify({
        kind: "success",
        text: t("community.toast.allRead"),
        dedupeKey: "mark-all-read",
      });
    } catch {
      setItems(snapshot); // revert (the UI never lies)
      setReadError(true);
      toast.notify({
        kind: "error",
        text: t("community.toast.actionError"),
        dedupeKey: "mark-all-read",
      });
    } finally {
      setMarkingAll(false);
    }
  }, [items, markingAll, t, toast]);

  // --- Cursor pagination ---------------------------------------------------
  const loadMore = useCallback(async () => {
    if (loadingMore || !cursor) return;
    setLoadingMore(true);
    setLoadError(false);
    try {
      const more = await loadMoreNotifications(cursor);
      if (more.unavailable) {
        setLoadError(true);
        return;
      }
      if (more.items.length > 0) {
        setItems((prev) => {
          const next = [...prev];
          for (const m of more.items) {
            if (knownIds.current.has(m.id)) continue;
            knownIds.current.add(m.id);
            next.push(m);
          }
          return next;
        });
      }
      setCursor(more.cursor);
    } finally {
      setLoadingMore(false);
    }
  }, [cursor, loadingMore]);

  /** First-page retry (server prefetch failed, or the list is empty + error). */
  const retryFirst = useCallback(async () => {
    setFetchError(false);
    setLoadError(false);
    const first = await loadFirstNotifications();
    if (first.unavailable) {
      setFetchError(true);
      return;
    }
    knownIds.current = new Set(first.items.map((i) => i.id));
    setItems(first.items);
    setCursor(first.cursor);
  }, []);

  // --- Grouping + tabs ------------------------------------------------------
  const unreadCount = useMemo(() => items.filter((i) => !i.read).length, [items]);
  const visible = useMemo(
    () => (tab === "unread" ? items.filter((i) => !i.read) : items),
    [items, tab],
  );
  const startOfToday = useMemo(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }, []);
  const groups = useMemo(() => {
    const by: Record<DayGroup, CenterNotification[]> = { today: [], yesterday: [], earlier: [] };
    for (const item of visible) by[dayGroupFor(item.created_at, startOfToday)].push(item);
    return by;
  }, [visible, startOfToday]);

  const groupLabel = (g: DayGroup): string =>
    g === "today" ? t("community.groupToday") : g === "yesterday" ? t("community.groupYesterday") : t("community.groupEarlier");

  const emptyUnread = tab === "unread" && visible.length === 0;

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-3 px-4 py-4 sm:px-6 sm:py-6">
        {/* Header */}
        <div className="flex items-start justify-between gap-3">
          <div>
            <h1 className="text-lg font-bold text-ink">{t("community.notificationsTitle")}</h1>
            <p className="text-xs text-muted">{t("community.notificationsSubtitle")}</p>
          </div>
          {unreadCount > 0 && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void markAll()}
              disabled={markingAll}
              aria-busy={markingAll || undefined}
            >
              {/* Stacked labels: the width never jumps while marking. */}
              <span className="relative grid">
                <span className={`col-start-1 row-start-1 ${markingAll ? "invisible" : ""}`}>
                  {t("community.markAllRead")}
                </span>
                <span
                  className={`col-start-1 row-start-1 flex items-center justify-center gap-1.5 ${markingAll ? "" : "invisible"}`}
                >
                  {markingAll && <ActionSpinner className="h-3.5 w-3.5" />}
                  {t("community.markAllRead")}
                </span>
              </span>
            </Button>
          )}
        </div>

        {/* Tabs: All / Unread */}
        <div className="flex items-center gap-1.5" role="tablist" aria-label={t("community.notificationsTitle")}>
          {(["all", "unread"] as const).map((value) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={tab === value}
              onClick={() => setTab(value)}
              className={`rounded-full px-3.5 py-1.5 text-xs font-semibold ${COMMUNITY_PRESS_CLASS} ${
                tab === value
                  ? "bg-accent-soft text-accent"
                  : "text-muted hover:bg-surface-2 hover:text-ink"
              }`}
            >
              {value === "all" ? t("community.tabAll") : t("community.tabUnread")}
              {value === "unread" && unreadCount > 0 && (
                <span className="ms-1.5 tabular-nums text-faint">{unreadCount}</span>
              )}
            </button>
          ))}
        </div>

        {/* Recoverable read-failure notice */}
        {readError && (
          <div
            role="alert"
            className="flex items-center gap-2 rounded-xl border border-danger/30 bg-danger-soft px-3 py-2 text-xs font-medium text-danger"
          >
            <Icon name="alert" size={13} />
            {t("community.actionFailed")}
          </div>
        )}

        {fetchError ? (
          <div className="flex flex-1 items-center justify-center py-10">
            <ErrorState
              title={t("community.notificationsTitle")}
              onRetry={() => void retryFirst()}
            />
          </div>
        ) : visible.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 py-16 text-center">
            <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-surface-2 text-faint">
              <Icon name="bell" size={20} />
            </span>
            <p className="text-sm font-semibold text-muted">
              {emptyUnread ? t("community.noUnread") : t("community.noNotifications")}
            </p>
          </div>
        ) : (
          <ul className="flex flex-col gap-4" aria-live="polite">
            {DAY_GROUPS.filter((g) => groups[g].length > 0).map((g) => (
              <li key={g} className="flex flex-col gap-1">
                <h2 className="px-1 text-[11px] font-bold uppercase tracking-wide text-faint">
                  {groupLabel(g)}
                </h2>
                <ul className="flex flex-col gap-1">
                  {groups[g].map((item) => {
                    const text = textFor(item);
                    const target = targetFor(item);
                    const inner = (
                      <>
                        <span
                          className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-xl ${
                            item.read ? "bg-surface-2 text-faint" : "bg-accent-soft text-accent"
                          }`}
                        >
                          <Icon name={iconFor(socialKindOf(item))} size={15} />
                        </span>
                         <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-1.5">
                            <span
                              className={`truncate text-sm ${
                                item.read ? "font-medium text-ink-soft" : "font-bold text-ink"
                              }`}
                            >
                              {text.title}
                            </span>
                            {actorIsAdmin(item.actorId) && (
                              <AdminBadge size={12} label={t("community.adminBadge")} />
                            )}
                            {!item.read && (
                              <span
                                aria-hidden="true"
                                className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent"
                              />
                            )}
                            <span className="ms-auto shrink-0 text-[11px] tabular-nums text-faint">
                              {new Date(item.created_at).toLocaleTimeString(undefined, {
                                hour: "2-digit",
                                minute: "2-digit",
                              })}
                            </span>
                          </span>
                          {text.content && (
                            <span className="block truncate text-xs text-muted">{text.content}</span>
                          )}
                        </span>
                      </>
                    );
                    return (
                      <li key={item.id}>
                        {target ? (
                          <button
                            type="button"
                            onClick={() => openItem(item)}
                            aria-label={`${text.title}. ${text.content}${item.read ? "" : ` (${t("community.unreadAria")})`}`}
                            className={`flex w-full items-center gap-2.5 rounded-xl border border-line bg-surface px-2.5 py-2 text-start ${COMMUNITY_PRESS_CLASS} active:bg-surface-2 hover:border-line-strong hover:bg-surface-2/60`}
                          >
                            {inner}
                          </button>
                        ) : (
                          <div
                            className="flex items-center gap-2.5 rounded-xl border border-line bg-surface px-2.5 py-2"
                            aria-label={`${text.title}. ${text.content}`}
                          >
                            {inner}
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </li>
            ))}
          </ul>
        )}

        {/* Cursor pagination */}
        {!fetchError && visible.length > 0 && (
          <div className="flex flex-col items-center gap-1.5 pb-4">
            {loadError && (
              <p role="alert" className="text-xs font-medium text-danger">
                {t("community.actionFailed")}
              </p>
            )}
            {cursor ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void loadMore()}
                disabled={loadingMore}
                aria-busy={loadingMore || undefined}
              >
                {/* Stacked labels: the width never jumps while loading. */}
                <span className="relative grid">
                  <span className={`col-start-1 row-start-1 ${loadingMore ? "invisible" : ""}`}>
                    {t("community.loadMore")}
                  </span>
                  <span
                    className={`col-start-1 row-start-1 flex items-center justify-center gap-1.5 ${loadingMore ? "" : "invisible"}`}
                  >
                    {loadingMore && <ActionSpinner className="h-3.5 w-3.5" />}
                    {t("community.loadMore")}
                  </span>
                </span>
              </Button>
            ) : (
              !loadError && (
                <p className="text-[11px] text-faint">{t("community.noMore")}</p>
              )
            )}
          </div>
        )}
      </div>
    </div>
  );
}
