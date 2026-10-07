"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createClient } from "@/lib/supabase/client";
import { useI18n } from "@/lib/i18n";
import { dictionaries } from "@/lib/i18n/dictionaries";
import { Icon, type IconName } from "@/components/icon";
import { markRoomRead } from "@/app/community/actions";
import {
  COMMUNITY_IMAGE_MIMES,
  COMMUNITY_MAX_IMAGE_BYTES,
  COMMUNITY_PAGE_SIZE,
  communityAvatarUrl,
  createOptimisticMessage,
  mergeCommunityMessages,
  setSendStatus,
  type CommunityAuthor,
  type CommunityMessage,
  type CommunityMessageClient,
  type CommunityRoom,
  type LocalMessage,
} from "@/lib/community";
import {
  TYPING_BROADCAST_EVENT,
  applyTypingEvent,
  buildTypingLabel,
  createTypingState,
  parseTypingBroadcast,
  selectActiveTypers,
  TypingSender,
  type TypingBroadcastType,
  type TypingPeer,
  type TypingState,
} from "@/lib/community/typing";
import {
  MESSAGE_DELETE_BROADCAST_EVENT,
  MESSAGE_UPDATE_BROADCAST_EVENT,
  PIN_BROADCAST_EVENT,
  PIN_REMOVE_BROADCAST_EVENT,
  parseMessageDeleteBroadcast,
  parseMessageUpdateBroadcast,
  parsePinBroadcast,
  parsePinRemoveBroadcast,
} from "@/lib/community/events";
import { pinMessageAction, unpinMessageAction } from "@/app/community/advanced-actions";
import Link from "next/link";
import { MessageRow } from "./message-row";
import { Composer } from "./composer";
import { useCommunityShell } from "./community-shell";
import { useVoice } from "./use-voice";
import { VoicePanel } from "./voice-panel";
import { ReportDialog } from "./report-dialog";

/** How often the local timer re-prunes stale typing peers (no network). */
const TYPING_PRUNE_INTERVAL_MS = 1000;
/** Phase 3 deep link: how many OLDER pages at most we walk (bounded, no
 *  unbounded loop — the walk stops on not-found as gracefully as on
 *  found). */
const JUMP_MAX_OLDER_PAGES = 8;
/** Phase 3 deep link: how long the target row stays highlighted (one-shot
 *  timeout, NOT an interval). */
const JUMP_HIGHLIGHT_MS = 2500;

// ---------------------------------------------------------------------------
// Development-only diagnostics. Gated on NODE_ENV so the checks (and every
// log) are stripped from the production build. Logs carry ids/booleans only
// — never tokens, keys or message payloads (no secret leakage).
// ---------------------------------------------------------------------------
const LOG_DEV = process.env.NODE_ENV === "development";
function devLog(scope: string, what: string, extra?: Record<string, unknown>) {
  if (LOG_DEV) console.debug(`[community:${scope}]`, what, extra ?? "");
}

/** Seed the author map from the prefetched history (pure, no hooks). */
function seedAuthorsFrom(
  list: CommunityMessageClient[],
): Record<string, CommunityAuthor> {
  const seed: Record<string, CommunityAuthor> = {};
  for (const m of list) {
    if (m.author && !seed[m.user_id]) seed[m.user_id] = m.author;
  }
  return seed;
}

interface RoomChatProps {
  me: { userId: string; displayName: string; avatarId: string };
  room: CommunityRoom;
  initialMessages: CommunityMessageClient[];
  /**
   * The server could not prefetch the history (DB outage / incomplete server
   * env). The chat still opens, Realtime keeps streaming, and the user gets
   * an explicit notice with a retry — instead of the page failing.
   */
  historyUnavailable?: boolean;
  /**
   * Phase 3 deep link (`?message=<id>` — notification center / toast). The
   * room loads its newest page normally; then this message is located in the
   * loaded page or by walking at most JUMP_MAX_OLDER_PAGES older pages,
   * scrolled into view and briefly highlighted. Bounded, event-driven, no
   * polling, no reload. Missing id → graceful no-op (dev log only).
   */
  jumpToMessageId?: string | null;
  /**
   * Phase 4: the room's active voice conversation — AGGREGATE METADATA ONLY
   * (a count, never participant identities; the table has none to begin
   * with). The page prefetches it; after that the voice UI is event-driven
   * (SFU participant events + the metadata-only broadcast channel).
   */
  initialVoice?: { active: boolean; participantCount: number };
  /**
   * Phase 5 (SERVER-computed): the viewer is moderator+. Pure affordance —
   * every pin action re-checks the role server-side on each call.
   */
  canModerate?: boolean;
  /** Phase 5: the room's pinned messages (server-loaded, newest first). */
  pinned?: RoomPinView[];
}

/** One pinned message as the page hands it to the chat (structural — the
 *  server module stays out of the client bundle). */
export interface RoomPinView {
  pinId: string;
  messageId: string;
  pinnedAt: string;
  pinnedByName: string | null;
  preview: string;
  authorName: string | null;
}

/** RoomChat is always rendered inside CommunityShell (members + panel). */

type ConnectionState = "connected" | "disconnected";
type RealtimeClient = ReturnType<typeof createClient>;
type RealtimeChannel = ReturnType<RealtimeClient["channel"]>;

function localeFor(lang: string): string {
  return lang === "de" ? "de-DE" : lang === "fr" ? "fr-FR" : lang === "ar" ? "ar" : "en-US";
}

/** Smooth unless the user prefers reduced motion (JS scroll is not covered
 *  by the CSS prefers-reduced-motion rule, so honour it explicitly). */
function scrollBehavior(): ScrollBehavior {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
}

const KNOWN_ICONS: ReadonlySet<string> = new Set([
  "grid", "search", "bookmark", "file", "folder", "settings", "help", "menu",
  "bell", "mail", "spark", "user", "users", "scan", "edit", "send", "activity",
  "target", "briefcase", "plus", "paperclip", "arrowUp", "stop", "x", "image",
  "alert", "arrowLeft", "arrowRight", "arrow", "chevron", "chevronLeft",
  "chevronRight", "check", "sun", "moon", "monitor", "globe", "external",
  "trash", "download", "upload", "lock", "clock", "logout", "chart", "hash",
  "book", "idCard", "message", "at", "smile", "reply", "pin", "mic", "shield",
  "flag", "award",
]);

