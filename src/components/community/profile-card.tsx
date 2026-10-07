"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Icon } from "@/components/icon";
import { Button, LoadingState } from "@/components/ui";
import { useI18n } from "@/lib/i18n";
import { communityAvatarUrl } from "@/lib/community";
import { allowedActions, type RelationshipState } from "@/lib/community/relationship";
import {
  parsePresenceBroadcast,
  PRESENCE_BROADCAST_CHANNEL,
  PRESENCE_BROADCAST_EVENT,
  type PresenceMode,
  type PresenceState,
} from "@/lib/community/presence";
import { presenceDotClass, PresenceIndicator } from "./presence-indicator";
import { ReportDialog } from "./report-dialog";

/**
 * The member PROFILE CARD (Phase 2 social layer).
 *
 * Privacy contract: the payload comes from GET /api/community/members/:id,
 * which selects ONLY community identity fields (username, avatar, bio, join
 * date, server-computed presence) plus the viewer's relationship to the
 * target. No email, no real name, no account ids — the card cannot show
 * what the API does not send.
 *
 * State-dependent actions (from the PURE state machine in
 * @/lib/community/relationship): every button the card offers is an action
 * the server accepts for this state, and every action result converges the
 * local state (the server row is the truth; on any error the card simply
 * shows the retry-able error and re-reads on next open).
 *
 * Keyboard: Escape closes (also from the confirm state), focus moves in on
 * open and returns to the trigger on close.
 */

export interface SocialProfileClient {
  userId: string;
  displayName: string;
  avatarId: string;
  bio: string | null;
  /** Community join date (ISO). */
  joinedAt: string;
  /** Server-computed presence flag (Phase 2; kept for compatibility). */
  online: boolean;
  /** Phase 3: privacy-mapped presence state (server-computed). */
  presence?: PresenceState;
  /** Phase 3: privacy-mapped last seen (null = hidden / never). */
  lastSeenAt?: string | null;
}

export interface RelationshipClient {
  state: RelationshipState;
  friendshipId: string | null;
  other: SocialProfileClient;
}

type CardData = { member: SocialProfileClient; relationship: RelationshipClient };

/** Phase 5: the reputation summary (SIBLING field of `member` — the API
 *  contract for `member`/`relationship` is untouched). */
type ReputationStats = {
  reputation: number;
  questions: number;
  answers: number;
  accepted: number;
};

type CardAction = "send_request" | "cancel_request" | "accept_request" | "decline_request" | "remove_friend" | "block" | "unblock" | "message";

interface ActionSpec {
  action: CardAction;
  label: string;
  variant: "primary" | "secondary" | "ghost";
  danger?: boolean;
  confirmFirst?: "block" | "remove_friend";
}

export interface ProfileCardProps {
  targetUserId: string;
  me: { userId: string };
  onClose: () => void;
}

function localeFor(lang: string): string {
  return lang === "de" ? "de-DE" : lang === "fr" ? "fr-FR" : lang === "ar" ? "ar" : "en-US";
}

