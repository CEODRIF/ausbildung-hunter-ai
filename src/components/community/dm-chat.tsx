"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { useI18n } from "@/lib/i18n";
import { Icon } from "@/components/icon";
import { markDmRead } from "@/app/community/actions";
import {
  COMMUNITY_IMAGE_MIMES,
  COMMUNITY_MAX_IMAGE_BYTES,
  COMMUNITY_PAGE_SIZE,
  communityAvatarUrl,
  createOptimisticMessage,
  isOwnMessage,
  mergeCommunityMessages,
  setSendStatus,
  type CommunityAuthor,
  type CommunityMessageReactionAgg,
  type LocalMessage,
} from "@/lib/community";
import {
  applyTypingEvent,
  buildTypingLabel,
  createTypingState,
  DM_TYPING_BROADCAST_EVENT,
  parseTypingBroadcast,
  selectActiveTypers,
  TypingSender,
  type TypingBroadcastType,
  type TypingPeer,
  type TypingState,
} from "@/lib/community/typing";
import {
  DM_MESSAGE_DELETE_BROADCAST_EVENT,
  DM_MESSAGE_UPDATE_BROADCAST_EVENT,
  parseDmMessageDeleteBroadcast,
  parseDmMessageUpdateBroadcast,
} from "@/lib/community/events";
import {
  parsePresenceBroadcast,
  PRESENCE_BROADCAST_CHANNEL,
  PRESENCE_BROADCAST_EVENT,
  type PresenceState,
} from "@/lib/community/presence";
import {
  resolveCommunityRealtimeClient,
  useDMRealtime,
} from "@/lib/community/conversation-realtime";
import { useCommunityPolling } from "@/lib/community/community-polling";
import {
  createEventBatcher,
  type EventBatcher,
  type RealtimeLikeChannel,
} from "@/lib/community/realtime-core";
import { useCommunityToast } from "./action-feedback";
import { MessageRow } from "./message-row";
import { Composer } from "./composer";
import { useCommunityShell } from "./community-shell";
import { AdminBadge } from "./admin-badge";
import type { SocialProfileClient } from "./profile-card";
import { presenceDotClass, PresenceIndicator } from "./presence-indicator";

/** How often the local timer re-prunes stale typing peers (no network). */
const TYPING_PRUNE_INTERVAL_MS = 1000;

/**
 * One DM CONVERSATION, live (Phase 2).
 *
 * The machinery is the room chat's, scoped to ONE conversation:
 *  - ONE realtime channel per conversation (`community-dm:<id>`); the page
 *    remounts the component via key={conversation.id} on every switch, so
 *    the previous channel is always torn down (no duplicate listeners, no
 *    cross-conversation bleed).
 *  - postgres INSERT/UPDATE/DELETE on community_direct_messages filtered by
 *    conversation_id (RLS: members only) + the actor re-broadcasts edits/
 *    deletes on the channel (owner-only rows would otherwise stream to the
 *    actor alone) + reactions INSERT/DELETE (guarded against this
 *    conversation's message ids) + the ephemeral typing broadcast.
 *  - Optimistic send with a client-generated id (the API is idempotent on
 *    it) — text AND images (≤ 2 MB, jpeg/png/webp; the server re-validates
 *    from the bytes and generates the storage path).
 *  - Cursor pagination ("load older" — 50 per page), never a full history
 *    load; read cursor (per conversation) for the unread badge.
 */

interface DmChatProps {
  me: { userId: string; displayName: string; avatarId: string; platformAdmin?: boolean };
  conversation: { id: string };
  /** The other member (server-resolved; null when their profile is gone). */
  other: SocialProfileClient | null;
  initialMessages: LocalMessage[];
  historyUnavailable?: boolean;
}

type ConnectionState = "connected" | "disconnected";
type RealtimeClient = ReturnType<typeof createClient>;
type RealtimeChannel = ReturnType<RealtimeClient["channel"]>;

/** One coalesced realtime INSERT (applied as a batch to the DM list). */
interface DmInsertEvent {
  row: LocalMessage;
  /** Already known (the echo of our own optimistic row). */
  dup: boolean;
  mine: boolean;
}

function localeFor(lang: string): string {
  return lang === "de" ? "de-DE" : lang === "fr" ? "fr-FR" : lang === "ar" ? "ar" : "en-US";
}

function scrollBehavior(): ScrollBehavior {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
}

/** DMs have no mention chips — a stable empty set keeps MessageRow memoized. */
const NO_KNOWN_MEMBERS: ReadonlySet<string> = new Set();

