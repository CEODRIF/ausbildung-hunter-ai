"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { CalendarClock, CheckCircle2, ChevronDown, ListPlus, Paperclip, Send, Timer, XCircle } from "lucide-react";
import { Button, Modal } from "@/components/ui";
import { EmptyState, StatusPill, type StatusTone } from "@/components/ui/feedback";
import { ScheduleForm } from "@/components/schedule-form";
import { useI18n } from "@/lib/i18n";
import { HARD_MIN_SEND_INTERVAL_MS, MAX_SEND_INTERVAL_MS, MIN_SEND_INTERVAL_MS } from "@/lib/email-rate-limit";
import {
  AUTO_BEWERB_COMPANY_LIMIT,
  isValidEmail,
  resolveAutoBewerbRecipient,
  type AutoBewerbBatchStatus,
  type AutoBewerbCompanyView,
} from "@/lib/auto-bewerb/schema";
import type {
  AutoBewerbBatchItemError,
  AutoBewerbBatchItemResult,
  AutoBewerbBatchResult,
  AutoBewerbScheduleInput,
} from "@/lib/auto-bewerb/engine";
import { AUTO_BEWERB_SENDING_WINDOW, formatWindowTime, windowLabel } from "@/lib/auto-bewerb/sending-window";
import {
  approveCompanyAction,
  cancelBatchAction,
  cancelSendAction,
  createBatchAction,
  scheduleCompaniesAction,
  sendCompaniesAction,
} from "@/app/auto-bewerb/actions";
import { Note, SectionCard, companyLabel, statusPill, useAutoBewerb } from "./shared";

/**
 * Step 7 — final review, explicit confirmation, multi-batch send / schedule.
 *
 * Safety contract (mirrors the engine):
 *  - the ONE global e-mail configuration (Step 6) is the exact content for
 *    EVERY company in the batch — the client passes only company ids;
 *  - a batch is a persistent unit: an immutable snapshot + per-company
 *    attempts are stored server-side and survive refresh / logout / restart;
 *  - a send only happens after a confirmation modal that lists the EXACT
 *    shared subject/body/account/attachments + the per-company delivery
 *    destination (each company's verified address);
 *  - the 3:30 inter-batch delay and the 5s per-account e-mail interval are
 *    enforced SERVER-SIDE (RPC gate + sender slots) — every countdown here
 *    is visual only;
 *  - databases without the batches migration fall back to the legacy
 *    per-company send/schedule path (batchesSupported = false).
 */

/** The status set a company can still (re-)enter a batch from — sent,
 *  scheduled and sending companies are already committed to a delivery. */
const BASE_SELECTABLE: ReadonlyArray<AutoBewerbCompanyView["company"]["status"]> = [
  "draft",
  "ready",
  "failed",
  "cancelled",
];

const BATCH_TONE: Record<AutoBewerbBatchStatus, StatusTone> = {
  scheduled: "neutral",
  waiting: "neutral",
  sending: "running",
  completed: "success",
  partially_failed: "blocked",
  failed: "blocked",
  cancelled: "skipped",
};

const BATCH_TERMINAL: ReadonlyArray<AutoBewerbBatchStatus> = [
  "completed",
  "partially_failed",
  "failed",
  "cancelled",
];

