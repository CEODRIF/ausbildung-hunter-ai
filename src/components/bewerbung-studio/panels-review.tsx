"use client";

/**
 * AI Bewerbung Studio — Section G (quality review), Section H
 * (company-specific application email) and Section I (final review,
 * explicit approval, send/schedule).
 *
 * I is the ONLY place an email can be dispatched, and it is double-gated:
 * the server requires `app.approved === true` (set by the explicit
 * "genehmigen" action) AND the client requires a per-send confirmation
 * checkbox naming the exact recipient. Scheduled sends are durable
 * (studio_send_attempts) and cancellable until dispatch.
 */

import { useCallback, useMemo, useState } from "react";
import { Icon } from "@/components/icon";
import { Input } from "@/components/ui";
import { useI18n } from "@/lib/i18n";
import { parseAdDeadline } from "@/lib/studio/quality";
import {
  isValidEmail,
  STUDIO_LETTER_PDF_ID,
  type AdExtract,
  type QualityIssue,
  type StudioApplicationRow,
  type StudioAttachmentRow,
  type StudioEmailContent,
  type StudioLetterContent,
  type StudioSendAttemptRow,
} from "@/lib/studio/schema";
import { zonedTimeToUtc } from "@/lib/studio/timezone";
import { cvHasContent, type CvDocument } from "@/lib/templates/cv";
import { BusyButton, Note, SectionCard } from "./studio-ui";
import type { ApiOutcome } from "./studio-client";

// ===========================================================================
// Section G — quality review
// ===========================================================================