export function ProfileCard({ targetUserId, me, onClose }: ProfileCardProps) {
  const { t, lang } = useI18n();
  const router = useRouter();
  const locale = localeFor(lang);
  const [data, setData] = useState<CardData | null>(null);
  const [stats, setStats] = useState<ReputationStats | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [busy, setBusy] = useState<CardAction | null>(null);
  // Classified action failure (incident: production showed only the generic
  // message, so the user could not tell self-request / blocked / not-found /
  // rate-limit / server error apart). The server is the classifier; the card
  // just maps the safe code to the matching localized copy.
  const [actionError, setActionError] = useState<
    false | "self_request" | "blocked" | "not_found" | "rate_limited" | "generic"
  >(false);
  const [confirming, setConfirming] = useState<null | "block" | "remove_friend">(null);
  // Phase 5: report dialog (self-report is blocked server-side; the button
  // is simply hidden for one's own card).
  const [reportOpen, setReportOpen] = useState(false);
  // Phase 3: the peer's LIVE presence (member-scoped broadcast channel).
  // A user with show_presence = false publishes nothing, so a broadcast
  // here always means "safe to show". Stale/out-of-order payloads (older
  // ts) are dropped; a fresh fetch on every open re-baselines from the
  // server's privacy-mapped state.
  const [live, setLive] = useState<{ mode: PresenceMode; lastSeenAt: string; ts: number } | null>(null);
  const liveTsRef = useRef(0);

  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  // Focus management: in on open, back to the trigger on close.
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    return () => {
      previous?.focus?.();
    };
  }, []);

  // Escape closes (confirm state first, then the card).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (confirming) setConfirming(null);
      else onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [confirming, onClose]);

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/community/members/${targetUserId}`, {
        cache: "no-store",
      });
      if (!response.ok) {
        setLoadError(true);
        return;
      }
      const body = (await response.json()) as CardData & { stats?: ReputationStats | null };
      setData(body);
      setStats(body.stats ?? null);
      setLive(null); // re-baseline: the fresh server state wins
      liveTsRef.current = 0;
    } catch {
      setLoadError(true);
    }
  }, [targetUserId]);

  useEffect(() => {
    // Intentional: fetch on open and whenever the target user changes.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  // Phase 3: live peer presence over the PER-USER broadcast channel
  // (community-presence-<targetUserId>). The card subscribes only while it
  // is open and tears the channel down on close — no global presence
  // channel, no timer.
  useEffect(() => {
    let disposed = false;
    let channel: ReturnType<ReturnType<typeof createClient>["channel"]> | null = null;
    let client: ReturnType<typeof createClient> | null = null;
    try {
      client = createClient();
    } catch (error) {
      console.error("[community] profile presence client unavailable:", error);
      return;
    }
    void (async () => {
      try {
        await client!.auth.initialize();
      } catch {
        return; // session restore failed: presence stays server-baselined
      }
      if (disposed) return;
      const {
        data: { session },
      } = await client!.auth.getSession();
      if (disposed || !session?.access_token) return;
      try {
        channel = client!.channel(PRESENCE_BROADCAST_CHANNEL(targetUserId)).on(
          "broadcast",
          { event: PRESENCE_BROADCAST_EVENT },
          (payload) => {
            const broadcast = parsePresenceBroadcast(payload?.payload);
            if (!broadcast || broadcast.userId !== targetUserId) return;
            if (broadcast.ts <= liveTsRef.current) return; // stale / out of order
            liveTsRef.current = broadcast.ts;
            setLive({ mode: broadcast.mode, lastSeenAt: broadcast.lastSeenAt, ts: broadcast.ts });
          },
        );
        channel.subscribe();
      } catch (error) {
        console.error("[community] profile presence subscribe failed:", error);
      }
    })();
    return () => {
      disposed = true;
      if (channel) void client!.removeChannel(channel);
    };
  }, [targetUserId]);

  const setRelationship = useCallback((patch: Partial<RelationshipClient>) => {
    setData((prev) => (prev ? { ...prev, relationship: { ...prev.relationship, ...patch } } : prev));
  }, []);

  const run = useCallback(
    async (action: CardAction) => {
      if (busy || !data) return;
      setBusy(action);
      setActionError(false);
      setConfirming(null);
      const rel = data.relationship;
      try {
        const json = (response: Response) =>
          response.json().catch(() => null) as Promise<Record<string, unknown> | null>;
        if (action === "send_request") {
          const response = await fetch("/api/community/friends", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ userId: targetUserId }),
          });
          if (!response.ok) {
            const errBody = (await json(response)) as { error?: unknown } | null;
            const code = typeof errBody?.error === "string" ? errBody.error : "";
            const cls =
              code === "self_request"
                ? "self_request"
                : code === "blocked"
                  ? "blocked"
                  : code === "member_not_found"
                    ? "not_found"
                    : response.status === 429
                      ? "rate_limited"
                      : "generic";
            throw new Error(`friend_error:${cls}`);
          }
          const body = (await json(response)) as { friendship?: { requester_id: string; status: "pending" | "accepted"; id: string } } | null;
          const row = body?.friendship;
          if (row) {
            setRelationship({
              state:
                row.status === "accepted"
                  ? "friends"
                  : row.requester_id === me.userId
                    ? "outgoing_pending"
                    : "incoming_pending",
              friendshipId: row.id,
            });
          }
        } else if (action === "cancel_request" && rel.friendshipId) {
          const response = await fetch(`/api/community/friends/requests/${rel.friendshipId}`, {
            method: "DELETE",
          });
          if (!response.ok) throw new Error(`cancel_request ${response.status}`);
          setRelationship({ state: "none", friendshipId: null });
        } else if (action === "accept_request" && rel.friendshipId) {
          const response = await fetch(`/api/community/friends/requests/${rel.friendshipId}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ action: "accept" }),
          });
          if (!response.ok) throw new Error(`accept_request ${response.status}`);
          setRelationship({ state: "friends" });
        } else if (action === "decline_request" && rel.friendshipId) {
          const response = await fetch(`/api/community/friends/requests/${rel.friendshipId}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ action: "decline" }),
          });
          if (!response.ok) throw new Error(`decline_request ${response.status}`);
          setRelationship({ state: "none", friendshipId: null });
        } else if (action === "remove_friend") {
          const response = await fetch(`/api/community/friends/${targetUserId}`, {
            method: "DELETE",
          });
          if (!response.ok) throw new Error(`remove_friend ${response.status}`);
          setRelationship({ state: "none", friendshipId: null });
        } else if (action === "block") {
          const response = await fetch(`/api/community/blocks/${targetUserId}`, {
            method: "POST",
          });
          if (!response.ok) throw new Error(`block ${response.status}`);
          setRelationship({ state: "blocked_by_me" });
        } else if (action === "unblock") {
          const response = await fetch(`/api/community/blocks/${targetUserId}`, {
            method: "DELETE",
          });
          if (!response.ok) throw new Error(`unblock ${response.status}`);
          // The underlying friendship (if any) decides the new state —
          // re-read the canonical card data.
          await load();
        } else if (action === "message") {
          const response = await fetch("/api/community/dm", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ userId: targetUserId }),
          });
          if (!response.ok) {
            const body = (await json(response)) as { error?: string } | null;
            if (body?.error === "not_friends") {
              setActionError("generic");
              setBusy(null);
              setRelationship({ state: "none" });
              return;
            }
            throw new Error(`message ${response.status}`);
          }
          const body = (await json(response)) as { conversation?: { id: string } } | null;
          const conversationId = body?.conversation?.id;
          if (!conversationId) throw new Error("message: no conversation");
          onClose();
          router.push(`/community/messages/${conversationId}`);
          return;
        }
      } catch (error) {
        // The server is the truth: on ANY failure the local state is left
        // untouched and the user can retry (or re-open the card, which
        // re-fetches). A tagged friend-error keeps its classification;
        // everything else degrades to the generic retry-able message.
        const tag =
          error instanceof Error && error.message.startsWith("friend_error:")
            ? error.message.slice("friend_error:".length)
            : "generic";
        setActionError(tag as "generic" | "self_request" | "blocked" | "not_found" | "rate_limited");
      } finally {
        setBusy(null);
      }
    },
    [busy, data, load, me.userId, onClose, router, setRelationship, targetUserId],
  );

  const member = data?.member ?? null;
  const relationship = data?.relationship ?? null;

  // Phase 3: the ONE shared presence derivation for this surface —
  // server-baselined (privacy-mapped), live-updated by the peer broadcast.
  const presenceState: PresenceState = live
    ? live.mode
    : member
      ? (member.presence ?? (member.online ? "online" : "offline"))
      : "offline";
  const presenceLastSeen: string | null = live
    ? live.lastSeenAt
    : (member?.lastSeenAt ?? null);

  const actions: ActionSpec[] = relationship
    ? allowedActions(relationship.state).flatMap((a): ActionSpec[] => {
        switch (a) {
          case "send_request":
            return [{ action: a, label: t("community.addFriend"), variant: "primary" }];
          case "cancel_request":
            return [{ action: a, label: t("community.cancelRequest"), variant: "secondary" }];
          case "accept_request":
            return [{ action: a, label: t("community.acceptRequest"), variant: "primary" }];
          case "decline_request":
            return [{ action: a, label: t("community.declineRequest"), variant: "secondary" }];
          case "remove_friend":
            return [{ action: a, label: t("community.removeFriend"), variant: "secondary", danger: true, confirmFirst: "remove_friend" }];
          case "block":
            return [{ action: a, label: t("community.block"), variant: "ghost", danger: true, confirmFirst: "block" }];
          case "unblock":
            return [{ action: a, label: t("community.unblock"), variant: "primary" }];
          case "message":
            return [{ action: a, label: t("community.message"), variant: "primary" }];
        }
      })
    : [];

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={t("community.profileCardTitle")}
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
    >
      <button
        type="button"
        aria-label={t("community.closeProfile")}
        onClick={onClose}
        className="absolute inset-0 bg-navy/45 backdrop-blur-[2px] dark:bg-black/60"
      />
      <div className="relative z-10 w-full max-w-sm rounded-2xl border border-line bg-surface p-5 shadow-2xl sm:p-6">
        <div className="mb-4 flex items-start justify-between gap-4">
          <h2 className="text-lg font-bold text-ink">{t("community.profileCardTitle")}</h2>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label={t("community.closeProfile")}
            className="rounded-lg p-1.5 text-faint hover:bg-surface-2 hover:text-ink"
          >
            <Icon name="x" size={16} strokeWidth={2} />
          </button>
        </div>

        {loadError ? (
          <div className="flex flex-col items-center gap-3 py-10 text-center">
            <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-danger-soft text-danger">
              <Icon name="alert" size={20} />
            </span>
            <p className="text-sm text-muted">{t("community.profileLoadError")}</p>
            <Button variant="secondary" size="sm" onClick={() => void load()}>
              {t("common.retry")}
            </Button>
          </div>
        ) : !data || !member || !relationship ? (
          <div className="flex justify-center py-10">
            <LoadingState />
          </div>
        ) : (
          <>
            {/* Identity */}
            <div className="flex items-start gap-3.5">
              <span className="relative shrink-0">
                {/* eslint-disable-next-line @next/next/no-img-element -- avatar: fixed 56px, static public asset */}
                <img
                  src={communityAvatarUrl(member.avatarId)}
                  alt=""
                  width={56}
                  height={56}
                  className="h-14 w-14 rounded-2xl object-cover"
                />
                <span
                  aria-hidden="true"
                  className={`absolute -bottom-0.5 -end-0.5 rounded-full ring-2 ring-surface ${presenceDotClass(presenceState, "h-3.5 w-3.5")}`}
                />
              </span>
              <div className="min-w-0 flex-1 pt-0.5">
                <p className="truncate text-base font-bold text-ink">{member.displayName}</p>
                <div className="mt-0.5">
                  <PresenceIndicator
                    state={presenceState}
                    size="md"
                    label={presenceState !== "offline"}
                    lastSeenAt={presenceState === "offline" ? presenceLastSeen : null}
                  />
                </div>
                <p className="mt-1 text-[11px] text-faint">
                  {t("community.joined", {
                    date: new Date(member.joinedAt).toLocaleDateString(locale, {
                      day: "2-digit",
                      month: "long",
                      year: "numeric",
                    }),
                  })}
                </p>
              </div>
            </div>

            {/* Bio (optional, identity-level only) */}
            <p className="mt-4 whitespace-pre-wrap break-words text-sm leading-6 text-ink-soft">
              {member.bio?.trim() ? member.bio : <span className="text-faint">{t("community.bioEmpty")}</span>}
            </p>

            {/* Phase 5: reputation stats (server-computed sibling field) */}
            {stats && (
              <dl className="mt-4 grid grid-cols-3 gap-2">
                <div className="rounded-xl bg-surface-2/60 px-2 py-2 text-center">
                  <dt className="text-[10px] font-semibold text-faint">{t("community.statsReputation")}</dt>
                  <dd className="text-sm font-bold text-ink">{stats.reputation}</dd>
                </div>
                <div className="rounded-xl bg-surface-2/60 px-2 py-2 text-center">
                  <dt className="text-[10px] font-semibold text-faint">{t("community.statsQuestionsLabel")}</dt>
                  <dd className="text-sm font-bold text-ink">{stats.questions}</dd>
                </div>
                <div className="rounded-xl bg-surface-2/60 px-2 py-2 text-center">
                  <dt className="text-[10px] font-semibold text-faint">{t("community.statsAcceptedLabel")}</dt>
                  <dd className="text-sm font-bold text-ink">{stats.accepted}</dd>
                </div>
              </dl>
            )}

            {actionError && (
              <p role="alert" className="mt-3 text-xs font-medium text-danger">
                {t(
                  actionError === "self_request"
                    ? "community.friendErrorSelf"
                    : actionError === "blocked"
                      ? "community.friendErrorBlocked"
                      : actionError === "not_found"
                        ? "community.friendErrorNotFound"
                        : actionError === "rate_limited"
                          ? "community.friendErrorRateLimit"
                          : "community.actionFailed",
                )}
              </p>
            )}

            {/* State-dependent actions */}
            <div className="mt-5 space-y-2">
              {relationship.state === "blocks_me" ? (
                <p className="rounded-xl border border-warning/30 bg-warning-soft px-3 py-2.5 text-xs leading-5 font-medium text-warning">
                  {t("community.blocksYouNote")}
                </p>
              ) : (
                actions.map(({ action, label, variant, danger, confirmFirst }) => (
                  <Button
                    key={action}
                    type="button"
                    variant={variant}
                    size="sm"
                    disabled={busy !== null}
                    className={`w-full ${danger && variant === "ghost" ? "text-danger hover:text-danger" : ""}`}
                    aria-label={`${label} — ${member.displayName}`}
                    onClick={() => {
                      if (confirmFirst) setConfirming(confirmFirst);
                      else void run(action);
                    }}
                  >
                    {label}
                  </Button>
                ))
              )}
              {/* Phase 5: report this member (never for one's own card —
                  the server would reject a self-report anyway). */}
              {member.userId !== me.userId && relationship.state !== "blocks_me" && (
                <button
                  type="button"
                  onClick={() => setReportOpen(true)}
                  className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-bold text-faint transition-colors hover:bg-danger-soft/50 hover:text-danger"
                >
                  <Icon name="flag" size={13} />
                  {t("community.report")}
                </button>
              )}
            </div>

            {/* Confirmation (block / remove friend are irreversible-ish) */}
            {confirming && (
              <div
                role="alertdialog"
                aria-label={
                  confirming === "block"
                    ? t("community.blockTitle", { name: member.displayName })
                    : t("community.removeFriendTitle")
                }
                className="mt-4 rounded-xl border border-line-strong bg-surface-2/60 p-3.5"
              >
                <p className="text-sm font-semibold text-ink">
                  {confirming === "block"
                    ? t("community.blockTitle", { name: member.displayName })
                    : t("community.removeFriendTitle")}
                </p>
                <p className="mt-1 text-xs leading-5 text-muted">
                  {confirming === "block"
                    ? t("community.blockText", { name: member.displayName })
                    : t("community.removeFriendText", { name: member.displayName })}
                </p>
                <div className="mt-3 flex gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant={confirming === "block" ? "dark" : "secondary"}
                    disabled={busy !== null}
                    onClick={() => void run(confirming === "block" ? "block" : "remove_friend")}
                  >
                    {confirming === "block" ? t("community.block") : t("community.removeFriend")}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={busy !== null}
                    onClick={() => setConfirming(null)}
                  >
                    {t("common.cancel")}
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* Phase 5: the ONE shared report dialog (profile target). */}
      <ReportDialog
        open={reportOpen}
        target={{ type: "profile", id: targetUserId }}
        onClose={() => setReportOpen(false)}
      />
    </div>
  );
}