export function DmChat({
  me,
  conversation,
  other,
  initialMessages,
  historyUnavailable = false,
}: DmChatProps) {
  const { t, lang } = useI18n();
  const { openProfile } = useCommunityShell();
  // Localized action feedback (the shared system — see action-feedback.tsx):
  // failures surface as small deduplicated toasts; the chat itself keeps
  // working (optimistic rows + retry + realtime echo convergence).
  const toast = useCommunityToast();
  const locale = useMemo(() => localeFor(lang), [lang]);
  const [messages, setMessages] = useState<LocalMessage[]>(initialMessages);
  const [authors, setAuthors] = useState<Record<string, CommunityAuthor>>(() => {
    const seed: Record<string, CommunityAuthor> = {};
    for (const m of initialMessages) {
      if (m.author && !seed[m.user_id]) seed[m.user_id] = m.author;
    }
    return seed;
  });
  const [connection, setConnection] = useState<ConnectionState>("connected");
  const [historyMissing, setHistoryMissing] = useState(historyUnavailable);
  const [olderLoading, setOlderLoading] = useState(false);
  const [hasMoreOlder, setHasMoreOlder] = useState(
    initialMessages.length >= COMMUNITY_PAGE_SIZE,
  );
  const [text, setText] = useState("");
  const [pendingImage, setPendingImage] = useState<{ file: File; url: string } | null>(null);
  const [imageError, setImageError] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [imageUrls, setImageUrls] = useState<Record<string, string>>({});
  const [replyTo, setReplyTo] = useState<LocalMessage | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [focusKey, setFocusKey] = useState(0);
  const [newCount, setNewCount] = useState(0);
  const [lightbox, setLightbox] = useState<string | null>(null);
  const [blockedNotice, setBlockedNotice] = useState(false);
  // Phase 3: the peer's LIVE presence (member-scoped broadcast channel —
  // the SAME per-user channel the presence hook publishes on). A user with
  // show_presence = false publishes nothing, so any broadcast received here
  // is safe to show. Stale/out-of-order payloads (older ts) are dropped.
  const [peerLive, setPeerLive] = useState<{ state: PresenceState; lastSeenAt: string; ts: number } | null>(null);
  const peerLiveTsRef = useRef(0);

  const listRef = useRef<HTMLDivElement>(null);
  const knownIds = useRef<Set<string>>(new Set(initialMessages.map((m) => m.id)));
  const authorsRef = useRef(authors);
  useEffect(() => {
    authorsRef.current = authors;
  }, [authors]);
  const connectionRef = useRef<ConnectionState>("connected");
  useEffect(() => {
    connectionRef.current = connection;
  }, [connection]);
  const stickToBottom = useRef(true);
  const restoreScroll = useRef<{ prevHeight: number; prevTop: number } | null>(null);
  const markReadTimer = useRef<number | null>(null);
  const sawDisconnected = useRef(false);
  const lastIdRef = useRef<string | null>(
    initialMessages.length > 0 ? initialMessages[initialMessages.length - 1].id : null,
  );
  const mountedRef = useRef(false);
  // Latest rows for the poll's change-detection (single-writer mirror).
  const messagesRef = useRef(messages);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);
  const pendingFiles = useRef<Map<string, { file: File; url: string }>>(new Map());
  const [pendingImageUrls, setPendingImageUrls] = useState<Record<string, string>>({});
  const inFlightRef = useRef<Set<string>>(new Set());
  // --- Typing (ephemeral — in-memory only, no DB, TTL-pruned) ---
  const typingStateRef = useRef<TypingState>(createTypingState(me.userId));
  const channelRef = useRef<RealtimeChannel | null>(null);
  const senderRef = useRef<TypingSender | null>(null);
  const [typingPeers, setTypingPeers] = useState<TypingPeer[]>([]);

  const myAuthor = useMemo<CommunityAuthor>(
    () => ({
      user_id: me.userId,
      display_name: me.displayName,
      avatar_id: me.avatarId,
      // Server-stamped in the page (session user id → admins table).
      platform_admin: me.platformAdmin === true,
    }),
    [me],
  );

  // The peer's identity is known from the start (server-resolved) — the
  // only authors in a two-person conversation.
  useEffect(() => {
    if (other) {
      const seed: CommunityAuthor = {
        user_id: other.userId,
        display_name: other.displayName,
        avatar_id: other.avatarId,
        // Server-trusted (the endpoint computes it from the database id).
        platform_admin: other.isPlatformAdmin === true,
      };
      // Intentional: seed the known peer once per conversation mount.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setAuthors((prev) => (prev[other.userId] ? prev : { ...prev, [other.userId]: seed }));
    }
    // Seed once per conversation mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const clientRef = useRef<RealtimeClient | null>(null);
  const getClient = useCallback((): RealtimeClient | null => {
    if (clientRef.current) return clientRef.current;
    try {
      clientRef.current = createClient();
    } catch (error) {
      console.error("[community] realtime client unavailable:", error);
      return null;
    }
    return clientRef.current;
  }, []);

  const scheduleMarkRead = useCallback(() => {
    if (markReadTimer.current) window.clearTimeout(markReadTimer.current);
    markReadTimer.current = window.setTimeout(() => {
      void markDmRead(conversation.id);
    }, 600);
  }, [conversation.id]);

  // Opening the conversation marks it read (immediately, not throttled).
  useEffect(() => {
    void markDmRead(conversation.id);
    if (markReadTimer.current) window.clearTimeout(markReadTimer.current);
  }, [conversation.id]);

  // Resync the newest page of the ACTIVE conversation. Driven by the
  // CENTRALIZED 1s poll (the synchronization guarantee, all devices) AND by
  // events (realtime reconnect, tab visibility return). `?poll=1` uses the
  // higher rate bucket; the fetch is conversation-scoped only. The in-flight
  // guard makes poll + event calls share ONE canonical overlap protection.
  const resyncInFlight = useRef(false);
  const resyncRecent = useCallback(
    async (signal?: AbortSignal) => {
      if (resyncInFlight.current) return; // overlap guard: skip, don't stack
      resyncInFlight.current = true;
      try {
        const response = await fetch(`/api/community/dm/${conversation.id}?poll=1`, {
          cache: "no-store",
          signal,
        });
        if (!response.ok) return; // e.g. 429 — keep state; the next cycle retries
        const data = (await response.json()) as { messages: LocalMessage[] };
        const before = new Set(knownIds.current);
        // NO-OP when nothing new AND nothing changed: the 1s poll runs
        // constantly — a quiet DM must not re-render every second.
        const localById = new Map(messagesRef.current.map((m) => [m.id, m] as const));
        let changed = false;
        for (const m of data.messages) {
          if (!before.has(m.id)) {
            changed = true;
            break;
          }
          const local = localById.get(m.id);
          if (
            local &&
            (local.message !== m.message ||
              (local.image_path ?? null) !== (m.image_path ?? null) ||
              (local.reply_to_message_id ?? null) !== (m.reply_to_message_id ?? null) ||
              local.updated_at !== m.updated_at ||
              local.sendStatus !== m.sendStatus)
          ) {
            changed = true;
            break;
          }
        }
        setHistoryMissing(false);
        if (!changed) return;
        for (const m of data.messages) knownIds.current.add(m.id);
        // Server rows win on id collision (the SAME canonical merge the
        // realtime handlers use — an optimistic row is replaced, never
        // duplicated, when its server twin arrives via poll or event).
        setMessages((prev) => mergeCommunityMessages(prev, data.messages, { preferIncoming: true }));
        const added = data.messages.filter((m) => !before.has(m.id)).length;
        if (added > 0 && !stickToBottom.current) setNewCount((c) => c + added);
        setAuthors((prev) => {
          const next = { ...prev };
          for (const m of data.messages) if (m.author) next[m.user_id] = m.author;
          return next;
        });
        if (added > 0) scheduleMarkRead();
      } catch {
        /* keep current state; the next cycle retries (abort = unmount) */
      } finally {
        resyncInFlight.current = false;
      }
    },
    [conversation.id, scheduleMarkRead],
  );

  // --- Typing (ephemeral, over the conversation channel) ---

  const broadcastTyping = useCallback(
    (type: TypingBroadcastType) => {
      const channel = channelRef.current;
      if (!channel) return;
      void channel
        .send({
          type: "broadcast",
          event: DM_TYPING_BROADCAST_EVENT,
          payload: {
            type,
            conversationId: conversation.id,
            userId: me.userId,
            displayName: me.displayName,
            timestamp: Date.now(),
          },
        })
        .catch(() => {});
    },
    [conversation.id, me],
  );

  const refreshTyping = useCallback(() => {
    const active = selectActiveTypers(typingStateRef.current, Date.now());
    setTypingPeers((prev) =>
      prev.length === active.length &&
      prev.every(
        (p, i) => p.userId === active[i].userId && p.name === active[i].name && p.at === active[i].at,
      )
        ? prev
        : active,
    );
  }, []);

  const clearTyping = useCallback(() => {
    typingStateRef.current = createTypingState(typingStateRef.current.selfId);
    setTypingPeers([]);
  }, []);

  // --- Realtime: ONE shared channel for this conversation (event-driven,
  // no polling). The subscription machinery (JWT handshake, stable channel
  // name, ref-counted registry, teardown on unmount/conversation switch,
  // reconnect tracking) lives in the shared community realtime layer; this
  // surface registers its handlers. INSERTs flow through a
  // leading-edge-immediate batcher: a single DM is applied synchronously
  // (effectively instant), a burst of rapid incoming messages flushes at
  // most 500ms apart with ONE setState per batch (no re-render per event).
  const insertBatcherRef = useRef<EventBatcher<DmInsertEvent> | null>(null);

  const applyInsertBatch = useCallback(
    (batch: readonly DmInsertEvent[]) => {
      setMessages((prev) =>
        mergeCommunityMessages(
          prev,
          batch.map((e) => e.row),
          { preferIncoming: true },
        ),
      );
      for (const e of batch) {
        if (!e.dup && !e.mine) {
          if (!stickToBottom.current) setNewCount((c) => c + 1);
          scheduleMarkRead();
        }
      }
    },
    [scheduleMarkRead],
  );

  const registerDmHandlers = useCallback(
    (channel: RealtimeLikeChannel) => {
      const convFilter = `conversation_id=eq.${conversation.id}`;
      const applyReactionDelta = (
        set: boolean,
        message_id: string,
        emoji: string,
        userId: string,
      ) => {
        if (!knownIds.current.has(message_id)) return; // not this conversation's state
        const mine = userId === me.userId;
        setMessages((prev) =>
          prev.map((m) => {
            if (m.id !== message_id) return m;
            const agg: CommunityMessageReactionAgg[] = m.reactions.map((r) => ({ ...r }));
            const found = agg.find((r) => r.emoji === emoji);
            if (set) {
              if (found) {
                found.count += 1;
                if (mine) found.mine = true;
              } else {
                agg.push({ emoji, count: 1, mine });
              }
            } else if (found) {
              found.count -= 1;
              if (mine) found.mine = false;
              const next = agg.filter((r) => r.count > 0);
              return { ...m, reactions: next };
            }
            return { ...m, reactions: agg };
          }),
        );
      };
      insertBatcherRef.current?.dispose();
      insertBatcherRef.current = createEventBatcher({ onFlush: applyInsertBatch });
      channel
        .on(
          "postgres_changes",
          { event: "INSERT", schema: "public", table: "community_direct_messages", filter: convFilter },
          (payload) => {
            const incoming = payload.new as LocalMessage;
            if (!incoming?.id) return;
            const dup = knownIds.current.has(incoming.id);
            knownIds.current.add(incoming.id);
            const mine = incoming.user_id === me.userId;
            insertBatcherRef.current?.push({
              row: { ...incoming, author: mine ? myAuthor : null, reactions: [], replyTo: null },
              dup,
              mine,
            });
          }
        )
        .on(
          "postgres_changes",
          { event: "UPDATE", schema: "public", table: "community_direct_messages", filter: convFilter },
          (payload) => {
            const incoming = payload.new as LocalMessage;
            if (!incoming?.id) return;
            // RLS: my edits only — merge (the broadcast reaches the peer).
            setMessages((prev) =>
              mergeCommunityMessages(
                prev,
                [{ ...incoming, author: myAuthor, reactions: [], replyTo: null }],
                { preferIncoming: true },
              ),
            );
          }
        )
        .on(
          "postgres_changes",
          { event: "DELETE", schema: "public", table: "community_direct_messages", filter: convFilter },
          (payload) => {
            const deleted = (payload.old as { id?: string })?.id;
            if (!deleted) return;
            // RLS: only my own deletions reach this stream.
            knownIds.current.delete(deleted);
            setMessages((prev) => prev.filter((m) => m.id !== deleted));
          }
        )
        .on(
          "postgres_changes",
          { event: "INSERT", schema: "public", table: "community_dm_reactions" },
          (payload) => {
            const row = payload.new as { message_id?: string; emoji?: string; user_id?: string };
            if (!row?.message_id || !row.emoji || !row.user_id) return;
            applyReactionDelta(true, row.message_id, row.emoji, row.user_id);
          },
        )
        .on(
          "postgres_changes",
          { event: "DELETE", schema: "public", table: "community_dm_reactions" },
          (payload) => {
            const row = payload.old as { message_id?: string; emoji?: string; user_id?: string };
            if (!row?.message_id || !row.emoji || !row.user_id) return;
            applyReactionDelta(false, row.message_id, row.emoji, row.user_id);
          },
        )
        .on("broadcast", { event: DM_TYPING_BROADCAST_EVENT }, (payload) => {
          const wire = payload?.payload as { conversationId?: unknown } | undefined;
          if (typeof wire?.conversationId !== "string" || wire.conversationId !== conversation.id) {
            return; // conversation guard (shared socket)
          }
          const broadcast = parseTypingBroadcast(payload?.payload);
          if (!broadcast) return;
          typingStateRef.current = applyTypingEvent(typingStateRef.current, broadcast, Date.now());
          refreshTyping();
        })
        .on("broadcast", { event: DM_MESSAGE_UPDATE_BROADCAST_EVENT }, (payload) => {
          const update = parseDmMessageUpdateBroadcast(payload?.payload);
          if (!update || update.conversationId !== conversation.id) return;
          setMessages((prev) =>
            mergeCommunityMessages(
              prev,
              [{ ...update.message, room_id: conversation.id, author: null, reactions: [], replyTo: null } as LocalMessage],
              { preferIncoming: true },
            ),
          );
        })
        .on("broadcast", { event: DM_MESSAGE_DELETE_BROADCAST_EVENT }, (payload) => {
          const del = parseDmMessageDeleteBroadcast(payload?.payload);
          if (!del || del.conversationId !== conversation.id) return;
          knownIds.current.delete(del.id);
          setMessages((prev) => prev.filter((m) => m.id !== del.id));
        });
    },
    [applyInsertBatch, conversation.id, me.userId, myAuthor, refreshTyping],
  );

  useDMRealtime(conversation.id, {
    registerHandlers: registerDmHandlers,
    // Reconnect recovery: ONE targeted recent-window resync (a no-op when
    // nothing was missed) — in addition to the 1s poll below.
    onMissedSync: () => {
      void resyncRecent();
      clearTyping();
    },
    onConnection: (state) => {
      if (state === "disconnected") {
        sawDisconnected.current = true;
        // Flush pending outgoing typing so the peer never sees a stale dot.
        senderRef.current?.commit();
      }
      setConnection(state);
    },
    onChannel: (ch) => {
      // Invoked by the shared layer outside render (setup/teardown); the ref
      // mirrors the live channel for broadcast sends.
      channelRef.current = (ch as RealtimeChannel | null) ?? null;
      if (ch === null) insertBatcherRef.current?.flush();
    },
  });

  // THE 1s synchronization guarantee (all devices): the centralized poll
  // fetches ONLY this conversation's newest page every 1000ms while mounted,
  // pauses while hidden, and is a silent no-op when nothing changed.
  useCommunityPolling({
    key: `dm:${conversation.id}`,
    fetcher: (signal) => resyncRecent(signal),
  });

  // No realtime client available (env missing) → report degraded.
  useEffect(() => {
    if (resolveCommunityRealtimeClient() === null) {
      sawDisconnected.current = true;
      // One-shot degraded state on mount (env missing), not a cascade.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setConnection("disconnected");
    }
  }, []);

  // Batch teardown on unmount (the registry tears the channel itself down).
  useEffect(() => () => insertBatcherRef.current?.dispose(), []);

  // Outgoing typing controller (declared after the realtime effect so its
  // dispose runs while the channel still exists).
  useEffect(() => {
    const sender = new TypingSender({
      emit: (type) => broadcastTyping(type),
      scheduler: {
        schedule: (callback, ms) => window.setTimeout(callback, ms),
        cancel: (handle) => window.clearTimeout(handle as number),
      },
    });
    senderRef.current = sender;
    return () => {
      senderRef.current = null;
      sender.dispose();
    };
  }, [broadcastTyping]);

  // Stale cleanup: purely local re-prune timer.
  useEffect(() => {
    const id = window.setInterval(refreshTyping, TYPING_PRUNE_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [refreshTyping]);

  // Phase 3: live peer presence over the PER-USER broadcast channel
  // (community-presence-<otherUserId>). SEPARATE from the conversation
  // channel (no postgres RLS needed — it is a pure broadcast), member-scoped
  // and torn down on unmount. No timer is added: presence updates are
  // event-driven, and a fresh page render re-baselines from the server.
  useEffect(() => {
    const peerId = other?.userId;
    if (!peerId) return;
    let disposed = false;
    let channel: RealtimeChannel | null = null;
    const client = getClient();
    if (!client) return;
    const subscribeChannel = () => {
      if (disposed || channel) return;
      try {
        channel = client
          .channel(PRESENCE_BROADCAST_CHANNEL(peerId))
          .on("broadcast", { event: PRESENCE_BROADCAST_EVENT }, (payload) => {
            const broadcast = parsePresenceBroadcast(payload?.payload);
            if (!broadcast || broadcast.userId !== peerId) return;
            if (broadcast.ts <= peerLiveTsRef.current) return; // stale / out of order
            peerLiveTsRef.current = broadcast.ts;
            setPeerLive({ state: broadcast.mode, lastSeenAt: broadcast.lastSeenAt, ts: broadcast.ts });
          })
          .subscribe();
      } catch (error) {
        console.error("[community] dm presence subscribe failed:", error);
      }
    };
    void (async () => {
      try {
        await client.auth.initialize();
      } catch {
        return; // session restore failed: presence stays server-baselined
      }
      if (disposed) return;
      const {
        data: { session },
      } = await client.auth.getSession();
      if (disposed) return;
      if (session?.access_token) {
        await client.realtime.setAuth(session.access_token).catch(() => {});
        if (!disposed) subscribeChannel();
      }
    })();
    const authSub = client.auth.onAuthStateChange((event, session) => {
      if (session?.access_token) {
        void client.realtime
          .setAuth(session.access_token)
          .then(() => {
            if (event === "INITIAL_SESSION" || event === "SIGNED_IN") subscribeChannel();
          })
          .catch(() => {});
      }
    });
    return () => {
      disposed = true;
      authSub.data.subscription.unsubscribe();
      if (channel) void client.removeChannel(channel);
    };
  }, [getClient, other?.userId]);

  // Revoke every kept object URL on unmount.
  useEffect(() => {
    const map = pendingFiles.current;
    return () => {
      for (const p of map.values()) URL.revokeObjectURL(p.url);
      map.clear();
    };
  }, []);

  // Resolve signed URLs for message images (private bucket).
  const signedPaths = useRef<Set<string>>(new Set());
  useEffect(() => {
    const client = getClient();
    if (!client) return;
    const toSign = messages.filter((m) => m.image_path && !signedPaths.current.has(m.image_path));
    if (toSign.length === 0) return;
    for (const m of toSign) signedPaths.current.add(m.image_path as string);
    let cancelled = false;
    void (async () => {
      for (const m of toSign) {
        let signedUrl: string | null = null;
        try {
          const { data } = await client.storage
            .from("community-images")
            .createSignedUrl(m.image_path as string, 3600);
          signedUrl = data?.signedUrl ?? null;
        } catch (error) {
          console.error("[community] dm image signing failed:", error);
        }
        if (signedUrl && !cancelled) {
          setImageUrls((prev) =>
            prev[m.image_path as string] ? prev : { ...prev, [m.image_path as string]: signedUrl },
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [messages, getClient]);

  const loadOlder = useCallback(async () => {
    const oldest = messages[0];
    if (!oldest || olderLoading || !hasMoreOlder) return;
    const el = listRef.current;
    if (el) restoreScroll.current = { prevHeight: el.scrollHeight, prevTop: el.scrollTop };
    setOlderLoading(true);
    try {
      const response = await fetch(
        `/api/community/dm/${conversation.id}?before_at=${encodeURIComponent(oldest.created_at)}`,
        { cache: "no-store" },
      );
      if (!response.ok) return;
      const data = (await response.json()) as { messages: LocalMessage[] };
      for (const m of data.messages) knownIds.current.add(m.id);
      setMessages((prev) => mergeCommunityMessages(data.messages, prev));
      setHasMoreOlder(data.messages.length >= COMMUNITY_PAGE_SIZE);
      setAuthors((prev) => {
        const next = { ...prev };
        for (const m of data.messages) if (m.author) next[m.user_id] = m.author;
        return next;
      });
    } catch {
      restoreScroll.current = null;
    } finally {
      setOlderLoading(false);
    }
  }, [conversation.id, hasMoreOlder, olderLoading, messages]);

  // Scroll behaviour (same contract as the room chat).
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    if (restoreScroll.current) {
      el.scrollTop = el.scrollHeight - restoreScroll.current.prevHeight + restoreScroll.current.prevTop;
      restoreScroll.current = null;
      return;
    }
    const last = messages[messages.length - 1];
    if (!last) {
      mountedRef.current = true;
      return;
    }
    if (!mountedRef.current) {
      el.scrollTop = el.scrollHeight;
      mountedRef.current = true;
      lastIdRef.current = last.id;
      return;
    }
    if (last.id !== lastIdRef.current) {
      const mine = last.user_id === me.userId;
      lastIdRef.current = last.id;
      if (stickToBottom.current) {
        el.scrollTo({ top: el.scrollHeight, behavior: mine ? "auto" : scrollBehavior() });
      }
    }
  });

  const onScroll = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    stickToBottom.current = atBottom;
    if (atBottom) setNewCount(0);
    if (el.scrollTop < 60) void loadOlder();
  }, [loadOlder]);

  const jumpToLatest = useCallback(() => {
    const el = listRef.current;
    stickToBottom.current = true;
    setNewCount(0);
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: scrollBehavior() });
  }, []);

  const jumpToMessage = useCallback((messageId: string) => {
    const el = listRef.current;
    const target = el?.querySelector(`#cm-${CSS.escape(messageId)}`);
    if (!el || !target) return;
    stickToBottom.current = false;
    target.scrollIntoView({ block: "center", behavior: scrollBehavior() });
  }, []);

  // iOS Safari: keep the newest message in view while the keyboard is up
  // (the shell reserves the covered height via --kb).
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const onViewportChange = () => {
      const covered = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      if (covered <= 0) return;
      stickToBottom.current = true;
      setNewCount(0);
      const el = listRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    };
    vv.addEventListener("resize", onViewportChange);
    vv.addEventListener("scroll", onViewportChange);
    return () => {
      vv.removeEventListener("resize", onViewportChange);
      vv.removeEventListener("scroll", onViewportChange);
    };
  }, []);

  // Phones suspend the realtime socket while backgrounded. Returning to the
  // tab performs ONE targeted catch-up resync (a silent no-op when nothing
  // new/changed arrived) — never a periodic poll.
  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState !== "visible") return;
      void resyncRecent();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, [resyncRecent]);

  // Lightbox: close on Escape.
  useEffect(() => {
    if (!lightbox) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setLightbox(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lightbox]);

  // Close the touch action bar when tapping outside a row.
  useEffect(() => {
    if (!activeId) return;
    const onPointerDown = (event: Event) => {
      const target = event.target as HTMLElement | null;
      if (target && target.closest?.(`#cm-${CSS.escape(activeId)}`)) return;
      setActiveId(null);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [activeId]);

  const onPickImage = (file: File | null | undefined) => {
    setImageError(null);
    if (!file) return;
    senderRef.current?.commit();
    if (!(COMMUNITY_IMAGE_MIMES as readonly string[]).includes(file.type)) {
      setImageError("invalidImage");
      return;
    }
    if (file.size > COMMUNITY_MAX_IMAGE_BYTES) {
      setImageError("imageTooLarge");
      return;
    }
    if (pendingImage) URL.revokeObjectURL(pendingImage.url);
    setPendingImage({ file, url: URL.createObjectURL(file) });
  };

  const clearPendingImage = useCallback(() => setPendingImage(null), []);

  // --- Message actions (reactions / edit / delete) -------------------------

  const toggleReaction = useCallback(
    async (messageId: string, emoji: string) => {
      const previous = messages.find((m) => m.id === messageId)?.reactions;
      const withPrev = (reactions: CommunityMessageReactionAgg[]) =>
        setMessages((prev) => prev.map((m) => (m.id === messageId ? { ...m, reactions } : m)));
      const prev = previous ?? [];
      const existing = prev.find((r) => r.emoji === emoji);
      withPrev(
        existing
          ? prev
              .map((r) => (r.emoji === emoji ? { ...r, count: r.count - 1, mine: false } : r))
              .filter((r) => r.count > 0)
          : [...prev, { emoji, count: 1, mine: true }],
      );
      try {
        const response = await fetch(`/api/community/dm/messages/${messageId}/reactions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ emoji }),
        });
        if (!response.ok) throw new Error(`reaction ${response.status}`);
        const data = (await response.json()) as { reactions: CommunityMessageReactionAgg[] };
        withPrev(data.reactions);
      } catch {
        // Revert (the UI never lies) + a small deduplicated error toast.
        withPrev(prev);
        toast.notify({
          kind: "error",
          text: t("community.toast.actionError"),
          dedupeKey: "reaction",
        });
      }
    },
    [messages, toast, t],
  );

  const saveEdit = useCallback(
    async (messageId: string, newText: string) => {
      const current = messages.find((m) => m.id === messageId);
      const original = current?.message ?? null;
      if (!current || newText.trim() === original?.trim()) return;
      setMessages((prev) =>
        prev.map((m) =>
          m.id === messageId
            ? { ...m, message: newText.trim(), updated_at: new Date().toISOString() }
            : m,
        ),
      );
      try {
        const response = await fetch(`/api/community/dm/messages/${messageId}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ message: newText }),
        });
        if (!response.ok) throw new Error(`edit ${response.status}`);
        const data = (await response.json()) as {
          message: {
            id: string;
            user_id: string;
            message: string | null;
            image_path: string | null;
            reply_to_message_id: string | null;
            created_at: string;
            updated_at: string;
          };
        };
        void channelRef.current?.send({
          type: "broadcast",
          event: DM_MESSAGE_UPDATE_BROADCAST_EVENT,
          payload: { conversationId: conversation.id, message: data.message },
        });
      } catch {
        setMessages((prev) =>
          prev.map((m) => (m.id === messageId ? { ...m, message: original } : m)),
        );
        setSendError("send_failed");
      }
    },
    [conversation.id, messages],
  );

  const deleteMessage = useCallback(
    async (messageId: string) => {
      try {
        const response = await fetch(`/api/community/dm/messages/${messageId}`, {
          method: "DELETE",
        });
        if (!response.ok) throw new Error(`delete ${response.status}`);
        knownIds.current.delete(messageId);
        setMessages((prev) => prev.filter((m) => m.id !== messageId));
        setActiveId(null);
        if (replyTo?.id === messageId) setReplyTo(null);
        void channelRef.current?.send({
          type: "broadcast",
          event: DM_MESSAGE_DELETE_BROADCAST_EVENT,
          payload: { conversationId: conversation.id, id: messageId },
        });
      } catch {
        setSendError("send_failed");
        toast.notify({
          kind: "error",
          text: t("community.toast.deleteFailed"),
          dedupeKey: "delete-message",
        });
      }
    },
    [conversation.id, replyTo, toast, t],
  );

  // --- Sending -------------------------------------------------------------

  const postMessage = useCallback(
    async (p: { id: string; text: string; file: File | null; replyToId: string | null }) => {
      inFlightRef.current.add(p.id);
      setSubmitting(inFlightRef.current.size > 0);
      try {
        const form = new FormData();
        form.set("message", p.text);
        form.set("id", p.id);
        if (p.replyToId) form.set("reply_to", p.replyToId);
        if (p.file) form.set("image", p.file, "image");
        const response = await fetch(`/api/community/dm/${conversation.id}/messages`, {
          method: "POST",
          body: form,
        });
        if (!response.ok) {
          const body = (await response.json().catch(() => null)) as { error?: string } | null;
          const code =
            response.status === 429
              ? "rate_limited"
              : body?.error === "empty_message"
                ? "empty_message"
                : body?.error === "text_too_long"
                  ? "text_too_long"
                  : body?.error === "image_too_large"
                    ? "image_too_large"
                    : body?.error === "invalid_image"
                      ? "invalid_image"
                      : body?.error === "not_friends"
                        ? "not_friends"
                        : body?.error === "blocked"
                          ? "blocked"
                          : body?.error === "conversation_not_found"
                            ? "conversationNotFound"
                            : "send_failed";
          setMessages((prev) => setSendStatus(prev, p.id, "failed"));
          if (p.text) setText(p.text);
          if (code === "blocked") setBlockedNotice(true);
          if (code !== "send_failed") setSendError(code);
          return;
        }
        const data = (await response.json()) as {
          message: {
            id: string;
            user_id: string;
            message: string | null;
            image_path: string | null;
            reply_to_message_id: string | null;
            created_at: string;
            updated_at: string;
          };
        };
        const serverRow: LocalMessage = {
          ...data.message,
          room_id: conversation.id,
          author: myAuthor,
          reactions: [],
          replyTo: p.replyToId ? (messages.find((m) => m.id === p.replyToId) ?? null) : null,
        };
        setMessages((prev) => mergeCommunityMessages(prev, [serverRow], { preferIncoming: true }));
        scheduleMarkRead();
      } catch {
        setMessages((prev) => setSendStatus(prev, p.id, "failed"));
        if (p.text) setText(p.text);
      } finally {
        inFlightRef.current.delete(p.id);
        setSubmitting(inFlightRef.current.size > 0);
      }
    },
    [conversation.id, messages, myAuthor, scheduleMarkRead],
  );

  const submit = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed && !pendingImage) {
      setSendError("empty_message");
      return;
    }
    if (submitting) return;
    const id = crypto.randomUUID();
    const file = pendingImage?.file ?? null;
    const url = pendingImage?.url ?? null;
    const replyToId = replyTo?.id ?? null;
    const replyRow = replyTo ? { ...replyTo, replyTo: null } : null;
    const optimistic = createOptimisticMessage({
      id,
      roomId: conversation.id,
      user: myAuthor,
      text: trimmed || null,
      imagePath: null, // storage path is generated server-side
      replyToMessageId: replyToId,
      createdAt: new Date().toISOString(),
    });
    if (replyRow) optimistic.replyTo = replyRow;
    knownIds.current.add(id);
    if (file && url) {
      pendingFiles.current.set(id, { file, url });
      setPendingImageUrls((prev) => ({ ...prev, [id]: url }));
    }
    setMessages((prev) => mergeCommunityMessages(prev, [optimistic]));
    setText("");
    setReplyTo(null);
    if (pendingImage) clearPendingImage();
    stickToBottom.current = true;
    setNewCount(0);
    setSendError(null);
    senderRef.current?.commit();
    void postMessage({ id, text: trimmed, file, replyToId });
  }, [
    clearPendingImage,
    conversation.id,
    myAuthor,
    pendingImage,
    postMessage,
    replyTo,
    submitting,
    text,
  ]);

  const retryMessage = useCallback(
    (m: LocalMessage) => {
      if (inFlightRef.current.has(m.id)) return;
      setMessages((prev) => setSendStatus(prev, m.id, "sending"));
      const file = pendingFiles.current.get(m.id)?.file ?? null;
      void postMessage({ id: m.id, text: m.message ?? "", file, replyToId: m.reply_to_message_id });
    },
    [postMessage],
  );

  const removeFailed = useCallback((id: string) => {
    const pending = pendingFiles.current.get(id);
    if (pending) {
      URL.revokeObjectURL(pending.url);
      pendingFiles.current.delete(id);
    }
    setPendingImageUrls((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
    knownIds.current.delete(id);
    setMessages((prev) => prev.filter((m) => m.id !== id));
  }, []);

  const startReply = useCallback((m: LocalMessage) => {
    setReplyTo(m);
    setActiveId(null);
    setFocusKey((k) => k + 1);
  }, []);

  const errorText = (code: string | null): string | null => {
    switch (code) {
      case "empty_message":
        return t("community.emptyMessage");
      case "text_too_long":
        return t("community.textTooLong");
      case "image_too_large":
        return t("community.imageTooLarge");
      case "invalid_image":
        return t("community.invalidImage");
      case "rate_limited":
        return t("community.rateLimited");
      case "not_friends":
        return t("community.dmNotFriends");
      case "blocked":
        return t("community.dmBlocked");
      case "conversationNotFound":
        return t("community.conversationNotFound");
      case "send_failed":
        return t("community.sendFailed");
      default:
        return null;
    }
  };

  const typingLabel = useMemo(
    () =>
      buildTypingLabel(
        typingPeers.map((p) => authors[p.userId]?.display_name ?? p.name),
        t,
      ),
    [typingPeers, authors, t],
  );

  const otherName = other?.displayName ?? t("community.member");

  // Phase 3: the ONE shared presence derivation for the header —
  // server-baselined (privacy-mapped), live-updated by the peer broadcast.
  const peerState: PresenceState = peerLive
    ? peerLive.state
    : other
      ? (other.presence ?? (other.online ? "online" : "offline"))
      : "offline";
  const peerLastSeen: string | null = peerLive
    ? peerLive.lastSeenAt
    : (other?.lastSeenAt ?? null);

  return (
    <div className="absolute inset-0 flex min-h-0 flex-col">
      {/* Conversation header */}
      <header className="flex h-14 shrink-0 items-center gap-2.5 border-b border-line px-3 sm:px-6">
        {/* Mobile back (desktop: the sidebar handles navigation) */}
        <Link
          href="/community/messages"
          aria-label={t("community.backToMessages")}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-muted transition-colors hover:bg-surface-2 hover:text-ink lg:hidden"
        >
          <Icon name="arrowLeft" size={17} className="rtl:rotate-180" />
        </Link>
        <button
          type="button"
          onClick={() => other && openProfile(other.userId)}
          aria-label={t("community.openProfile")}
          className="flex min-w-0 flex-1 items-center gap-2.5 text-start"
        >
          <span className="relative shrink-0">
            {/* eslint-disable-next-line @next/next/no-img-element -- avatar: fixed 36px, static public asset */}
            <img
              src={communityAvatarUrl(other?.avatarId ?? "avatar-1")}
              alt=""
              width={36}
              height={36}
              className="h-9 w-9 rounded-xl object-cover"
            />
            <span
              className={`absolute -bottom-0.5 -end-0.5 ring-2 ring-surface ${presenceDotClass(peerState)}`}
              aria-hidden="true"
            />
          </span>
          <span className="min-w-0">
            <span className="flex items-center gap-1.5">
              <span className="block truncate text-sm font-bold leading-tight text-ink">
                {otherName}
              </span>
              {other?.isPlatformAdmin === true && (
                <AdminBadge size={13} label={t("community.adminBadge")} />
              )}
            </span>
            <PresenceIndicator
              state={peerState}
              label={peerState !== "offline"}
              lastSeenAt={peerState === "offline" ? peerLastSeen : null}
              className="leading-tight"
            />
          </span>
        </button>
        <span
          className={`h-2 w-2 shrink-0 rounded-full ${
            connection === "connected" ? "bg-success" : "bg-warning"
          }`}
          aria-hidden="true"
        />
      </header>

      {/* Message list */}
      <div className="relative min-h-0 flex-1">
        <div ref={listRef} onScroll={onScroll} className="h-full min-h-0 overflow-y-auto overscroll-contain">
          <div className="mx-auto flex w-full max-w-3xl flex-col px-2 py-3 sm:px-4">
            {connection !== "connected" && (
              <div className="flex justify-center">
                <span className="inline-flex items-center gap-1.5 rounded-full border border-warning/30 bg-warning-soft px-3 py-1 text-xs font-semibold text-warning">
                  <Icon name="alert" size={12} />
                  {t("community.reconnecting")}
                </span>
              </div>
            )}

            {historyMissing && (
              <div className="flex justify-center">
                <span className="inline-flex flex-wrap items-center justify-center gap-1.5 rounded-full border border-warning/30 bg-warning-soft px-3 py-1 text-xs font-semibold text-warning">
                  <Icon name="alert" size={12} />
                  {t("community.historyUnavailable")}
                  <button type="button" onClick={() => void resyncRecent()} className="underline underline-offset-2">
                    {t("community.historyUnavailableRetry")}
                  </button>
                </span>
              </div>
            )}

            {blockedNotice && (
              <div className="flex justify-center">
                <span className="inline-flex items-center gap-1.5 rounded-full border border-danger/30 bg-danger-soft px-3 py-1 text-xs font-semibold text-danger">
                  <Icon name="alert" size={12} />
                  {t("community.dmBlocked")}
                </span>
              </div>
            )}

            {messages.length === 0 ? (
              <div className="flex flex-1 flex-col items-center justify-center gap-3 py-16 text-center">
                <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-accent-soft text-accent">
                  <Icon name="message" size={24} />
                </span>
                <h2 className="flex items-center gap-1.5 text-lg font-bold text-ink">
                  {otherName}
                  {other?.isPlatformAdmin === true && (
                    <AdminBadge size={14} label={t("community.adminBadge")} />
                  )}
                </h2>
                <p className="max-w-sm text-sm leading-6 text-muted">{t("community.emptyCta")}</p>
              </div>
            ) : (
              <>
                {olderLoading && (
                  <p className="py-1 text-center text-xs font-medium text-faint">{t("common.loading")}</p>
                )}
                {messages.map((m, i) => {
                  // Messenger-style alignment: sender-based ownership via the
                  // STABLE user IDs (never display name / locale / direction).
                  const mine = isOwnMessage(m.user_id, me.userId);
                  const prev = i > 0 ? messages[i - 1] : null;
                  const firstOfGroup =
                    !prev ||
                    prev.user_id !== m.user_id ||
                    Date.parse(m.created_at) - Date.parse(prev.created_at) > 5 * 60 * 1000;
                  const author = mine ? myAuthor : (authors[m.user_id] ?? null);
                  const name = mine ? me.displayName : (author?.display_name ?? t("community.member"));
                  const avatarUrl = mine
                    ? communityAvatarUrl(me.avatarId)
                    : author
                      ? communityAvatarUrl(author.avatar_id)
                      : null;
                  const imageUrl =
                    (m.image_path ? imageUrls[m.image_path] : undefined) ??
                    pendingImageUrls[m.id] ??
                    null;
                  return (
                    <MessageRow
                      key={m.id}
                      message={m}
                      mine={mine}
                       firstOfGroup={firstOfGroup}
                       name={name}
                       authorIsAdmin={author?.platform_admin === true}
                       avatarUrl={avatarUrl}
                      locale={locale}
                      imageUrl={imageUrl}
                      knownMembers={NO_KNOWN_MEMBERS}
                      t={t}
                      active={activeId === m.id}
                      onActivate={setActiveId}
                      onOpenImage={setLightbox}
                      onJumpToMessage={jumpToMessage}
                      onRetry={retryMessage}
                      onRemoveFailed={removeFailed}
                      onReply={startReply}
                      onToggleReaction={(id, emoji) => void toggleReaction(id, emoji)}
                      onSaveEdit={(id, text2) => void saveEdit(id, text2)}
                      onCancelEdit={() => {}}
                      onDelete={(id) => void deleteMessage(id)}
                      onOpenAuthor={openProfile}
                    />
                  );
                })}
              </>
            )}
          </div>
        </div>

        {newCount > 0 && (
          <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
            <button
              type="button"
              onClick={jumpToLatest}
              className="pointer-events-auto inline-flex items-center gap-1.5 rounded-full bg-accent px-3.5 py-1.5 text-xs font-semibold text-white shadow-lg transition-opacity hover:opacity-90"
            >
              <Icon name="arrowUp" size={12} className="rotate-180" />
              {t("community.newMessagesCount", { count: newCount })}
            </button>
          </div>
        )}
      </div>

      {/* Typing indicator + composer */}
      <div className="shrink-0 border-t border-line bg-surface/95 px-3 pb-3 pt-1.5 sm:px-6">
        <div
          role="status"
          aria-live="polite"
          className="flex h-5 items-center gap-1.5 px-1.5 text-xs font-medium text-muted"
        >
          {typingLabel && (
            <>
              <span className="typing-dots" aria-hidden="true">
                <span className="typing-dot" />
                <span className="typing-dot" />
                <span className="typing-dot" />
              </span>
              <span className="truncate">{typingLabel}</span>
            </>
          )}
        </div>
        <div className="-mx-3 -mt-1.5 sm:-mx-6">
          <Composer
            members={[]}
            text={text}
            onTextChange={(value) => {
              setText(value);
              setSendError(null);
            }}
            onTyping={(hasText) => senderRef.current?.onInput(hasText)}
            replyTo={replyTo}
            onCancelReply={() => setReplyTo(null)}
            pendingImage={pendingImage}
            onPickImage={onPickImage}
            onClearImage={clearPendingImage}
            onSend={() => void submit()}
            submitting={submitting}
            focusSignal={focusKey}
            error={errorText(sendError)}
            imageError={imageError ? errorText(imageError) : null}
            t={t}
          />
        </div>
      </div>

      {/* Lightbox */}
      {lightbox && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={t("community.viewImage")}
          className="fixed inset-0 z-50 flex items-center justify-center bg-navy/85 p-4 backdrop-blur-sm"
          onClick={() => setLightbox(null)}
        >
          <button
            type="button"
            onClick={() => setLightbox(null)}
            aria-label={t("community.closeImage")}
            className="absolute end-4 top-4 flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20"
          >
            <Icon name="x" size={18} />
          </button>
          {/* eslint-disable-next-line @next/next/no-img-element -- signed URL from the private bucket */}
          <img
            src={lightbox}
            alt={t("community.imageAlt")}
            onClick={(event) => event.stopPropagation()}
            className="max-h-full max-w-full rounded-lg shadow-2xl"
          />
        </div>
      )}
    </div>
  );
}
