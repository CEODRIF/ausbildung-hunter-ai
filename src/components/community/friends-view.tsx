"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Icon } from "@/components/icon";
import { Button, Card, ErrorState } from "@/components/ui";
import { useI18n } from "@/lib/i18n";
import { communityAvatarUrl } from "@/lib/community";
import type {
  RelationshipState,
} from "@/lib/community/relationship";
import type { PresenceState } from "@/lib/community/presence";
import { useCommunityShell } from "./community-shell";
import type { SocialProfileClient } from "./profile-card";
import { presenceDotClass, PresenceIndicator } from "./presence-indicator";
import { AdminBadge } from "./admin-badge";

/**
 * The FRIENDS page (Phase 2):
 *   - Incoming requests (Accept / Decline)
 *   - Outgoing requests (Cancel)
 *   - Friends, grouped by server-computed presence (Online / Offline)
 *   - Blocked members (Unblock)
 *
 * Data: the page prefetches everything server-side (degraded-safe). While the
 * page is open, Supabase Realtime streams relationship changes (RLS scopes
 * the postgres stream to the viewer's own rows — a request arriving, an
 * acceptance, a cancellation) and the view re-fetches the summary to
 * converge. Own actions also update the local state immediately.
 */

export interface FriendRow {
  userId: string;
  displayName: string;
  avatarId: string;
  /** Phase 2 flag (kept for compatibility; `presence` wins when present). */
  online: boolean;
  /** Phase 3: privacy-mapped presence state (server-computed). */
  presence?: PresenceState;
  /** Phase 3: privacy-mapped last seen (null = hidden / never). */
  lastSeenAt?: string | null;
  /** Phase 10: server-trusted platform-admin flag (drives the red badge). */
  isPlatformAdmin?: boolean;
  state: RelationshipState;
  friendshipId: string | null;
}

export interface FriendsViewData {
  friends: FriendRow[];
  incoming: FriendRow[];
  outgoing: FriendRow[];
  blocked: SocialProfileClient[];
  unavailable: boolean;
}

export interface FriendsViewProps {
  me: { userId: string };
  initial: FriendsViewData;
}

const REALTIME_REFETCH_DEBOUNCE_MS = 250;

/** The wire row from GET /api/community/friends (RelationshipView shape —
 *  the SAME shape the server derives the initial page data from). */
