"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useFriendshipsRealtime } from "@/lib/community/conversation-realtime";
import type { RealtimeLikeChannel } from "@/lib/community/realtime-core";
import { useCommunityPolling } from "@/lib/community/community-polling";
import { ActionSpinner, useCommunityToast } from "./action-feedback";
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
  const toast = useCommunityToast();

  // One shared, overlap-guarded social-state refresh — used by the
  // CENTRALIZED 1s poll (the synchronization guarantee) AND the realtime
  // event path. `?poll=1` keeps background refreshes in the higher
  // community_poll bucket. Change detection: an UNCHANGED payload causes
  // zero setState, so a quiet friends page renders nothing every second.
  const refetch = useCallback(async (signal?: AbortSignal) => {
    if (refetching.current) return; // overlap guard: skip, don't stack
    refetching.current = true;
    try {
      const response = await fetch("/api/community/friends?poll=1", {
        cache: "no-store",
        signal,
      });
      if (!response.ok) return; // keep the current view; the next cycle retries
      const next = normalizeFriendsPayload(await response.json());
      if (!next) return;
      setData((prev) => {
        const candidate = prev.unavailable ? next : next.unavailable ? prev : next;
        if (candidate === prev) return prev;
        if (JSON.stringify(candidate) === JSON.stringify(prev)) return prev; // unchanged
        return candidate;
      });
    } catch {
      /* chrome: keep the last good state */
    } finally {
      refetching.current = false;
    }
  }, []);

  // Realtime: relationship rows change (incoming request, acceptance, …).
  // The postgres stream is RLS-scoped — only the viewer's own rows arrive.
  // The subscription lives in the shared community realtime layer (stable
  // channel name, registry, JWT handshake, teardown, reconnect tracking);
  // the 250ms debounce below is the ≤500ms coalescing window for rapid
  // events.
  const scheduleRefetch = useCallback(() => {
    if (refetchTimer.current) window.clearTimeout(refetchTimer.current);
    refetchTimer.current = window.setTimeout(() => void refetch(), REALTIME_REFETCH_DEBOUNCE_MS);
  }, [refetch]);

  const registerFriendshipsHandlers = useCallback(
    (channel: RealtimeLikeChannel) => {
      channel
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
        );
    },
    [scheduleRefetch],
  );

  useFriendshipsRealtime(me.userId, {
    registerHandlers: registerFriendshipsHandlers,
    // Reconnect recovery: ONE targeted summary refetch — in addition to the
    // 1s poll below (same guarded function, no overlap possible).
    onMissedSync: () => {
      if (refetchTimer.current) window.clearTimeout(refetchTimer.current);
      void refetch();
    },
  });

  // THE 1s synchronization guarantee (all devices): the centralized poll
  // refreshes ONLY the viewer's friends/requests/blocks every 1000ms while
  // this view is mounted, pauses while hidden, no-ops when unchanged.
  useCommunityPolling({
    key: `friends:${me.userId}`,
    fetcher: (signal) => refetch(signal),
  });

  useEffect(() => {
    const timer = refetchTimer;
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, []);

  /** Perform a relationship action, then converge (optimistic + server).
   *  The pending state is set SYNCHRONOUSLY (the clicked button shows its
   *  spinner the same frame — the rest of the page stays interactive);
   *  success is a small localized toast, failure keeps the row + refetches. */
  const act = useCallback(
    async (row: FriendRow, action: "accept" | "decline" | "cancel" | "message" | "unblock") => {
      const key = `${row.userId}:${action}`;
      if (busy === key) return; // double-submit guard
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
          toast.notify({
            kind: "success",
            text: t("community.toast.nowFriends", { name: row.displayName }),
            dedupeKey: `friend-accept-${row.userId}`,
          });
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
          toast.notify({
            kind: "success",
            text: t("community.toast.requestDeclined"),
            dedupeKey: `friend-decline-${row.userId}`,
          });
        } else if (action === "cancel" && row.friendshipId) {
          const response = await fetch(`/api/community/friends/requests/${row.friendshipId}`, {
            method: "DELETE",
          });
          if (!response.ok) throw new Error(`cancel ${response.status}`);
          setData((prev) => ({
            ...prev,
            outgoing: prev.outgoing.filter((r) => r.userId !== row.userId),
          }));
          toast.notify({
            kind: "success",
            text: t("community.toast.requestCanceled"),
            dedupeKey: `friend-cancel-${row.userId}`,
          });
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
          toast.notify({
            kind: "success",
            text: t("community.toast.unblocked", { name: row.displayName }),
            dedupeKey: `friend-unblock-${row.userId}`,
          });
        }
      } catch {
        setError(true);
        toast.notify({
          kind: "error",
          text: t("community.toast.actionError"),
          dedupeKey: "friend-action-error",
        });
        await refetch(); // converge to the server truth
      } finally {
        setBusy(null);
      }
    },
    [busy, refetch, router, t, toast],
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
          aria-busy={busy === `${row.userId}:message` || undefined}
          onClick={() => void act(row, "message")}
          aria-label={`${t("community.message")} — ${row.displayName}`}
        >
          {busy === `${row.userId}:message` ? (
            <ActionSpinner className="h-3.5 w-3.5" />
          ) : (
            <Icon name="message" size={13} />
          )}
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
              aria-busy={busy === `${row.userId}:accept` || undefined}
              onClick={() => void act(row, "accept")}
              aria-label={`${t("community.acceptRequest")} — ${row.displayName}`}
            >
              {busy === `${row.userId}:accept` ? (
                <ActionSpinner className="h-3.5 w-3.5" />
              ) : (
                <Icon name="check" size={13} />
              )}
              <span className="hidden sm:inline">{t("community.acceptRequest")}</span>
            </Button>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={busy !== null}
              aria-busy={busy === `${row.userId}:decline` || undefined}
              onClick={() => void act(row, "decline")}
              aria-label={`${t("community.declineRequest")} — ${row.displayName}`}
            >
              {busy === `${row.userId}:decline` ? (
                <ActionSpinner className="h-3.5 w-3.5" />
              ) : (
                <Icon name="x" size={13} />
              )}
            </Button>
          </div>
        ) : (
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={busy !== null}
            aria-busy={busy === `${row.userId}:cancel` || undefined}
            onClick={() => void act(row, "cancel")}
            aria-label={`${t("community.cancelRequest")} — ${row.displayName}`}
          >
            {busy === `${row.userId}:cancel` && <ActionSpinner className="h-3.5 w-3.5" />}
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
                      aria-busy={busy === `${row.userId}:unblock` || undefined}
                    >
                      {busy === `${row.userId}:unblock` && <ActionSpinner className="h-3.5 w-3.5" />}
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
