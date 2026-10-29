"use client";

/**
 * AI Bewerbung Studio — batch sending (up to 10 emails).
 *
 * Every item is validated and dispatched INDEPENDENTLY through the existing
 * per-application engine (`sendApplicationAction` → `prepareStudioSend`):
 * per-app explicit approval, owned + active email account, owned
 * attachments of THAT application, atomic send-slot claim (no duplicate
 * sends), idempotency, deadline checks, quota/rate limits. The batch
 * approval checkbox is an ADDITIONAL gate on top — it never replaces the
 * per-application approval.
 *
 * Partial success is reported per item; only failed items can be retried.
 * The email content sent is EXACTLY the stored, user-reviewed email of
 * that application (recipient / subject / body / selected attachments).
 */

import { useMemo, useState } from "react";
import { cancelSendAction, sendApplicationAction } from "@/app/bewerbung-studio/actions";
import { Icon } from "@/components/icon";
import { Button, Input } from "@/components/ui";
import { useI18n } from "@/lib/i18n";
import { zonedTimeToUtc } from "@/lib/studio/timezone";
import type { StudioBatchView, StudioBatchAppView } from "@/lib/studio";
import type { StudioCompletionKey } from "@/lib/studio/completion";
import { useTimeZones } from "./panels-review";
import { BusyButton, Note } from "./studio-ui";

type ItemStatus =
  | "sent"
  | "scheduled"
  | "failed"
  | "in_progress"
  | "not_selectable"
  | "selectable";

interface Eligibility {
  status: ItemStatus;
  /** Human label for why the item is (not) selectable / its send state. */
  label: string;
}

interface RunResult {
  appId: string;
  company: string;
  ok: boolean;
  scheduledAt: string | null;
  message: string;
}

const REQ_KEYS: Record<StudioCompletionKey, string> = {
  ad: "studio.reqAd",
  profile: "studio.reqProfile",
  cv: "studio.reqCv",
  letter: "studio.reqLetter",
  docs: "studio.reqDocs",
  email: "studio.reqEmail",
  quality: "studio.reqQuality",
};

function companyOf(v: StudioBatchAppView): string {
  return v.app.ad_extracted?.company?.trim() || "—";
}

