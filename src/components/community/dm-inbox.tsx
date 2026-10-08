"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useConversationListRealtime } from "@/lib/community/conversation-realtime";
import type { RealtimeLikeChannel } from "@/lib/community/realtime-core";
import { useCommunityPolling } from "@/lib/community/community-polling";
import { Icon } from "@/components/icon";
import { ErrorState } from "@/components/ui";
import { useI18n } from "@/lib/i18n";
import { communityAvatarUrl } from "@/lib/community";
import { formatMessageTime } from "./message-row";
import type { SocialProfileClient } from "./profile-card";
import { AdminBadge } from "./admin-badge";
import { presenceDotClass } from "./presence-indicator";

/**
 * The DM INBOX — every conversation the viewer belongs to, newest activity
 * first, with the unread badge (SQL-computed, never a message download).
 *
 * `variant="page"`: the /community/messages view (centered column).
 * `variant="sidebar"`: the desktop column beside an active conversation.
 * Mobile always uses the full-width page variant (list → tap → conversation
 * → back — the conversation view owns its own header/back button).
 *
 * Live: new messages stream over the postgres channel (RLS-scoped to the
 * viewer's conversations); a debounced summary re-fetch keeps the previews
 * and unread counts honest without any polling.
 */

export interface DmConversationRow {
  conversationId: string;
  other: SocialProfileClient;
  unread: number;
  lastMessageAt: string | null;
  lastMessage: string | null;
  lastMessageIsImage: boolean;
  lastMessageMine: boolean;
}

export interface DmInboxProps {
  me: { userId: string };
  initial: DmConversationRow[];
  unavailable: boolean;
  /** The conversation in the URL (sidebar active state). */
  activeConversationId?: string | null;
  variant?: "page" | "sidebar";
}

const REFETCH_DEBOUNCE_MS = 300;

