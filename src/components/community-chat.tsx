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
import { Icon } from "@/components/icon";
import { Button } from "@/components/ui";
import { MessageRow } from "@/components/community-message-row";
import { markCommunityRead } from "@/app/community/actions";
import {
  COMMUNITY_IMAGE_MIMES,
  COMMUNITY_MAX_IMAGE_BYTES,
  COMMUNITY_MAX_MESSAGE_LENGTH,
  COMMUNITY_PAGE_SIZE,
  communityAvatarUrl,
  createOptimisticMessage,
  mergeCommunityMessages,
  setSendStatus,
  type CommunityAuthor,
  type CommunityMessage,
  type CommunityMessageView,
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

/** How often the local timer re-prunes stale typing peers (no network). */
const TYPING_PRUNE_INTERVAL_MS = 1000;

// ---------------------------------------------------------------------------
// Development-only diagnostics. Gated on NODE_ENV so the checks (and every
// log) are stripped from the production build. Logs carry ids/booleans only —
// never tokens, keys or message payloads (no secret leakage).
// ---------------------------------------------------------------------------
const LOG_DEV = process.env.NODE_ENV === "development";
function devLog(scope: string, what: string, extra?: Record<string, unknown>) {
  if (LOG_DEV) console.debug(`[community:${scope}]`, what, extra ?? "");
}

interface CommunityChatProps {
  me: { userId: string; displayName: string; avatarId: string };
  initialMessages: CommunityMessageView[];
  /**
   * The server could not prefetch the history (DB outage / incomplete server
   * env). The chat still opens, Realtime keeps streaming, and the user gets an
   * explicit notice with a retry that resyncs through the API route — instead
   * of the whole page failing.
   */
  historyUnavailable?: boolean;
  /** Real member count (onboarded profiles) for the header — 0 hides it. */
  memberCount?: number;
}

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

/**
 * The community group chat.
 *
 *  - Optimistic send: pressing Send inserts the row INSTANTLY (status
 *    "sending") with a client-generated UUID; the API accepts that id
 *    (idempotency), so a retry reuses the same row and neither the POST
 *    response nor the Realtime echo can ever create a duplicate.
 *  - Real-time via Supabase Realtime (postgres_changes INSERT on
 *    community_messages). Every merge goes through mergeCommunityMessages,
 *    which dedupes by stable message id.
 *  - The realtime socket is attached to the user's JWT BEFORE joining
 *    (auth.initialize + realtime.setAuth): without it the INSERT stream is
 *    RLS-filtered to zero rows — the classic "message only after refresh".
 *  - After a dropped connection the channel re-subscribes and the most
 *    recent page is re-fetched and merged (no replay guarantee from
 *    Postgres changes, so we resync explicitly).
 *  - "Load older" pages backwards on scroll-up (50 per page); no polling.
 *  - Messages render as plain text (React text nodes) — never as HTML.
 *  - Read state: opening the page (and receiving while viewing) advances
 *    the user's read cursor, which drives the sidebar badge.
 */
export function CommunityChat({
  me,
  initialMessages,
  historyUnavailable = false,
  memberCount = 0,
}: CommunityChatProps) {
  const { t, lang } = useI18n();
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
  // How many messages arrived while the reader is scrolled up in the history:
  // the list deliberately does NOT jump, it offers a counted pill instead.
  const [newCount, setNewCount] = useState(0);
  // Lightbox for message images (signed URL, resolved at click time).
  const [lightbox, setLightbox] = useState<string | null>(null);

  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const knownIds = useRef<Set<string>>(new Set(initialMessages.map((m) => m.id)));
  // Latest-authors mirror for async callbacks (realtime INSERTs, resync).
  // Synced in an effect — refs are never written during render.
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
  // Files kept in memory for the optimistic rows they belong to (retry after
  // a failed image send). Keyed by the client-generated message id.
  const pendingFiles = useRef<Map<string, { file: File; url: string }>>(new Map());
  // Render-side mirror of those object URLs: the ref holds the data the
  // handlers need (File), while React state is what the rows read in render
  // (reading refs during render is forbidden by react-hooks/refs).
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

  // The public NEXT_PUBLIC_* Supabase values are INLINED into the client bundle
  // at BUILD time, so a deployment can legitimately ship without them while the
  // server (which reads process.env at runtime) keeps working. Building the
  // browser client would then throw — and this component used to do it during
  // render, which blanked the whole page through the error boundary. It is now
  // created lazily, on first use after mount: if that fails, the chat still
  // loads and sends through the RLS-backed API routes and only realtime plus
  // image signing are degraded.
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

  const scheduleMarkRead = useCallback((messageId: string) => {
    if (markReadTimer.current) window.clearTimeout(markReadTimer.current);
    // Throttled: the cursor only needs to reach the newest message, not
    // every intermediate one.
    markReadTimer.current = window.setTimeout(() => {
      void markCommunityRead(messageId);
    }, 600);
  }, []);

  // Mark the latest message read when the page is actually opened.
  useEffect(() => {
    const latest = messages[messages.length - 1];
    if (latest) void markCommunityRead(latest.id);
    if (markReadTimer.current) window.clearTimeout(markReadTimer.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Resync the newest page after a dropped connection has recovered.
  const resyncRecent = useCallback(async (reason?: string) => {
    devLog("sync", "resync", { reason: reason ?? "reconnect" });
    try {
      const response = await fetch(`/api/community/messages`, { cache: "no-store" });
      if (!response.ok) return;
      const data = (await response.json()) as { items: CommunityMessageView[] };
      // A successful (RLS-backed) fetch clears the degraded-history notice.
      setHistoryMissing(false);
      const before = new Set(knownIds.current);
      for (const m of data.items) knownIds.current.add(m.id);
      // Server rows win on id collision (they flip a lost in-flight row to
      // "sent" and carry the DB created_at).
      setMessages((prev) =>
        mergeCommunityMessages(prev, data.items, { preferIncoming: true }),
      );
      const added = data.items.filter((m) => !before.has(m.id)).length;
      if (added > 0 && !stickToBottom.current) setNewCount((c) => c + added);
      for (const m of data.items) {
        if (m.author) authorsRef.current = { ...authorsRef.current, [m.user_id]: m.author };
      }
      setAuthors((prev) => {
        const next = { ...prev };
        for (const m of data.items) if (m.author) next[m.user_id] = m.author;
        return next;
      });
    } catch {
      /* keep the current state; the next reconnect retries */
    }
  }, []);

  // --- Typing indicator (ephemeral presence, over the existing channel) ---

  /** Broadcast OUR typing state. Fire-and-forget: a failed broadcast only
   *  degrades the indicator for others, never the chat itself. */
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
            userId: me.userId,
            displayName: me.displayName,
            timestamp: Date.now(),
          },
        })
        .catch((error) => devLog("typing", "tx failed", { type, error: String(error) }));
    },
    [me],
  );

  /** Re-derive the visible typer list (prunes stale peers); skips the
   *  re-render when nothing changed. Also best-effort upgrades each typer's
   *  broadcast name to the trusted RLS profile name (same path as messages). */
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

  /** Wipe all remote typing state — after a reconnect the gap may have
   *  swallowed stops, so every remaining peer is by definition stale. */
  const clearTyping = useCallback(() => {
    typingStateRef.current = createTypingState(typingStateRef.current.selfId);
    setTypingPeers([]);
  }, []);

  // Realtime subscription (event-driven; no polling).
  //
  // THE critical production detail: the browser session (cookie) is only
  // restored by auth.initialize(), which this app never called — so the
  // realtime socket joined with NO user JWT, and the postgres INSERT stream
  // (RLS: authenticated only) silently delivered ZERO rows. Every client
  // therefore "needed a refresh". We now initialize the session and attach
  // the token to the socket BEFORE the channel joins.
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
        channel = client
          .channel("community-messages")
          .on(
            "postgres_changes",
            { event: "INSERT", schema: "public", table: "community_messages" },
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
              // Realtime rows carry no author; ensureAuthor() fills the
              // display data into the authors map (the render reads from it).
              setMessages((prev) =>
                mergeCommunityMessages(prev, [{ ...incoming, author: null }], {
                  preferIncoming: true,
                }),
              );
              if (!dup && !authorOf(incoming)) void ensureAuthor(incoming.user_id);
              // Scrolling follows stickToBottom (updated on scroll) — a user
              // reading history is not yanked to the bottom by new messages.
              if (!dup && !stickToBottom.current) setNewCount((c) => c + 1);
              scheduleMarkRead(incoming.id);
            },
          )
          .on("broadcast", { event: TYPING_BROADCAST_EVENT }, (payload) => {
            const broadcast = parseTypingBroadcast(payload?.payload);
            if (!broadcast) {
              devLog("typing", "rx malformed (ignored)");
              return;
            }
            devLog("typing", "rx", { type: broadcast.type, userId: broadcast.userId });
            typingStateRef.current = applyTypingEvent(
              typingStateRef.current,
              broadcast,
              Date.now(),
            );
            refreshTyping();
          })
          .subscribe((status) => {
            devLog("rt", "status", { status });
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
              // CONNECTING is transient (no banner flash). A real failure
              // degrades to the banner; the realtime client retries on its
              // own, and a resync then covers any missed INSERTs.
              sawDisconnected.current = true;
              setConnection("disconnected");
              // Don't leave others staring at a stale "… is typing".
              senderRef.current?.commit();
            }
          });
        channelRef.current = channel;
      } catch (error) {
        // A realtime setup failure must never reach the error boundary (an
        // error thrown inside an effect is caught by it): degrade to the
        // banner instead.
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
      // Attach the user JWT to the realtime socket BEFORE the phx_join:
      // postgres events are RLS-filtered by the socket token.
      devLog("auth", "realtime token", { hasToken: Boolean(session?.access_token) });
      if (session?.access_token) {
        // Awaited on purpose: in supabase-js 2.117 setAuth is async and the
        // join payload must carry the JWT from its first byte — a token-less
        // join would stream zero RLS rows until a post-join re-auth landed.
        await client.realtime.setAuth(session.access_token).catch((error) =>
          devLog("auth", "realtime setAuth failed", { error: String(error) }),
        );
        if (!disposed) subscribeChannel();
      }
      // No session (yet): NEVER join without a JWT — with RLS-backed realtime
      // a token-less channel receives zero rows. If auth.initialize() is
      // still restoring the session, the INITIAL_SESSION event below attaches
      // the token and does the join instead.
    })();

    // Keep the socket token fresh (TOKEN_REFRESHED, sign-out) and cover the
    // slow start (INITIAL_SESSION / SIGNED_IN). Every path is guarded
    // (subscribeChannel() only ever creates ONE channel), so a late event can
    // never produce a duplicate subscription.
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
  }, [getClient]);

  // Outgoing typing controller. Declared AFTER the realtime effect so that
  // on unmount its cleanup (dispose → immediate typing_stop) still runs
  // while the channel exists — no stuck indicator on leave/navigation.
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

  // Stale cleanup: a purely LOCAL timer that re-prunes the peer map so a
  // dead peer (closed browser, lost typing_stop) drops out after the TTL.
  // In-memory only — no network, no polling.
  useEffect(() => {
    const id = window.setInterval(refreshTyping, TYPING_PRUNE_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [refreshTyping]);

  // Revoke every kept object URL when the chat unmounts.
  useEffect(() => {
    const map = pendingFiles.current;
    return () => {
      for (const p of map.values()) URL.revokeObjectURL(p.url);
      map.clear();
    };
  }, []);

  // Resolve signed URLs for message images (private bucket). Each path is
  // signed at most once per session (3600 s expiry ≫ page lifetime).
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
          // Best-effort: a failed signature only affects that one image.
          console.error("[community] image signing failed:", error);
        }
        if (signedUrl && !cancelled) {
          setImageUrls((prev) =>
            prev[m.image_path as string]
              ? prev
              : { ...prev, [m.image_path as string]: signedUrl as string },
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
        `/api/community/messages?before_at=${encodeURIComponent(oldest.created_at)}`,
        { cache: "no-store" },
      );
      if (!response.ok) return;
      const data = (await response.json()) as { items: CommunityMessageView[] };
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
  }, [hasMoreOlder, olderLoading, messages]);

  // Scroll behaviour:
  //  - first paint: jump straight to the latest message (instant);
  //  - newer message while at the bottom: smooth follow (instant for our own);
  //  - reading history: never yanked — the counted pill offers the jump;
  //  - "load older" prepends: the reading position is restored pixel-exact.
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

  // iOS Safari: the keyboard shrinks the VISUAL viewport without resizing the
  // layout viewport, so 100dvh alone cannot follow it (and the old 100vh hacks
  // are exactly what breaks). Reserve precisely the covered height on the chat
  // root — the composer then sits directly above the keyboard while the message
  // list shrinks, and the page itself never scrolls.
  useEffect(() => {
    const vv = window.visualViewport;
    const root = rootRef.current;
    if (!vv || !root) return;
    const measure = () => {
      const covered = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      root.style.setProperty("--kb", `${Math.round(covered)}px`);
      return covered;
    };
    measure();
    const onViewportChange = () => {
      if (measure() <= 0) return;
      // The keyboard is open: keep the newest message in view while typing.
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
      root.style.removeProperty("--kb");
    };
  }, []);

  // Phones suspend the realtime socket while the tab is backgrounded. Coming
  // back resyncs ONLY when the link actually had a gap — a routine tab
  // switch on a healthy connection must not trigger a fetch (that would be
  // polling in disguise).
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

  const onPickImage = (file: File | null | undefined) => {
    setImageError(null);
    if (!file) return;
    // Picking an image is not typing — stop the indicator immediately.
    senderRef.current?.commit();
    if (!(COMMUNITY_IMAGE_MIMES as readonly string[]).includes(file.type)) {
      setImageError("invalid_image");
      return;
    }
    if (file.size > COMMUNITY_MAX_IMAGE_BYTES) {
      setImageError("image_too_large");
      return;
    }
    if (pendingImage) URL.revokeObjectURL(pendingImage.url);
    setPendingImage({ file, url: URL.createObjectURL(file) });
  };

  const clearPendingImage = useCallback(() => {
    // NOTE: no revoke here — when this is part of a send, the object URL
    // belongs to the optimistic row (kept in pendingFiles for retry). The
    // unmount cleanup revokes everything.
    setPendingImage(null);
    if (fileRef.current) fileRef.current.value = "";
  }, []);

  /**
   * Network phase of a send (and of every retry). The optimistic row already
   * exists in the UI; here we only learn the outcome:
   *   - 201 created / 200 duplicate (idempotent retry) → the server row is
   *     merged in (server wins by id → status "sent");
   *   - 4xx/5xx or network error → the row flips to "failed" (retryable),
   *     and the user's text is restored to the composer so it is NEVER lost.
   */
  const postMessage = useCallback(
    async (p: { id: string; text: string; file: File | null }) => {
      const startedAt = Date.now();
      inFlightRef.current.add(p.id);
      setSubmitting(inFlightRef.current.size > 0);
      devLog("send", "start", { id: p.id, image: p.file !== null });
      try {
        const form = new FormData();
        form.set("message", p.text);
        // Idempotency: retries reuse the SAME id — the server either creates
        // this exact row or returns the one that already exists.
        form.set("id", p.id);
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
                        : "send_failed";
          devLog("send", "failed", {
            id: p.id,
            code,
            ms: Date.now() - startedAt,
          });
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
        };
        devLog("send", "ok", { id: p.id, ms: Date.now() - startedAt });
        // Server row wins on the id collision → the optimistic row becomes
        // the persisted one (status "sent"), no duplicate is possible.
        setMessages((prev) =>
          mergeCommunityMessages(prev, [serverRow], { preferIncoming: true }),
        );
        scheduleMarkRead(serverRow.id);
      } catch {
        // Network-level failure (offline / timeout): the row stays, retryable.
        devLog("send", "network-error", { id: p.id, ms: Date.now() - startedAt });
        setMessages((prev) => setSendStatus(prev, p.id, "failed"));
        if (p.text) setText(p.text);
      } finally {
        inFlightRef.current.delete(p.id);
        setSubmitting(inFlightRef.current.size > 0);
      }
    },
    [me, myAuthor, scheduleMarkRead],
  );

  /**
   * Optimistic send — the WhatsApp/Messenger flow:
   *   1. UI FIRST: the row appears instantly with status "sending";
   *   2. the composer resets (the text now lives in the row);
   *   3. the typing indicator stops immediately;
   *   4. persistence runs in the background (postMessage) — the UI never
   *      waits for Supabase, and a failure only flips the row to "failed".
   */
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
    const optimistic = createOptimisticMessage({
      id,
      user: myAuthor,
      text: trimmed || null,
      imagePath: null, // the storage path is generated server-side
      createdAt,
    });
    knownIds.current.add(id);
    if (file && url) {
      pendingFiles.current.set(id, { file, url });
      setPendingImageUrls((prev) => ({ ...prev, [id]: url }));
    }
    setMessages((prev) => mergeCommunityMessages(prev, [optimistic]));
    devLog("send", "optimistic", { id, image: file !== null });
    setText("");
    if (textareaRef.current) textareaRef.current.style.height = "auto";
    if (pendingImage) clearPendingImage();
    stickToBottom.current = true;
    setNewCount(0);
    setSendError(null);
    senderRef.current?.commit();
    void postMessage({ id, text: trimmed, file });
  }, [clearPendingImage, myAuthor, pendingImage, postMessage, submitting, text]);

  /** Retry a failed message: SAME id (idempotent), same content/file. */
  const retryMessage = useCallback(
    (m: LocalMessage) => {
      if (inFlightRef.current.has(m.id)) return;
      devLog("send", "retry", { id: m.id });
      setMessages((prev) => setSendStatus(prev, m.id, "sending"));
      const file = pendingFiles.current.get(m.id)?.file ?? null;
      void postMessage({ id: m.id, text: m.message ?? "", file });
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

  const handleTextChange = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = event.target.value.slice(0, COMMUNITY_MAX_MESSAGE_LENGTH);
    setText(value);
    // Drives the typing sender: ONE typing_start per burst (first keystroke
    // only), re-armed debounce after the last one, immediate stop on empty.
    senderRef.current?.onInput(value.length > 0);
    // Auto-grow the textarea (capped) — no scroll inside the field itself.
    const el = event.target;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 144)}px`;
  };

  const onTextKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void submit();
    }
  };

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
      case "send_failed":
        return t("community.sendFailed");
      default:
        return null;
    }
  };

  // The indicator text. Names prefer the trusted RLS profile name and fall
  // back to the (untrusted) broadcast name only until the profile resolves.
  const typingLabel = useMemo(
    () =>
      buildTypingLabel(
        typingPeers.map((p) => authors[p.userId]?.display_name ?? p.name),
        t,
      ),
    [typingPeers, authors, t],
  );

  return (
    <div
      ref={rootRef}
      className="flex h-full min-h-0 w-full flex-col"
      style={{ paddingBottom: "var(--kb, 0px)" }}
    >
      {/* Header — slim, honest: the real member count, and the realtime
          health dot (no invented "online" presence). */}
      <header className="flex shrink-0 items-center gap-2.5 border-b border-line px-4 py-2.5 sm:px-6">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent">
          <Icon name="users" size={15} />
        </span>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-sm font-bold leading-tight text-ink">
            {t("nav.community")}
          </h1>
          {memberCount > 0 && (
            <p className="text-[11px] leading-tight text-muted">
              {t("community.membersCount", { count: memberCount })}
            </p>
          )}
        </div>
        <span
          className={`h-2 w-2 shrink-0 rounded-full ${
            connection === "connected" ? "bg-success" : "bg-warning"
          }`}
          aria-hidden="true"
        />
      </header>

      {/* Message list — the ONLY scrollable region; the page never scrolls. */}
      <div className="relative min-h-0 flex-1">
      <div
        ref={listRef}
        onScroll={onScroll}
        className="h-full min-h-0 overflow-y-auto overscroll-contain"
      >
        <div className="mx-auto flex w-full max-w-2xl flex-col px-4 py-4 sm:px-6">
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
                <Icon name="users" size={26} />
              </span>
              <h2 className="text-lg font-bold text-ink">{t("community.emptyTitle")}</h2>
              <p className="max-w-sm text-sm leading-6 text-muted">{t("community.emptyText")}</p>
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
                const firstOfGroup = !prev || prev.user_id !== m.user_id;
                const author = mine ? myAuthor : (authors[m.user_id] ?? null);
                const name = mine ? me.displayName : author?.display_name ?? t("community.member");
                const avatarUrl = mine
                  ? communityAvatarUrl(me.avatarId)
                  : author
                    ? communityAvatarUrl(author.avatar_id)
                    : null;
                // Signed URL for persisted images; the local object URL for
                // in-flight optimistic rows (and as fallback until signed).
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
                    t={t}
                    onOpenImage={setLightbox}
                    onRetry={retryMessage}
                    onRemove={removeFailed}
                  />
                );
              })}
            </>
          )}
        </div>
      </div>

        {/* New-messages pill: shown only when the reader is scrolled up in the
            history, so new arrivals never yank the screen away. */}
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

      {/* Composer — pinned above the bottom navigation (and above the keyboard
          on iOS via the --kb reservation on the root). */}
      <div className="shrink-0 border-t border-line bg-surface/95 px-3 pb-3 pt-1.5 sm:px-6">
        <div className="mx-auto w-full max-w-2xl">
          {/* Typing indicator: fixed-height row (no layout jump) above the
              composer inputs; role="status" gives a polite live region
              without per-keystroke announcements. */}
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
          {imageError && (
            <p role="alert" className="mb-1.5 px-1.5 text-xs font-medium text-danger">
              {errorText(imageError)}
            </p>
          )}
          {pendingImage && (
            <div className="mb-2 flex items-center gap-2.5 px-1.5">
              {/* eslint-disable-next-line @next/next/no-img-element -- local object-URL preview */}
              <img
                src={pendingImage.url}
                alt={t("community.imageAlt")}
                className="h-16 w-16 rounded-xl border border-line object-cover"
              />
              <button
                type="button"
                onClick={clearPendingImage}
                className="inline-flex items-center gap-1.5 rounded-lg border border-line-strong px-2.5 py-1.5 text-xs font-semibold text-muted transition-colors hover:bg-surface-2 hover:text-ink"
              >
                <Icon name="x" size={12} />
                {t("community.removeImage")}
              </button>
            </div>
          )}
          <div className="flex items-end gap-1.5 rounded-2xl border border-line-strong bg-surface p-1.5 transition focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/25">
            <input
              ref={fileRef}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              className="hidden"
              onChange={(event) => onPickImage(event.target.files?.[0])}
            />
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              aria-label={t("community.attachImage")}
              title={t("community.attachImage")}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-muted transition-colors hover:bg-surface-2 hover:text-ink"
            >
              <Icon name="image" size={18} />
            </button>
            <textarea
              ref={textareaRef}
              value={text}
              onChange={handleTextChange}
              onKeyDown={onTextKeyDown}
              rows={1}
              placeholder={t("community.placeholder")}
              aria-label={t("community.placeholder")}
              className="max-h-36 min-h-9 flex-1 resize-none bg-transparent px-1.5 py-2 text-sm text-ink outline-none placeholder:text-faint"
            />
            <Button
              onClick={() => void submit()}
              disabled={submitting || (!text.trim() && !pendingImage)}
              aria-label={t("community.send")}
              title={t("community.send")}
              className="h-9 w-9 shrink-0 rounded-xl px-0"
            >
              <Icon name="send" size={16} />
            </Button>
          </div>
          {sendError && (
            <p role="alert" className="mt-1.5 px-1.5 text-xs font-medium text-danger">
              {errorText(sendError)}
            </p>
          )}
        </div>
      </div>

      {/* Lightbox — message images open full-size (signed URL, no download). */}
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
    </div>
  );
}