/** Visual-only countdown formatting (the server owns the actual schedule). */
function countdownText(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function StatTile({ label, value, hint }: { label: string; value: number | string; hint?: string }) {
  return (
    <div className="rounded-2xl border border-line bg-surface-2/50 px-4 py-3">
      <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-faint">{label}</p>
      <p className="mt-1 text-2xl font-bold tabular-nums text-ink">{value}</p>
      {hint && <p className="mt-0.5 text-[11px] font-semibold text-accent">{hint}</p>}
    </div>
  );
}

export function Step7Review() {
  const { ws, refresh, notify, goToStep } = useAutoBewerb();
  const { t, lang } = useI18n();
  const locale = { de: "de-DE", en: "en-GB", fr: "fr-FR", ar: "ar-EG" }[lang] ?? "de-DE";
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [scheduling, setScheduling] = useState(false);
  const [results, setResults] = useState<AutoBewerbBatchItemResult[] | null>(null);
  const [batchMeta, setBatchMeta] = useState<AutoBewerbBatchResult | null>(null);
  const [batchErrors, setBatchErrors] = useState<AutoBewerbBatchItemError[] | null>(null);
  const [approvingId, setApprovingId] = useState<string | null>(null);
  const [expandedBatch, setExpandedBatch] = useState<string | null>(null);
  const [cancellingBatch, setCancellingBatch] = useState<string | null>(null);
  // Visual-only clock for the queue countdowns (30 s tick, never authoritative).
  const [now, setNow] = useState(() => Date.now());

  const s = ws.emailSettings; // null = legacy database (per-company rows)
  const globalComplete = Boolean(s && s.body.trim() && s.subject.trim() && s.accountId);
  const batchMode = ws.batchesSupported;
  // GLOBAL capacity from PERSISTED server counters (fallback: the active list
  // is the same reserved set — honest even pre-migration).
  const cap = ws.capacity ?? {
    reserved: ws.companies.length,
    capacity: AUTO_BEWERB_COMPANY_LIMIT,
    available: Math.max(0, AUTO_BEWERB_COMPANY_LIMIT - ws.companies.length),
  };

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  const fmtTime = (iso: string) => new Date(iso).toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" });

  /** The e-mail configuration that will actually be sent for this company —
   *  global settings (supported) or the legacy stored row values. */
  const emailCfg = (v: AutoBewerbCompanyView) => {
    const r = v.company;
    if (s) {
      return {
        dest: resolveAutoBewerbRecipient("", r.recipient_email, r.ad_extracted),
        subject: s.subject.trim(),
        body: s.body.trim(),
        attachCv: s.attachCv,
        attachLetter: s.attachLetter,
        account: ws.emailAccounts.find((a) => a.id === s.accountId) ?? null,
      };
    }
    return {
      dest: (r.recipient_email ?? "").trim(),
      subject: (r.email_subject ?? "").trim(),
      body: ws.emailTemplate.trim(),
      attachCv: r.email_attach_cv,
      attachLetter: r.email_attach_letter,
      account: ws.emailAccounts.find((a) => a.id === (r.email_account_id ?? "")) ?? null,
    };
  };

  const sendable = (v: AutoBewerbCompanyView): boolean => {
    const r = v.company;
    const base = r.status === "draft" || r.status === "ready" || r.status === "failed" || r.status === "cancelled";
    if (!base) return false;
    // Explicit approval is REQUIRED (engine gate — set via the row's
    // "Genehmigen" button; the engine re-checks it server-side at send).
    if (!r.approved) return false;
    const cfg = emailCfg(v);
    if (s) {
      // Global configuration: complete settings + a resolvable verified
      // destination + the documents the global attachment flags demand.
      return globalComplete && Boolean(cfg.dest) && isValidEmail(cfg.dest) && (!cfg.attachCv || Boolean(v.cv)) && (!cfg.attachLetter || Boolean(v.letter));
    }
    // Legacy (settings migration not applied): stored per-company values.
    return Boolean(cfg.dest) && isValidEmail(cfg.dest) && Boolean(cfg.subject) && Boolean(v.cv) && Boolean(v.letter) && Boolean(cfg.account);
  };

  /** Checkbox eligibility: batch mode allows selecting INCOMPLETE companies
   *  (the readiness is shown, gaps are actionable); legacy mode only
   *  fully-ready rows (the old per-company isolation). */
  const selectable = (v: AutoBewerbCompanyView): boolean =>
    batchMode ? BASE_SELECTABLE.includes(v.company.status) : sendable(v);

  const missing = (v: AutoBewerbCompanyView): string[] => {
    const out: string[] = [];
    const r = v.company;
    if (!r.approved) out.push(t("autoBewerb.missingApproval"));
    const cfg = emailCfg(v);
    if (!cfg.body) out.push(t("autoBewerb.templateEmptyNote"));
    if (!cfg.subject) out.push(t("autoBewerb.missingSubject"));
    if (!cfg.dest) out.push(t("autoBewerb.missingRecipient"));
    else if (!isValidEmail(cfg.dest)) out.push(t("autoBewerb.invalidRecipient"));
    if (cfg.attachCv && !v.cv) out.push(t("autoBewerb.missingCv"));
    if (cfg.attachLetter && !v.letter) out.push(t("autoBewerb.missingLetter"));
    if (!cfg.account) out.push(t("autoBewerb.missingAccount"));
    return out;
  };

  /** Attachment count exactly as the engine resolves it: the GLOBAL document
   *  library + this company's own CV/letter PDF (per the attachment flags). */
  const attachmentCount = (v: AutoBewerbCompanyView): number => {
    const cfg = emailCfg(v);
    let n = ws.attachments.length;
    if (cfg.attachCv && v.cv) n += 1;
    if (cfg.attachLetter && v.letter) n += 1;
    return n;
  };

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      // Per-batch max = the global limit (server: AUTO_BEWERB_BATCH_COMPANY_LIMIT
      // = AUTO_BEWERB_COMPANY_LIMIT); the reserved set is already bounded by it.
      else if (next.size < AUTO_BEWERB_COMPANY_LIMIT) next.add(id);
      return next;
    });
  };

  // Derived, never an effect: the server row is the truth. Companies that
  // entered a delivery (scheduled/sending/sent) — e.g. after a refresh —
  // silently drop out of the selection, so "Current batch" only shows
  // actionable companies and stale ids never consume the 10-company cap.
  const selection = new Set(
    ws.companies.filter((c) => selectable(c) && selected.has(c.company.id)).map((c) => c.company.id),
  );
  const selectedViews = ws.companies.filter((c) => selected.has(c.company.id) && selectable(c));
  const readyViews = selectedViews.filter(sendable);
  const allReady = selectedViews.length > 0 && readyViews.length === selectedViews.length;
  const atCap = selection.size >= AUTO_BEWERB_COMPANY_LIMIT;

  /** One honest result line per company of the last accepted batch. */
  const resultText = (r: AutoBewerbBatchItemResult): string => {
    if (r.ok) {
      if (r.scheduledAt) return t("autoBewerb.resultScheduled", { time: fmtTime(r.scheduledAt) });
      if (r.dispatchStatus === "sent") return t("autoBewerb.resultSent");
      if (r.dispatchStatus === "duplicate") return t("autoBewerb.resultDuplicate");
      if (r.dispatchStatus === "queued" || r.dispatchStatus === "skipped") return t("autoBewerb.resultQueued");
      return t("autoBewerb.resultSent");
    }
    const code = r.failureCode ?? r.code ?? "";
    if (code === "already_sent") return t("autoBewerb.alreadySentNote");
    if (code === "not_approved") return t("autoBewerb.notApprovedResult");
    if (code === "no_email_account") return t("autoBewerb.emailAccountNoneBody");
    return t("autoBewerb.resultFailed", { code });
  };

  /** Actionable per-company gap text for batch pre-validation failures. */
  const itemErrorText = (code: string): string => {
    switch (code) {
      case "not_approved": return t("autoBewerb.notApprovedResult");
      case "already_sent": return t("autoBewerb.alreadySentNote");
      case "invalid_recipient": return t("autoBewerb.invalidRecipient");
      case "missing_cv": return t("autoBewerb.missingCv");
      case "missing_letter": return t("autoBewerb.missingLetter");
      case "schedule_after_deadline": return t("autoBewerb.scheduleAfterDeadline");
      case "schedule_outside_window": return t("autoBewerb.scheduleWindowInvalid");
      case "send_in_progress": return t("autoBewerb.sendInProgress");
      case "not_found": return t("autoBewerb.companyNotFound");
      default: return t("autoBewerb.resultFailed", { code });
    }
  };

  const globalErrorText = (code: string): string => {
    switch (code) {
      case "no_settings":
      case "incomplete_settings": return t("autoBewerb.emailSettingsIncomplete");
      case "no_email_account": return t("autoBewerb.emailAccountNoneBody");
      case "invalid_schedule": return t("autoBewerb.invalidScheduleNote");
      case "schedule_outside_window": return t("autoBewerb.scheduleWindowInvalid");
      case "sending_unavailable": return t("autoBewerb.sendingUnavailableNote");
      case "batch_too_large": return t("autoBewerb.currentBatchMaxHint");
      case "schema_pending": return t("autoBewerb.batchesPendingNote");
      default: return t("autoBewerb.resultFailed", { code });
    }
  };

  const handleBatchCreated = (res: AutoBewerbBatchResult) => {
    setResults(res.items ?? []);
    setBatchMeta(res);
    setBatchErrors(null);
    setSelected(new Set()); // spec: accepted batch leaves the active selection
    void refresh();
    if (res.windowDeferred) {
      // Honest status: the batch was accepted but starts only inside the
      // daily sending window (07:30–10:30 Europe/Berlin) — never "started".
      notify("info", t("autoBewerb.windowDeferredNote", { label: ws.sendingWindow?.label ?? windowLabel() }));
      return;
    }
    notify(
      "success",
      res.scheduledAt
        ? t("autoBewerb.batchCreatedScheduled", { no: res.batchNo ?? "", time: fmtTime(res.scheduledAt) })
        : t("autoBewerb.batchCreatedStarted", { no: res.batchNo ?? "" }),
    );
  };

  const handleBatchError = (code: string, errors: AutoBewerbBatchItemError[] | undefined) => {
    if (errors && errors.length > 0) {
      setBatchErrors(errors);
      setResults([]);
      setBatchMeta(null);
    } else {
      setBatchErrors(null);
      notify("error", globalErrorText(code));
    }
  };

  const doSend = async () => {
    setSending(true);
    setConfirmOpen(false);
    if (batchMode) {
      // The client passes ONLY company ids + the explicit confirmation —
      // every e-mail setting is resolved server-side into the batch snapshot.
      const res = await createBatchAction(selectedViews.map((v) => v.company.id), null, true);
      setSending(false);
      if (res.ok) handleBatchCreated(res.value);
      else handleBatchError(res.code, "errors" in res ? res.errors : undefined);
    } else {
      // Legacy path (batches migration pending): per-company isolation.
      const inputs = selectedViews.map((v) => ({ companyId: v.company.id, confirmed: true }));
      const res = await sendCompaniesAction(inputs);
      setSending(false);
      if (res.ok) {
        setResults(res.value);
        setBatchMeta(null);
        setBatchErrors(null);
        setSelected(new Set());
        await refresh();
        // Honest status: an out-of-window "Send Now" is accepted but HELD at
        // the next window start — never falsely reported as sent.
        const deferred =
          res.value.some((r) => r.dispatchStatus === "queued" && r.scheduledAt) &&
          !res.value.some((r) => r.dispatchStatus === "sent");
        if (deferred) notify("info", t("autoBewerb.windowDeferredNote", { label: ws.sendingWindow?.label ?? windowLabel() }));
      } else {
        notify("error", t("autoBewerb.saveError"));
      }
    }
  };

  const onSchedule = (formData: FormData) => {
    setScheduling(true);
    if (batchMode) {
      const num = (k: string) => Number(formData.get(k) ?? 0);
      const schedule: AutoBewerbScheduleInput = {
        timeZone: String(formData.get("scheduleTimezone") ?? "Europe/Berlin"),
        year: num("scheduleYear"),
        month: num("scheduleMonth"),
        day: num("scheduleDay"),
        hour: num("scheduleHour"),
        minute: num("scheduleMinute"),
      };
      void createBatchAction(selectedViews.map((v) => v.company.id), schedule, true).then((res) => {
        setScheduling(false);
        if (res.ok) handleBatchCreated(res.value);
        else handleBatchError(res.code, "errors" in res ? res.errors : undefined);
      });
      return;
    }
    void scheduleCompaniesAction(Array.from(selection), formData).then((res) => {
      setScheduling(false);
      if (res.ok) {
        setResults(res.value);
        setBatchMeta(null);
        setBatchErrors(null);
        setSelected(new Set());
        void refresh();
      } else {
        notify("error", t("autoBewerb.saveError"));
      }
    });
  };

  /** Explicit per-company approval — the engine refuses every send without
   *  approved = true; this is the UI path that sets it (scoped by company id). */
  const approve = async (companyId: string) => {
    setApprovingId(companyId);
    const res = await approveCompanyAction(companyId);
    setApprovingId(null);
    if (res.ok) {
      await refresh();
      notify("success", t("autoBewerb.approvedNote"));
    } else {
      notify("error", res.code === "already_sent" ? t("autoBewerb.alreadySentNote") : t("autoBewerb.saveError"));
    }
  };

  const cancelScheduled = async (attemptId: string) => {
    const res = await cancelSendAction(attemptId);
    if (res.ok) {
      await refresh();
      notify("success", t("autoBewerb.cancelledNote"));
    } else notify("error", t("autoBewerb.saveError"));
  };

  /** Safe batch cancellation — only before the batch started (the engine
   *  re-checks the status atomically); releases queue reservations only. */
  const cancelBatch = async (batchId: string) => {
    setCancellingBatch(batchId);
    const res = await cancelBatchAction(batchId);
    setCancellingBatch(null);
    if (res.ok) {
      await refresh();
      notify("success", t("autoBewerb.queueCancelled"));
    } else {
      notify("error", t("autoBewerb.saveError"));
    }
  };

  const batchStatusLabel = (status: AutoBewerbBatchStatus): string =>
    status === "scheduled"
      ? t("autoBewerb.batchStatusScheduled")
      : status === "waiting"
        ? t("autoBewerb.batchStatusWaiting")
        : status === "sending"
          ? t("autoBewerb.batchStatusSending")
          : status === "completed"
            ? t("autoBewerb.batchStatusCompleted")
            : status === "partially_failed"
              ? t("autoBewerb.batchStatusPartiallyFailed")
              : status === "failed"
                ? t("autoBewerb.batchStatusFailed")
                : t("autoBewerb.batchStatusCancelled");

  // Empty ONLY when there is truly nothing: no active companies, no batches
  // and no preserved history. With automatic removal a fully-delivered
  // campaign leaves the active list — the queue + history must still show.
  if (ws.companies.length === 0 && ws.batches.length === 0 && (ws.sendHistory?.length ?? 0) === 0) {
    return <EmptyState title={t("autoBewerb.reviewEmpty")} body={t("autoBewerb.reviewEmptyBody")} illustration={<Send size={34} strokeWidth={1.6} />} ctaIcon={<Button variant="primary" onClick={() => goToStep(2)}>{t("autoBewerb.goToCompanies")}</Button>} />;
  }

  const resultFor = (id: string) => results?.find((r) => r.companyId === id) ?? null;

  return (
    <div className="space-y-5">
      <Note kind="info">{t("autoBewerb.draftNote")}</Note>

      {/* Live sending-window state (server-computed, IANA Europe/Berlin,
          DST-aware): new batch STARTS only happen while open; waiting
          batches start automatically in the next window. */}
      {ws.sendingWindow && (
        <Note kind={ws.sendingWindow.open ? "success" : "info"}>
          {ws.sendingWindow.open
            ? t("autoBewerb.windowBannerOpen", { label: ws.sendingWindow.label })
            : t("autoBewerb.windowBannerClosed", {
                label: ws.sendingWindow.label,
                // The instant is correct; format it in the window's OWN zone
                // (Europe/Berlin, DST-aware) — never browser-local or UTC.
                time: ws.sendingWindow.nextStartMs ? formatWindowTime(ws.sendingWindow.nextStartMs, locale) : "–",
              })}
        </Note>
      )}

      {ws.emailAccounts.length === 0 && (
        <Note kind="error">
          {t("autoBewerb.emailAccountNoneBody")}{" "}
          <Link href="/settings/email" className="font-semibold text-accent underline underline-offset-2">
            {t("autoBewerb.emailAccountNoneCta")}
          </Link>
        </Note>
      )}

      {/* Results of the last accepted batch (honest, per company) */}
      {(results || batchErrors) && (
        <SectionCard
          title={t("autoBewerb.resultsTitle")}
          aside={
            batchMeta && batchMeta.status ? (
              <span className="flex items-center gap-2 text-xs font-semibold text-muted">
                {t("autoBewerb.queueBatchNo", { no: batchMeta.batchNo ?? "" })}
                <StatusPill tone={BATCH_TONE[batchMeta.status]} label={batchStatusLabel(batchMeta.status)} />
              </span>
            ) : undefined
          }
        >
          {batchErrors && batchErrors.length > 0 && (
            <ul className="mb-3 space-y-2">
              {batchErrors.map((e) => {
                const v = ws.companies.find((c) => c.company.id === e.companyId);
                const label = v ? companyLabel(v.company).name : e.companyId;
                return (
                  <li key={e.companyId} className="rounded-2xl border border-danger/25 bg-danger-soft/50 px-4 py-3 text-sm text-danger">
                    {/* cv_overflow carries the actionable guidance in its message */}
                    <span className="font-bold">{label}:</span> {e.code === "cv_overflow" ? e.message : itemErrorText(e.code)}
                  </li>
                );
              })}
            </ul>
          )}
          {results && results.length > 0 && (
            <ul className="space-y-2">
              {results.map((r) => {
                const v = ws.companies.find((c) => c.company.id === r.companyId);
                const label = v ? companyLabel(v.company).name : r.companyId;
                const tone = r.ok ? "success" : "error";
                const text = resultText(r);
                return (
                  <li key={r.companyId} className={`rounded-2xl border px-4 py-3 text-sm ${tone === "success" ? "border-success/25 bg-success-soft/50 text-success" : "border-danger/25 bg-danger-soft/50 text-danger"}`}>
                    <span className="font-bold">{label}:</span> {text}
                  </li>
                );
              })}
            </ul>
          )}
        </SectionCard>
      )}

      {/* A. Current batch — the companies that will form the next batch */}
      <SectionCard
        title={t("autoBewerb.currentBatchTitle", { count: selectedViews.length })}
        aside={
          <div className="flex flex-wrap items-center gap-2">
            {selectedViews.length > 0 && (
              <span
                className={`rounded-full border px-2.5 py-1 text-[11px] font-bold ${
                  allReady ? "border-success/30 bg-success-soft/50 text-success" : "border-warning/40 bg-warning-soft/50 text-warning"
                }`}
              >
                {t("autoBewerb.currentBatchReady", { ready: readyViews.length, total: selectedViews.length })}
              </span>
            )}
            <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())} disabled={selection.size === 0}>
              <ListPlus size={14} />
              {t("autoBewerb.addAnotherList")}
            </Button>
          </div>
        }
      >
        <p className="mb-3 text-xs leading-5 text-muted">{t("autoBewerb.currentBatchBody")}</p>
        {selectedViews.length === 0 ? (
          <p className="rounded-2xl border border-dashed border-line-strong px-4 py-6 text-center text-sm text-muted">
            {t("autoBewerb.currentBatchEmpty")}
          </p>
        ) : (
          <>
            <ul className="divide-y divide-line">
              {selectedViews.map((v) => {
                const r = v.company;
                const { name, job } = companyLabel(r);
                const cfg = emailCfg(v);
                const isReady = sendable(v);
                return (
                  <li key={r.id} className="flex flex-wrap items-center gap-3 py-2.5">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate text-sm font-bold text-ink">{name}</span>
                        {job && <span className="truncate text-xs text-muted">{job}</span>}
                      </div>
                      <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-muted">
                        <span>
                          {t("autoBewerb.recipientLabel")}:{" "}
                          <span className={`font-medium ${cfg.dest && isValidEmail(cfg.dest) ? "text-ink-soft" : "text-warning"}`}>
                            {cfg.dest || t("autoBewerb.unavailable")}
                          </span>
                        </span>
                        <span className="text-faint">·</span>
                        <span className="inline-flex items-center gap-1">
                          <Paperclip size={11} />
                          {attachmentCount(v)}
                        </span>
                      </p>
                    </div>
                    {isReady ? (
                      <span className="rounded-full border border-success/30 bg-success-soft/50 px-2 py-0.5 text-[10px] font-bold text-success">
                        {t("autoBewerb.currentBatchReadyChip")}
                      </span>
                    ) : (
                      <span className="rounded-full border border-warning/40 bg-warning-soft/50 px-2 py-0.5 text-[10px] font-bold text-warning">
                        {t("autoBewerb.currentBatchNotReady")}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
            {!allReady && <p className="mt-2 text-xs text-warning">{t("autoBewerb.noneSelectable")}</p>}
            {atCap && <p className="mt-2 text-xs text-faint">{t("autoBewerb.currentBatchMaxHint")}</p>}
            <div className="mt-4 flex flex-wrap gap-2">
              <Button variant="primary" size="sm" onClick={() => setConfirmOpen(true)} disabled={!allReady || sending}>
                <Send size={14} />
                {sending ? t("autoBewerb.sendingNote") : t("autoBewerb.sendNowButton", { count: selectedViews.length })}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => document.getElementById("schedule-form")?.scrollIntoView({ behavior: "smooth" })}
                disabled={!allReady || scheduling}
              >
                <CalendarClock size={14} />
                {t("autoBewerb.scheduleButton", { count: selectedViews.length })}
              </Button>
            </div>
          </>
        )}
      </SectionCard>

      {/* B. Schedule automatically — validated future datetime, persistent */}
      {selectedViews.length > 0 && (
        <div id="schedule-form">
          <SectionCard title={t("autoBewerb.scheduleTitle")}>
            <ScheduleForm
              action={onSchedule}
              submitLabel={scheduling ? t("autoBewerb.scheduling") : t("autoBewerb.scheduleSubmit", { count: selectedViews.length })}
              pendingLabel={t("autoBewerb.scheduling")}
              window={{
                timeZone: AUTO_BEWERB_SENDING_WINDOW.timeZone,
                startMinute: AUTO_BEWERB_SENDING_WINDOW.startHour * 60 + AUTO_BEWERB_SENDING_WINDOW.startMinute,
                endMinute: AUTO_BEWERB_SENDING_WINDOW.endHour * 60 + AUTO_BEWERB_SENDING_WINDOW.endMinute,
              }}
            />
          </SectionCard>
        </div>
      )}

      {/* C. Versand-Warteschlange — real persisted queue data */}
      {batchMode && (
        <SectionCard title={t("autoBewerb.queueTitle")}>
          {ws.batches.length === 0 ? (
            <p className="text-sm text-muted">{t("autoBewerb.queueEmpty")}</p>
          ) : (
            <ul className="space-y-3">
              {ws.batches.map((b) => {
                const cancellable = b.status === "scheduled" || b.status === "waiting";
                const countdown =
                  cancellable && b.scheduled_at && Date.parse(b.scheduled_at) > now
                    ? countdownText(Date.parse(b.scheduled_at) - now)
                    : null;
                const expanded = expandedBatch === b.id;
                const terminal = BATCH_TERMINAL.includes(b.status);
                return (
                  <li
                    key={b.id}
                    className={`rounded-2xl border p-4 ${
                      b.status === "sending" ? "border-accent/40 bg-accent-soft/10" : "border-line bg-surface-2/30"
                    } ${terminal ? "opacity-75" : ""}`}
                  >
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                      <span className="text-sm font-bold text-ink">{t("autoBewerb.queueBatchNo", { no: b.batch_no })}</span>
                      <span className="text-xs text-muted">{t("autoBewerb.queueCompanies", { count: b.snapshot.items.length })}</span>
                      <StatusPill tone={BATCH_TONE[b.status]} label={batchStatusLabel(b.status)} />
                      {b.scheduled_at && (
                        <span className="text-xs text-ink-soft">{t("autoBewerb.queueScheduledAt", { time: fmtTime(b.scheduled_at) })}</span>
                      )}
                      {b.started_at && (
                        <span className="text-xs text-ink-soft">{t("autoBewerb.queueStartedAt", { time: fmtTime(b.started_at) })}</span>
                      )}
                      {countdown && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-accent-soft/60 px-2 py-0.5 text-[11px] font-bold text-accent">
                          <Timer size={11} />
                          {t("autoBewerb.queueCountdown", { time: countdown })}
                        </span>
                      )}
                      {b.status === "waiting" && !countdown && (
                        <span className="text-[11px] font-semibold text-warning">{t("autoBewerb.queueWaitingGate")}</span>
                      )}
                      <span className="text-xs text-muted">{t("autoBewerb.queueAccount", { account: b.snapshot.accountEmail || "—" })}</span>
                    </div>
                    <p className="mt-1.5 text-[11px] text-faint">
                      {t("autoBewerb.queueCounts", { sent: b.sentCount, failed: b.failedCount, pending: b.pendingCount })}
                    </p>
                    <div className="mt-2 flex flex-wrap gap-2">
                      <Button variant="ghost" size="sm" onClick={() => setExpandedBatch(expanded ? null : b.id)}>
                        <ChevronDown size={14} className={expanded ? "rotate-180" : ""} />
                        {expanded ? t("autoBewerb.queueHideDetails") : t("autoBewerb.queueDetails")}
                      </Button>
                      {cancellable && (
                        <Button variant="ghost" size="sm" onClick={() => void cancelBatch(b.id)} disabled={cancellingBatch !== null}>
                          <XCircle size={14} />
                          {cancellingBatch === b.id ? t("autoBewerb.queueCancelling") : t("autoBewerb.queueCancel")}
                        </Button>
                      )}
                    </div>
                    {expanded && (
                      <ul className="mt-3 divide-y divide-line rounded-xl border border-line bg-surface px-3 py-1">
                        {b.snapshot.items.map((item) => (
                          <li key={item.companyId} className="flex flex-wrap items-baseline gap-2 py-2 text-xs">
                            <span className="font-semibold text-ink">{item.company}</span>
                            {item.position && <span className="text-muted">{item.position}</span>}
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </SectionCard>
      )}

      {/* Company review list — build the batch (up to 100, bounded by the global capacity) */}
      <SectionCard title={t("autoBewerb.reviewHeading")}>
        <ul className="divide-y divide-line">
          {ws.companies.map((v) => {
            const r = v.company;
            const { name, job } = companyLabel(r);
            const canSelect = selectable(v);
            const gaps = missing(v);
            const cfg = emailCfg(v);
            const res = resultFor(r.id);
            return (
              <li key={r.id} className="flex flex-wrap items-start gap-3 py-4">
                <input
                  type="checkbox"
                  aria-label={name}
                  checked={selection.has(r.id)}
                  disabled={!canSelect || (!selection.has(r.id) && atCap)}
                  onChange={() => toggle(r.id)}
                  className="mt-1 h-4 w-4 accent-[var(--color-accent)]"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-sm font-bold text-ink">{name}</span>
                    {job && <span className="truncate text-xs text-muted">{job}</span>}
                    {statusPill(r.status, t)}
                    {r.approved && (
                      <span className="rounded-full border border-success/30 bg-success-soft/50 px-2 py-0.5 text-[10px] font-bold text-success">
                        {t("autoBewerb.approvedChip")}
                      </span>
                    )}
                    {res && (
                      <span className={`text-xs font-semibold ${res.ok ? "text-success" : "text-danger"}`}>
                        {res.ok ? (res.dispatchStatus === "queued" || res.dispatchStatus === "skipped" || res.scheduledAt ? t("autoBewerb.resultQueued") : t("autoBewerb.resultSent")) : resultText(res)}
                      </span>
                    )}
                  </div>
                  <dl className="mt-1.5 grid gap-x-4 gap-y-0.5 text-xs text-muted sm:grid-cols-2">
                    <div>
                      <dt className="inline text-faint">{t("autoBewerb.recipientLabel")}: </dt>
                      <dd className={`inline font-medium ${cfg.dest && isValidEmail(cfg.dest) ? "text-ink-soft" : "text-warning"}`}>
                        {cfg.dest || t("autoBewerb.unavailable")}
                      </dd>
                    </div>
                    <div>
                      <dt className="inline text-faint">{t("autoBewerb.subjectLabel")}: </dt>
                      <dd className={`inline font-medium ${cfg.subject ? "text-ink-soft" : "text-warning"}`}>{cfg.subject || t("autoBewerb.unavailable")}</dd>
                    </div>
                    <div className="flex items-center gap-1 sm:col-span-2">
                      <Paperclip size={12} />
                      <span className="font-medium text-ink-soft">
                        {[cfg.attachCv && v.cv ? v.cvPdfName : null, cfg.attachLetter && v.letter ? v.letterPdfName : null]
                          .filter(Boolean)
                          .join(", ") || t("autoBewerb.noAttachments")}
                      </span>
                    </div>
                    {ws.attachments.length > 0 && (
                      <div className="sm:col-span-2">
                        <span className="text-faint">{t("autoBewerb.attachSharedDocs")} </span>
                        <span className="font-medium text-ink-soft">{ws.attachments.map((a) => a.display_name).join(", ")}</span>
                      </div>
                    )}
                  </dl>
                  {gaps.length > 0 && (
                    <p className="mt-1 text-xs text-warning">
                      {gaps.join(" · ")}
                      {/* Approval is fixed RIGHT HERE (row button) — the Step 6
                          link only applies to the e-mail configuration gaps. */}
                      {gaps.some((g) => g !== t("autoBewerb.missingApproval")) && (
                        <>
                          {" — "}
                          <button type="button" className="font-semibold underline underline-offset-2" onClick={() => goToStep(6)}>
                            {t("autoBewerb.fixInStep6")}
                          </button>
                        </>
                      )}
                    </p>
                  )}
                  {r.scheduled_at && (
                    <p className="mt-1 text-xs text-ink-soft">
                      {t("autoBewerb.scheduledAtLabel")}: {new Date(r.scheduled_at).toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" })}
                    </p>
                  )}
                </div>
                {/* Legacy per-attempt cancel only (batch mode: cancel the whole
                    batch from the queue panel — the atomic status gate applies). */}
                {!batchMode && r.status === "scheduled" && v.latestAttempt && (
                  <Button variant="ghost" size="sm" onClick={() => void cancelScheduled(v.latestAttempt!.id)}>
                    <XCircle size={14} />
                    {t("autoBewerb.cancelSchedule")}
                  </Button>
                )}
                {r.status !== "sent" && !r.approved && (
                  <Button variant="secondary" size="sm" onClick={() => void approve(r.id)} disabled={approvingId !== null}>
                    <CheckCircle2 size={14} />
                    {approvingId === r.id ? t("autoBewerb.approving") : t("autoBewerb.approveButton")}
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
        {selectedViews.length === 0 && <p className="mt-3 text-xs text-muted">{t("autoBewerb.noneSelectable")}</p>}
      </SectionCard>

      {/* E. Smart Sending — the actual server-enforced policy (no bypass UI) */}
      <SectionCard
        title={t("autoBewerb.smartSendingTitle")}
        aside={
          <span className="rounded-full border border-success/40 bg-success-soft/50 px-2.5 py-1 font-mono text-[10px] font-bold tracking-wider text-success">
            {t("autoBewerb.smartSendingAlwaysOn")}
          </span>
        }
      >
        <div className="flex items-center gap-2">
          <span className="h-2.5 w-2.5 rounded-full bg-success" aria-hidden="true" />
          <span className="text-sm font-bold text-success">{t("autoBewerb.smartSendingEnabled")}</span>
        </div>
        <p className="mt-2 text-sm leading-6 text-muted">{t("autoBewerb.smartSendingDesc")}</p>
        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
          {(
            [
              [t("autoBewerb.smartSendingMinInterval"), t("autoBewerb.smartSendingSeconds", { n: `${HARD_MIN_SEND_INTERVAL_MS / 1000}–${MAX_SEND_INTERVAL_MS / 1000}` })],
              [t("autoBewerb.smartSendingRecommended"), t("autoBewerb.smartSendingSeconds", { n: String(MIN_SEND_INTERVAL_MS / 1000) })],
              [t("autoBewerb.smartSendingAllowedMin"), t("autoBewerb.smartSendingSeconds", { n: String(HARD_MIN_SEND_INTERVAL_MS / 1000) })],
            ] as Array<[string, string]>
          ).map(([label, value]) => (
            <div key={label} className="rounded-2xl border border-line bg-surface-2/50 px-4 py-3">
              <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-faint">{label}</p>
              <p className="mt-1 text-sm font-bold text-ink">{value}</p>
            </div>
          ))}
        </div>
        <p className="mt-3 text-xs leading-5 text-faint">{t("autoBewerb.smartSendingFootnote")}</p>
        <p className="mt-1.5 text-xs leading-5 text-faint">{t("autoBewerb.smartSendingInterBatch")}</p>
      </SectionCard>

      {/* F. Capacity + sending statistics — always derived from PERSISTED
          server counters (never client state, never demo numbers) */}
      <SectionCard title={t("autoBewerb.statsTitle")}>
        {ws.companies.length === 0 && (ws.sendHistory?.length ?? 0) > 0 && (
          <p className="mb-3 text-xs leading-5 text-muted">{t("autoBewerb.sentAutoRemovedNote")}</p>
        )}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <StatTile
            label={t("autoBewerb.statsReserved")}
            value={`${cap.reserved} / ${cap.capacity}`}
            hint={t("autoBewerb.capacityAvailable", { count: Math.max(0, cap.available) })}
          />
          <StatTile label={t("autoBewerb.statsSentToday")} value={ws.sendStats.sentToday} />
          <StatTile label={t("autoBewerb.statsScheduled")} value={ws.sendStats.scheduled} />
          <StatTile label={t("autoBewerb.statsProcessing")} value={ws.sendStats.processing} />
          <StatTile label={t("autoBewerb.statsFailed")} value={ws.sendStats.failed} />
          <StatTile label={t("autoBewerb.statsTotalToday")} value={ws.sendStats.totalToday} />
        </div>
      </SectionCard>

      {/* G. Sending history — the preserved audit records of companies that
          auto-left the active list (sent / safely cancelled). Nothing is ever
          cascade-deleted: name, recipient, position, result, timestamp,
          sending account and batch id stay accessible here. */}
      <SectionCard title={t("autoBewerb.historyTitle")}>
        {(ws.sendHistory?.length ?? 0) === 0 ? (
          <p className="text-sm text-muted">{t("autoBewerb.historyEmpty")}</p>
        ) : (
          <ul className="divide-y divide-line">
            {(ws.sendHistory ?? []).map((h) => (
              <li key={h.companyId} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5 text-xs">
                <StatusPill
                  tone={h.status === "sent" ? "success" : "skipped"}
                  label={h.status === "sent" ? t("autoBewerb.historyStatusSent") : t("autoBewerb.historyStatusCancelled")}
                />
                <span className="font-bold text-ink">{h.company}</span>
                {h.position && <span className="text-muted">{h.position}</span>}
                {h.recipient && (
                  <span className="text-muted">
                    {t("autoBewerb.recipientLabel")}: {h.recipient}
                  </span>
                )}
                <span className="text-faint">
                  {h.sentAt
                    ? h.status === "sent"
                      ? t("autoBewerb.historySentAt", { time: fmtTime(h.sentAt) })
                      : t("autoBewerb.historyCancelledAt", { time: fmtTime(h.sentAt) })
                    : h.status === "sent"
                      ? t("autoBewerb.historySentAt", { time: "—" })
                      : t("autoBewerb.historyCancelledAt", { time: "—" })}
                </span>
                {h.accountEmail && (
                  <span className="text-faint">
                    {t("autoBewerb.historyAccount")}: {h.accountEmail}
                  </span>
                )}
                {h.batchId && (
                  <span className="font-mono text-[10px] text-faint">
                    {t("autoBewerb.historyBatch")} {h.batchId.slice(0, 8)}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      {/* Explicit confirmation — the EXACT shared e-mail configuration +
          the verified delivery destination for EVERY recipient */}
      <Modal open={confirmOpen} onClose={() => !sending && setConfirmOpen(false)} title={t("autoBewerb.confirmTitle")}>
        <p className="text-sm leading-6 text-muted">{t("autoBewerb.confirmIntro")}</p>
        <p className="mt-2 text-xs text-muted">{t("autoBewerb.confirmBodySharedNote")}</p>

        {/* The ONE shared e-mail (identical for every recipient) */}
        {selectedViews.length > 0 && (
          <div className="mt-3 rounded-2xl border border-accent/30 bg-accent-soft/20 p-3 text-xs">
            <p className="font-bold text-ink">{t("autoBewerb.globalPreviewTitle")}</p>
            <p className="mt-1 text-ink-soft">
              {t("autoBewerb.previewSubject")}: <b>{emailCfg(selectedViews[0]).subject || "—"}</b>
            </p>
            <p className="text-ink-soft">
              {t("autoBewerb.previewAccount")}: <b>{emailCfg(selectedViews[0]).account?.email ?? t("autoBewerb.missingAccount")}</b>
            </p>
            <p className="mt-1 flex items-center gap-1 text-muted">
              <Paperclip size={11} />
              {[emailCfg(selectedViews[0]).attachCv ? t("autoBewerb.attachCvPdf") : null, emailCfg(selectedViews[0]).attachLetter ? t("autoBewerb.attachLetterPdf") : null]
                .filter(Boolean)
                .join(", ") || t("autoBewerb.noAttachments")}
              {ws.attachments.length > 0 && ` · ${t("autoBewerb.attachSharedDocs")} ${ws.attachments.map((a) => a.display_name).join(", ")}`}
            </p>
            <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap rounded-lg bg-surface p-2 text-[11px] leading-4 text-ink-soft">
              {(() => {
                const body = emailCfg(selectedViews[0]).body;
                return body ? `${body.slice(0, 400)}${body.length > 400 ? "…" : ""}` : t("autoBewerb.templateEmptyNote");
              })()}
            </pre>
            <p className="mt-1.5 text-faint">{t("autoBewerb.previewCount", { count: selectedViews.length })}</p>
          </div>
        )}

        {/* Per-company breakdown (verified, read-only): each company's own
            recipient + its OWN CV/letter filenames, plus the shared subject/docs. */}
        <div className="mt-3 max-h-64 space-y-2 overflow-auto">
          {selectedViews.map((v) => {
            const { name, job } = companyLabel(v.company);
            const cfg = emailCfg(v);
            return (
              <div key={v.company.id} className="rounded-2xl border border-line bg-surface-2/40 p-3 text-xs">
                <p className="font-bold text-ink">
                  {name} {job ? `— ${job}` : ""}
                </p>
                <p className="mt-1 text-ink-soft">
                  {t("autoBewerb.recipientLabel")}: <b>{cfg.dest || t("autoBewerb.deliveryNoDest")}</b>
                </p>
                <p className="text-ink-soft">
                  {t("autoBewerb.subjectLabel")}: <b>{cfg.subject || t("autoBewerb.unavailable")}</b>
                </p>
                {/* This company's OWN application documents (exact filenames). */}
                <p className="mt-0.5 flex items-center gap-1 text-muted">
                  <Paperclip size={11} />
                  {[cfg.attachCv && v.cv ? v.cvPdfName : null, cfg.attachLetter && v.letter ? v.letterPdfName : null]
                    .filter(Boolean)
                    .join(", ") || t("autoBewerb.noAttachments")}
                </p>
                {ws.attachments.length > 0 && (
                  <p className="text-muted">
                    <span className="text-faint">{t("autoBewerb.attachSharedDocs")} </span>
                    {ws.attachments.map((a) => a.display_name).join(", ")}
                  </p>
                )}
              </div>
            );
          })}
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setConfirmOpen(false)} disabled={sending}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" onClick={() => void doSend()} disabled={sending}>
            <Send size={14} />
            {sending ? t("autoBewerb.sendingNote") : t("autoBewerb.confirmSendButton", { count: selectedViews.length })}
          </Button>
        </div>
      </Modal>
    </div>
  );
}
