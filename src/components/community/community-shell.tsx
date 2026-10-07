"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Icon } from "@/components/icon";
import { useI18n } from "@/lib/i18n";
import type { CommunityAuthor, CommunityRoomGroup } from "@/lib/community";
import {
  emitCommunityNotification,
  type BusNotification,
} from "@/lib/community/notification-bus";
import { socialKindOf } from "@/lib/community/notification-kinds";
import { useCommunityPresence } from "@/lib/community/use-presence";
import { playNotificationChime } from "@/lib/community/chime";
import { toggleRoomMute } from "@/app/community/actions";
import { RoomNav } from "./room-nav";
import { MembersPanel } from "./members-panel";
import { IdentityDialog } from "./identity-dialog";
import { ProfileCard } from "./profile-card";
import { CommunitySettings, type CommunitySettingsState } from "./community-settings";

/**
 * The Community layout shell (Discord-inspired, not a Discord clone):
 *
 *   desktop (lg+):  [ room nav 264px | main content | members 240px (opt) ]
 *   mobile:         [ top strip: rooms | title | members ] + main content,
 *                    with start-side room sheet + end-side members sheet.
 *
 * The shell owns: the members directory (fetched once — shared by the panel
 * and the @-mention autocomplete), the identity dialog, the settings sheet
 * (Phase 3), the presence heartbeat (Phase 3 — the ONE sanctioned periodic
 * traffic, via the useCommunityPresence hook), and the ONE realtime
 * notifications channel (Phase 3 — pages inside the shell consume the
 * notification bus, never a second channel). It also owns the iOS keyboard
 * reservation (--kb via visualViewport) so the composer always sits above
 * the keyboard while the message list shrinks.
 *
 * The root fills the AppShell's fill-mode <main> EXACTLY (`absolute inset-0`
 * against a positioned, definite-height box — zero percentage-height
 * resolution, the iOS Safari fix inherited from the old chat).
 */

/** Nav badges (null = chrome unavailable, render without badges). */
export interface SocialUnread {
  dms: number;
  friendRequests: number;
  notifications: number;
}

export interface CommunityShellProps {
  me: { userId: string; displayName: string; avatarId: string; platformAdmin?: boolean };
  categories: CommunityRoomGroup[];
  /** room_id → unread count (0/missing = read). */
  unread: Record<string, number>;
  /** The room in the URL (null = the community home). */
  activeSlug: string | null;
  /** Social nav badges (computed server-side, degraded-safe). */
  socialUnread?: SocialUnread | null;
  /** Phase 3: the viewer's presence + notification preferences (server). */
  settings?: CommunitySettingsState | null;
  /** Phase 3: muted room ids (server). */
  mutedRooms?: string[];
  /** Phase 5: the viewer is moderator+ (SERVER-computed — the nav reveals
   *  the Moderation entry from this flag only, never a client claim). */
  viewerIsModerator?: boolean;
  children: ReactNode;
}

export const DEFAULT_COMMUNITY_SETTINGS: CommunitySettingsState = {
  mode: "online",
  showPresence: true,
  friendRequests: true,
  mentions: true,
  replies: true,
  reactions: true,
  directMessages: true,
  sound: true,
};

/**
 * Shell → child plumbing (one fetch, one source of truth): the member
 * directory (shared by the panel and the @-mention autocomplete), the
 * members-panel toggle used by the room header, and the profile-card opener
 * (members panel, friends list and message authors all open the SAME
 * dialog, owned by the shell).
 */
export interface CommunityShellContextValue {
  members: CommunityAuthor[];
  /** The members panel (desktop column or mobile sheet) is visible. */
  membersOpen: boolean;
  toggleMembers: () => void;
  /** Open the profile card for a member (never for "me"). */
  openProfile: (userId: string) => void;
  /** The viewer's muted rooms (Phase 3). */
  mutedRooms: Set<string>;
  toggleRoomMute: (roomId: string) => void;
  /**
   * Phase 4: the active room's voice aggregate (count only — never
   * participant identities). RoomChat reports it event-driven; the nav
   * renders a "Voice · N" chip for the active room when N > 0.
   */
  reportVoiceState: (meta: { active: boolean; count: number } | null) => void;
}

export const CommunityShellContext = createContext<CommunityShellContextValue>({
  members: [],
  membersOpen: false,
  toggleMembers: () => {},
  openProfile: () => {},
  mutedRooms: new Set(),
  toggleRoomMute: () => {},
  reportVoiceState: () => {},
});