interface RelationshipViewWire {
  state: RelationshipState;
  friendshipId: string | null;
  other: SocialProfileClient;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Normalize ONE wire row to FriendRow (drops malformed rows — the server
 *  is the truth; a bad row can never crash the list). */
function toFriendRow(value: unknown): FriendRow | null {
  if (!isRecord(value)) return null;
  const view = value as Partial<RelationshipViewWire>;
  const other = view.other;
  if (!isRecord(other) || typeof other.userId !== "string") return null;
  if (typeof view.state !== "string") return null;
  return {
    userId: other.userId,
    displayName: typeof other.displayName === "string" ? other.displayName : "",
    avatarId: typeof other.avatarId === "string" ? other.avatarId : "",
    online: other.online === true,
    presence: other.presence,
    lastSeenAt: other.lastSeenAt ?? null,
    isPlatformAdmin: other.isPlatformAdmin === true,
    state: view.state as RelationshipState,
    friendshipId: typeof view.friendshipId === "string" ? view.friendshipId : null,
  };
}

/** Normalize the WHOLE /api/community/friends payload into the view's
 *  FriendsViewData shape — the refetched data always has the same
 *  normalized shape as the server-prefetched initial data (no
 *  client/server type drift). */
function normalizeFriendsPayload(body: unknown): FriendsViewData | null {
  if (!isRecord(body) || !Array.isArray(body.friends)) return null;
  const toRows = (list: unknown): FriendRow[] =>
    (Array.isArray(list) ? list : []).map(toFriendRow).filter((r): r is FriendRow => r !== null);
  const blocked = (Array.isArray(body.blocked) ? body.blocked : [])
    .filter((b): b is SocialProfileClient => isRecord(b) && typeof b.userId === "string")
    .map((b) => ({
      userId: b.userId,
      displayName: b.displayName,
      avatarId: b.avatarId,
      bio: b.bio,
      joinedAt: b.joinedAt,
      online: b.online,
      presence: b.presence,
      lastSeenAt: b.lastSeenAt ?? null,
      isPlatformAdmin: b.isPlatformAdmin,
    }));
  return {
    friends: toRows(body.friends),
    incoming: toRows(body.incoming),
    outgoing: toRows(body.outgoing),
    blocked,
    unavailable: body.unavailable === true,
  };
}

export function FriendsView({ me, initial }: FriendsViewProps) {
  const { t } = useI18n();
  const { openProfile } = useCommunityShell();
  const router = useRouter();
  const [data, setData] = useState<FriendsViewData>(initial);
  const [busy, setBusy] = useState<string | null>(null); // key of the row being updated
  const [error, setError] = useState(false);
  const refetchTimer = useRef<number | null>(null);
  const refetching = useRef(false);

  const refetch = useCallback(async () => {
    if (refetching.current) return;
    refetching.current = true;
    try {
      const response = await fetch("/api/community/friends", { cache: "no-store" });
      if (!response.ok) return; // keep the current view; the next event retries
      const next = normalizeFriendsPayload(await response.json());
      if (next) {
        setData((prev) => (prev.unavailable ? next : next.unavailable ? prev : next));
      }
    } catch {
      /* chrome: keep the last good state */
    } finally {
      refetching.current = false;
    }
  }, []);

  // Realtime: relationship rows change (incoming request, acceptance, …).
  // The postgres stream is RLS-scoped — only the viewer's own rows arrive —
  // which requires the JWT attached to the socket BEFORE joining (same
  // pattern as RoomChat; a token-less join streams zero rows).
  const clientRef = useRef<ReturnType<typeof createClient> | null>(null);
  const getClient = useCallback((): ReturnType<typeof createClient> | null => {
    if (clientRef.current) return clientRef.current;
    try {
      clientRef.current = createClient();
    } catch (error) {
      console.error("[community] realtime client unavailable:", error);
      return null;
    }
    return clientRef.current;
  }, []);

  useEffect(() => {
    let disposed = false;
    let channel: ReturnType<ReturnType<typeof createClient>["channel"]> | null = null;
    const scheduleRefetch = () => {
      if (disposed) return;
      if (refetchTimer.current) window.clearTimeout(refetchTimer.current);
      refetchTimer.current = window.setTimeout(() => void refetch(), REALTIME_REFETCH_DEBOUNCE_MS);
    };
    const client = getClient();
    if (!client) return;
    const subscribeChannel = () => {
      if (disposed || channel) return;
      try {
        channel = client
          .channel(`community-friendships-${me.userId}`)
          .on(
            "postgres_changes",
            { event: "INSERT", schema: "public", table: "community_friendships" },
            () => scheduleRefetch(),
          )
          .on(
            "postgres_changes",
            { event: "UPDATE", schema: "public", table: "community_friendships" },
            () => scheduleRefetch(),
          )
          .on(
            "postgres_changes",
            { event: "DELETE", schema: "public", table: "community_friendships" },
            () => scheduleRefetch(),
          )
          .subscribe();
      } catch (error) {
        console.error("[community] friends realtime failed:", error);
      }
    };
    void (async () => {
      try {
        await client.auth.initialize();
      } catch {
        /* restored-session failure: the join simply stays pending */
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
    // Session restored AFTER the first getSession(): join then.
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
      if (refetchTimer.current) window.clearTimeout(refetchTimer.current);
      authSub.data.subscription.unsubscribe();
      if (channel) void client.removeChannel(channel);
    };
  }, [getClient, me.userId, refetch]);

  /** Perform a relationship action, then converge (optimistic + server). */
  const act = useCallback(
    async (row: FriendRow, action: "accept" | "decline" | "cancel" | "message" | "unblock") => {
      const key = `${row.userId}:${action}`;
      setBusy(key);
      setError(false);
      try {
        if (action === "accept" && row.friendshipId) {
          const response = await fetch(`/api/community/friends/requests/${row.friendshipId}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ action: "accept" }),
          });
          if (!response.ok) throw new Error(`accept ${response.status}`);
          setData((prev) => ({
            ...prev,
            incoming: prev.incoming.filter((r) => r.userId !== row.userId),
            friends: [
              { ...row, state: "friends" as const },
              ...prev.friends.filter((r) => r.userId !== row.userId),
            ],
          }));
        } else if (action === "decline" && row.friendshipId) {
          const response = await fetch(`/api/community/friends/requests/${row.friendshipId}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ action: "decline" }),
          });
          if (!response.ok) throw new Error(`decline ${response.status}`);
          setData((prev) => ({
            ...prev,
            incoming: prev.incoming.filter((r) => r.userId !== row.userId),
          }));
        } else if (action === "cancel" && row.friendshipId) {
          const response = await fetch(`/api/community/friends/requests/${row.friendshipId}`, {
            method: "DELETE",
          });
          if (!response.ok) throw new Error(`cancel ${response.status}`);
          setData((prev) => ({
            ...prev,
            outgoing: prev.outgoing.filter((r) => r.userId !== row.userId),
          }));
        } else if (action === "message") {
          const response = await fetch("/api/community/dm", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ userId: row.userId }),
          });
          if (!response.ok) throw new Error(`message ${response.status}`);
          const body = (await response.json()) as { conversation: { id: string } };
          router.push(`/community/messages/${body.conversation.id}`);
          return;
        } else if (action === "unblock") {
          const response = await fetch(`/api/community/blocks/${row.userId}`, {
            method: "DELETE",
          });
          if (!response.ok) throw new Error(`unblock ${response.status}`);
          setData((prev) => ({
            ...prev,
            blocked: prev.blocked.filter((r) => r.userId !== row.userId),
          }));
        }
      } catch {
        setError(true);
        await refetch(); // converge to the server truth
      } finally {
        setBusy(null);
      }
    },
    [refetch, router],
  );

  if (data.unavailable) {
    return (
      <div className="mx-auto w-full max-w-3xl px-4 py-8">
        <ErrorState onRetry={() => void refetch()} />
      </div>
    );
  }

  /** The ONE shared presence derivation (state wins, flag as fallback). */
  const presenceOf = (row: FriendRow): PresenceState =>
    row.presence ?? (row.online ? "online" : "offline");

  const online = data.friends.filter((f) => presenceOf(f) !== "offline");
  const offline = data.friends.filter((f) => presenceOf(f) === "offline");

  const friendRow = (row: FriendRow) => {
    const state = presenceOf(row);
    return (
    <li key={row.userId}>
      <div className="group flex items-center gap-3 rounded-xl px-2.5 py-2 transition-colors hover:bg-surface-2/60">
        <button
          type="button"
          onClick={() => openProfile(row.userId)}
          aria-label={t("community.openProfile")}
          className="flex min-w-0 flex-1 items-center gap-3 text-start"
        >
          <span className="relative shrink-0">
            {/* eslint-disable-next-line @next/next/no-img-element -- avatar: fixed 36px, static public asset */}
            <img
              src={communityAvatarUrl(row.avatarId)}
              alt=""
              width={36}
              height={36}
              className="h-9 w-9 rounded-xl object-cover"
            />
            {/* Phase 3: the shared presence dot (privacy-mapped). */}
            <span
              className={`absolute -bottom-0.5 -end-0.5 ring-2 ring-surface ${presenceDotClass(state)}`}
              aria-hidden="true"
            />
          </span>
          <span className="min-w-0">
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="block truncate text-sm font-semibold text-ink">
                {row.displayName}
              </span>
              {row.isPlatformAdmin === true && (
                <AdminBadge size={13} label={t("community.adminBadge")} />
              )}
            </span>
            <PresenceIndicator
              state={state}
              label={state !== "offline"}
              lastSeenAt={state === "offline" ? row.lastSeenAt ?? null : null}
            />
          </span>
        </button>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={busy !== null}
          onClick={() => void act(row, "message")}
          aria-label={`${t("community.message")} — ${row.displayName}`}
        >
          <Icon name="message" size={13} />
          <span className="hidden sm:inline">{t("community.message")}</span>
        </Button>
      </div>
    </li>
    );
  };

  const requestRow = (row: FriendRow, section: "incoming" | "outgoing") => (
    <li key={row.userId}>
      <div className="flex items-center gap-3 rounded-xl px-2.5 py-2">
        <button
          type="button"
          onClick={() => openProfile(row.userId)}
          aria-label={t("community.openProfile")}
          className="flex min-w-0 flex-1 items-center gap-3 text-start"
        >
          <span className="relative shrink-0">
            {/* eslint-disable-next-line @next/next/no-img-element -- avatar: fixed 36px, static public asset */}
            <img
              src={communityAvatarUrl(row.avatarId)}
              alt=""
              width={36}
              height={36}
              className="h-9 w-9 rounded-xl object-cover"
            />
            <span
              className={`absolute -bottom-0.5 -end-0.5 ring-2 ring-surface ${presenceDotClass(presenceOf(row))}`}
              aria-hidden="true"
            />
          </span>
          <span className="min-w-0">
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="block truncate text-sm font-semibold text-ink">
                {row.displayName}
              </span>
              {row.isPlatformAdmin === true && (
                <AdminBadge size={13} label={t("community.adminBadge")} />
              )}
            </span>
            <span className="block truncate text-[11px] text-faint">
              {section === "incoming"
                ? t("community.incomingTitle")
                : t("community.outgoingTitle")}
            </span>
          </span>
        </button>
        {section === "incoming" ? (
          <div className="flex shrink-0 gap-1.5">
            <Button
              type="button"
              size="sm"
              disabled={busy !== null}
              onClick={() => void act(row, "accept")}
              aria-label={`${t("community.acceptRequest")} — ${row.displayName}`}
            >
              <Icon name="check" size={13} />
              <span className="hidden sm:inline">{t("community.acceptRequest")}</span>
            </Button>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={busy !== null}
              onClick={() => void act(row, "decline")}
              aria-label={`${t("community.declineRequest")} — ${row.displayName}`}
            >
              <Icon name="x" size={13} />
            </Button>
          </div>
        ) : (
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={busy !== null}
            onClick={() => void act(row, "cancel")}
            aria-label={`${t("community.cancelRequest")} — ${row.displayName}`}
          >
            {t("community.cancelRequest")}
          </Button>
        )}
      </div>
    </li>
  );

  return (
    <div className="absolute inset-0 overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl px-4 py-5 sm:px-6">
        <h1 className="text-xl font-bold text-ink">{t("community.friendsTitle")}</h1>
        <p className="mt-0.5 text-sm text-muted">{t("community.friendsSubtitle")}</p>

        {error && (
          <p role="alert" className="mt-3 text-xs font-medium text-danger">
            {t("community.actionFailed")}
          </p>
        )}

        {/* Requests */}
        <div className="mt-5 grid gap-4 sm:grid-cols-2">
          <Card>
            <div className="border-b border-line px-4 py-3">
              <h2 className="flex items-center gap-2 text-sm font-bold text-ink">
                {t("community.incomingTitle")}
                <span className="rounded-full bg-accent-soft px-2 py-0.5 text-[11px] font-bold text-accent">
                  {data.incoming.length}
                </span>
              </h2>
            </div>
            {data.incoming.length === 0 ? (
              <p className="px-4 py-5 text-xs text-faint">{t("community.noRequests")}</p>
            ) : (
              <ul className="p-2">{data.incoming.map((r) => requestRow(r, "incoming"))}</ul>
            )}
          </Card>
          <Card>
            <div className="border-b border-line px-4 py-3">
              <h2 className="flex items-center gap-2 text-sm font-bold text-ink">
                {t("community.outgoingTitle")}
                <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[11px] font-bold text-muted">
                  {data.outgoing.length}
                </span>
              </h2>
            </div>
            {data.outgoing.length === 0 ? (
              <p className="px-4 py-5 text-xs text-faint">{t("community.noRequests")}</p>
            ) : (
              <ul className="p-2">{data.outgoing.map((r) => requestRow(r, "outgoing"))}</ul>
            )}
          </Card>
        </div>

        {/* Friends (presence groups) */}
        <h2 className="mt-7 text-sm font-bold tracking-[0.08em] text-ink uppercase">
          {t("community.friendsListTitle")}
        </h2>
        {data.friends.length === 0 ? (
          <p className="mt-2 rounded-2xl border border-dashed border-line-strong px-4 py-6 text-center text-sm text-muted">
            {t("community.noFriends")}
          </p>
        ) : (
          <div className="mt-2 space-y-4">
            {online.length > 0 && (
              <section aria-label={t("community.onlineGroup")}>
                <h3 className="mb-1 flex items-center gap-1.5 px-2.5 text-[11px] font-bold tracking-wide text-success uppercase">
                  <span className="h-1.5 w-1.5 rounded-full bg-success" aria-hidden="true" />
                  {t("community.onlineGroup")} ({online.length})
                </h3>
                <ul className="space-y-0.5">{online.map(friendRow)}</ul>
              </section>
            )}
            {offline.length > 0 && (
              <section aria-label={t("community.offlineGroup")}>
                <h3 className="mb-1 flex items-center gap-1.5 px-2.5 text-[11px] font-bold tracking-wide text-faint uppercase">
                  <span className="h-1.5 w-1.5 rounded-full bg-faint" aria-hidden="true" />
                  {t("community.offlineGroup")} ({offline.length})
                </h3>
                <ul className="space-y-0.5">{offline.map(friendRow)}</ul>
              </section>
            )}
          </div>
        )}

        {/* Blocked */}
        {data.blocked.length > 0 && (
          <>
            <h2 className="mt-7 text-sm font-bold tracking-[0.08em] text-ink uppercase">
              {t("community.blockedTitle")}
            </h2>
            <ul className="mt-2 space-y-0.5">
              {data.blocked.map((row) => (
                <li key={row.userId}>
                  <div className="flex items-center gap-3 rounded-xl px-2.5 py-2">
                    <span className="relative shrink-0">
                      {/* eslint-disable-next-line @next/next/no-img-element -- avatar: fixed 36px, static public asset */}
                      <img
                        src={communityAvatarUrl(row.avatarId)}
                        alt=""
                        width={36}
                        height={36}
                        className="h-9 w-9 rounded-xl object-cover opacity-60"
                      />
                      <span
                        className={`absolute -bottom-0.5 -end-0.5 ring-2 ring-surface ${presenceDotClass(
                          row.presence ?? (row.online ? "online" : "offline"),
                        )}`}
                        aria-hidden="true"
                      />
                    </span>
                    <span className="flex min-w-0 flex-1 items-center gap-1.5">
                      <span className="truncate text-sm font-semibold text-muted">
                        {row.displayName}
                      </span>
                      {row.isPlatformAdmin === true && (
                        <AdminBadge size={13} label={t("community.adminBadge")} />
                      )}
                    </span>
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      disabled={busy !== null}
                      onClick={() =>
                        void act(
                          {
                            userId: row.userId,
                            displayName: row.displayName,
                            avatarId: row.avatarId,
                            online: row.online,
                            state: "blocked_by_me",
                            friendshipId: null,
                          },
                          "unblock",
                        )
                      }
                      aria-label={`${t("community.unblock")} — ${row.displayName}`}
                    >
                      {t("community.unblock")}
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}