/** The room's stored icon (data) mapped onto the app's icon set (safe). */
function roomIcon(icon: string | null | undefined): IconName {
  return icon && KNOWN_ICONS.has(icon) ? (icon as IconName) : "hash";
}

/**
 * One COMMUNITY ROOM, live.
 *
 *  - Optimistic send: pressing Send inserts the row INSTANTLY (status
 *    "sending") with a client-generated UUID; the API accepts that id
 *    (idempotency), so a retry reuses the same row and neither the POST
 *    response nor the Realtime echo can ever create a duplicate.
 *  - Real-time via Supabase Realtime on the PER-ROOM channel
 *    `community-room:<id>` (postgres INSERT/UPDATE/DELETE filtered by
 *    room_id). Every merge goes through mergeCommunityMessages, which
 *    dedupes by stable message id.
 *  - The realtime socket is attached to the user's JWT BEFORE joining
 *    (auth.initialize + realtime.setAuth): without it the stream is
 *    RLS-filtered to zero rows — the classic "message only after refresh".
 *  - Owner edits/deletes stream only to the actor (RLS), so the actor also
 *    BROADCASTS them on the room channel (community_message_update /
 *    community_message_delete) — the same trust model as typing.
 *  - "Load older" pages backwards on scroll-up (50 per page); no polling.
 *  - Messages render as plain text nodes + safe mention chips/links — never
 *    HTML.
 *  - Read state: opening the room (and receiving while viewing) advances
 *    the user's PER-ROOM cursor.
 */