/** Consume the shell's shared data (used by RoomChat / RoomNav). */
export function useCommunityShell(): CommunityShellContextValue {
  return useContext(CommunityShellContext);
}

const SOCIAL_TOAST_TYPES = new Set([
  "friend_request",
  "friend_accepted",
  "mention",
  "reply",
  "reaction",
  "direct_message",
  // Phase 5 Q&A notifications.
  "answer",
  "answer_accepted",
]);

interface ToastItem {
  id: string;
  text: string;
  target: string | null;
}

export function CommunityShell({
  me,
  categories,
  unread,
  activeSlug,
  socialUnread = null,
  settings = null,
  mutedRooms = [],
  viewerIsModerator = false,
  children,
}: CommunityShellProps) {
  const { t } = useI18n();
  const pathname = usePathname();
  const router = useRouter();
  const [members, setMembers] = useState<CommunityAuthor[]>([]);
  const [roomsSheetOpen, setRoomsSheetOpen] = useState(false);
  const [membersOpen, setMembersOpen] = useState(false); // desktop column
  const [membersSheetOpen, setMembersSheetOpen] = useState(false); // mobile sheet
  const [identityOpen, setIdentityOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [profileTarget, setProfileTarget] = useState<string | null>(null);
  const [badges, setBadges] = useState<SocialUnread | null>(socialUnread);
  const [prefs, setPrefs] = useState<CommunitySettingsState>(
    settings ?? DEFAULT_COMMUNITY_SETTINGS,
  );
  const [muted, setMuted] = useState<Set<string>>(() => new Set(mutedRooms));
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const rootRef = useRef<HTMLDivElement>(null);
  const pathnameRef = useRef(pathname);
  useEffect(() => {
    pathnameRef.current = pathname;
  }, [pathname]);
  const prefsRef = useRef(prefs);
  useEffect(() => {
    prefsRef.current = prefs;
  }, [prefs]);

  // Phase 3 presence — the ONE heartbeat hook (throttled writes while the
  // tab is visible, immediate on visibility/activity flips, per-user
  // broadcast channel for the DM peer + profile card).
  const presence = useCommunityPresence({
    myId: me.userId,
    initialMode: settings?.mode ?? "online",
    showPresence: settings?.showPresence ?? true,
    onShowPresenceChanged: (show) => setPrefs((p) => ({ ...p, showPresence: show })),
  });
  // Keep the settings sheet in sync with the hook's mode (activity flips) —
  // the render-phase state-adjustment pattern (an effect here would only add
  // a cascading render).
  const [syncedPresenceMode, setSyncedPresenceMode] = useState(presence.mode);
  if (presence.mode !== syncedPresenceMode) {
    setSyncedPresenceMode(presence.mode);
    setPrefs((p) => (p.mode === presence.mode ? p : { ...p, mode: presence.mode }));
  }

  const openProfile = useCallback(
    (userId: string) => {
      if (userId === me.userId) return; // no self profile card
      setProfileTarget(userId);
    },
    [me.userId],
  );

  const toggleMute = useCallback((roomId: string) => {
    setMuted((prev) => {
      const next = new Set(prev);
      if (next.has(roomId)) next.delete(roomId);
      else next.add(roomId);
      return next;
    });
    void toggleRoomMute(roomId); // server-stamped; chrome, never throws
  }, []);

  // The members directory — ONE fetch for the panel + autocomplete
  // (the rows now carry privacy-mapped presence from the endpoint).
  useEffect(() => {
    let cancelled = false;
    fetch("/api/community/members", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (!cancelled && data && Array.isArray((data as { items?: unknown[] }).items)) {
          setMembers((data as { items: CommunityAuthor[] }).items);
        }
      })
      .catch(() => {
        /* members are chrome — the chat works without the list */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const activeRoom = useMemo(() => {
    if (!activeSlug) return null;
    for (const category of categories) {
      for (const room of category.rooms) {
        if (room.slug === activeSlug) return room;
      }
    }
    return null;
  }, [activeSlug, categories]);

  const roomIdToSlug = useMemo(() => {
    const map = new Map<string, string>();
    for (const category of categories) {
      for (const room of category.rooms) map.set(room.id, room.slug);
    }
    return map;
  }, [categories]);
  const roomIdToSlugRef = useRef(roomIdToSlug);
  useEffect(() => {
    roomIdToSlugRef.current = roomIdToSlug;
  }, [roomIdToSlug]);
  // Phase 3: toasts show the room's DISPLAY NAME (never the raw slug);
  // navigation still uses the slug.
  const roomIdToName = useMemo(() => {
    const map = new Map<string, string>();
    for (const category of categories) {
      for (const room of category.rooms) map.set(room.id, room.name);
    }
    return map;
  }, [categories]);
  const roomIdToNameRef = useRef(roomIdToName);
  useEffect(() => {
    roomIdToNameRef.current = roomIdToName;
  }, [roomIdToName]);
  const membersRef = useRef(members);
  useEffect(() => {
    membersRef.current = members;
  }, [members]);

  const toggleMembers = useCallback(() => {
    const isDesktop = window.matchMedia("(min-width: 1024px)").matches;
    if (isDesktop) setMembersOpen((v) => !v);
    else setMembersSheetOpen((v) => !v);
  }, []);

  // Phase 3 badge resync — EVENT-DRIVEN only (realtime RECONNECTED +
  // network "online"): no polling. Fresh server counts replace the local
  // state (converges the shell badge with the page badge).
  const resyncBadges = useCallback(() => {
    fetch("/api/community/badges", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        const b = data as SocialUnread | null;
        if (
          b &&
          typeof b.dms === "number" &&
          typeof b.friendRequests === "number" &&
          typeof b.notifications === "number"
        ) {
          setBadges(b);
        }
      })
      .catch(() => {
        /* badges are chrome */
      });
  }, []);

  useEffect(() => {
    const onOnline = () => resyncBadges();
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, [resyncBadges]);

  // One toast (max 2 visible, auto-dismiss 6 s). Suppression is the whole
  // point: DND, hidden tab, the user being inside the relevant DM/room, and
  // per-type preferences all mean "badge only, no toast".
  const pushToast = useCallback(
    (n: BusNotification) => {
      const actorName = n.actor_id
        ? (membersRef.current.find((m) => m.user_id === n.actor_id)?.display_name ?? null)
        : null;
      const roomSlug = n.room_id ? roomIdToSlugRef.current.get(n.room_id) ?? null : null;
      const roomName = n.room_id ? roomIdToNameRef.current.get(n.room_id) ?? null : null;
      let text = "";
      let target: string | null = null;
      switch (n.type) {
        case "friend_request":
          text = actorName ? t("community.toast.friendRequest", { name: actorName }) : t("community.toast.friendRequestGeneric");
          target = "/community/friends";
          break;
        case "friend_accepted":
          text = actorName ? t("community.toast.friendAccepted", { name: actorName }) : t("community.toast.friendAcceptedGeneric");
          target = "/community/friends";
          break;
        case "mention":
          text = actorName && roomName
            ? t("community.toast.mention", { name: actorName, room: roomName })
            : t("community.toast.mentionGeneric");
          target = roomSlug ? `/community/${roomSlug}${n.room_message_id ? `?message=${n.room_message_id}` : ""}` : null;
          break;
        case "reply":
          text = actorName && roomName
            ? t("community.toast.reply", { name: actorName, room: roomName })
            : t("community.toast.replyGeneric");
          target = roomSlug ? `/community/${roomSlug}${n.room_message_id ? `?message=${n.room_message_id}` : ""}` : null;
          break;
        case "reaction":
          text = actorName
            ? t("community.toast.reaction", { name: actorName, emoji: n.reaction_emoji ?? "" })
            : t("community.toast.reactionGeneric");
          target = n.conversation_id
            ? `/community/messages/${n.conversation_id}`
            : roomSlug
              ? `/community/${roomSlug}${n.room_message_id ? `?message=${n.room_message_id}` : ""}`
              : null;
          break;
         case "direct_message":
           text = actorName ? t("community.toast.dm", { name: actorName }) : t("community.toast.dmGeneric");
           target = n.conversation_id ? `/community/messages/${n.conversation_id}` : null;
           break;
         case "answer":
           text = actorName ? t("community.toast.answer", { name: actorName }) : t("community.toast.answerGeneric");
           target = n.question_id ? `/community/questions/${n.question_id}` : null;
           break;
         case "answer_accepted":
           text = t("community.toast.accepted");
           target = n.question_id ? `/community/questions/${n.question_id}` : null;
           break;
         default:
           return;
       }
      if (!text) return;
      setToasts((prev) => [...prev.slice(-1), { id: n.id, text, target }]);
      if (prefsRef.current.sound && prefsRef.current.mode !== "dnd") {
        playNotificationChime();
      }
      window.setTimeout(() => {
        setToasts((prev) => prev.filter((x) => x.id !== n.id));
      }, 6000);
    },
    [t],
  );

  // Phase 3 — the shell's ONE notifications channel (RLS delivers only
  // this recipient's rows + platform updates). The notification center
  // page consumes emitCommunityNotification — never a second channel.
  useEffect(() => {
    let disposed = false;
    let channel: ReturnType<ReturnType<typeof createClient>["channel"]> | null = null;
    let client: ReturnType<typeof createClient>;
    try {
      client = createClient();
    } catch (error) {
      console.error("[community] realtime client unavailable:", error);
      return;
    }
    const onRow = (payload: { new?: Record<string, unknown> }) => {
      const row = payload.new;
      if (!row || typeof row.id !== "string" || !row.id) return;
      const n: BusNotification = {
        id: row.id,
        title: typeof row.title === "string" ? row.title : "",
        content: typeof row.content === "string" ? row.content : "",
        type: typeof row.type === "string" ? row.type : "info",
        target_type: row.target_type === "all" ? "all" : "user",
        actor_id: typeof row.actor_id === "string" ? row.actor_id : null,
        room_id: typeof row.room_id === "string" ? row.room_id : null,
        room_message_id: typeof row.room_message_id === "string" ? row.room_message_id : null,
        conversation_id: typeof row.conversation_id === "string" ? row.conversation_id : null,
        dm_message_id: typeof row.dm_message_id === "string" ? row.dm_message_id : null,
        reaction_emoji: typeof row.reaction_emoji === "string" ? row.reaction_emoji : null,
        question_id: typeof row.question_id === "string" ? row.question_id : null,
        answer_id: typeof row.answer_id === "string" ? row.answer_id : null,
        created_at: typeof row.created_at === "string" ? row.created_at : new Date().toISOString(),
      };
      // Normalize the stored representation to the effective kind before the
      // bus: social rows carry the marker in `title`, legacy rows in `type`.
      const kind = socialKindOf(n);
      if (kind) n.type = kind;
      emitCommunityNotification(n);
      setBadges((b) => (b ? { ...b, notifications: b.notifications + 1 } : b));
      // Toast gate (see pushToast callers): social + visible + not DND +
      // not already inside the relevant room/conversation + pref on.
      if (n.target_type !== "user" || !SOCIAL_TOAST_TYPES.has(n.type)) return;
      if (prefsRef.current.mode === "dnd") return;
      if (document.visibilityState !== "visible") return;
      if (
        n.type === "direct_message" &&
        n.conversation_id &&
        pathnameRef.current === `/community/messages/${n.conversation_id}`
      ) {
        return; // the message is on screen — nothing to toast
      }
      if (
        (n.type === "mention" || n.type === "reply" || n.type === "reaction") &&
        n.room_id
      ) {
        const slug = roomIdToSlugRef.current.get(n.room_id);
        if (slug && pathnameRef.current === `/community/${slug}`) return;
      }
      if (
        (n.type === "answer" || n.type === "answer_accepted") &&
        n.question_id &&
        pathnameRef.current === `/community/questions/${n.question_id}`
      ) {
        return; // the question is on screen — nothing to toast
      }
      const prefKey =
        n.type === "friend_request"
          ? "friendRequests"
          : n.type === "friend_accepted"
            ? "friendRequests"
            : n.type === "mention"
              ? "mentions"
              : n.type === "reply"
                ? "replies"
                : n.type === "reaction"
                  ? "reactions"
                  : n.type === "answer"
                    ? "replies"
                    : n.type === "answer_accepted"
                      ? "replies"
                      : "directMessages";
      if (prefsRef.current[prefKey] === false) return;
      pushToast(n);
    };
    let joinedOnce = false;
    const subscribeChannel = () => {
      if (disposed || channel) return;
      try {
        channel = client
          .channel(`community-notifications-${me.userId}`)
          .on("postgres_changes", { event: "INSERT", schema: "public", table: "notifications" }, onRow)
          .subscribe((status) => {
            // Reconnect recovery: when the socket drops and returns, the
            // channel re-joins and this fires SUBSCRIBED a second time —
            // only the badge COUNTS need a bounded refresh (the stream
            // re-subscribes itself). The first join is a no-op (the badges
            // arrive as props). No timer, no polling, no reload.
            if (status === "SUBSCRIBED") {
              if (joinedOnce) resyncBadges();
              joinedOnce = true;
            }
          });
      } catch (error) {
        console.error("[community] notifications realtime failed:", error);
      }
    };
    void (async () => {
      try {
        await client.auth.initialize();
      } catch {
        /* session restore failure: the join stays pending */
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
  }, [me.userId, pushToast, resyncBadges]);

  // iOS Safari: the keyboard shrinks the VISUAL viewport without resizing the
  // layout viewport, so 100dvh alone cannot follow it. Reserve precisely the
  // covered height on the shell root — the composer then sits directly above
  // the keyboard while the message list shrinks, and the page itself never
  // scrolls.
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
    };
    vv.addEventListener("resize", onViewportChange);
    vv.addEventListener("scroll", onViewportChange);
    return () => {
      vv.removeEventListener("resize", onViewportChange);
      vv.removeEventListener("scroll", onViewportChange);
      root.style.removeProperty("--kb");
    };
  }, []);

  // Close the sheets + profile card + settings on navigation (mobile).
  // Transient state is reset DURING RENDER on the prop change — the
  // React-recommended pattern for "state derived from props".
  const [prevPath, setPrevPath] = useState(pathname);
  if (prevPath !== pathname) {
    setPrevPath(pathname);
    setRoomsSheetOpen(false);
    setMembersSheetOpen(false);
    setProfileTarget(null);
    setSettingsOpen(false);
  }

  // Phase 4: the active room's voice aggregate (reported event-driven by
  // RoomChat; count only — the nav never shows identities to outsiders).
  const [voiceMeta, setVoiceMeta] = useState<{ active: boolean; count: number } | null>(null);
  const reportVoiceState = useCallback(
    (meta: { active: boolean; count: number } | null) => {
      setVoiceMeta((prev) => {
        if (meta === null) return prev === null ? prev : null;
        if (!meta.active) return prev === null || !prev.active ? prev : null;
        if (prev !== null && prev.active === meta.active && prev.count === meta.count) {
          return prev;
        }
        return meta;
      });
    },
    [],
  );

  const shellValue = useMemo<CommunityShellContextValue>(
    () => ({
      members,
      membersOpen: membersOpen || membersSheetOpen,
      toggleMembers,
      openProfile,
      mutedRooms: muted,
      toggleRoomMute: toggleMute,
      reportVoiceState,
    }),
    [
      members,
      membersOpen,
      membersSheetOpen,
      toggleMembers,
      openProfile,
      muted,
      toggleMute,
      reportVoiceState,
    ],
  );

  const roomNav = (
    <RoomNav
      me={me}
      categories={categories}
      unread={unread}
      activeSlug={activeSlug}
      activePath={pathname}
      socialUnread={badges}
      onOpenIdentity={() => setIdentityOpen(true)}
      onOpenSettings={() => setSettingsOpen(true)}
      onNavigate={() => setRoomsSheetOpen(false)}
      voiceMeta={activeSlug ? voiceMeta : null}
      showModeration={viewerIsModerator}
    />
  );

  const setPref = (patch: Partial<CommunitySettingsState>) =>
    setPrefs((p) => ({ ...p, ...patch }));

  return (
    <div
      ref={rootRef}
      className="absolute inset-0 flex min-h-0"
      style={{ paddingBottom: "var(--kb, 0px)" }}
    >
      {/* Desktop room nav (hidden entirely on mobile — no hidden desktop
          components rendered there, spec §34). */}
      <aside className="hidden w-[264px] shrink-0 flex-col border-e border-line bg-surface/50 lg:flex">
        {roomNav}
      </aside>

      {/* Main column */}
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
        {/* Mobile top strip: room sheet | current room | members sheet */}
        <div className="flex h-12 shrink-0 items-center gap-1 border-b border-line px-1.5 lg:hidden">
          <button
            type="button"
            onClick={() => setRoomsSheetOpen(true)}
            aria-label={t("community.openRoomList")}
            className="flex h-9 w-9 items-center justify-center rounded-xl text-muted hover:bg-surface-2 hover:text-ink"
          >
            <Icon name="menu" size={18} />
          </button>
          <span className="min-w-0 flex-1 truncate px-1 text-sm font-bold text-ink">
            {activeRoom ? (
              <>
                <span aria-hidden="true" className="text-faint"># </span>
                {activeRoom.name}
              </>
            ) : (
              t("nav.community")
            )}
          </span>
          <button
            type="button"
            onClick={() => setMembersSheetOpen(true)}
            aria-label={t("community.membersTitle")}
            className="flex h-9 w-9 items-center justify-center rounded-xl text-muted hover:bg-surface-2 hover:text-ink"
          >
            <Icon name="users" size={18} />
          </button>
          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            aria-label={t("community.settings.title")}
            className="flex h-9 w-9 items-center justify-center rounded-xl text-muted hover:bg-surface-2 hover:text-ink"
          >
            <Icon name="settings" size={18} />
          </button>
        </div>
        <CommunityShellContext.Provider value={shellValue}>
          <div className="relative min-h-0 flex-1">{children}</div>
        </CommunityShellContext.Provider>
      </div>

      {/* Phase 3 realtime toasts — top (never covers the composer), max 2,
          polite live region for screen readers. */}
      <div
        aria-live="polite"
        aria-label={t("community.settings.notificationsSection")}
        className="pointer-events-none fixed start-1/2 top-14 z-40 flex w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 flex-col gap-2 lg:start-auto lg:end-4 lg:top-4 lg:translate-x-0"
      >
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className="pointer-events-auto flex items-center gap-2 rounded-xl border border-line bg-surface px-3 py-2.5 shadow-lg"
          >
            <Icon name="bell" size={15} className="shrink-0 text-accent" />
            <span className="min-w-0 flex-1 truncate text-xs font-medium text-ink">{toast.text}</span>
            {toast.target && (
              <button
                type="button"
                onClick={() => {
                  setToasts((prev) => prev.filter((x) => x.id !== toast.id));
                  void router.push(toast.target as string);
                }}
                className="shrink-0 rounded-lg bg-accent-soft px-2 py-1 text-[11px] font-bold text-accent hover:bg-accent/20"
              >
                {t("community.toast.view")}
              </button>
            )}
          </div>
        ))}
      </div>

      {/* Desktop members column (optional) */}
      {membersOpen && (
        <MembersPanel
          me={me}
          members={members}
          variant="desktop"
          onClose={() => setMembersOpen(false)}
          onOpenProfile={openProfile}
        />
      )}

      {/* Mobile room sheet */}
      {roomsSheetOpen && (
        <>
          <button
            type="button"
            aria-label={t("community.closeRoomList")}
            onClick={() => setRoomsSheetOpen(false)}
            className="fixed inset-0 z-40 bg-navy/45 lg:hidden dark:bg-black/60"
          />
          <aside
            aria-label={t("nav.community")}
            className="fixed inset-y-0 start-0 z-50 flex w-[280px] max-w-[85vw] flex-col border-e border-line bg-surface shadow-2xl"
          >
            <button
              type="button"
              onClick={() => setRoomsSheetOpen(false)}
              aria-label={t("common.close")}
              className="absolute end-2 top-3 z-10 flex h-8 w-8 items-center justify-center rounded-lg text-muted hover:bg-surface-2"
            >
              <Icon name="x" size={15} />
            </button>
            {roomNav}
          </aside>
        </>
      )}

      {/* Mobile members sheet */}
      {membersSheetOpen && (
        <MembersPanel
          me={me}
          members={members}
          variant="sheet"
          onClose={() => setMembersSheetOpen(false)}
          onOpenProfile={openProfile}
        />
      )}

      {identityOpen && (
        <IdentityDialog
          me={{
            displayName: me.displayName,
            avatarId: me.avatarId,
            // Server-stamped flag (page → shell) — the dialog only relaxes the
            // client-side hint for the designated admin; the server action
            // re-validates with its own session check.
            platformAdmin: me.platformAdmin === true,
          }}
          onClose={() => setIdentityOpen(false)}
        />
      )}

      {settingsOpen && (
        <CommunitySettings
          initial={{
            ...prefs,
            mode: presence.mode,
            showPresence: presence.showPresence,
          }}
          onSetMode={(m) => {
            setPref({ mode: m });
            presence.setMode(m);
          }}
          onToggleShowPresence={() => {
            presence.toggleShowPresence();
          }}
          onClose={() => setSettingsOpen(false)}
        />
      )}

      {/* Profile card — owned by the shell so members panel, friends list
          and message authors all open the SAME dialog. */}
      {profileTarget && (
        <ProfileCard
          key={profileTarget}
          targetUserId={profileTarget}
          me={{ userId: me.userId }}
          onClose={() => setProfileTarget(null)}
        />
      )}
    </div>
  );
}
