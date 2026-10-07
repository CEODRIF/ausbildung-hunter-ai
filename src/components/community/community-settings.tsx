"use client";

/**
 * Community Phase 3 — presence + notification settings (small, deliberate:
 * NOT a settings platform). One sheet, opened from the shell footer /
 * mobile strip:
 *
 *   Presence:      Online / Away / Do Not Disturb (manual choice)
 *                  "Show my online status" privacy toggle
 *   Notifications: friend requests / mentions / replies / reactions / DMs
 *                  sound on/off
 *
 * PERSISTENCE CONTRACT (production incident fix):
 *   - mode + "show online status" are rendered from the SHELL (the ack-aware
 *     presence hook) — the sheet never holds its own copy of them, so a
 *     rejected write visibly reverts;
 *   - notification toggles are optimistic per toggle and REVERT on a
 *     rejected server write (each write updates exactly its own column and
 *     is verified by a server read-back — a zero-row update is a failure);
 *   - opening the sheet reloads the CURRENT database state
 *     (refreshCommunitySettings, own RLS row) — no stale page props;
 *   - any failure shows a localized error (never a silent lie).
 *
 * All writes go through the rate-limited, field-whitelisted server actions
 * (own row only, RLS-backed — the session's auth.uid(), never client ids).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "@/components/icon";
import { useI18n } from "@/lib/i18n";
import {
  refreshCommunitySettings,
  updateNotificationPreferences,
  type CommunityPreferenceInput,
} from "@/app/community/actions";
import type { ViewerCommunitySettings } from "@/lib/community/social";
import type { PresenceMode } from "@/lib/community/presence";

/** The six notification toggles (everything except mode/showPresence,
 *  which the shell's ack-aware presence hook owns). */
export interface CommunitySettingsPrefs {
  friendRequests: boolean;
  mentions: boolean;
  replies: boolean;
  reactions: boolean;
  directMessages: boolean;
  sound: boolean;
}

export interface CommunitySettingsState extends CommunitySettingsPrefs {
  mode: PresenceMode;
  showPresence: boolean;
}

export interface CommunitySettingsProps {
  /**
   * The shell's current state. `mode`/`showPresence` come from the
   * ack-aware presence hook (server-confirmed values); the prefs are the
   * sheet's optimistic copy (seeded from the shell, refreshed on open).
   */
  initial: CommunitySettingsState;
  /** Presence mode change (the shell's hook — explicit write + broadcast). */
  onSetMode: (mode: PresenceMode) => void;
  /** "Show my online status" (the shell's hook — write + (re)publish). */
  onToggleShowPresence: () => void;
  /**
   * Called with the DATABASE-confirmed settings when the sheet opens
   * (refreshCommunitySettings). The shell applies it to its state (and
   * syncs the presence hook) so the whole community sees the truth.
   */
  onRefreshed?: (fresh: ViewerCommunitySettings) => void;
  /**
   * A localized error for a REJECTED presence/visibility write (the
   * shell's hook reports it; rendered as the sheet's error alert).
   */
  error?: string | null;
  onClose: () => void;
}

/** Phase 5: the reporter's OWN reports (the only user-facing report read
 *  path — GET /api/community/reports, RLS own-only, moderation fields
 *  stripped). */
interface MyReportRow {
  id: string;
  targetType: string;
  reason: string;
  status: "open" | "reviewing" | "resolved" | "dismissed";
  createdAt: string;
  resolvedAt: string | null;
}

const MODES: Array<{ value: PresenceMode; icon: "sun" | "clock" | "moon"; labelKey: string }> = [
  { value: "online", icon: "sun", labelKey: "community.presence.online" },
  { value: "away", icon: "clock", labelKey: "community.presence.away" },
  { value: "dnd", icon: "moon", labelKey: "community.presence.dnd" },
];

function prefsOf(initial: CommunitySettingsState): CommunitySettingsPrefs {
  return {
    friendRequests: initial.friendRequests,
    mentions: initial.mentions,
    replies: initial.replies,
    reactions: initial.reactions,
    directMessages: initial.directMessages,
    sound: initial.sound,
  };
}