export function QualityPanel({
  onRun,
}: {
  onRun: (withAi: boolean) => Promise<ApiOutcome<{ issues: QualityIssue[]; aiChecked: boolean }>>;
}) {
  const { t } = useI18n();
  const [running, setRunning] = useState(false);
  const [withAi, setWithAi] = useState(false);
  const [issues, setIssues] = useState<QualityIssue[] | null>(null);
  const [aiChecked, setAiChecked] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(
    async (useAi: boolean) => {
      setRunning(true);
      setError(null);
      const out = await onRun(useAi);
      setRunning(false);
      if (!out.ok) {
        setError(out.error);
        return;
      }
      setIssues(out.value.issues);
      setAiChecked(out.value.aiChecked);
    },
    [onRun],
  );

  const blocking = issues?.filter((i) => i.severity === "blocking") ?? [];
  const optional = issues?.filter((i) => i.severity === "optional") ?? [];

  return (
    <SectionCard
      title={t("studio.qualityTitle")}
      subtitle={t("studio.qualitySubtitle")}
      actions={
        <>
          <label className="flex items-center gap-1.5 text-xs text-muted">
            <input type="checkbox" checked={withAi} onChange={(e) => setWithAi(e.target.checked)} />
            {t("studio.qualityRunWithAi")}
          </label>
          <BusyButton size="sm" busy={running} onClick={() => run(withAi)}>
            {running ? t("studio.qualityRunning") : t("studio.qualityRun")}
          </BusyButton>
        </>
      }
    >
      {error ? (
        <div className="mb-3">
          <Note kind="danger">{error}</Note>
        </div>
      ) : null}
      {issues === null ? (
        <p className="text-sm text-muted">{t("studio.qualitySubtitle")}</p>
      ) : (
        <div className="space-y-4">
          {blocking.length === 0 && optional.length === 0 ? (
            <Note kind="info">{t("studio.qualityClean")}</Note>
          ) : null}
          {blocking.length > 0 ? (
            <div>
              <h3 className="mb-2 text-sm font-semibold text-danger">{t("studio.qualityBlocking")}</h3>
              <ul className="space-y-1.5">
                {blocking.map((i, idx) => (
                  <li key={`${i.key}-${idx}`} className="flex gap-2 rounded-lg bg-danger/10 px-3 py-2 text-sm">
                    <Icon name="alert" size={14} className="mt-0.5 shrink-0 text-danger" />
                    <span>{i.detail}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {optional.length > 0 ? (
            <div>
              <h3 className="mb-2 text-sm font-semibold">{t("studio.qualityOptional")}</h3>
              <ul className="list-disc space-y-1 pl-5 text-sm text-muted">
                {optional.map((i, idx) => (
                  <li key={`${i.key}-${idx}`}>{i.detail}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {!aiChecked && withAi && (
            <Note kind="info">
              {t("studio.qualityRunWithAi")} — {t("studio.qualityOptional")}
            </Note>
          )}
        </div>
      )}
    </SectionCard>
  );
}

// ===========================================================================
// Section H — application email
// ===========================================================================

export function EmailPanel({
  applicationId,
  extract,
  letter,
  atts,
  userFacts,
  emailDraft,
  onEmailDraftChange,
  recipient,
  onRecipientChange,
  onSaveEmail,
}: {
  applicationId: string;
  extract: AdExtract | null;
  letter: StudioLetterContent | null;
  atts: StudioAttachmentRow[];
  userFacts: { fullName: string; email: string };
  emailDraft: StudioEmailContent | null;
  onEmailDraftChange: (d: StudioEmailContent | null) => void;
  recipient: string;
  onRecipientChange: (v: string) => void;
  onSaveEmail: (d: StudioEmailContent) => Promise<boolean>;
}) {
  const { t } = useI18n();
  const [generating, setGenerating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const draft = useMemo(
    () => emailDraft ?? { subject: "", body: "", attachmentIds: [] },
    [emailDraft],
  );

  const generate = useCallback(async () => {
    setGenerating(true);
    setError(null);
    try {
      const res = await fetch("/api/bewerbung-studio/generate-email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          applicationId,
          letterExcerpt: letter ? letter.text.slice(0, 400) : undefined,
          attachmentNames: atts.map((a) => a.display_name).slice(0, 10),
        }),
      });
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        setError(
          res.status === 429
            ? t("studio.quotaError")
            : typeof data.error === "string"
              ? data.error
              : t("studio.error"),
        );
        return;
      }
      onEmailDraftChange({
        subject: typeof data.subject === "string" ? data.subject : "",
        body: typeof data.body === "string" ? data.body : "",
        attachmentIds: atts.map((a) => a.id),
      });
      if (!recipient.trim()) {
        const fromAd = extract?.applicationEmail ?? "";
        onRecipientChange(fromAd || userFacts.email);
      }
    } catch {
      setError(t("studio.error"));
    } finally {
      setGenerating(false);
    }
  }, [applicationId, letter, atts, recipient, extract, userFacts.email, onEmailDraftChange, onRecipientChange, t]);

  const save = useCallback(async () => {
    if (!draft.subject.trim() || !draft.body.trim()) return;
    setSaving(true);
    await onSaveEmail(draft);
    setSaving(false);
  }, [draft, onSaveEmail]);

  const toggleAttachment = (id: string) =>
    onEmailDraftChange({
      ...draft,
      attachmentIds: draft.attachmentIds.includes(id)
        ? draft.attachmentIds.filter((x) => x !== id)
        : [...draft.attachmentIds, id],
    });

  return (
    <SectionCard
      title={t("studio.emailTitle")}
      subtitle={t("studio.emailSubtitle")}
      actions={
        <>
          {emailDraft ? (
            <BusyButton size="sm" variant="secondary" busy={saving} onClick={save}>
              {t("studio.saveAnalysis")}
            </BusyButton>
          ) : null}
          <BusyButton
            size="sm"
            busy={generating}
            onClick={generate}
            disabled={!extract}
            title={!extract ? t("studio.noAnalysis") : undefined}
          >
            {generating ? t("studio.emailGenerating") : t("studio.emailGenerate")}
          </BusyButton>
        </>
      }
    >
      {error ? (
        <div className="mb-3">
          <Note kind="danger">{error}</Note>
        </div>
      ) : null}
      {!extract ? <p className="text-sm text-muted">{t("studio.noAnalysis")}</p> : !emailDraft ? (
        <p className="text-sm text-muted">{t("studio.noEmail")}</p>
      ) : (
        <div className="grid gap-4">
          <div>
            <label htmlFor="st-email-recipient" className="mb-1 block text-sm font-medium">
              {t("studio.emailRecipient")}
            </label>
            <Input
              id="st-email-recipient"
              type="email"
              value={recipient}
              onChange={(e) => onRecipientChange(e.target.value)}
              placeholder={extract.applicationEmail || "name@unternehmen.de"}
              error={recipient.trim() && !isValidEmail(recipient) ? "Ungültige E-Mail-Adresse" : undefined}
            />
          </div>
          <div>
            <label htmlFor="st-email-subject" className="mb-1 block text-sm font-medium">
              {t("studio.emailSubject")}
            </label>
            <Input
              id="st-email-subject"
              value={draft.subject}
              onChange={(e) => onEmailDraftChange({ ...draft, subject: e.target.value })}
            />
          </div>
          <div>
            <label htmlFor="st-email-body" className="mb-1 block text-sm font-medium">
              {t("studio.emailBody")}
            </label>
            <textarea
              id="st-email-body"
              rows={10}
              value={draft.body}
              onChange={(e) => onEmailDraftChange({ ...draft, body: e.target.value })}
              className="w-full rounded-xl border border-border bg-surface px-3 py-2 text-sm leading-6 focus:outline-none focus:ring-2 focus:ring-primary/40"
            />
          </div>
          {(atts.length > 0 || letter?.text.trim()) ? (
            <div>
              <p className="mb-1 text-sm font-medium">{t("studio.emailAttachments")}</p>
              <p className="mb-2 text-xs text-muted">{t("studio.emailAttachmentsHint")}</p>
              <ul className="space-y-1.5">
                {letter?.text.trim() ? (
                  <li>
                    <label className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={draft.attachmentIds.includes(STUDIO_LETTER_PDF_ID)}
                        onChange={() => toggleAttachment(STUDIO_LETTER_PDF_ID)}
                      />
                      <span>
                        Anschreiben (PDF)
                        <span className="ml-1 text-xs text-muted">— aus dem gespeicherten Anschreiben gerendert</span>
                      </span>
                    </label>
                  </li>
                ) : null}
                {atts.map((a) => (
                  <li key={a.id}>
                    <label className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={draft.attachmentIds.includes(a.id)}
                        onChange={() => toggleAttachment(a.id)}
                      />
                      {a.display_name}
                    </label>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      )}
    </SectionCard>
  );
}

// ===========================================================================
// Section I — final review, approval, send / schedule
// ===========================================================================

const COMMON_TZS = ["Europe/Berlin", "Europe/Zurich", "Europe/Paris", "Europe/Vienna", "America/New_York"];

function useTimeZones(): string[] {
  return useMemo(() => {
    try {
      const all = (Intl as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone") ?? [];
      const set = new Set<string>([...COMMON_TZS, ...all]);
      const sorted = [...set].sort((a, b) => a.localeCompare(b));
      return COMMON_TZS.filter((tz) => set.has(tz)).concat(sorted.filter((tz) => !COMMON_TZS.includes(tz)));
    } catch {
      return COMMON_TZS;
    }
  }, []);
}

export function SendPanel({
  app,
  extract,
  cv,
  letter,
  emailDraft,
  atts,
  recipient,
  onRecipientChange,
  emailAccounts,
  latestAttempt,
  onApprove,
  onSend,
  onCancelScheduled,
  onRefresh,
}: {
  app: StudioApplicationRow;
  extract: AdExtract | null;
  cv: CvDocument | null;
  letter: StudioLetterContent | null;
  emailDraft: StudioEmailContent | null;
  atts: StudioAttachmentRow[];
  recipient: string;
  onRecipientChange: (v: string) => void;
  emailAccounts: Array<{ id: string; provider: "gmail" | "outlook"; email: string; is_active: boolean; requires_reconnect: boolean }>;
  latestAttempt: StudioSendAttemptRow | null;
  onApprove: () => Promise<boolean>;
  onSend: (input: {
    recipientEmail: string;
    emailAccountId: string;
    subject: string;
    body: string;
    attachmentIds: string[];
    schedule: { timeZone: string; year: number; month: number; day: number; hour: number; minute: number } | null;
  }) => Promise<ApiOutcome<{ attemptId: string; scheduledAt: string | null; dispatchStatus?: string; failureCode?: string | null }>>;
  onCancelScheduled: (attemptId: string) => Promise<boolean>;
  onRefresh: () => Promise<boolean>;
}) {
  const { t, lang } = useI18n();
  const timeZones = useTimeZones();

  const [approving, setApproving] = useState(false);
  const [accountId, setAccountId] = useState<string>(
    emailAccounts.find((a) => a.is_active && !a.requires_reconnect)?.id ?? emailAccounts[0]?.id ?? "",
  );
  const [mode, setMode] = useState<"now" | "schedule">("now");
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [tz, setTz] = useState(timeZones[0] ?? "Europe/Berlin");
  const [confirmed, setConfirmed] = useState(false);
  const [sending, setSending] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [sendResult, setSendResult] = useState<
    | { kind: "sent" }
    | { kind: "scheduled" }
    | { kind: "failed"; code: string | null }
    | null
  >(null);

  const activeAccount = emailAccounts.find((a) => a.id === accountId) ?? null;
  const hasCv = cv ? cvHasContent(cv) : false;
  const hasLetter = Boolean(letter?.text?.trim());
  const hasEmail = Boolean(emailDraft?.subject?.trim() && emailDraft?.body?.trim());
  const recipientOk = isValidEmail(recipient);
  const accountOk = Boolean(activeAccount?.is_active && !activeAccount?.requires_reconnect);

  const checks: Array<{ ok: boolean; label: string }> = [
    { ok: hasCv, label: `${t("studio.stepCv")} — ${t("studio.noCv")}` },
    { ok: hasLetter, label: `${t("studio.stepLetter")} — ${t("studio.noLetter")}` },
    { ok: hasEmail, label: `${t("studio.stepEmail")} — ${t("studio.noEmail")}` },
    { ok: recipientOk, label: `${t("studio.emailRecipient")} — ${t("studio.invalidRecipient")}` },
    { ok: accountOk, label: t("studio.emailAccount") },
  ];
  const ready = checks.every((c) => c.ok);

  const deadline = useMemo(() => parseAdDeadline(extract?.applicationDeadline ?? null), [extract?.applicationDeadline]);

  // Client-side mirror of the server schedule validation (instant feedback).
  // Computed in EVENT HANDLERS (revalidateSchedule) and held in state —
  // Date.now() must never run during render or in a memo.
  const [scheduleCheck, setScheduleCheck] = useState<
    { ok: true; utcMs: number } | { ok: false; msg: string } | null
  >(null);

  const revalidateSchedule = useCallback(
    (next: { mode: string; date: string; time: string; tz: string }) => {
      if (next.mode !== "schedule") {
        setScheduleCheck(null);
        return;
      }
      const d = new Date(`${next.date}T${next.time}`);
      if (Number.isNaN(d.getTime())) {
        setScheduleCheck({ ok: false, msg: t("studio.invalidSchedule") });
        return;
      }
      const utcMs = zonedTimeToUtc(d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes(), next.tz);
      if (utcMs === null) {
        setScheduleCheck({ ok: false, msg: t("studio.invalidSchedule") });
        return;
      }
      if (utcMs <= Date.now() + 60_000) {
        setScheduleCheck({ ok: false, msg: t("studio.scheduleFuture") });
        return;
      }
      if (deadline !== null && utcMs > deadline) {
        setScheduleCheck({ ok: false, msg: t("studio.deadlineWarning") });
        return;
      }
      setScheduleCheck({ ok: true, utcMs });
    },
    [deadline, t],
  );

  const pickMode = (m: "now" | "schedule") => {
    setMode(m);
    revalidateSchedule({ mode: m, date, time, tz });
  };

  const fmtDate = (iso: string) => {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    try {
      return new Intl.DateTimeFormat(lang === "ar" ? "ar" : lang, { dateStyle: "medium", timeStyle: "short", timeZone: app.schedule_timezone ?? undefined }).format(d);
    } catch {
      return d.toLocaleString();
    }
  };

  const doApprove = useCallback(async () => {
    setApproving(true);
    await onApprove();
    setApproving(false);
  }, [onApprove]);

  const doSend = useCallback(async () => {
    if (!confirmed || !recipientOk || !accountOk || !emailDraft) return;
    let schedule: { timeZone: string; year: number; month: number; day: number; hour: number; minute: number } | null = null;
    if (mode === "schedule" && scheduleCheck && "utcMs" in scheduleCheck && scheduleCheck.ok) {
      const d = new Date(`${date}T${time}`);
      schedule = { timeZone: tz, year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate(), hour: d.getHours(), minute: d.getMinutes() };
    }
    setSending(true);
    setSendResult(null);
    const out = await onSend({
      recipientEmail: recipient,
      emailAccountId: accountId,
      subject: emailDraft.subject,
      body: emailDraft.body,
      attachmentIds: emailDraft.attachmentIds,
      schedule,
    });
    setSending(false);
    if (!out.ok) {
      setSendResult({ kind: "failed", code: out.code });
      return;
    }
    setSendResult(out.value.scheduledAt ? { kind: "scheduled" } : out.value.dispatchStatus === "failed" ? { kind: "failed", code: out.value.failureCode ?? null } : { kind: "sent" });
    setConfirmed(false);
  }, [confirmed, recipientOk, accountOk, emailDraft, mode, scheduleCheck, date, time, tz, onSend, recipient, accountId]);

  const doCancel = useCallback(async () => {
    if (!latestAttempt) return;
    setCancelling(true);
    const ok = window.confirm(t("studio.cancelConfirm"));
    if (!ok) {
      setCancelling(false);
      return;
    }
    await onCancelScheduled(latestAttempt.id);
    setCancelling(false);
    setSendResult(null);
  }, [latestAttempt, onCancelScheduled, t]);

  const doRefresh = useCallback(async () => {
    setRefreshing(true);
    await onRefresh();
    setRefreshing(false);
  }, [onRefresh]);

  const attached = atts.filter((a) => emailDraft?.attachmentIds.includes(a.id));
  const attachedNames = [
    ...(emailDraft?.attachmentIds.includes(STUDIO_LETTER_PDF_ID) ? ["Anschreiben (PDF)"] : []),
    ...attached.map((a) => a.display_name),
  ];

  return (
    <SectionCard title={t("studio.reviewTitle")} subtitle={t("studio.reviewSubtitle")}>
      <div className="grid gap-4 lg:grid-cols-2">
        {/* ---- summary column ------------------------------------------- */}
        <div className="space-y-3 text-sm">
          <ReviewRow label={t("studio.fCompany")} value={extract?.company || "—"} />
          <ReviewRow label={t("studio.fJobTitle")} value={extract?.jobTitle || extract?.occupation || "—"} />
          <ReviewRow label={t("studio.emailRecipient")} value={recipient || "—"} />
          <ReviewRow label={t("studio.emailSubject")} value={emailDraft?.subject || "—"} />
          <div>
            <p className="text-xs font-medium text-muted">{t("studio.emailAttachments")}</p>
            {attachedNames.length === 0 ? (
              <p className="text-sm text-muted">—</p>
            ) : (
              <ul className="mt-1 space-y-0.5">
                {attachedNames.map((name, i) => (
                  <li key={i} className="flex items-center gap-1.5 text-sm">
                    <Icon name="paperclip" size={12} className="text-muted" />
                    {name}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div>
            <p className="text-xs font-medium text-muted">{t("studio.qualityTitle")}</p>
            <div className="mt-1">
              {ready ? (
                <span className="inline-flex items-center gap-1.5 text-sm font-medium text-success">
                  <Icon name="check" size={14} /> {t("studio.reviewReady")}
                </span>
              ) : (
                <div className="space-y-1">
                  <p className="text-sm font-medium text-warning">{t("studio.reviewNotReady")}</p>
                  <ul className="space-y-0.5 text-xs text-muted">
                    {checks.filter((c) => !c.ok).map((c, i) => (
                      <li key={i} className="flex items-center gap-1.5">
                        <Icon name="x" size={10} className="text-danger" /> {c.label}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* ---- action column --------------------------------------------- */}
        <div className="space-y-4">
          {app.status === "sent" ? (
            <Note kind="info">
              {t("studio.sent", { date: app.sent_at ? fmtDate(app.sent_at) : "—" })}
              {app.provider_message_id ? ` (ID: ${app.provider_message_id.slice(0, 12)}…)` : ""}
            </Note>
          ) : app.approved ? (
            <>
              {/* scheduled / in-flight / failed states */}
              {app.status === "scheduled" && latestAttempt ? (
                <div className="space-y-2">
                  <Note kind="info">
                    {t("studio.scheduledFor", {
                      when: latestAttempt.scheduled_at ? fmtDate(latestAttempt.scheduled_at) : "—",
                      tz: app.schedule_timezone ?? "UTC",
                    })}
                  </Note>
                  <div className="flex flex-wrap gap-2">
                    <BusyButton size="sm" variant="secondary" busy={cancelling} onClick={doCancel}>
                      {t("studio.scheduleCancel")}
                    </BusyButton>
                    <BusyButton size="sm" variant="ghost" busy={refreshing} onClick={doRefresh}>
                      <Icon name="refresh" size={14} />
                    </BusyButton>
                  </div>
                </div>
              ) : null}
              {app.status === "sending" ? (
                <div className="space-y-2">
                  <Note kind="warning">{t("studio.sending")}</Note>
                  <BusyButton size="sm" variant="ghost" busy={refreshing} onClick={doRefresh}>
                    <Icon name="refresh" size={14} />
                  </BusyButton>
                </div>
              ) : null}
              {app.status === "failed" || sendResult?.kind === "failed" ? (
                <div className="space-y-2">
                  <Note kind="danger">
                    {t("studio.sendFailed", { code: sendResult?.kind === "failed" ? (sendResult.code ?? "") : (app.last_failure_code ?? latestAttempt?.failure_code ?? "") })}
                  </Note>
                  <p className="text-xs text-muted">{t("studio.retryHint")}</p>
                </div>
              ) : null}
              {sendResult?.kind === "scheduled" ? (
                <Note kind="info">{t("studio.saved")}</Note>
              ) : null}
              {(app.status === "draft" || app.status === "ready") ? (
                <div className="space-y-3 rounded-xl border border-border bg-surface-2 p-4">
                  <p className="text-xs font-medium text-muted">{t("studio.whenLabel")}</p>
                  <div className="flex gap-2">
                    <label className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm ${mode === "now" ? "border-primary bg-primary/10 text-primary" : "border-border"}`}>
                      <input type="radio" name="st-send-mode" checked={mode === "now"} onChange={() => pickMode("now")} />
                      {t("studio.sendNow")}
                    </label>
                    <label className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm ${mode === "schedule" ? "border-primary bg-primary/10 text-primary" : "border-border"}`}>
                      <input type="radio" name="st-send-mode" checked={mode === "schedule"} onChange={() => pickMode("schedule")} />
                      {t("studio.scheduleSend")}
                    </label>
                  </div>
                  {mode === "schedule" ? (
                    <div className="grid gap-2 sm:grid-cols-2">
                      <div>
                        <label htmlFor="st-send-date" className="mb-1 block text-xs font-medium">{t("studio.tzLabel")}</label>
                        <Input id="st-send-date" type="date" value={date} onChange={(e) => { setDate(e.target.value); revalidateSchedule({ mode, date: e.target.value, time, tz }); }} />
                      </div>
                      <div>
                        <label htmlFor="st-send-time" className="mb-1 block text-xs font-medium">Uhrzeit</label>
                        <Input id="st-send-time" type="time" value={time} onChange={(e) => { setTime(e.target.value); revalidateSchedule({ mode, date, time: e.target.value, tz }); }} />
                      </div>
                      <div className="sm:col-span-2">
                        <label htmlFor="st-send-tz" className="mb-1 block text-xs font-medium">{t("studio.tzLabel")}</label>
                        <select
                          id="st-send-tz"
                          value={tz}
                          onChange={(e) => { setTz(e.target.value); revalidateSchedule({ mode, date, time, tz: e.target.value }); }}
                          className="w-full rounded-xl border border-border bg-surface px-3 py-2 text-sm"
                        >
                          {timeZones.map((z) => (
                            <option key={z} value={z}>{z}</option>
                          ))}
                        </select>
                      </div>
                      {scheduleCheck && !scheduleCheck.ok ? (
                        <div className="sm:col-span-2">
                          <Note kind="danger">{scheduleCheck.msg}</Note>
                        </div>
                      ) : null}
                    </div>
                  ) : null}

                  <div>
                    <label htmlFor="st-send-recipient" className="mb-1 block text-xs font-medium">{t("studio.emailRecipient")}</label>
                    <Input
                      id="st-send-recipient"
                      type="email"
                      value={recipient}
                      onChange={(e) => onRecipientChange(e.target.value)}
                    />
                  </div>
                  <div>
                    <label htmlFor="st-send-account" className="mb-1 block text-xs font-medium">{t("studio.emailAccount")}</label>
                    <select
                      id="st-send-account"
                      value={accountId}
                      onChange={(e) => setAccountId(e.target.value)}
                      className="w-full rounded-xl border border-border bg-surface px-3 py-2 text-sm"
                    >
                      {emailAccounts.length === 0 ? <option value="">{t("studio.emailNoAccount")}</option> : null}
                      {emailAccounts.map((a) => (
                        <option key={a.id} value={a.id} disabled={!a.is_active || a.requires_reconnect}>
                          {a.email} ({a.provider === "gmail" ? "Gmail" : "Outlook"})
                          {!a.is_active || a.requires_reconnect ? " — " + (a.requires_reconnect ? "reconnect" : "inactive") : ""}
                        </option>
                      ))}
                    </select>
                  </div>

                  <label className="flex items-start gap-2 rounded-xl border border-border bg-surface p-3 text-sm">
                    <input
                      type="checkbox"
                      checked={confirmed}
                      onChange={(e) => setConfirmed(e.target.checked)}
                      className="mt-0.5"
                    />
                    <span>{t("studio.sendConfirm", { email: recipient || "…" })}</span>
                  </label>
                  <BusyButton
                    busy={sending}
                    disabled={!confirmed || !recipientOk || !accountOk || (mode === "schedule" && (!scheduleCheck || !scheduleCheck.ok))}
                    onClick={doSend}
                  >
                    {sending ? t("studio.sending") : t("studio.sendButton")}
                  </BusyButton>
                </div>
              ) : null}
            </>
          ) : (
            <div className="space-y-3">
              <Note kind="info">{t("studio.approveHint")}</Note>
              <BusyButton busy={approving} disabled={!ready} onClick={doApprove}>
                {t("studio.approveButton")}
              </BusyButton>
              {!ready ? (
                <p className="text-xs text-muted">{t("studio.reviewNotReady")}</p>
              ) : null}
            </div>
          )}
          {app.approved && app.approved_at ? (
            <p className="text-xs text-muted">{t("studio.approvedOn", { date: fmtDate(app.approved_at) })}</p>
          ) : null}
          {emailAccounts.length === 0 ? (
            <Note kind="warning">
              {t("studio.emailNoAccount")}{" "}
              <a href="/settings/email" className="font-medium underline">
                {t("studio.emailAccountLink")}
              </a>
            </Note>
          ) : null}
        </div>
      </div>
    </SectionCard>
  );
}

function ReviewRow({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs font-medium text-muted">{label}</p>
      <p className="text-sm">{value}</p>
    </div>
  );
}
