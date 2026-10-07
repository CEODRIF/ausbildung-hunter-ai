"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useI18n } from "@/lib/i18n";
import { Icon, type IconName } from "@/components/icon";
import { Button } from "@/components/ui";
import {
  assignReportAction,
  performModerationActionAction,
  setMemberRoleAction,
  setReportStatusAction,
  updateRoomSettingsAction,
} from "@/app/community/advanced-actions";

/**
 * Community Phase 5 — the moderation console UI.
 *
 * This component is a VIEW over server decisions: the page has already
 * refused non-moderators, the tabs were resolved server-side, and every
 * button calls a "use server" action that re-checks the role + rate limit
 * in the database. The rank table below drives WHICH affordances are shown
 * (UX); it is NOT the authorization — the server re-enforces it on every
 * call, so a forged or stale client cannot escalate.
 */

type ModTab = "reports" | "members" | "rooms" | "audit";
type ModStatus = "open" | "reviewing" | "resolved" | "dismissed";

export interface ModQueueItem {
  id: string;
  reporterName: string | null;
  targetType: "message" | "question" | "answer" | "profile";
  targetId: string;
  targetPreview: string;
  roomSlug: string | null;
  reason: string;
  details: string | null;
  status: ModStatus;
  assignedTo: string | null;
  assignedName: string | null;
  targetAuthorId: string | null;
  targetAuthorName: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

export interface ModMember {
  userId: string;
  displayName: string;
  role: string;
  joinedAt: string;
  suspended: boolean;
  mutedUntil: string | null;
}

export interface ModRoom {
  id: string;
  slug: string;
  name: string;
  categoryId: string;
  description: string | null;
  position: number;
  enabled: boolean;
  qnaEnabled: boolean;
}

export interface ModAuditRow {
  id: string;
  action: string;
  targetType: string;
  targetId: string;
  reason: string | null;
  moderatorName: string | null;
  createdAt: string;
}

export interface ModerationViewProps {
  me: { userId: string; displayName: string };
  viewerRole: string;
  tab: ModTab;
  queueStatus: ModStatus;
  queueCounts: { open: number; reviewing: number; resolved: number; dismissed: number } | null;
  queue: ModQueueItem[];
  queueUnavailable: boolean;
  queueHasMore: boolean;
  /** Assignable reviewers (moderators+; server-provided). */
  members: ModMember[];
  membersUnavailable: boolean;
  rooms: ModRoom[] | null;
  roomCategories: Array<{ id: string; slug: string; name: string }>;
  roomsUnavailable: boolean;
  audit: ModAuditRow[];
}

/** Display-only rank order (the server is the authority on every action). */
const RANK: Record<string, number> = { member: 1, helper: 2, moderator: 3, admin: 4, owner: 5 };
const ALL_ROLES = ["member", "helper", "moderator", "admin", "owner"] as const;

const REASON_KEY: Record<string, string> = {
  spam: "community.reportReasonSpam",
  harassment: "community.reportReasonHarassment",
  hate: "community.reportReasonHate",
  scam: "community.reportReasonScam",
  misinformation: "community.reportReasonMisinformation",
  sexual_content: "community.reportReasonSexual",
  illegal_content: "community.reportReasonIllegal",
  impersonation: "community.reportReasonImpersonation",
  other: "community.reportReasonOther",
};

const TARGET_KEY: Record<string, string> = {
  message: "community.reportTargetMessage",
  question: "community.reportTargetQuestion",
  answer: "community.reportTargetAnswer",
  profile: "community.reportTargetProfile",
};

const QUEUE_TARGET_HREF: Record<string, (item: ModQueueItem) => string | null> = {
  message: (i) => (i.roomSlug ? `/community/${i.roomSlug}?message=${i.targetId}` : null),
  question: (i) => `/community/questions/${i.targetId}`,
  answer: (i) => (i.roomSlug ? `/community/${i.roomSlug}/questions` : null),
  profile: () => null,
};

export function ModerationView(props: ModerationViewProps) {
  const { t, lang } = useI18n();
  const locale = lang === "de" ? "de-DE" : lang === "fr" ? "fr-FR" : lang === "ar" ? "ar" : "en-US";
  const {
    me,
    viewerRole,
    tab,
    queueStatus,
    queueCounts,
    queue,
    queueUnavailable,
    queueHasMore,
    members,
    membersUnavailable,
    rooms,
    roomCategories,
    roomsUnavailable,
    audit,
  } = props;

  const viewerRank = RANK[viewerRole] ?? 1;
  const isAdmin = viewerRank >= RANK.admin;

  const tabs: Array<{ id: ModTab; label: string; icon: IconName; visible: boolean }> = [
    { id: "reports", label: t("community.modTabQueue"), icon: "flag", visible: true },
    { id: "members", label: t("community.modTabMembers"), icon: "users", visible: isAdmin },
    { id: "rooms", label: t("community.modTabRooms"), icon: "hash", visible: true },
    { id: "audit", label: t("community.modTabAudit"), icon: "activity", visible: true },
  ];

  const tabHref = (id: ModTab) =>
    id === "reports" ? "/community/moderation" : `/community/moderation?tab=${id}`;

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-5 p-4 sm:p-6">
      <header>
        <h1 className="text-lg font-bold text-ink sm:text-xl">{t("community.moderationTitle")}</h1>
        <p className="mt-0.5 text-sm text-muted">{t("community.moderationSubtitle")}</p>
      </header>

      <nav aria-label={t("community.moderationTitle")} className="flex flex-wrap gap-1.5">
        {tabs
          .filter((x) => x.visible)
          .map((x) => (
            <Link
              key={x.id}
              href={tabHref(x.id)}
              aria-current={tab === x.id ? "page" : undefined}
              className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-bold transition-colors ${
                tab === x.id
                  ? "bg-accent-soft text-accent"
                  : "bg-surface text-muted hover:bg-surface-2 hover:text-ink"
              }`}
            >
              <Icon name={x.icon} size={13} />
              {x.label}
            </Link>
          ))}
      </nav>

      {tab === "reports" && (
        <ReportsTab
          me={me}
          viewerRank={viewerRank}
          status={queueStatus}
          counts={queueCounts}
          items={queue}
          unavailable={queueUnavailable}
          hasMore={queueHasMore}
          assignable={members.filter((m) => (RANK[m.role] ?? 1) >= RANK.moderator)}
          locale={locale}
        />
      )}
      {tab === "members" && (
        <MembersTab
          meUserId={me.userId}
          viewerRole={viewerRole}
          members={members}
          unavailable={membersUnavailable}
          locale={locale}
        />
      )}
      {tab === "rooms" && (
        <RoomsTab
          rooms={rooms}
          categories={roomCategories}
          unavailable={roomsUnavailable}
        />
      )}
      {tab === "audit" && <AuditTab rows={audit} locale={locale} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Reports queue
// ---------------------------------------------------------------------------

function ReportsTab({
  me,
  viewerRank,
  status,
  counts,
  items,
  unavailable,
  hasMore,
  assignable,
  locale,
}: {
  me: { userId: string; displayName: string };
  viewerRank: number;
  status: ModStatus;
  counts: { open: number; reviewing: number; resolved: number; dismissed: number } | null;
  items: ModQueueItem[];
  unavailable: boolean;
  hasMore: boolean;
  assignable: ModMember[];
  locale: string;
}) {
  const { t } = useI18n();
  const router = useRouter();
  const [assignee, setAssignee] = useState<Record<string, string>>({});

  const statuses: Array<{ id: ModStatus; label: string }> = [
    { id: "open", label: t("community.modQueueOpen") },
    { id: "reviewing", label: t("community.modQueueReviewing") },
    { id: "resolved", label: t("community.modQueueResolved") },
    { id: "dismissed", label: t("community.modQueueDismissed") },
  ];

  const run = async (fn: () => Promise<{ ok: boolean; code?: string }>) => {
    const res = await fn();
    if (res.ok) router.refresh();
  };

  if (unavailable) {
    return (
      <p className="rounded-2xl border border-line bg-surface p-6 text-center text-sm font-semibold text-muted">
        {t("community.modQueueLoadError")}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-1.5">
        {statuses.map((s) => (
          <Link
            key={s.id}
            href={
              s.id === "open"
                ? "/community/moderation"
                : `/community/moderation?status=${s.id}`
            }
            aria-current={status === s.id ? "page" : undefined}
            className={`rounded-full px-3 py-1.5 text-xs font-bold transition-colors ${
              status === s.id
                ? "bg-accent-soft text-accent"
                : "bg-surface text-muted hover:bg-surface-2 hover:text-ink"
            }`}
          >
            {s.label}
            {counts ? ` · ${counts[s.id]}` : ""}
          </Link>
        ))}
      </div>

      {items.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-line bg-surface/60 p-8 text-center text-sm text-muted">
          {t("community.modQueueEmpty")}
        </p>
      ) : (
        items.map((item) => {
          const targetHref = QUEUE_TARGET_HREF[item.targetType]?.(item) ?? null;
          const author = item.targetAuthorId;
          const isAdminLevel = viewerRank >= RANK.admin;
          return (
            <article
              key={item.id}
              className="flex flex-col gap-3 rounded-2xl border border-line bg-surface p-4"
            >
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="rounded-full bg-danger/10 px-2 py-0.5 font-bold text-danger">
                  {t(REASON_KEY[item.reason] ?? "community.reportReasonOther")}
                </span>
                <span className="rounded-full bg-surface-2 px-2 py-0.5 font-semibold text-muted">
                  {t(TARGET_KEY[item.targetType] ?? "community.reportTargetMessage")}
                </span>
                {item.roomSlug && (
                  <span className="font-semibold text-accent">#{item.roomSlug}</span>
                )}
                <span className="text-faint">
                  {t("community.modFiledAt")}{" "}
                  {new Date(item.createdAt).toLocaleString(locale)}
                </span>
              </div>

              <p className="whitespace-pre-line rounded-xl bg-surface-2/60 px-3 py-2 text-sm text-ink-soft">
                {item.targetPreview || "—"}
              </p>
              {item.details && (
                <p className="whitespace-pre-line text-xs text-muted">{item.details}</p>
              )}

              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-faint">
                <span>
                  {t("community.modReporter")}:{" "}
                  <span className="font-semibold text-muted">{item.reporterName ?? "—"}</span>
                </span>
                {author && (
                  <span>
                    {t("community.modTarget")}:{" "}
                    <span className="font-semibold text-muted">
                      {item.targetAuthorName ?? "—"}
                    </span>
                  </span>
                )}
                {item.assignedTo ? (
                  <span>
                    {t("community.modAssigned")}: {item.assignedName ?? "—"}
                  </span>
                ) : (
                  <span>{t("community.modUnassigned")}</span>
                )}
                {item.resolvedAt && (
                  <span>
                    {t("community.modResolvedAt")}{" "}
                    {new Date(item.resolvedAt).toLocaleString(locale)}
                  </span>
                )}
              </div>

              {/* Actions — every one re-authenticated server-side */}
              <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
                {status === "open" && (
                  <Button variant="secondary" size="sm" onClick={() => void run(() => setReportStatusAction(item.id, "reviewing"))}>
                    {t("community.modMarkReviewing")}
                  </Button>
                )}
                {(status === "open" || status === "reviewing") && (
                  <>
                    <Button size="sm" onClick={() => void run(() => setReportStatusAction(item.id, "resolved"))}>
                      {t("community.modResolve")}
                    </Button>
                    <Button variant="secondary" size="sm" onClick={() => void run(() => setReportStatusAction(item.id, "dismissed"))}>
                      {t("community.modDismiss")}
                    </Button>
                  </>
                )}
                {assignable.length > 0 && (
                  <span className="flex items-center gap-1.5">
                    <select
                      aria-label={t("community.modAssign")}
                      value={assignee[item.id] ?? ""}
                      onChange={(e) => setAssignee((prev) => ({ ...prev, [item.id]: e.target.value }))}
                      className="rounded-xl border border-line bg-surface px-2 py-1.5 text-xs font-semibold text-ink focus:border-accent focus:outline-none"
                    >
                      <option value="">{t("community.modAssign")}…</option>
                      {assignable.map((m) => (
                        <option key={m.userId} value={m.userId}>
                          {m.displayName}
                        </option>
                      ))}
                    </select>
                    {assignee[item.id] && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() =>
                          void run(() => assignReportAction(item.id, assignee[item.id])).then(() =>
                            setAssignee((prev) => {
                              const next = { ...prev };
                              delete next[item.id];
                              return next;
                            }),
                          )
                        }
                      >
                        <Icon name="check" size={13} />
                      </Button>
                    )}
                  </span>
                )}
                {targetHref && (
                  <Link
                    href={targetHref}
                    className="ml-auto text-xs font-bold text-accent hover:underline"
                  >
                    {t("community.toast.view")}
                  </Link>
                )}
              </div>

              {/* Content + user actions */}
              <div className="flex flex-wrap items-center gap-2">
                {item.targetType === "message" && (
                  <>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        if (window.confirm(t("community.modConfirmDeleteMessage")))
                          void run(() => performModerationActionAction({ action: "delete_message", targetType: "message", targetId: item.targetId }));
                      }}
                    >
                      {t("community.modActionDeleteMessage")}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        if (window.confirm(t("community.modConfirmHideMessage")))
                          void run(() => performModerationActionAction({ action: "hide_message", targetType: "message", targetId: item.targetId }));
                      }}
                    >
                      {t("community.modActionHideMessage")}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        void run(() => performModerationActionAction({ action: "unpin", targetType: "message", targetId: item.targetId }))
                      }
                    >
                      {t("community.modActionUnpin")}
                    </Button>
                  </>
                )}
                {item.targetType === "question" && (
                  <>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        void run(() => performModerationActionAction({ action: "close_question", targetType: "question", targetId: item.targetId }))
                      }
                    >
                      {t("community.modActionCloseQuestion")}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        void run(() => performModerationActionAction({ action: "reopen_question", targetType: "question", targetId: item.targetId }))
                      }
                    >
                      {t("community.modActionReopenQuestion")}
                    </Button>
                  </>
                )}
                {item.targetType === "answer" && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      if (window.confirm(t("community.modConfirmRemoveAnswer")))
                        void run(() => performModerationActionAction({ action: "remove_answer", targetType: "answer", targetId: item.targetId }));
                    }}
                  >
                    {t("community.modActionRemoveAnswer")}
                  </Button>
                )}
                {author && author !== me.userId && (
                  <>
                    <span className="mx-1 h-5 w-px bg-line" aria-hidden="true" />
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        void run(() => performModerationActionAction({ action: "warn_user", targetType: "profile", targetId: author! }))
                      }
                    >
                      {t("community.modActionWarn")}
                    </Button>
                    <span className="flex items-center gap-1">
                      {(["1h", "24h", "7d"] as const).map((d) => (
                        <Button
                          key={d}
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            if (window.confirm(t("community.modConfirmTimeout")))
                              void run(() => performModerationActionAction({ action: "timeout_user", targetType: "profile", targetId: author!, timeoutKey: d }));
                          }}
                        >
                          {t(`community.modTimeout${d}`)}
                        </Button>
                      ))}
                    </span>
                    {isAdminLevel && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          if (window.confirm(t("community.modConfirmSuspend")))
                            void run(() => performModerationActionAction({ action: "suspend_user", targetType: "profile", targetId: author! }));
                        }}
                      >
                        {t("community.modActionSuspend")}
                      </Button>
                    )}
                    {isAdminLevel && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() =>
                          void run(() => performModerationActionAction({ action: "reinstate_user", targetType: "profile", targetId: author! }))
                        }
                      >
                        {t("community.modActionReinstate")}
                      </Button>
                    )}
                  </>
                )}
              </div>
            </article>
          );
        })
      )}

      {hasMore && (
        <div className="flex justify-center">
          <Link
            href={
              (status === "open" ? "/community/moderation" : `/community/moderation?status=${status}`) +
              (status === "open" ? "?" : "&") +
              `before=${encodeURIComponent(items[items.length - 1]?.createdAt ?? "")}&beforeId=${encodeURIComponent(items[items.length - 1]?.id ?? "")}`
            }
            className="inline-flex h-11 items-center gap-2 rounded-2xl border border-line bg-surface px-4 text-sm font-semibold text-ink transition-colors hover:bg-surface-2"
          >
            {t("community.modQueueLoadMore")}
          </Link>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Members + roles (admin+ tab)
// ---------------------------------------------------------------------------

function MembersTab({
  meUserId,
  viewerRole,
  members,
  unavailable,
  locale,
}: {
  meUserId: string;
  viewerRole: string;
  members: ModMember[];
  unavailable: boolean;
  locale: string;
}) {
  const { t } = useI18n();
  const router = useRouter();
  const viewerRank = RANK[viewerRole] ?? 4;
  const grantable = ALL_ROLES.filter((r) => RANK[r] < viewerRank);

  const roleKey: Record<string, string> = {
    member: "community.modMember",
    helper: "community.modHelper",
    moderator: "community.modModerator",
    admin: "community.modAdmin",
    owner: "community.modOwner",
  };

  if (unavailable) {
    return (
      <p className="rounded-2xl border border-line bg-surface p-6 text-center text-sm font-semibold text-muted">
        {t("community.modQueueLoadError")}
      </p>
    );
  }

  return (
    <section aria-labelledby="mod-members-title">
      <h2 id="mod-members-title" className="text-sm font-bold text-ink">
        {t("community.modMembersTitle")}
      </h2>
      <p className="mt-0.5 text-xs text-muted">{t("community.modMembersSubtitle")}</p>
      <ul className="mt-3 divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface">
        {members.map((m) => (
          <li key={m.userId} className="flex flex-wrap items-center gap-3 px-4 py-3">
            <span className="min-w-0 flex-1">
              <span className="flex flex-wrap items-center gap-2 text-sm">
                <span className="font-bold text-ink">{m.displayName}</span>
                {m.suspended && (
                  <span className="rounded-full bg-danger/10 px-1.5 py-px text-[10px] font-bold text-danger">
                    {t("community.modSuspendedBadge")}
                  </span>
                )}
                {m.mutedUntil && new Date(m.mutedUntil) > new Date() && (
                  <span className="rounded-full bg-warning/10 px-1.5 py-px text-[10px] font-bold text-warning">
                    {t("community.modMutedBadge")}
                  </span>
                )}
                <span className="text-[10px] text-faint">
                  {new Date(m.joinedAt).toLocaleDateString(locale)}
                </span>
              </span>
              <span className="text-[11px] text-faint">{roleKey[m.role] ?? m.role}</span>
            </span>
            {m.userId !== meUserId && (
              <select
                aria-label={`${t("community.modRole")} — ${m.displayName}`}
                defaultValue={m.role}
                onChange={(e) => {
                  void (async () => {
                    const res = await setMemberRoleAction(m.userId, e.target.value);
                    if (res.ok) router.refresh();
                  })();
                }}
                className="rounded-xl border border-line bg-surface px-2.5 py-1.5 text-xs font-semibold text-ink focus:border-accent focus:outline-none"
              >
                <option value={m.role} disabled>
                  {roleKey[m.role] ?? m.role}
                </option>
                {grantable.map((r) => (
                  <option key={r} value={r}>
                    {roleKey[r]}
                  </option>
                ))}
              </select>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Rooms
// ---------------------------------------------------------------------------

function RoomsTab({
  rooms,
  categories,
  unavailable,
}: {
  rooms: ModRoom[] | null;
  categories: Array<{ id: string; slug: string; name: string }>;
  unavailable: boolean;
}) {
  const { t } = useI18n();
  const router = useRouter();
  const [savedId, setSavedId] = useState<string | null>(null);
  const [errorId, setErrorId] = useState<string | null>(null);

  if (unavailable || !rooms) {
    return (
      <p className="rounded-2xl border border-line bg-surface p-6 text-center text-sm font-semibold text-muted">
        {t("community.modQueueLoadError")}
      </p>
    );
  }

  return (
    <section aria-labelledby="mod-rooms-title">
      <h2 id="mod-rooms-title" className="text-sm font-bold text-ink">
        {t("community.modRoomsTitle")}
      </h2>
      <p className="mt-0.5 text-xs text-muted">{t("community.modRoomsSubtitle")}</p>
      <ul className="mt-3 flex flex-col gap-3">
        {rooms.map((room) => (
          <RoomSettingsRow
            key={room.id}
            room={room}
            categories={categories}
            saved={savedId === room.id}
            error={errorId === room.id}
            onSaved={() => {
              setSavedId(room.id);
              setErrorId(null);
              window.setTimeout(() => setSavedId((cur) => (cur === room.id ? null : cur)), 3000);
            }}
            onFailed={() => {
              setErrorId(room.id);
              setSavedId(null);
              router.refresh();
            }}
          />
        ))}
      </ul>
    </section>
  );
}

function RoomSettingsRow({
  room,
  categories,
  saved,
  error,
  onSaved,
  onFailed,
}: {
  room: ModRoom;
  categories: Array<{ id: string; slug: string; name: string }>;
  saved: boolean;
  error: boolean;
  onSaved: () => void;
  onFailed: () => void;
}) {
  const { t } = useI18n();
  const [description, setDescription] = useState(room.description ?? "");
  const [categoryId, setCategoryId] = useState(room.categoryId);
  const [qna, setQna] = useState(room.qnaEnabled);
  const [enabled, setEnabled] = useState(room.enabled);
  const [position, setPosition] = useState(room.position);
  const [busy, setBusy] = useState(false);
  // Snapshot of what the server has — the dirty check compares against
  // THIS, so the `room` prop is never mutated. When the server revalidates
  // and hands us a fresh prop, the snapshot follows it (render-time
  // state adjustment, the React-documented pattern).
  const [savedSnapshot, setSavedSnapshot] = useState<ModRoom>(room);
  const [prevRoom, setPrevRoom] = useState(room);
  if (prevRoom !== room) {
    setPrevRoom(room);
    setSavedSnapshot(room);
  }

  const dirty =
    description !== (savedSnapshot.description ?? "") ||
    categoryId !== savedSnapshot.categoryId ||
    qna !== savedSnapshot.qnaEnabled ||
    enabled !== savedSnapshot.enabled ||
    position !== savedSnapshot.position;

  const save = async () => {
    if (busy) return;
    setBusy(true);
    const res = await updateRoomSettingsAction({
      roomId: room.id,
      description: description.trim() || null,
      categoryId,
      qnaEnabled: qna,
      enabled,
      position,
    });
    setBusy(false);
    if (res.ok) {
      onSaved();
      setSavedSnapshot({
        ...savedSnapshot,
        description: description.trim() || null,
        categoryId,
        qnaEnabled: qna,
        enabled,
        position,
      });
    } else {
      onFailed();
    }
  };

  return (
    <li className="rounded-2xl border border-line bg-surface p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-bold text-ink">
          <span aria-hidden="true" className="text-faint"># </span>
          {room.name}
        </span>
        <div className="flex items-center gap-3 text-xs font-semibold">
          <label className="flex cursor-pointer items-center gap-1.5 text-muted">
            <input
              type="checkbox"
              checked={qna}
              onChange={(e) => setQna(e.target.checked)}
              className="accent-accent"
            />
            {t("community.modRoomQna")}
          </label>
          <label className="flex cursor-pointer items-center gap-1.5 text-muted">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              className="accent-accent"
            />
            {t("community.modRoomEnabled")}
          </label>
        </div>
      </div>
      <p className="mt-1 text-[11px] text-faint">{t("community.modRoomQnaHint")}</p>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1 block text-xs font-semibold text-muted">
            {t("community.modRoomDescription")}
          </span>
          <input
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={280}
            className="h-10 w-full rounded-xl border border-line bg-surface px-3 text-sm text-ink focus:border-accent focus:outline-none"
          />
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="mb-1 block text-xs font-semibold text-muted">
              {t("community.modRoomCategory")}
            </span>
            <select
              value={categoryId}
              onChange={(e) => setCategoryId(e.target.value)}
              className="h-10 w-full rounded-xl border border-line bg-surface px-2 text-sm text-ink focus:border-accent focus:outline-none"
            >
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-semibold text-muted">
              {t("community.modRoomPosition")}
            </span>
            <input
              type="number"
              min={0}
              max={999}
              value={position}
              onChange={(e) => setPosition(Math.max(0, Math.min(999, Number(e.target.value) || 0)))}
              className="h-10 w-full rounded-xl border border-line bg-surface px-3 text-sm text-ink focus:border-accent focus:outline-none"
            />
          </label>
        </div>
      </div>
      <div className="mt-3 flex items-center gap-2">
        <Button size="sm" disabled={!dirty || busy} onClick={() => void save()}>
          {t("community.modRoomSave")}
        </Button>
        {saved && (
          <span role="status" className="text-xs font-bold text-success">
            {t("community.modRoomSaved")}
          </span>
        )}
        {error && (
          <span role="alert" className="text-xs font-bold text-danger">
            {t("community.modRoomSaveError")}
          </span>
        )}
      </div>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

function AuditTab({ rows, locale }: { rows: ModAuditRow[]; locale: string }) {
  const { t } = useI18n();
  if (rows.length === 0) {
    return (
      <p className="rounded-2xl border border-dashed border-line bg-surface/60 p-8 text-center text-sm text-muted">
        {t("community.modAuditEmpty")}
      </p>
    );
  }
  return (
    <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface">
      {rows.map((row) => (
        <li key={row.id} className="px-4 py-3 text-sm">
          <span className="flex flex-wrap items-baseline gap-x-2">
            <span className="font-bold text-ink">{row.action}</span>
            <span className="text-xs text-faint">
              {t(TARGET_KEY[String(row.targetType)] ?? "community.reportTargetMessage")} ·{" "}
              {row.targetId.slice(0, 8)}…
            </span>
            {row.moderatorName && (
              <span className="text-xs text-muted">· {row.moderatorName}</span>
            )}
          </span>
          <span className="mt-0.5 flex flex-wrap items-center gap-x-3 text-[11px] text-faint">
            {row.reason && <span>{row.reason}</span>}
            <span>{new Date(row.createdAt).toLocaleString(locale)}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}