export function CommunitySettings({
  initial,
  onSetMode,
  onToggleShowPresence,
  onRefreshed,
  error: shellError,
  onClose,
}: CommunitySettingsProps) {
  const { t, lang } = useI18n();
  const locale = lang === "de" ? "de-DE" : lang === "fr" ? "fr-FR" : lang === "ar" ? "ar" : "en-US";

  // Mode + "show online status" are NOT local state — they are the shell's
  // ack-aware values (a rejected write reverts them there, and this sheet
  // re-renders with the confirmed value). Local state = the six optimistic
  // notification toggles only.
  const [prefs, setPrefs] = useState<CommunitySettingsPrefs>(() => prefsOf(initial));
  const [saving, setSaving] = useState(false);
  const [prefError, setPrefError] = useState<string | null>(null);

  const error = shellError ?? prefError;

  // Auto-clear the error after a few seconds (the user keeps the values).
  useEffect(() => {
    if (!error) return;
    const timer = window.setTimeout(() => setPrefError(null), 6000);
    return () => window.clearTimeout(timer);
  }, [error]);

  // SETTINGS RELOAD (requirement I): on open, load the CURRENT database
  // state of the own row (RLS-scoped; never stale page props). The sheet
  // is mounted only while open, so mount == open. Ref-guarded callback so
  // the effect stays mount-only (no re-fetch loop on shell re-renders).
  const onRefreshedRef = useRef(onRefreshed);
  useEffect(() => {
    onRefreshedRef.current = onRefreshed;
  }, [onRefreshed]);
  useEffect(() => {
    let disposed = false;
    void refreshCommunitySettings().then((fresh) => {
      if (disposed || !fresh) return;
      setPrefs({
        friendRequests: fresh.friendRequests,
        mentions: fresh.mentions,
        replies: fresh.replies,
        reactions: fresh.reactions,
        directMessages: fresh.directMessages,
        sound: fresh.sound,
      });
      onRefreshedRef.current?.(fresh);
    });
    return () => {
      disposed = true;
    };
  }, []);

  // Phase 5: "My reports" — fetched ONCE when the sheet opens (the sheet is
  // mounted only while open; user-initiated, never polled).
  const [myReports, setMyReports] = useState<MyReportRow[] | null>(null);
  const [myReportsError, setMyReportsError] = useState(false);
  useEffect(() => {
    let disposed = false;
    void (async () => {
      try {
        const res = await fetch("/api/community/reports", { cache: "no-store" });
        if (!res.ok) throw new Error(String(res.status));
        const data = (await res.json()) as { reports: MyReportRow[] };
        if (!disposed) setMyReports(data.reports);
      } catch {
        if (!disposed) setMyReportsError(true);
      }
    })();
    return () => {
      disposed = true;
    };
  }, []);

  // Escape closes (keyboard accessible); focus the sheet on open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  /**
   * One notification toggle — optimistic, ONE column per call (the server
   * whitelists + verifies the write). On a rejected write the toggle
   * reverts to the last confirmed value and the error alert shows.
   */
  const setPref = useCallback((patch: Partial<CommunityPreferenceInput>) => {
    const prev = prefs;
    const next: CommunitySettingsPrefs = {
      ...prefs,
      ...(patch.friendRequests !== undefined && { friendRequests: patch.friendRequests }),
      ...(patch.mentions !== undefined && { mentions: patch.mentions }),
      ...(patch.replies !== undefined && { replies: patch.replies }),
      ...(patch.reactions !== undefined && { reactions: patch.reactions }),
      ...(patch.directMessages !== undefined && { directMessages: patch.directMessages }),
      ...(patch.sound !== undefined && { sound: patch.sound }),
    };
    setPrefs(next); // optimistic
    setSaving(true);
    setPrefError(null);
    void updateNotificationPreferences(patch).then((result) => {
      setSaving(false);
      if (!result.ok) {
        setPrefs(prev); // revert on failure (the DB value is the truth)
        setPrefError(t("community.settings.saveError"));
      }
    });
  }, [prefs, t]);

  const toggle = (key: keyof CommunityPreferenceInput & keyof CommunitySettingsPrefs) => {
    const current = prefs[key];
    if (typeof current === "boolean") {
      setPref({ [key]: !current } as Partial<CommunityPreferenceInput>);
    }
  };

  const prefRow = (
    key: keyof CommunityPreferenceInput & keyof CommunitySettingsPrefs,
    labelKey: string,
  ) => (
    <ToggleRow
      label={t(labelKey)}
      on={Boolean(prefs[key])}
      disabled={saving}
      onToggle={() => toggle(key)}
    />
  );

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
      <button
        type="button"
        aria-label={t("common.close")}
        onClick={onClose}
        className="absolute inset-0 bg-navy/45 dark:bg-black/60"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("community.settings.title")}
        className="relative flex max-h-[85vh] w-full max-w-md flex-col overflow-y-auto rounded-t-2xl border border-line bg-surface p-4 shadow-2xl sm:rounded-2xl"
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-bold text-ink">{t("community.settings.title")}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("common.close")}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-muted hover:bg-surface-2"
          >
            <Icon name="x" size={15} />
          </button>
        </div>

        {error && (
          <p
            role="alert"
            className="mb-3 rounded-xl border border-danger/30 bg-danger-soft px-3 py-2 text-xs font-medium text-danger"
          >
            {error}
          </p>
        )}

        {/* Presence — mode + visibility are the shell's ack-aware values. */}
        <p className="mb-1.5 text-xs font-bold uppercase tracking-wide text-faint">
          {t("community.settings.presenceSection")}
        </p>
        <div role="radiogroup" aria-label={t("community.settings.presenceSection")} className="grid grid-cols-3 gap-1.5">
          {MODES.map((m) => (
            <button
              key={m.value}
              type="button"
              role="radio"
              aria-checked={initial.mode === m.value}
              onClick={() => initial.mode !== m.value && onSetMode(m.value)}
              className={`flex flex-col items-center gap-1 rounded-xl border px-2 py-2.5 text-xs font-semibold transition-colors ${
                initial.mode === m.value
                  ? "border-accent bg-accent-soft/60 text-accent"
                  : "border-line bg-surface text-muted hover:bg-surface-2"
              }`}
            >
              <Icon name={m.icon} size={16} />
              {t(m.labelKey)}
            </button>
          ))}
        </div>
        <ToggleRow
          className="mt-1.5"
          label={t("community.settings.showPresence")}
          hint={t("community.settings.showPresenceHint")}
          on={initial.showPresence}
          onToggle={onToggleShowPresence}
        />

        {/* Notifications */}
        <p className="mb-1.5 mt-4 text-xs font-bold uppercase tracking-wide text-faint">
          {t("community.settings.notificationsSection")}
        </p>
        <div className="flex flex-col">
          {prefRow("friendRequests", "community.settings.notifyFriendRequests")}
          {prefRow("mentions", "community.settings.notifyMentions")}
          {prefRow("replies", "community.settings.notifyReplies")}
          {prefRow("reactions", "community.settings.notifyReactions")}
          {prefRow("directMessages", "community.settings.notifyDms")}
          {prefRow("sound", "community.settings.sound")}
        </div>

        {/* Phase 5: my reports (own-only — the API can return nothing else) */}
        <p className="mb-1.5 mt-4 text-xs font-bold uppercase tracking-wide text-faint">
          {t("community.myReports")}
        </p>
        {myReports === null && !myReportsError && (
          <p className="py-2 text-xs text-faint" aria-busy="true">
            {t("community.loading")}
          </p>
        )}
        {myReportsError && (
          <p role="alert" className="py-2 text-xs font-semibold text-danger">
            {t("community.reportError")}
          </p>
        )}
        {myReports !== null &&
          (myReports.length === 0 ? (
            <p className="py-2 text-xs text-muted">{t("community.reportSuccessHint")}</p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {myReports.slice(0, 5).map((r) => (
                <li
                  key={r.id}
                  className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl bg-surface-2/50 px-3 py-2 text-xs"
                >
                  <span className="font-bold text-muted">
                    {t(
                      r.targetType === "question"
                        ? "community.reportTargetQuestion"
                        : r.targetType === "answer"
                          ? "community.reportTargetAnswer"
                          : r.targetType === "profile"
                            ? "community.reportTargetProfile"
                            : "community.reportTargetMessage",
                    )}
                  </span>
                  <span className="text-faint">
                    {t(
                      r.reason === "spam"
                        ? "community.reportReasonSpam"
                        : r.reason === "harassment"
                          ? "community.reportReasonHarassment"
                          : r.reason === "hate"
                            ? "community.reportReasonHate"
                            : r.reason === "scam"
                              ? "community.reportReasonScam"
                              : r.reason === "misinformation"
                                ? "community.reportReasonMisinformation"
                                : r.reason === "sexual_content"
                                  ? "community.reportReasonSexual"
                                  : r.reason === "illegal_content"
                                    ? "community.reportReasonIllegal"
                                    : r.reason === "impersonation"
                                      ? "community.reportReasonImpersonation"
                                      : "community.reportReasonOther",
                    )}
                  </span>
                  <span
                    className={`ms-auto rounded-full px-1.5 py-px font-bold ${
                      r.status === "open"
                        ? "bg-accent-soft text-accent"
                        : r.status === "reviewing"
                          ? "bg-warning/10 text-warning"
                          : r.status === "resolved"
                            ? "bg-success/10 text-success"
                            : "bg-surface-2 text-faint"
                    }`}
                  >
                    {t(
                      r.status === "open"
                        ? "community.reportStatusOpen"
                        : r.status === "reviewing"
                          ? "community.reportStatusReviewing"
                          : r.status === "resolved"
                            ? "community.reportStatusResolved"
                            : "community.reportStatusDismissed",
                    )}
                  </span>
                  <span className="w-full text-[10px] text-faint">
                    {new Date(r.createdAt).toLocaleDateString(locale)}
                  </span>
                </li>
              ))}
            </ul>
          ))}
      </div>
    </div>
  );
}

function ToggleRow({
  label,
  hint,
  on,
  onToggle,
  disabled = false,
  className = "",
}: {
  label: string;
  hint?: string;
  on: boolean;
  onToggle: () => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      disabled={disabled}
      onClick={onToggle}
      className={`flex w-full items-center justify-between gap-3 rounded-xl px-2 py-2 text-start hover:bg-surface-2 disabled:opacity-60 ${className}`}
    >
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium text-ink">{label}</span>
        {hint && <span className="block truncate text-xs text-faint">{hint}</span>}
      </span>
      <span
        aria-hidden="true"
        className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${
          on ? "bg-accent" : "bg-line-strong"
        }`}
      >
        <span
          className="absolute top-0.5 h-4 w-4 rounded-full bg-surface shadow"
          style={{ insetInlineStart: on ? "1.125rem" : "0.125rem" }}
        />
      </span>
    </button>
  );
}