export function BatchSendPanel({
  batch,
  emailAccounts,
  onClose,
  onBatchDone,
}: {
  batch: StudioBatchView;
  emailAccounts: Array<{
    id: string;
    provider: "gmail" | "outlook";
    email: string;
    is_active: boolean;
    requires_reconnect: boolean;
  }>;
  onClose: () => void;
  onBatchDone: () => Promise<void> | void;
}) {
  const { t, lang } = useI18n();
  const timeZones = useTimeZones();

  const activeAccounts = emailAccounts.filter((a) => a.is_active && !a.requires_reconnect);

  // ---------------------------------------------------------------------
  // Per-item eligibility (independent validation, server state only)
  // ---------------------------------------------------------------------

  const eligibility = useMemo<Record<string, Eligibility>>(() => {
    const out: Record<string, Eligibility> = {};
    for (const v of batch.apps) {
      const { app, completion, slot } = v;
      if (app.status === "sent") {
        out[app.id] = { status: "in_progress", label: t("studio.statusSent") };
      } else if (app.status === "sending") {
        out[app.id] = { status: "in_progress", label: t("studio.statusSending") };
      } else if (app.status === "scheduled") {
        out[app.id] = { status: "in_progress", label: t("studio.statusScheduled") };
      } else if (!slot.unlocked) {
        out[app.id] = {
          status: "not_selectable",
          label: t("studio.navLockedHint", {
            missing: completion.missing.slice(0, 3).map((k) => t(REQ_KEYS[k])).join(" · "),
          }),
        };
      } else if (!completion.complete) {
        out[app.id] = {
          status: "not_selectable",
          label: t("studio.batchSendItemNotReady", {
            missing: completion.missing.slice(0, 3).map((k) => t(REQ_KEYS[k])).join(" · "),
          }),
        };
      } else if (!app.approved) {
        out[app.id] = { status: "not_selectable", label: t("studio.batchSendItemNotApproved") };
      } else if (!app.recipient_email || !v.emailSubject || !v.emailBody) {
        out[app.id] = {
          status: "not_selectable",
          label: t("studio.batchSendItemNotReady", { missing: t("studio.reqEmail") }),
        };
      } else {
        out[app.id] = { status: "selectable", label: t("studio.batchSendItemReady") };
      }
    }
    return out;
  }, [batch.apps, t]);

  const selectableIds = batch.apps
    .filter((v) => eligibility[v.app.id]?.status === "selectable")
    .map((v) => v.app.id);

  const [selected, setSelected] = useState<Set<string>>(() => new Set(selectableIds));
  const [accountId, setAccountId] = useState<string>(activeAccounts[0]?.id ?? "");
  const [mode, setMode] = useState<"now" | "schedule">("now");
  const [approved, setApproved] = useState(false);
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<RunResult[] | null>(null);

  // schedule fields
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [tz, setTz] = useState(timeZones[0] ?? "Europe/Berlin");

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const allSelected = selectableIds.length > 0 && selectableIds.every((id) => selected.has(id));
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(selectableIds));

  const scheduleValid =
    mode === "now" ||
    (date !== "" && time !== "" && zonedTimeToUtc(dateToY(date), dateToM(date), dateToD(date), timeToH(time), timeToMin(time), tz) !== null);

  const canRun =
    running === false && approved && selected.size > 0 && activeAccounts.length > 0 && accountId !== "" && scheduleValid;

  // ---------------------------------------------------------------------
  // Batch run — sequential, per-item independent, partial-success aware
  // ---------------------------------------------------------------------

  const runBatch = async (ids: string[]) => {
    if (ids.length === 0 || running) return;
    setRunning(true);
    setResults(null);
    const out: RunResult[] = [];
    for (const id of ids) {
      const v = batch.apps.find((a) => a.app.id === id);
      if (!v) continue;
      const company = companyOf(v);
      if (!v.app.recipient_email || !v.emailSubject || !v.emailBody) {
        out.push({ appId: id, company, ok: false, scheduledAt: null, message: t("studio.batchSendItemNotReady", { missing: t("studio.reqEmail") }) });
        continue;
      }
      let schedule: { timeZone: string; year: number; month: number; day: number; hour: number; minute: number } | null = null;
      if (mode === "schedule") {
        const y = dateToY(date), m = dateToM(date), d = dateToD(date), h = timeToH(time), mi = timeToMin(time);
        const utcMs = zonedTimeToUtc(y, m, d, h, mi, tz);
        if (utcMs === null) {
          out.push({ appId: id, company, ok: false, scheduledAt: null, message: t("studio.invalidSchedule") });
          continue;
        }
        schedule = { timeZone: tz, year: y, month: m, day: d, hour: h, minute: mi };
      }
      const res = await sendApplicationAction({
        applicationId: id,
        recipientEmail: v.app.recipient_email,
        emailAccountId: accountId,
        subject: v.emailSubject,
        body: v.emailBody,
        attachmentIds: v.emailAttachmentIds,
        schedule,
        confirmed: true, // batch approval checkbox (user-checked) + per-app approval (server-checked)
      });
      if (res.ok) {
        out.push({
          appId: id,
          company,
          ok: true,
          scheduledAt: res.value.scheduledAt,
          message: res.value.scheduledAt ? t("studio.scheduledFor", { when: formatWhen(res.value.scheduledAt, tz, lang), tz }) : t("studio.sent", { date: new Date().toLocaleDateString(lang === "ar" ? "ar" : lang) }),
        });
      } else {
        out.push({ appId: id, company, ok: false, scheduledAt: null, message: res.message });
      }
    }
    setResults(out);
    setRunning(false);
    setApproved(false);
    await onBatchDone();
  };

  const failedResults = (results ?? []).filter((r) => !r.ok);

  const cancelScheduledItem = async (v: StudioBatchAppView) => {
    const attempt = v.latestAttempt;
    if (!attempt) return;
    const res = await cancelSendAction(attempt.id);
    if (res.ok) {
      await onBatchDone();
    } else {
      // ignore — re-render will show the state
    }
  };

  // ---------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------

  return (
    <div className="rounded-2xl border border-border bg-surface p-5 shadow-sm sm:p-6">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-base font-semibold">{t("studio.batchSendTitle")}</h2>
          <p className="mt-1 text-sm leading-6 text-muted">{t("studio.batchSendSubtitle")}</p>
        </div>
        <Button size="sm" variant="ghost" onClick={onClose}>
          <Icon name="x" size={14} />
          {t("studio.batchClose")}
        </Button>
      </div>

      {activeAccounts.length === 0 ? (
        <Note kind="danger">
          {t("studio.batchSendNoAccount")}{" "}
          <a href="/settings" className="font-medium underline">
            {t("studio.emailAccountLink")}
          </a>
        </Note>
      ) : (
        <>
          {/* item list */}
          <div className="mb-4 overflow-hidden rounded-xl border border-border">
            <div className="flex items-center gap-3 border-b border-border bg-surface-2 px-4 py-2.5">
              <input
                type="checkbox"
                id="batch-select-all"
                checked={allSelected}
                disabled={selectableIds.length === 0}
                onChange={toggleAll}
                className="h-4 w-4 accent-[var(--color-primary)]"
                aria-label={t("studio.batchSendSelectAll")}
              />
              <label htmlFor="batch-select-all" className="text-xs font-medium text-muted">
                {t("studio.batchSendSelectAll")}
              </label>
              <span className="ml-auto text-xs text-muted">
                {selected.size}/{selectableIds.length}
              </span>
            </div>
            <ul className="divide-y divide-border">
              {batch.apps.map((v) => {
                const elig = eligibility[v.app.id];
                const selectable = elig?.status === "selectable";
                const isScheduled = v.app.status === "scheduled";
                return (
                  <li key={v.app.id} className="flex items-start gap-3 px-4 py-3">
                    <input
                      type="checkbox"
                      checked={selected.has(v.app.id)}
                      disabled={!selectable || running}
                      onChange={() => toggle(v.app.id)}
                      className="mt-1 h-4 w-4 accent-[var(--color-primary)]"
                      aria-label={`${t("studio.batchSendSelectAll")}: ${companyOf(v)}`}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <span className="text-sm font-semibold">{companyOf(v)}</span>
                        <span className="truncate text-xs text-muted">{v.app.recipient_email ?? "—"}</span>
                      </p>
                      <p className="mt-0.5 truncate text-xs text-muted">
                        {v.emailSubject || "—"}
                        {v.docVersions.cv ? ` · CV v${v.docVersions.cv}` : ""}
                        {v.docVersions.letter ? ` · Anschreiben v${v.docVersions.letter}` : ""}
                        {` · ${v.attachmentCount} Anhänge`}
                      </p>
                      <p
                        className={`mt-1 text-xs ${
                          selectable
                            ? "text-success"
                            : isScheduled || elig?.status === "in_progress"
                              ? "text-muted"
                              : "text-warning"
                        }`}
                      >
                        {elig?.label}
                      </p>
                    </div>
                    {isScheduled && v.latestAttempt ? (
                      <Button size="sm" variant="ghost" className="shrink-0 text-danger" onClick={() => cancelScheduledItem(v)}>
                        {t("studio.scheduleCancel")}
                      </Button>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </div>

          {/* sender account */}
          <div className="mb-4">
            <label htmlFor="batch-account" className="mb-1 block text-sm font-medium">
              {t("studio.emailAccount")}
            </label>
            <select
              id="batch-account"
              value={accountId}
              onChange={(e) => setAccountId(e.target.value)}
              disabled={running}
              className="w-full max-w-sm rounded-xl border border-border bg-surface px-3 py-2 text-sm"
            >
              {activeAccounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.email} ({a.provider})
                </option>
              ))}
            </select>
          </div>

          {/* mode: now / schedule */}
          <div className="mb-4 flex flex-wrap gap-2">
            <ModeChip active={mode === "now"} onClick={() => setMode("now")}>
              {t("studio.sendNow")}
            </ModeChip>
            <ModeChip active={mode === "schedule"} onClick={() => setMode("schedule")}>
              {t("studio.scheduleSend")}
            </ModeChip>
          </div>

          {mode === "schedule" ? (
            <div className="mb-4 grid gap-3 sm:grid-cols-3">
              <div>
                <label htmlFor="batch-date" className="mb-1 block text-xs font-medium">
                  {t("studio.whenLabel")}
                </label>
                <Input id="batch-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} disabled={running} />
              </div>
              <div>
                <label htmlFor="batch-time" className="mb-1 block text-xs font-medium">
                  {t("studio.whenLabel")}
                </label>
                <Input id="batch-time" type="time" value={time} onChange={(e) => setTime(e.target.value)} disabled={running} />
              </div>
              <div>
                <label htmlFor="batch-tz" className="mb-1 block text-xs font-medium">
                  {t("studio.tzLabel")}
                </label>
                <select
                  id="batch-tz"
                  value={tz}
                  onChange={(e) => setTz(e.target.value)}
                  disabled={running}
                  className="w-full rounded-xl border border-border bg-surface px-3 py-2 text-sm"
                >
                  {timeZones.map((z) => (
                    <option key={z} value={z}>
                      {z}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          ) : null}

          {/* final review + batch approval (never bypasses per-app approval) */}
          <div className="mb-4 rounded-xl border border-border bg-surface-2 p-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-faint">
              {t("studio.batchSendReview")}
            </p>
            <p className="mt-1 text-xs leading-5 text-muted">{t("studio.batchSendReviewHint")}</p>
          </div>

          <label className="mb-4 flex items-start gap-3 rounded-xl border border-border p-3">
            <input
              type="checkbox"
              checked={approved}
              onChange={(e) => setApproved(e.target.checked)}
              disabled={running || selected.size === 0}
              className="mt-0.5 h-4 w-4 accent-[var(--color-primary)]"
            />
            <span className="text-sm leading-6">{t("studio.batchSendApprove")}</span>
          </label>

          {selected.size === 0 ? (
            <p className="mb-3 text-sm text-warning">{t("studio.batchSendNoneSelected")}</p>
          ) : null}

          <div className="flex flex-wrap items-center gap-3">
            <BusyButton busy={running} disabled={!canRun} onClick={() => runBatch([...selected])}>
              <Icon name="send" size={14} />
              {mode === "now" ? t("studio.batchSendSend") : t("studio.batchSendSchedule")}
            </BusyButton>
            {!scheduleValid && mode === "schedule" ? (
              <span className="text-xs text-danger">{t("studio.invalidSchedule")}</span>
            ) : null}
          </div>

          {/* partial-success report */}
          {results ? (
            <div className="mt-5 border-t border-border pt-4">
              <p className="mb-2 text-sm font-semibold">
                {t("studio.batchSendResult", {
                  sent: results.length - failedResults.length,
                  failed: failedResults.length,
                })}
              </p>
              <ul className="space-y-1.5">
                {results.map((r) => (
                  <li key={r.appId} className="flex items-start gap-2 text-sm">
                    <span className={`mt-0.5 shrink-0 ${r.ok ? "text-success" : "text-danger"}`}>
                      <Icon name={r.ok ? "check" : "alert"} size={14} strokeWidth={2.5} />
                    </span>
                    <span className="min-w-0">
                      <span className="font-medium">{r.company}</span>{" "}
                      <span className="text-muted">— {r.message}</span>
                    </span>
                  </li>
                ))}
              </ul>
              {failedResults.length > 0 ? (
                <Button
                  size="sm"
                  variant="secondary"
                  className="mt-3"
                  disabled={running}
                  onClick={() => runBatch(failedResults.map((r) => r.appId))}
                >
                  {t("studio.batchSendRetryFailed")}
                </Button>
              ) : null}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

function ModeChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        "rounded-full border px-4 py-2 text-sm font-medium transition-colors",
        active ? "border-primary bg-primary text-primary-foreground" : "border-border bg-surface text-muted hover:text-foreground",
      ].join(" ")}
    >
      {children}
    </button>
  );
}

function formatWhen(iso: string, tz: string, lang: string): string {
  try {
    return new Intl.DateTimeFormat(lang === "ar" ? "ar" : lang, {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: tz,
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

// date/time string → numbers (client input values)
function dateToY(s: string): number {
  return Number(s.slice(0, 4));
}
function dateToM(s: string): number {
  return Number(s.slice(5, 7));
}
function dateToD(s: string): number {
  return Number(s.slice(8, 10));
}
function timeToH(s: string): number {
  return Number(s.slice(0, 2));
}
function timeToMin(s: string): number {
  return Number(s.slice(3, 5));
}
