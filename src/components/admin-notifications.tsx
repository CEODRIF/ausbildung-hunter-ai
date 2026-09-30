"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Card, Input, Modal, Textarea } from "@/components/ui";
import { useI18n } from "@/lib/i18n";
import { relativeTime } from "@/lib/relative-time";
import type {
  AdminNotificationRow,
  NotificationRecipient,
  NotificationType,
} from "@/lib/notifications/types";

/**
 * Admin → Platform Updates: send in-app notifications to ALL users or to
 * ONE specific user (search by email/name, ≤ 10 results, debounced).
 *
 * Security: this component is only RENDERED for the platform owner (the
 * server component checks before mounting it), and every API call is
 * re-verified server-side (session → admin membership → owner email). The
 * recipient identity is re-derived by the server from `target_user_id` —
 * the client never sends names/emails the server would trust.
 *
 * In-app only: nothing here sends email/SMS/push.
 */

type Mode = "all" | "user";
type Phase = "form" | "confirm" | "sending";
type Feedback = { kind: "ok" | "info" | "error"; text: string } | null;

const TYPE_KEYS: Record<NotificationType, string> = {
  info: "admin.notifTypeInfo",
  important: "admin.notifTypeImportant",
  maintenance: "admin.notifTypeMaintenance",
  improvement: "admin.notifTypeImprovement",
};

function freshIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function AdminNotifications() {
  const { t, lang } = useI18n();
  const locale =
    lang === "de" ? "de-DE" : lang === "fr" ? "fr-FR" : lang === "ar" ? "ar" : "en-US";

  // ---- form state -----------------------------------------------------
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>("all");
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchResults, setSearchResults] = useState<NotificationRecipient[]>([]);
  const [selected, setSelected] = useState<NotificationRecipient | null>(null);
  const [title, setTitle] = useState("");
  const [type, setType] = useState<NotificationType>("info");
  const [content, setContent] = useState("");
  const [phase, setPhase] = useState<Phase>("form");
  const [feedback, setFeedback] = useState<Feedback>(null);
  // One key per form open → double-clicks / slow-network retries cannot
  // create duplicate notifications (server enforces via unique send_key).
  const idempotencyKeyRef = useRef<string>(freshIdempotencyKey());

  // ---- history ----------------------------------------------------------
  const [history, setHistory] = useState<AdminNotificationRow[] | null>(null);
  const [historyError, setHistoryError] = useState(false);

  const loadHistory = useCallback(async () => {
    setHistoryError(false);
    try {
      const response = await fetch("/api/admin/notifications/history");
      if (!response.ok) throw new Error(String(response.status));
      const data = (await response.json()) as { items: AdminNotificationRow[] };
      setHistory(data.items);
    } catch {
      setHistoryError(true);
    }
  }, []);

  useEffect(() => {
    // Initial history load: fetch → setState after await (async, not a
    // synchronous cascading update).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadHistory();
  }, [loadHistory]);

  // ---- debounced recipient search (server-side, ≤ 10 results) ----------
  // All state updates happen in the input handler / async callbacks — never
  // synchronously in an effect (no cascading renders).
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const modeRef = useRef(mode);
  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  const runSearch = async (q: string) => {
    try {
      const response = await fetch("/api/admin/notifications/search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: q }),
      });
      if (!response.ok) throw new Error(String(response.status));
      const data = (await response.json()) as {
        results: NotificationRecipient[];
      };
      if (modeRef.current !== "user") return;
      setSearchResults(data.results);
    } catch {
      if (modeRef.current !== "user") return;
      setSearchResults([]);
    } finally {
      if (modeRef.current === "user") setSearching(false);
    }
  };

  const onQueryChange = (value: string) => {
    setQuery(value);
    setSelected(null);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    const trimmed = value.trim();
    if (trimmed.length < 2) {
      setSearchResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    searchTimer.current = setTimeout(() => void runSearch(trimmed), 300);
  };

  useEffect(() => {
    return () => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
    };
  }, []);

  const resetForm = (keepFeedback?: Feedback) => {
    setMode("all");
    setQuery("");
    setSearchResults([]);
    setSelected(null);
    setTitle("");
    setType("info");
    setContent("");
    setPhase("form");
    idempotencyKeyRef.current = freshIdempotencyKey();
    setFeedback(keepFeedback ?? null);
  };

  const targetMissing =
    mode === "user" && selected === null
      ? t("admin.selectUserFirst")
      : null;
  const titleInvalid = title.trim().length < 3 || title.trim().length > 120;
  const contentInvalid = content.trim().length < 3 || content.trim().length > 2000;
  const canProceed = !targetMissing && !titleInvalid && !contentInvalid;

  const doSend = async () => {
    setPhase("sending");
    try {
      const response = await fetch("/api/admin/notifications/send", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          target_type: mode,
          target_user_id: mode === "user" ? selected?.id ?? null : null,
          title: title.trim(),
          content: content.trim(),
          type,
          idempotency_key: idempotencyKeyRef.current,
        }),
      });
      const data = (await response.json()) as {
        duplicate?: boolean;
        error?: string;
      };
      if (!response.ok) throw new Error(data.error ?? String(response.status));
      resetForm(
        data.duplicate
          ? { kind: "info", text: t("admin.duplicateSent") }
          : { kind: "ok", text: t("admin.sent") },
      );
      setOpen(false);
      await loadHistory();
    } catch (error) {
      setPhase("form");
      setFeedback({
        kind: "error",
        text:
          error instanceof Error && error.message.length > 0
            ? error.message
            : t("admin.sendFailed"),
      });
    }
  };

  const confirmText =
    mode === "all"
      ? t("admin.confirmAll")
      : selected
        ? t("admin.confirmUser", { name: selected.full_name || selected.email })
        : "";

  return (
    <Card className="mt-6 overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-6 py-4">
        <div>
          <h2 className="text-base font-bold text-ink">
            {t("admin.platformUpdates")}
          </h2>
          <p className="mt-0.5 text-xs text-muted">
            {t("admin.platformUpdatesHint")}
          </p>
        </div>
        <Button
          variant="secondary"
          onClick={() => {
            setOpen((value) => !value);
            setFeedback(null);
          }}
        >
          {t("admin.newNotification")}
        </Button>
      </div>

      {open && (
        <div className="border-b border-line bg-surface-2/40 px-6 py-5">
          {/* Send to */}
          <fieldset>
            <legend className="text-xs font-bold uppercase tracking-[0.08em] text-faint">
              {t("admin.sendTo")}
            </legend>
            <div className="mt-2 flex gap-5">
              <label className="flex items-center gap-2 text-sm text-ink-soft">
                <input
                  type="radio"
                  name="notif-target"
                  checked={mode === "all"}
                  onChange={() => {
                    setMode("all");
                    setSelected(null);
                    setQuery("");
                  }}
                  className="h-4 w-4 accent-accent"
                />
                {t("admin.allUsers")}
              </label>
              <label className="flex items-center gap-2 text-sm text-ink-soft">
                <input
                  type="radio"
                  name="notif-target"
                  checked={mode === "user"}
                  onChange={() => setMode("user")}
                  className="h-4 w-4 accent-accent"
                />
                {t("admin.specificUser")}
              </label>
            </div>
          </fieldset>

          {/* Recipient search (only for targeted sends) */}
          {mode === "user" && (
            <div className="mt-4">
              <Input
                value={query}
                onChange={(event) => onQueryChange(event.target.value)}
                placeholder={t("admin.searchUser")}
                aria-label={t("admin.searchUser")}
              />
              {selected ? (
                <div className="mt-2 flex items-center gap-2 text-sm text-ink-soft">
                  <span className="font-semibold">{t("admin.selectedUser")}</span>
                  <span>
                    {selected.full_name || "—"}{" "}
                    <span className="text-muted">({selected.email})</span>
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      setSelected(null);
                      setQuery("");
                    }}
                    className="text-xs font-semibold text-accent underline"
                  >
                    {t("admin.changeUser")}
                  </button>
                </div>
              ) : searching ? (
                <p className="mt-2 text-xs text-muted">{t("admin.searchingUsers")}</p>
              ) : query.trim().length >= 2 && searchResults.length > 0 ? (
                <ul className="mt-2 divide-y divide-line rounded-xl border border-line bg-surface text-sm">
                  {searchResults.map((row) => (
                    <li key={row.id}>
                      <button
                        type="button"
                        onClick={() => setSelected(row)}
                        className="flex w-full items-baseline gap-2 px-4 py-2.5 text-start transition-colors hover:bg-surface-2"
                      >
                        <span className="font-semibold text-ink-soft">
                          {row.full_name || "—"}
                        </span>
                        <span className="text-xs text-muted">{row.email}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : query.trim().length >= 2 ? (
                <p className="mt-2 text-xs text-muted">{t("admin.noUserMatches")}</p>
              ) : null}
            </div>
          )}

          {/* Content */}
          <div className="mt-4 grid gap-4 sm:grid-cols-[1fr_180px]">
            <Input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder={t("admin.titleLabel")}
              aria-label={t("admin.titleLabel")}
              maxLength={120}
            />
            <select
              value={type}
              onChange={(event) => setType(event.target.value as NotificationType)}
              aria-label={t("admin.typeLabel")}
              className="rounded-xl border border-line-strong bg-surface px-3 py-2 text-sm text-ink"
            >
              {(Object.keys(TYPE_KEYS) as NotificationType[]).map((value) => (
                <option key={value} value={value}>
                  {t(TYPE_KEYS[value])}
                </option>
              ))}
            </select>
          </div>
          <div className="mt-4">
            <Textarea
              value={content}
              onChange={(event) => setContent(event.target.value)}
              placeholder={t("admin.messageLabel")}
              aria-label={t("admin.messageLabel")}
              rows={4}
              maxLength={2000}
            />
          </div>

          {targetMissing && (
            <p className="mt-3 text-xs font-semibold text-danger">{targetMissing}</p>
          )}
          {feedback && (
            <p
              className={`mt-3 rounded-xl px-3 py-2 text-sm font-semibold ${
                feedback.kind === "ok"
                  ? "bg-success-soft text-success"
                  : feedback.kind === "info"
                    ? "bg-surface-2 text-ink-soft"
                    : "bg-danger-soft text-danger"
              }`}
            >
              {feedback.text}
            </p>
          )}

          {phase !== "confirm" && (
            <div className="mt-4 flex items-center gap-3">
              <Button
                variant="primary"
                disabled={!canProceed || phase === "sending"}
                onClick={() => setPhase("confirm")}
              >
                {t("admin.sendNotification")}
              </Button>
              <Button variant="ghost" onClick={() => resetForm()}>
                {t("admin.cancel")}
              </Button>
              {feedback?.kind === "error" && (
                <span className="text-xs font-semibold text-danger">
                  {feedback.text}
                </span>
              )}
            </div>
          )}
        </div>
      )}

      {/* History */}
      <div className="px-6 py-4">
        <h3 className="text-xs font-bold uppercase tracking-[0.08em] text-faint">
          {t("admin.historyTitle")}
        </h3>
        {historyError ? (
          <p className="mt-3 text-sm text-muted">{t("admin.historyError")}</p>
        ) : history === null ? (
          <p className="mt-3 text-sm text-muted">{t("admin.loading")}</p>
        ) : history.length === 0 ? (
          <p className="mt-3 text-sm text-muted">{t("admin.historyEmpty")}</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[560px] text-start text-sm">
              <thead>
                <tr className="border-b border-line text-[11px] uppercase tracking-[0.08em] text-faint">
                  <th className="px-3 py-2 text-start">{t("admin.date")}</th>
                  <th className="px-3 py-2 text-start">{t("admin.recipient")}</th>
                  <th className="px-3 py-2 text-start">{t("admin.typeLabel")}</th>
                  <th className="px-3 py-2 text-start">{t("admin.titleLabel")}</th>
                  <th className="px-3 py-2 text-start">{t("admin.status")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {history.map((row) => (
                  <tr key={row.id}>
                    <td className="whitespace-nowrap px-3 py-2.5 text-xs text-muted">
                      {relativeTime(row.created_at, t, locale)}
                    </td>
                    <td className="px-3 py-2.5">
                      {row.target_type === "all" ? (
                        <span className="text-xs font-semibold text-ink-soft">
                          {t("admin.allUsers")}
                        </span>
                      ) : (
                        <span className="text-xs text-ink-soft">
                          {row.recipient?.full_name || "—"}{" "}
                          <span className="text-muted">
                            ({row.recipient?.email ?? "—"})
                          </span>
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-xs text-muted">
                      {t(TYPE_KEYS[row.type])}
                    </td>
                    <td className="max-w-[220px] truncate px-3 py-2.5 text-xs font-semibold text-ink-soft">
                      {row.title}
                    </td>
                    <td className="px-3 py-2.5">
                      <span className="rounded-md bg-success-soft px-1.5 py-0.5 text-[10px] font-bold text-success">
                        {t("admin.sentBadge")}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Confirmation */}
      <Modal open={phase === "confirm" || phase === "sending"} onClose={() => phase !== "sending" && setPhase("form")} title={t("admin.confirmTitle")}>
        <p className="text-sm leading-6 text-ink-soft">{confirmText}</p>
        <div className="mt-5 flex items-center gap-3">
          <Button
            variant="primary"
            disabled={phase === "sending"}
            onClick={() => void doSend()}
          >
            {phase === "sending" ? t("admin.sending") : t("admin.send")}
          </Button>
          <Button
            variant="ghost"
            disabled={phase === "sending"}
            onClick={() => setPhase("form")}
          >
            {t("admin.cancel")}
          </Button>
        </div>
      </Modal>
    </Card>
  );
}