export function RoomChat({
  me,
  room,
  initialMessages,
  historyUnavailable = false,
  jumpToMessageId = null,
  initialVoice = { active: false, participantCount: 0 },
  canModerate = false,
  pinned = [],
}: RoomChatProps) {
  const { t, lang } = useI18n();
  const { members, membersOpen, toggleMembers, openProfile, reportVoiceState } =
    useCommunityShell();
  // Phase 4: the voice session — ONE per room mount (RoomChat is keyed by
  // room.id, so a room switch tears it down: no cross-room bleed, no second
  // media session). The microphone is only ever touched by the explicit join.
  const voice = useVoice({
    roomId: room.id,
    me,
    initialMeta: {
      active: initialVoice.active,
      count: initialVoice.participantCount,
    },
    onMetaChange: reportVoiceState,
  });
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
  // The message being replied to (composer context bar).
  const [replyTo, setReplyTo] = useState<LocalMessage | null>(null);
  // Touch devices: the tap-selected row (shows its action bar).
  const [activeId, setActiveId] = useState<string | null>(null);
  // Focus signal for the composer (reply actions).
  const [focusKey, setFocusKey] = useState(0);
  // How many messages arrived while the reader is scrolled up in the history:
  // the list deliberately does NOT jump, it offers a counted pill instead.
  const [newCount, setNewCount] = useState(0);
  // Lightbox for message images (signed URL, resolved at click time).
  const [lightbox, setLightbox] = useState<string | null>(null);
  // --- Phase 5: pins (server-authorized; the list is a local mirror) ---
  const [pins, setPins] = useState<RoomPinView[]>(pinned);
  const [pinsOpen, setPinsOpen] = useState(false);
  // --- Phase 5: the report dialog target (message row actions) ---
  const [reportTarget, setReportTarget] = useState<string | null>(null);
  const [pinNotice, setPinNotice] = useState<string | null>(null);
  const pinNoticeTimer = useRef<number | null>(null);
  const flashPinNotice = useCallback((text: string) => {
    setPinNotice(text);
    if (pinNoticeTimer.current) window.clearTimeout(pinNoticeTimer.current);
    pinNoticeTimer.current = window.setTimeout(() => setPinNotice(null), 4000);
  }, []);
  useEffect(
    () => () => {
      if (pinNoticeTimer.current) window.clearTimeout(pinNoticeTimer.current);
    },
    [],
  );
  // Phase 3 deep link: the briefly highlighted target + its one-shot timer.
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const jumpHighlightTimer = useRef<number | null>(null);
  const jumpAttempted = useRef(false);
  // Live mirror of `messages` for the deep-link walk (stable closure).
  const messagesRef = useRef<LocalMessage[]>(initialMessages);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);
  // Latest-value ref for stable event/callback closures. Initialized from
  // the PROPs (the same seed the `authors` state uses) — a state-linked
  // initializer makes the compiler reject the effect sync as a state
  // mutation. Declared BEFORE its first use (togglePin below); the RENDER
  // path always reads the `authors` state directly.
  const authorsRef = useRef<Record<string, CommunityAuthor>>(seedAuthorsFrom(initialMessages));
  useEffect(() => {
    authorsRef.current = authors;
  }, [authors]);

  /**
   * Phase 5: pin / unpin one message (moderator+ affordance). The ACTION
   * re-checks the role + room + rate limit server-side; on success the
   * LOCAL mirror updates AND the change is re-broadcast on the room channel
   * (the pin rows are admin-written, so no postgres stream reaches members).
   */
  const togglePin = useCallback(
    async (messageId: string) => {
      const isPinned = pins.some((p) => p.messageId === messageId);
      const res = isPinned
        ? await unpinMessageAction(room.slug, messageId)
        : await pinMessageAction(room.slug, messageId);
      if (!res.ok) {
        flashPinNotice(
          res.code === "forbidden" ? t("community.pinForbidden") : t("community.pinError"),
        );
        return;
      }
      if (isPinned) {
        setPins((prev) => prev.filter((p) => p.messageId !== messageId));
        channelRef.current?.send({
          type: "broadcast",
          event: PIN_REMOVE_BROADCAST_EVENT,
          payload: { roomId: room.id, messageId },
        });
      } else {
        const msg = messagesRef.current.find((m) => m.id === messageId);
        setPins((prev) =>
          prev.some((p) => p.messageId === messageId)
            ? prev
            : [
                {
                  pinId: `local-${messageId}`,
                  messageId,
                  pinnedAt: new Date().toISOString(),
                  pinnedByName: me.displayName,
                  preview: msg?.message?.trim().slice(0, 160) ?? "",
                  authorName: msg
                    ? msg.user_id === me.userId
                      ? me.displayName
                      : (authorsRef.current[msg.user_id]?.display_name ?? null)
                    : null,
                },
                ...prev,
              ],
        );
        channelRef.current?.send({
          type: "broadcast",
          event: PIN_BROADCAST_EVENT,
          payload: { roomId: room.id, messageId },
        });
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pins, room.slug, room.id, me.displayName, flashPinNotice, t],
  );

  const listRef = useRef<HTMLDivElement>(null);
  const knownIds = useRef<Set<string>>(new Set(initialMessages.map((m) => m.id)));
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
  // Files kept in memory for the optimistic rows they belong to (retry after
  // a failed image send). Keyed by the client-generated message id.
  const pendingFiles = useRef<Map<string, { file: File; url: string }>>(new Map());
  const [pendingImageUrls, setPendingImageUrls] = useState<Record<string, string>>({});
  // Message ids with a POST currently in flight (double-submit guard).
  const inFlightRef = useRef<Set<string>>(new Set());
  // --- Typing indicator (ephemeral presence — in-memory only, no DB) ---
  const typingStateRef = useRef<TypingState>(createTypingState(me.userId));
  const channelRef = useRef<RealtimeChannel | null>(null);
  const senderRef = useRef<TypingSender | null>(null);
  const [typingPeers, setTypingPeers] = useState<TypingPeer[]>([]);

  const myAuthor = useMemo<CommunityAuthor>(
    () => ({ user_id: me.userId, display_name: me.displayName, avatar_id: me.avatarId }),
    [me],
  );

  // Known member usernames (mention chips) — the member directory plus
  // every author resolved from the loaded history.
  const knownMembers = useMemo(() => {
    const set = new Set<string>();
    for (const m of members) set.add(m.display_name.toLowerCase());
    for (const a of Object.values(authors)) set.add(a.display_name.toLowerCase());
    return set;
  }, [members, authors]);

  // The public NEXT_PUBLIC_* Supabase values are INLINED into the client
  // bundle at build time, so a deployment can legitimately ship without them
  // while the server keeps working. The client is created lazily, on first
  // use after mount: if that fails, the room still loads and sends through
  // the RLS-backed API routes and only realtime plus image signing degrade.
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

  const authorOf = useCallback(
    (m: CommunityMessage): CommunityAuthor | null => {
      if (m.user_id === me.userId) return myAuthor;
      return authorsRef.current[m.user_id] ?? null;
    },
    [me, myAuthor],
  );

  const ensureAuthor = useCallback(
    async (userId: string) => {
      const client = getClient();
      if (!client || userId in authorsRef.current) return;
      const { data } = await client
        .from("community_profiles")
        .select("user_id,display_name,avatar_id")
        .eq("user_id", userId)
        .maybeSingle();
      if (data) {
        setAuthors((prev) => ({
          ...prev,
          [userId]: {
            user_id: data.user_id,
            display_name: data.display_name,
            avatar_id: data.avatar_id,
          },
        }));
      }
    },
    [getClient],
  );

  const scheduleMarkRead = useCallback(() => {
    if (markReadTimer.current) window.clearTimeout(markReadTimer.current);
    // Throttled: the cursor only needs to reach "now", not every message.
    markReadTimer.current = window.setTimeout(() => {
      void markRoomRead(room.id);
    }, 600);
  }, [room.id]);

  // Mark the room read when it is actually opened.
  useEffect(() => {
    void markRoomRead(room.id);
    if (markReadTimer.current) window.clearTimeout(markReadTimer.current);
  }, [room.id]);

  // Resync the newest page of the ACTIVE room after a dropped connection has
  // recovered, and (every second) as the authoritative background fallback for
  // the realtime stream. `?poll=1` uses the higher poll rate bucket. The fetch
  // is room-scoped only — never the whole dataset, never other rooms.
  const resyncRecent = useCallback(async (reason?: string) => {
    devLog("sync", "resync", { room: room.slug, reason: reason ?? "reconnect" });
    try {
      const response = await fetch(
        `/api/community/messages?room=${encodeURIComponent(room.slug)}&poll=1`,
        { cache: "no-store" },
      );
      if (!response.ok) return; // e.g. 429 — keep state; the next tick retries
      const data = (await response.json()) as { items: CommunityMessageClient[] };
      setHistoryMissing(false);
      const before = new Set(knownIds.current);
      // NO-OP when nothing new AND nothing changed: a 1s tick against a quiet
      // room must not re-render the list (no flash, no scroll reset, no
      // duplicate rows). mergeCommunityMessages always returns a NEW array, so
      // we must skip the setState entirely when there is nothing to apply.
      const localById = new Map(
        messagesRef.current.map((m) => [m.id, m] as const),
      );
      let changed = false;
      for (const m of data.items) {
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
            local.updated_at !== m.updated_at)
        ) {
          changed = true;
          break;
        }
      }
      if (!changed) return;
      for (const m of data.items) knownIds.current.add(m.id);
      // Server rows win on id collision (they flip a lost in-flight row to
      // "sent" and carry the DB created_at + reactions + reply previews).
      setMessages((prev) =>
        mergeCommunityMessages(prev, data.items, { preferIncoming: true }),
      );
      const added = data.items.filter((m) => !before.has(m.id)).length;
      if (added > 0 && !stickToBottom.current) setNewCount((c) => c + added);
      // The author mirror lands via STATE (setAuthors) + the sync effect —
      // the ref stays a single-writer cell (the compiler rejects refs that
      // are assigned from multiple closures).
      setAuthors((prev) => {
        const next = { ...prev };
        for (const m of data.items) if (m.author) next[m.user_id] = m.author;
        return next;
      });
    } catch {
      /* keep the current state; the next tick retries */
    }
  }, [room.slug]);

  // --- 1s invisible background refresh of the ACTIVE room ---------------
  // Realtime (postgres_changes INSERT) is the fast primary path. This poll is
  // the authoritative fallback so a message the realtime stream missed (mobile
  // socket drops, iOS app lifecycle, RLS edge cases) still appears within ~1s
  // WITHOUT a page reload or navigation. resyncRecent() is a no-op when nothing
  // new/changed arrived, so a quiet room costs one small room-scoped fetch and
  // causes NO re-render. One timer per room; a still-running request is never
  // overlapped; a hidden tab pauses (and catches up once on return).
  useEffect(() => {
    let disposed = false;
    let inFlight = false;
    let timer: number | null = null;
    const tick = () => {
      if (disposed || inFlight) return; // overlap guard
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
      inFlight = true;
      void resyncRecent("poll")
        .catch(() => {
          /* network error: keep state; the next tick retries silently */
        })
        .finally(() => {
          inFlight = false;
        });
    };
    const onVisibility = () => {
      // Returning to the tab: one immediate catch-up poll.
      tick();
    };
    tick(); // fill any gap since (re)mount
    timer = window.setInterval(tick, 1000);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      disposed = true;
      if (timer != null) window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [resyncRecent]);

  // --- Typing indicator (ephemeral presence, over the room channel) ---

  const broadcastTyping = useCallback(
    (type: TypingBroadcastType) => {
      const channel = channelRef.current;
      if (!channel) {
        devLog("typing", "tx skipped (no channel)", { type });
        return;
      }
      devLog("typing", "tx", { type });
      void channel
        .send({
          type: "broadcast",
          event: TYPING_BROADCAST_EVENT,
          payload: {
            type,
            roomId: room.id,
            userId: me.userId,
            displayName: me.displayName,
            timestamp: Date.now(),
          },
        })
        .catch((error) => devLog("typing", "tx failed", { type, error: String(error) }));
    },
    [me, room.id],
  );

  const refreshTyping = useCallback(() => {
    const active = selectActiveTypers(typingStateRef.current, Date.now());
    setTypingPeers((prev) =>
      prev.length === active.length &&
      prev.every(
        (p, i) =>
          p.userId === active[i].userId && p.name === active[i].name && p.at === active[i].at,
      )
        ? prev
        : active,
    );
    for (const peer of active) {
      if (!(peer.userId in authorsRef.current)) void ensureAuthor(peer.userId);
    }
  }, [ensureAuthor]);

  const clearTyping = useCallback(() => {
    typingStateRef.current = createTypingState(typingStateRef.current.selfId);
    setTypingPeers([]);
  }, []);

  // Realtime subscription (event-driven; no polling) — ONE channel per room.
  useEffect(() => {
    let disposed = false;
    let channel: RealtimeChannel | null = null;
    let degradedTimer: number | null = null;
    const reportDegraded = () => {
      degradedTimer = window.setTimeout(() => {
        sawDisconnected.current = true;
        setConnection("disconnected");
      }, 0);
    };
    const client = getClient();
    if (!client) {
      reportDegraded();
      return () => {
        if (degradedTimer) window.clearTimeout(degradedTimer);
      };
    }

    const subscribeChannel = () => {
      if (disposed || channel) return;
      try {
        const roomFilter = `room_id=eq.${room.id}`;
        channel = client
          .channel(`community-room:${room.id}`)
          .on(
            "postgres_changes",
            { event: "INSERT", schema: "public", table: "community_messages", filter: roomFilter },
            (payload) => {
              const incoming = payload.new as CommunityMessage;
              if (!incoming?.id) return;
              // Dedupe happens in the merge (by stable id): a duplicate echo
              // of our own optimistic row is NOT skipped here — it is the
              // proof the send persisted, so the row flips to "sent".
              const dup = knownIds.current.has(incoming.id);
              const mine = incoming.user_id === me.userId;
              devLog("rt", "insert", { id: incoming.id, mine, dup });
              knownIds.current.add(incoming.id);
              // Realtime rows carry no author/reactions; the merge fills what
              // it can, and ensureAuthor/ensureReply upgrade the labels.
              setMessages((prev) =>
                mergeCommunityMessages(
                  prev,
                  [{ ...incoming, author: null, reactions: [], replyTo: null }],
                  { preferIncoming: true },
                ),
              );
              if (!dup && !authorOf(incoming)) void ensureAuthor(incoming.user_id);
              if (!dup && !stickToBottom.current) setNewCount((c) => c + 1);
              scheduleMarkRead();
            },
          )
          .on(
            "postgres_changes",
            { event: "UPDATE", schema: "public", table: "community_messages", filter: roomFilter },
            (payload) => {
              const incoming = payload.new as CommunityMessage;
              if (!incoming?.id) return;
              // RLS: this UPDATE stream only ever carries MY edits — merge
              // them (the broadcast below reaches everyone else).
              setMessages((prev) =>
                mergeCommunityMessages(
                  prev,
                  [{ ...incoming, author: null, reactions: [], replyTo: null }],
                  { preferIncoming: true },
                ),
              );
            },
          )
          .on(
            "postgres_changes",
            { event: "DELETE", schema: "public", table: "community_messages", filter: roomFilter },
            (payload) => {
              const deleted = (payload.old as { id?: string })?.id;
              if (!deleted) return;
              // RLS: only my own deletions reach this stream.
              setMessages((prev) => prev.filter((m) => m.id !== deleted));
            },
          )
          .on("broadcast", { event: TYPING_BROADCAST_EVENT }, (payload) => {
            const broadcast = parseTypingBroadcast(payload?.payload);
            if (!broadcast) return;
            // Room guard: ignore typing from other rooms (shared socket).
            const wireRoom = (payload?.payload as { roomId?: unknown } | undefined)?.roomId;
            if (typeof wireRoom === "string" && wireRoom !== room.id) return;
            typingStateRef.current = applyTypingEvent(
              typingStateRef.current,
              broadcast,
              Date.now(),
            );
            refreshTyping();
          })
          .on("broadcast", { event: MESSAGE_UPDATE_BROADCAST_EVENT }, (payload) => {
            const update = parseMessageUpdateBroadcast(payload?.payload);
            if (!update || update.roomId !== room.id) return;
            setMessages((prev) =>
              mergeCommunityMessages(
                prev,
                [{ ...update.message, author: null, reactions: [], replyTo: null }],
                { preferIncoming: true },
              ),
            );
          })
          .on("broadcast", { event: MESSAGE_DELETE_BROADCAST_EVENT }, (payload) => {
            const del = parseMessageDeleteBroadcast(payload?.payload);
            if (!del || del.roomId !== room.id) return;
            setMessages((prev) => prev.filter((m) => m.id !== del.id));
          })
          // Phase 5: pin metadata from another moderator (the pin rows are
          // admin-written — this broadcast is the members' realtime view).
          .on("broadcast", { event: PIN_BROADCAST_EVENT }, (payload) => {
            const pin = parsePinBroadcast(payload?.payload);
            if (!pin || pin.roomId !== room.id) return;
            setPins((prev) => {
              if (prev.some((p) => p.messageId === pin.messageId)) return prev;
              const msg = messagesRef.current.find((m) => m.id === pin.messageId);
              return [
                {
                  pinId: `rt-${pin.messageId}`,
                  messageId: pin.messageId,
                  pinnedAt: new Date().toISOString(),
                  pinnedByName: null,
                  preview: msg?.message?.trim().slice(0, 160) ?? "",
                  authorName: msg
                    ? msg.user_id === me.userId
                      ? me.displayName
                      : (authorsRef.current[msg.user_id]?.display_name ?? null)
                    : null,
                },
                ...prev,
              ];
            });
          })
          .on("broadcast", { event: PIN_REMOVE_BROADCAST_EVENT }, (payload) => {
            const del = parsePinRemoveBroadcast(payload?.payload);
            if (!del || del.roomId !== room.id) return;
            setPins((prev) => prev.filter((p) => p.messageId !== del.messageId));
          })
          .subscribe((status) => {
            devLog("rt", "status", { status, room: room.slug });
            if (status === "SUBSCRIBED") {
              setConnection("connected");
              if (sawDisconnected.current) {
                void resyncRecent();
                clearTyping();
              }
            } else if (
              status === "TIMED_OUT" ||
              status === "CLOSED" ||
              status === "CHANNEL_ERROR"
            ) {
              sawDisconnected.current = true;
              setConnection("disconnected");
              senderRef.current?.commit();
            }
          });
        channelRef.current = channel;
      } catch (error) {
        // A realtime setup failure must never reach the error boundary.
        console.error("[community] realtime subscribe failed:", error);
        reportDegraded();
      }
    };

    void (async () => {
      try {
        await client.auth.initialize();
      } catch (error) {
        devLog("auth", "initialize failed", { error: String(error) });
      }
      if (disposed) return;
      const {
        data: { session },
      } = await client.auth.getSession();
      if (disposed) return;
      if (session?.access_token) {
        // Awaited on purpose: the join payload must carry the JWT from its
        // first byte — a token-less join streams zero RLS rows.
        devLog("auth", "realtime token", { hasToken: true });
        await client.realtime.setAuth(session.access_token).catch((error) =>
          devLog("auth", "realtime setAuth failed", { error: String(error) }),
        );
        if (!disposed) subscribeChannel();
      }
      // No session (yet): NEVER join without a JWT. If auth.initialize() is
      // still restoring the session, the INITIAL_SESSION event below does it.
    })();

    const sub = client.auth.onAuthStateChange((event, session) => {
      if (session?.access_token) {
        void client.realtime
          .setAuth(session.access_token)
          .then(() => {
            if (event === "INITIAL_SESSION" || event === "SIGNED_IN") subscribeChannel();
          })
          .catch((error) =>
            devLog("auth", "realtime setAuth failed", { error: String(error) }),
          );
      } else if (event === "SIGNED_OUT") client.realtime.setAuth();
    });

    return () => {
      disposed = true;
      if (degradedTimer) window.clearTimeout(degradedTimer);
      sub.data.subscription.unsubscribe();
      channelRef.current = null;
      if (channel) void client.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [getClient, room.id, room.slug]);

  // Outgoing typing controller (declared AFTER the realtime effect so that
  // on unmount its dispose runs while the channel still exists).
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

  // Stale cleanup: a purely LOCAL timer that re-prunes the peer map.
  useEffect(() => {
    const id = window.setInterval(refreshTyping, TYPING_PRUNE_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [refreshTyping]);

  // Revoke every kept object URL when the room unmounts.
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
    const toSign = messages.filter(
      (m) => m.image_path && !signedPaths.current.has(m.image_path),
    );
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
          console.error("[community] image signing failed:", error);
        }
        if (signedUrl && !cancelled) {
          setImageUrls((prev) =>
            prev[m.image_path as string]
              ? prev
              : { ...prev, [m.image_path as string]: signedUrl },
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
        `/api/community/messages?room=${encodeURIComponent(room.slug)}&before_at=${encodeURIComponent(oldest.created_at)}`,
        { cache: "no-store" },
      );
      if (!response.ok) return;
      const data = (await response.json()) as { items: CommunityMessageClient[] };
      for (const m of data.items) knownIds.current.add(m.id);
      setMessages((prev) => mergeCommunityMessages(data.items, prev));
      setHasMoreOlder(data.items.length >= COMMUNITY_PAGE_SIZE);
      setAuthors((prev) => {
        const next = { ...prev };
        for (const m of data.items) if (m.author) next[m.user_id] = m.author;
        return next;
      });
    } catch {
      restoreScroll.current = null;
    } finally {
      setOlderLoading(false);
    }
  }, [hasMoreOlder, olderLoading, messages, room.slug]);

  // Scroll behaviour (port of the old chat): first paint jumps to the
  // latest; new messages follow only when at the bottom; reading history
  // never yanks the reader; "load older" restores the pixel position.
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
    if (!el || !target) {
      // The parent may live in an older, not-yet-loaded page.
      devLog("jump", "not loaded", { id: messageId });
      return;
    }
    stickToBottom.current = false;
    target.scrollIntoView({ block: "center", behavior: scrollBehavior() });
  }, []);

  // --- Phase 3 deep link (?message=) ---------------------------------------
  // Scroll to a row that is (or just became) part of the loaded list. The
  // double rAF waits for the merged rows to be committed to the DOM — no
  // timer involved.
  const revealMessage = useCallback(
    (messageId: string) => {
      stickToBottom.current = false;
      setNewCount(0);
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => {
          const el = listRef.current?.querySelector(`#cm-${CSS.escape(messageId)}`);
          if (!el) return;
          el.scrollIntoView({ block: "center", behavior: scrollBehavior() });
        });
      });
      // Temporary highlight (one-shot timeout — the only "timer" here).
      setHighlightId(messageId);
      if (jumpHighlightTimer.current) window.clearTimeout(jumpHighlightTimer.current);
      jumpHighlightTimer.current = window.setTimeout(() => setHighlightId(null), JUMP_HIGHLIGHT_MS);
    },
    [],
  );

  useEffect(() => {
    const timer = jumpHighlightTimer.current;
    if (timer == null) return;
    return () => {
      // Only clear the timer this effect armed — a later revealMessage may
      // have re-armed it already.
      if (jumpHighlightTimer.current === timer) window.clearTimeout(timer);
    };
  }, [highlightId]);

  // Locate the deep-linked message: newest page first, then a BOUNDED walk
  // of older pages (same API the manual "load older" uses). Stops on found,
  // on the beginning of the room, on a fetch failure, or after
  // JUMP_MAX_OLDER_PAGES — whichever comes first. Never retries in a loop.
  useEffect(() => {
    const target = jumpToMessageId;
    if (!target || jumpAttempted.current) return;
    jumpAttempted.current = true;
    let disposed = false;
    const slug = room.slug;
    const cleanUrl = () => {
      // Drop ?message= from the URL bar only — replaceState rewrites the
      // address without a reload and without a Next navigation event (the
      // router's history.state is preserved), so the mounted room keeps its
      // chat state and this effect never re-runs (jumpAttempted ref).
      window.history.replaceState(window.history.state, "", window.location.pathname);
    };
    void (async () => {
      if (messagesRef.current.some((m) => m.id === target)) {
        if (!disposed) {
          revealMessage(target);
          cleanUrl();
        }
        return;
      }
      let pagesLeft = JUMP_MAX_OLDER_PAGES;
      while (pagesLeft > 0 && !disposed) {
        const oldest = messagesRef.current[0];
        if (!oldest) break; // nothing older at all
        const el = listRef.current;
        if (el) restoreScroll.current = { prevHeight: el.scrollHeight, prevTop: el.scrollTop };
        let response: Response | null = null;
        try {
          response = await fetch(
            `/api/community/messages?room=${encodeURIComponent(slug)}&before_at=${encodeURIComponent(oldest.created_at)}`,
            { cache: "no-store" },
          );
        } catch {
          devLog("jump", "fetch failed", { id: target });
          break; // graceful — no retry loop
        }
        if (!response || !response.ok) break;
        let data: { items: CommunityMessageClient[] } | null = null;
        try {
          data = (await response.json()) as { items: CommunityMessageClient[] };
        } catch {
          break;
        }
        if (!data || disposed) return;
        for (const m of data.items) knownIds.current.add(m.id);
        setMessages((prev) => mergeCommunityMessages(data!.items, prev));
        setHasMoreOlder(data.items.length >= COMMUNITY_PAGE_SIZE);
        setAuthors((prev) => {
          const next = { ...prev };
          for (const m of data!.items) if (m.author) next[m.user_id] = m.author;
          return next;
        });
        if (data.items.some((m) => m.id === target)) {
          revealMessage(target);
          cleanUrl();
          return;
        }
        // A short page = we walked to the beginning of the room.
        if (data.items.length === 0 || data.items.length < COMMUNITY_PAGE_SIZE) break;
        pagesLeft -= 1;
      }
      if (!disposed) devLog("jump", "not found", { id: target });
    })();
    return () => {
      disposed = true;
    };
  }, [jumpToMessageId, revealMessage, room.slug]);

  // iOS Safari: the keyboard shrinks the VISUAL viewport without resizing the
  // layout viewport. The SHELL reserves the covered height (--kb, see
  // community-shell.tsx); here we only keep the newest message in view while
  // typing — the chat-specific half of the old combined effect.
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

  // Phones suspend the realtime socket while the tab is backgrounded.
  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState !== "visible") return;
      if (sawDisconnected.current || connectionRef.current !== "connected") {
        void resyncRecent("visibility");
      }
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

  // Close the touch action bar when tapping outside a row (document level).
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

  const clearPendingImage = useCallback(() => {
    setPendingImage(null);
  }, []);

  // --- Message actions (reactions / edit / delete) -------------------------

  const toggleReaction = useCallback(
    async (messageId: string, emoji: string) => {
      // Optimistic flip (snappy UI); the server response is the truth.
      const previous = messages.find((m) => m.id === messageId)?.reactions;
      const withPrev = (reactions: NonNullable<typeof previous>) =>
        setMessages((prev) =>
          prev.map((m) => (m.id === messageId ? { ...m, reactions } : m)),
        );
      const optimistic = (prev: NonNullable<typeof previous>) => {
        const existing = prev?.find((r) => r.emoji === emoji);
        if (existing) {
          const next = prev
            .map((r) =>
              r.emoji === emoji ? { ...r, count: r.count - 1, mine: false } : r,
            )
            .filter((r) => r.count > 0);
          withPrev(next);
        } else {
          withPrev([...(prev ?? []), { emoji, count: 1, mine: true }]);
        }
      };
      const prev = previous ?? [];
      optimistic(prev);
      try {
        const response = await fetch(
          `/api/community/messages/${messageId}/reactions`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ emoji }),
          },
        );
        if (!response.ok) throw new Error(`reaction ${response.status}`);
        const data = (await response.json()) as { reactions: NonNullable<typeof previous> };
        withPrev(data.reactions);
      } catch {
        // Revert: the UI never lies about a reaction that failed.
        withPrev(prev ?? []);
      }
    },
    [messages],
  );

  const saveEdit = useCallback(
    async (messageId: string, newText: string) => {
      const current = messages.find((m) => m.id === messageId);
      const original = current?.message ?? null;
      if (!current || newText.trim() === original?.trim()) return;
      // Optimistic update (updated_at = now so the "(edited)" marker shows).
      setMessages((prev) =>
        prev.map((m) =>
          m.id === messageId
            ? { ...m, message: newText.trim(), updated_at: new Date().toISOString() }
            : m,
        ),
      );
      try {
        const response = await fetch(`/api/community/messages/${messageId}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ message: newText }),
        });
        if (!response.ok) throw new Error(`edit ${response.status}`);
        // Broadcast so the other members see the new text (the RLS UPDATE
        // stream reaches only the actor).
        const data = (await response.json()) as { message: CommunityMessage };
        void channelRef.current?.send({
          type: "broadcast",
          event: MESSAGE_UPDATE_BROADCAST_EVENT,
          payload: { roomId: room.id, message: data.message },
        });
      } catch {
        // Revert on failure — the original text is never lost.
        setMessages((prev) =>
          prev.map((m) => (m.id === messageId ? { ...m, message: original } : m)),
        );
        setSendError("send_failed");
      }
    },
    [messages, room.id],
  );

  const deleteMessage = useCallback(
    async (messageId: string) => {
      try {
        const response = await fetch(`/api/community/messages/${messageId}`, {
          method: "DELETE",
        });
        if (!response.ok) throw new Error(`delete ${response.status}`);
        setMessages((prev) => prev.filter((m) => m.id !== messageId));
        setActiveId(null);
        if (replyTo?.id === messageId) setReplyTo(null);
        void channelRef.current?.send({
          type: "broadcast",
          event: MESSAGE_DELETE_BROADCAST_EVENT,
          payload: { roomId: room.id, id: messageId },
        });
      } catch {
        setSendError("send_failed");
      }
    },
    [replyTo, room.id],
  );

  // --- Sending -------------------------------------------------------------

  const postMessage = useCallback(
    async (p: { id: string; text: string; file: File | null; replyToId: string | null }) => {
      const startedAt = Date.now();
      inFlightRef.current.add(p.id);
      setSubmitting(inFlightRef.current.size > 0);
      devLog("send", "start", { id: p.id, image: p.file !== null, reply: p.replyToId });
      try {
        const form = new FormData();
        form.set("message", p.text);
        // Idempotency: retries reuse the SAME id — the server either creates
        // this exact row or returns the one that already exists.
        form.set("id", p.id);
        form.set("room", room.slug);
        if (p.replyToId) form.set("reply_to", p.replyToId);
        if (p.file) form.set("image", p.file, "image");
        const response = await fetch("/api/community/messages", {
          method: "POST",
          body: form,
        });
        if (!response.ok) {
          const body = (await response.json().catch(() => null)) as {
            error?: string;
          } | null;
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
                      : body?.error === "profile_required"
                        ? "profile_required"
                        : body?.error === "room_not_found"
                          ? "roomNotFound"
                          : "send_failed";
          devLog("send", "failed", { id: p.id, code, ms: Date.now() - startedAt });
          setMessages((prev) => setSendStatus(prev, p.id, "failed"));
          // The user's text is never lost: it stays in the failed bubble AND
          // is restored to the composer (editable + resendable).
          if (p.text) setText(p.text);
          if (code !== "send_failed") setSendError(code);
          return;
        }
        const data = (await response.json()) as { message: CommunityMessage };
        const serverRow: LocalMessage = {
          ...data.message,
          author: data.message.user_id === me.userId ? myAuthor : null,
          reactions: [],
          replyTo: p.replyToId
            ? (messages.find((m) => m.id === p.replyToId) ?? null)
            : null,
        };
        devLog("send", "ok", { id: p.id, ms: Date.now() - startedAt });
        setMessages((prev) =>
          mergeCommunityMessages(prev, [serverRow], { preferIncoming: true }),
        );
        scheduleMarkRead();
      } catch {
        devLog("send", "network-error", { id: p.id, ms: Date.now() - startedAt });
        setMessages((prev) => setSendStatus(prev, p.id, "failed"));
        if (p.text) setText(p.text);
      } finally {
        inFlightRef.current.delete(p.id);
        setSubmitting(inFlightRef.current.size > 0);
      }
    },
    // messages is read (replyTo lookup) — keep the callback fresh.
    [me, myAuthor, messages, room.slug, scheduleMarkRead],
  );

  const submit = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed && !pendingImage) {
      setSendError("empty_message");
      return;
    }
    if (submitting) return; // no duplicate submit while a POST is in flight
    const id = crypto.randomUUID();
    const file = pendingImage?.file ?? null;
    const url = pendingImage?.url ?? null;
    const createdAt = new Date().toISOString();
    const replyToId = replyTo?.id ?? null;
    const replyRow = replyTo ? { ...replyTo, reactions: replyTo.reactions, replyTo: null } : null;
    const optimistic = createOptimisticMessage({
      id,
      roomId: room.id,
      user: myAuthor,
      text: trimmed || null,
      imagePath: null, // the storage path is generated server-side
      replyToMessageId: replyToId,
      createdAt,
    });
    if (replyRow) optimistic.replyTo = replyRow;
    knownIds.current.add(id);
    if (file && url) {
      pendingFiles.current.set(id, { file, url });
      setPendingImageUrls((prev) => ({ ...prev, [id]: url }));
    }
    setMessages((prev) => mergeCommunityMessages(prev, [optimistic]));
    devLog("send", "optimistic", { id, image: file !== null, reply: replyToId });
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
    myAuthor,
    pendingImage,
    postMessage,
    replyTo,
    room.id,
    submitting,
    text,
  ]);

  /** Retry a failed message: SAME id (idempotent), same content/file. */
  const retryMessage = useCallback(
    (m: LocalMessage) => {
      if (inFlightRef.current.has(m.id)) return;
      devLog("send", "retry", { id: m.id });
      setMessages((prev) => setSendStatus(prev, m.id, "sending"));
      const file = pendingFiles.current.get(m.id)?.file ?? null;
      void postMessage({ id: m.id, text: m.message ?? "", file, replyToId: m.reply_to_message_id });
    },
    [postMessage],
  );

  /** Drop a failed message the user no longer wants (releases its file). */
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
      case "profile_required":
        return t("community.profileRequired");
      case "roomNotFound":
        return t("community.roomNotFound");
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

  // Room description: translated per slug (i18n is the source of truth for
  // copy), DB text as fallback for admin-created rooms.
  const roomDescription = useMemo(
    () =>
      (dictionaries[lang].community.roomDescriptions as Record<string, string>)[room.slug] ??
      room.description ??
      "",
    [lang, room],
  );

  return (
    <div className="absolute inset-0 flex min-h-0 flex-col">
      {/* Room header */}
      <header className="flex shrink-0 items-center gap-2.5 border-b border-line px-4 py-2.5 sm:px-6">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent">
          <Icon name={roomIcon(room.icon)} size={15} />
        </span>
        <div className="min-w-0 flex-1">
          <h1 className="flex items-center gap-1 truncate text-sm font-bold leading-tight text-ink">
            <span aria-hidden="true" className="text-faint">#</span>
            <span className="truncate">{room.name}</span>
          </h1>
          {roomDescription && (
            <p className="truncate text-[11px] leading-tight text-muted">{roomDescription}</p>
          )}
        </div>
        {/* Phase 5: pinned messages (room-scoped; ?message= deep links) */}
        <button
          type="button"
          onClick={() => setPinsOpen((v) => !v)}
          aria-expanded={pinsOpen}
          aria-label={t("community.pinsOpen")}
          title={t("community.pinsOpen")}
          className={`relative flex h-8 w-8 items-center justify-center rounded-xl transition-colors ${
            pinsOpen
              ? "bg-accent-soft text-accent"
              : "text-muted hover:bg-surface-2 hover:text-ink"
          }`}
        >
          <Icon name="pin" size={16} />
          {pins.length > 0 && (
            <span className="absolute -top-1 -end-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[9px] font-bold text-white">
              {pins.length}
            </span>
          )}
        </button>
        {/* Phase 5: this room's questions */}
        <Link
          href={`/community/${room.slug}/questions`}
          aria-label={t("community.questionsNav")}
          title={t("community.questionsNav")}
          className="flex h-8 w-8 items-center justify-center rounded-xl text-muted transition-colors hover:bg-surface-2 hover:text-ink"
        >
          <Icon name="help" size={16} />
        </Link>
        <button
          type="button"
          onClick={voice.openDialog}
          aria-label={t("community.voiceStartHint")}
          title={t("community.voiceStartHint")}
          className="flex h-8 w-8 items-center justify-center rounded-xl text-muted transition-colors hover:bg-surface-2 hover:text-ink"
        >
          <Icon name="mic" size={16} />
        </button>
        <button
          type="button"
          onClick={toggleMembers}
          aria-pressed={membersOpen}
          aria-label={t("community.membersTitle")}
          title={t("community.membersTitle")}
          className={`flex h-8 w-8 items-center justify-center rounded-xl transition-colors ${
            membersOpen
              ? "bg-accent-soft text-accent"
              : "text-muted hover:bg-surface-2 hover:text-ink"
          }`}
        >
          <Icon name="users" size={16} />
        </button>
        <span
          className={`h-2 w-2 shrink-0 rounded-full ${
            connection === "connected" ? "bg-success" : "bg-warning"
          }`}
          aria-hidden="true"
        />
      </header>

      {/* Phase 4: voice — outside: count-only bar (no identities); inside:
          participants + controls. Null when there is no conversation. */}
      <VoicePanel voice={voice} />

      {/* Phase 5: pinned messages (room-scoped list, newest pin first). */}
      {pinsOpen && (
        <div className="max-h-56 shrink-0 overflow-y-auto border-b border-line bg-surface-2/50 px-4 py-3 sm:px-6">
          <p className="mb-2 text-xs font-bold text-ink">
            {t("community.pinsTitle")}
            <span className="ms-2 font-medium text-faint">{t("community.pinsSubtitle")}</span>
          </p>
          {pins.length === 0 ? (
            <p className="py-2 text-xs text-muted">{t("community.pinsEmpty")}</p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {pins.map((pin) => (
                <li
                  key={pin.pinId}
                  className="flex items-center gap-2 rounded-xl border border-line bg-surface px-3 py-2"
                >
                  <Icon name="pin" size={12} className="shrink-0 text-accent" />
                  <span className="min-w-0 flex-1">
                    <Link
                      href={`/community/${room.slug}?message=${pin.messageId}`}
                      className="block truncate text-xs font-semibold text-ink hover:text-accent hover:underline"
                      aria-label={t("community.pinnedLink")}
                    >
                      {pin.preview || "—"}
                    </Link>
                    <span className="block truncate text-[10px] text-faint">
                      {pin.authorName ? `${pin.authorName} · ` : ""}
                      {t("community.pinnedBy", {
                        name: pin.pinnedByName ?? t("community.modModerator"),
                      })}
                    </span>
                  </span>
                  {canModerate && (
                    <button
                      type="button"
                      onClick={() => void togglePin(pin.messageId)}
                      aria-label={t("community.unpinMessage")}
                      className="shrink-0 rounded-lg p-1 text-faint transition-colors hover:bg-surface-2 hover:text-danger"
                    >
                      <Icon name="x" size={13} />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Phase 5: pin action feedback (transient, aria-live) */}
      {pinNotice && (
        <p
          role="status"
          aria-live="polite"
          className="shrink-0 border-b border-line bg-danger-soft/40 px-4 py-1.5 text-center text-[11px] font-semibold text-danger sm:px-6"
        >
          {pinNotice}
        </p>
      )}

      {/* Message list — the ONLY scrollable region; the page never scrolls. */}
      <div className="relative min-h-0 flex-1">
        <div
          ref={listRef}
          onScroll={onScroll}
          className="h-full min-h-0 overflow-y-auto overscroll-contain"
        >
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
                  <button
                    type="button"
                    onClick={() => void resyncRecent("manual")}
                    className="underline underline-offset-2"
                  >
                    {t("community.historyUnavailableRetry")}
                  </button>
                </span>
              </div>
            )}

            {messages.length === 0 ? (
              <div className="flex flex-1 flex-col items-center justify-center gap-3 py-16 text-center">
                <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-accent-soft text-accent">
                  <Icon name={roomIcon(room.icon)} size={26} />
                </span>
                <h2 className="text-lg font-bold text-ink"># {room.name}</h2>
                <p className="max-w-sm text-sm leading-6 text-muted">{roomDescription}</p>
                <p className="text-xs font-semibold text-faint">{t("community.emptyCta")}</p>
              </div>
            ) : (
              <>
                {olderLoading && (
                  <p className="py-1 text-center text-xs font-medium text-faint">
                    {t("common.loading")}
                  </p>
                )}
                {messages.map((m, i) => {
                  const mine = m.user_id === me.userId;
                  const prev = i > 0 ? messages[i - 1] : null;
                  const firstOfGroup =
                    !prev ||
                    prev.user_id !== m.user_id ||
                    Date.parse(m.created_at) - Date.parse(prev.created_at) > 5 * 60 * 1000;
                  const author = mine ? myAuthor : (authors[m.user_id] ?? null);
                  const name = mine
                    ? me.displayName
                    : author?.display_name ?? t("community.member");
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
                       avatarUrl={avatarUrl}
                       locale={locale}
                       imageUrl={imageUrl}
                       knownMembers={knownMembers}
                       t={t}
                       active={activeId === m.id}
                       highlight={highlightId === m.id}
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
                       canModerate={canModerate}
                       isPinned={pins.some((p) => p.messageId === m.id)}
                       onPinToggle={(id) => void togglePin(id)}
                       onReportMessage={(id) => setReportTarget(id)}
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
        <Composer
          members={members}
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
            className="absolute right-4 top-4 flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20"
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

      {/* Phase 5: report dialog for message rows (the ONE shared dialog —
          the reporter is always the session user, resolved by the API). */}
      <ReportDialog
        open={reportTarget !== null}
        target={{ type: "message", id: reportTarget ?? "" }}
        onClose={() => setReportTarget(null)}
      />
    </div>
  );
}