export function DmInbox({
  me,
  initial,
  unavailable,
  activeConversationId = null,
  variant = "page",
}: DmInboxProps) {
  const { t, lang } = useI18n();
  const [conversations, setConversations] = useState<DmConversationRow[]>(initial);
  const [failed, setFailed] = useState(unavailable);
  const refetchTimer = useRef<number | null>(null);
  const refetching = useRef(false);
  // Latest list for the poll's change detection (single-writer mirror).
  const conversationsRef = useRef(conversations);
  useEffect(() => {
    conversationsRef.current = conversations;
  }, [conversations]);

  // One shared, overlap-guarded summary refresh — used by the CENTRALIZED
  // 1s poll (the synchronization guarantee) AND the realtime event path.
  // `?poll=1` keeps every background refresh in the higher community_poll
  // bucket. Change detection: an UNCHANGED summary causes zero setState,
  // so a quiet inbox renders nothing every second.
  const refetch = useCallback(async (signal?: AbortSignal) => {
    if (refetching.current) return; // overlap guard: skip, don't stack
    refetching.current = true;
    try {
      const response = await fetch("/api/community/dm?poll=1", {
        cache: "no-store",
        signal,
      });
      if (!response.ok) return;
      const body = (await response.json()) as { conversations: DmConversationRow[] };
      const next = body.conversations;
      if (JSON.stringify(next) === JSON.stringify(conversationsRef.current)) {
        return; // identical → no state update, no re-render
      }
      setConversations(next);
      setFailed(false);
    } catch {
      /* keep the last good list; the next cycle retries */
    } finally {
      refetching.current = false;
    }
  }, []);

  // New messages (any direction) → converge the summaries. The postgres
  // stream is RLS-scoped to the viewer's conversations, so no conversation
  // filter is needed (and none is possible — one stream per user). The
  // subscription itself lives in the shared community realtime layer
  // (stable channel name, registry, teardown, reconnect tracking); the
  // 300ms debounce below is the ≤500ms coalescing window for rapid events.
  const scheduleRefetch = useCallback(() => {
    if (refetchTimer.current) window.clearTimeout(refetchTimer.current);
    refetchTimer.current = window.setTimeout(() => void refetch(), REFETCH_DEBOUNCE_MS);
  }, [refetch]);

  const registerInboxHandlers = useCallback(
    (channel: RealtimeLikeChannel) => {
      // INSERT: a new message (new preview, +1 unread, list moves).
      // UPDATE: the last message was edited (preview text changes).
      // DELETE: a message was removed (preview / count change).
      // All three converge with ONE debounced SQL summary refetch — the
      // list never downloads message content on realtime events.
      channel
        .on(
          "postgres_changes",
          { event: "INSERT", schema: "public", table: "community_direct_messages" },
          () => scheduleRefetch(),
        )
        .on(
          "postgres_changes",
          { event: "UPDATE", schema: "public", table: "community_direct_messages" },
          () => scheduleRefetch(),
        )
        .on(
          "postgres_changes",
          { event: "DELETE", schema: "public", table: "community_direct_messages" },
          () => scheduleRefetch(),
        );
    },
    [scheduleRefetch],
  );

  useConversationListRealtime(me.userId, {
    registerHandlers: registerInboxHandlers,
    // Reconnect recovery: ONE targeted summary refetch — in addition to the
    // 1s poll below (same guarded function, no overlap possible).
    onMissedSync: () => {
      if (refetchTimer.current) window.clearTimeout(refetchTimer.current);
      void refetch();
    },
  });

  // THE 1s synchronization guarantee (all devices): the centralized poll
  // refreshes ONLY the viewer's conversation summaries every 1000ms while
  // this list is mounted, pauses while hidden, and is a silent no-op when
  // the summary is unchanged.
  useCommunityPolling({
    key: `inbox:${me.userId}`,
    fetcher: (signal) => refetch(signal),
  });

  useEffect(() => {
    const timer = refetchTimer;
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, []);

  if (failed && conversations.length === 0) {
    return (
      <div className="p-4">
        <ErrorState onRetry={() => void refetch()} />
      </div>
    );
  }

  const list = (
    <ul className="space-y-0.5 p-2">
      {conversations.length === 0 && (
        <li className="px-3 py-8 text-center text-xs leading-5 text-faint">
          {t("community.noConversations")}
          <span className="mt-1 block text-[11px]">{t("community.noConversationsCta")}</span>
        </li>
      )}
      {conversations.map((c) => {
        const active = c.conversationId === activeConversationId;
        return (
          <li key={c.conversationId}>
            <Link
              href={`/community/messages/${c.conversationId}`}
              aria-current={active ? "page" : undefined}
              className={`flex w-full items-center gap-3 rounded-xl px-2.5 py-2.5 text-start transition-colors ${
                active ? "bg-accent-soft/60" : "hover:bg-surface-2/60"
              }`}
            >
              <span className="relative shrink-0">
                {/* eslint-disable-next-line @next/next/no-img-element -- avatar: fixed 40px, static public asset */}
                <img
                  src={communityAvatarUrl(c.other.avatarId)}
                  alt=""
                  width={40}
                  height={40}
                  loading="lazy"
                  className="h-10 w-10 rounded-xl object-cover"
                />
                {/* Phase 3: the shared presence dot (privacy-mapped state;
                    `online` flag as fallback for older payloads). */}
                <span
                  className={`absolute -bottom-0.5 -end-0.5 ${presenceDotClass(
                    c.other.presence ?? (c.other.online ? "online" : "offline"),
                  )}`}
                  aria-hidden="true"
                />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex min-w-0 items-center gap-1.5">
                  <span
                    className={`block truncate text-sm ${
                      c.unread > 0 ? "font-bold text-ink" : "font-semibold text-ink-soft"
                    }`}
                  >
                    {c.other.displayName}
                  </span>
                  {c.other.isPlatformAdmin === true && (
                    <AdminBadge size={12} label={t("community.adminBadge")} />
                  )}
                </span>
                <span
                  className={`mt-0.5 flex items-center gap-1 truncate text-xs ${
                    c.unread > 0 ? "font-semibold text-ink-soft" : "text-faint"
                  }`}
                >
                  {c.lastMessageIsImage ? (
                    <>
                      <Icon name="image" size={11} className="shrink-0" />
                      <span className="truncate">{t("community.dmImagePreview")}</span>
                    </>
                  ) : (
                    <span className="truncate">
                      {c.lastMessage ?? t("community.noConversations")}
                    </span>
                  )}
                </span>
              </span>
              <span className="flex shrink-0 flex-col items-end gap-1">
                {c.lastMessageAt && (
                  <span className="text-[10px] font-medium text-faint">
                    {formatMessageTime(c.lastMessageAt, localeFor(lang))}
                  </span>
                )}
                {c.unread > 0 && (
                  <span
                    className="flex h-5 min-w-5 items-center justify-center rounded-full bg-accent px-1.5 text-[10px] font-bold text-white"
                    aria-label={t("community.messagesBadge", { count: c.unread })}
                  >
                    {c.unread > 99 ? "99+" : c.unread}
                  </span>
                )}
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );

  if (variant === "sidebar") {
    return <nav aria-label={t("community.messagesTitle")} className="flex h-full min-h-0 flex-col">{list}</nav>;
  }

  return (
    <div className="absolute inset-0 overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl px-4 py-5 sm:px-6">
        <h1 className="text-xl font-bold text-ink">{t("community.messagesTitle")}</h1>
        <p className="mt-0.5 text-sm text-muted">{t("community.messagesSubtitle")}</p>
        <div className="mt-5 overflow-hidden rounded-3xl border border-line bg-surface shadow-[var(--shadow-card)]">
          {list}
        </div>
      </div>
    </div>
  );
}

function localeFor(l: string): string {
  return l === "de" ? "de-DE" : l === "fr" ? "fr-FR" : l === "ar" ? "ar" : "en-US";
}
