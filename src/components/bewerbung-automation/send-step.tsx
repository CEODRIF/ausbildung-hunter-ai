"use client";

/**
 * Step 5 — explicit confirmation + safe send + live progress.
 *
 * Delivery happens ONLY here and ONLY after the user confirms the final
 * dialog (recipient count, sending mailbox, attachments policy). The server
 * then re-verifies identity, ownership, sender health, content, and quota
 * before queueing anything (startBewSend). While the campaign drains, the
 * view is polled (client.tsx) and the actual per-message outcome is shown —
 * a message is "sent" only because the provider answered success.
 */
import { memo, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  bewRescheduleSend,
  bewStartSend,
} from "@/app/bewerbung-automation/actions";
import { useI18n } from "@/lib/i18n";
import { localeForLang } from "@/lib/i18n/core";
import { computeSendPlan, isBewEmailComplete } from "@/lib/bewerbung-automation";
import {
  formatScheduledLocal,
  offsetLabelAt,
  utcToLocalParts,
} from "@/lib/schedule-time";
import { Button, Card } from "@/components/ui";
import { Icon } from "@/components/icon";
import { StatusPill } from "@/components/ui/feedback";
import { ScheduleForm, type ScheduleDefaults } from "@/components/schedule-form";
import {
  appSendFlags,
  hasRequiredDocuments,
  resolveBewError,
  type BewViewDTO,
} from "./types";

interface Props {
  view: BewViewDTO;
  refresh: () => Promise<unknown>;
  /** Pump: fresh persisted view + one bounded drain of THIS campaign's due
   *  queue (the same atomic claim core the cron uses). Resolves true when a
   *  fresh view was received, false when the campaign is gone/not owned. */
  pump: () => Promise<boolean>;
  selectedIds: Set<string>;
  onCancelSend: () => void;
  sending: boolean;
}

export const SendStep = memo(function SendStep({ view, refresh, pump, selectedIds, onCancelSend, sending }: Props) {
  const { t, lang } = useI18n();
  const router = useRouter();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Refresh button (scheduled card): loading state + inline notice/error,
  // same notification pattern as the e-mail step (localized, no reload).
  const [refreshing, setRefreshing] = useState(false);
  const [refreshNotice, setRefreshNotice] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  // Scheduled send (reuses the existing scheduler): the date/time/timezone
  // picker + the reschedule dialog are mutually exclusive with the immediate
  // confirm dialog. `scheduleError` shows a failed schedule/reschedule result.
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [rescheduleOpen, setRescheduleOpen] = useState(false);
  const [scheduleError, setScheduleError] = useState<string | null>(null);

  const docs = hasRequiredDocuments(view.documents);
  const certCount = view.documents.filter(
    (d) => d.kind === "certificate" || d.kind === "supporting",
  ).length;
  /* The campaign e-mail message (subject + body) must be complete — the
     server re-enforces this in startBewSend (EMAIL_INCOMPLETE). */
  const emailComplete = isBewEmailComplete(
    view.campaign.email_subject,
    view.campaign.email_body_html,
  );

  const eligibleSelected = useMemo(
    () =>
      view.applications.filter(
        (a) =>
          selectedIds.has(a.id) &&
          appSendFlags(a).length === 0 &&
          docs.cv &&
          docs.certs,
      ),
    [view.applications, selectedIds, docs.cv, docs.certs],
  );
  const n = eligibleSelected.length;

  // null = the quota read failed — no plan preview is computed (never a
  // fabricated 0; the confirm sheet shows an honest unknown state).
  const plan = useMemo(
    () =>
      view.usage.remaining === null
        ? null
        : computeSendPlan({
            requested: n,
            remaining: view.usage.remaining,
          }),
    [n, view.usage.remaining],
  );

  async function confirmAndSend() {
    setBusy(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.set("campaignId", view.campaign.id);
      fd.set("selectedSeqs", JSON.stringify(eligibleSelected.map((a) => a.seq)));
      const result = await bewStartSend(fd);
      setConfirmOpen(false);
      if (!result.ok) {
        // A resolved result error (stable code, e.g. NO_SENDER /
        // NOTHING_TO_SEND) is not a throw — map it like one.
        setError(codeMessage(result.error, t));
      }
      await refresh();
    } catch (e) {
      const msg = resolveBewError(e, t, (p) => router.replace(p));
      if (msg !== null) setError(msg);
    } finally {
      setBusy(false);
    }
  }

  // Scheduled-send display values (all derived from the persisted row; the
  // browser clock never decides "due" — only the claim predicate does).
  const locale = localeForLang(lang);
  const scheduledIso = view.campaign.scheduled_at ?? null;
  const scheduledZone = view.campaign.timezone ?? null;
  const hasSchedule = Boolean(scheduledIso);
  // Pending vs. in-flight — decided by SERVER data only (no browser clock in
  // render): a scheduled batch is "pending" while the claim predicate has not
  // yet run, which is exactly when campaign.started_at is still NULL. The
  // first claim (at/after the due instant) coalesces started_at, so the view
  // flips to the ordinary live-progress panel on the next 3s poll. The claim
  // predicate — not this flag — remains the only authority for when anything
  // is sent.
  const scheduledPending = hasSchedule && view.campaign.started_at === null;
  // Prefill the reschedule picker with the CURRENT scheduled instant.
  const rescheduleDefaults: ScheduleDefaults | undefined = useMemo(() => {
    if (!scheduledIso || !scheduledZone) return undefined;
    const parts = utcToLocalParts(scheduledIso, scheduledZone);
    return parts ? { ...parts, timeZone: scheduledZone } : undefined;
  }, [scheduledIso, scheduledZone]);

  const eligibleSeqs = eligibleSelected.map((a) => a.seq);

  // Funnel the reused server actions (immediate + scheduled + reschedule)
  // through one wrapper: report the result, close the dialog on success, and
  // refresh the view. A thrown server-action error becomes a localized message.
  async function runScheduling(
    fd: FormData,
    fn: (fd: FormData) => Promise<unknown>,
    closeOnSuccess: () => void,
  ) {
    setScheduleError(null);
    try {
      const result = (await fn(fd)) as { ok?: boolean; error?: string } | null;
      if (result && !result.ok) setScheduleError(codeMessage(result.error, t));
      else closeOnSuccess();
    } catch (e) {
      const msg = resolveBewError(e, t, (p) => router.replace(p));
      if (msg !== null) setScheduleError(msg);
    } finally {
      await refresh();
    }
  }
  const scheduleAction = (fd: FormData) =>
    runScheduling(fd, (f) => bewStartSend(f), () => setScheduleOpen(false));
  const rescheduleAction = (fd: FormData) =>
    runScheduling(fd, (f) => bewRescheduleSend(f), () => setRescheduleOpen(false));

  /** Refresh button: fetch the latest persisted status (and let the server
   *  continue this campaign's queue if it is now due — bounded, idempotent,
   *  nothing before the due instant). Loading state disables the button so
   *  a slow drain can't stack concurrent requests. No page reload: the
   *  fresh view re-renders every status field in place (status, queued /
   *  sent / failed counts, and the schedule if it changed). */
  async function refreshStatus() {
    if (refreshing) return;
    setRefreshing(true);
    setRefreshNotice(null);
    setRefreshError(null);
    try {
      const ok = await pump();
      if (ok) setRefreshNotice(t("bewauto.refreshed"));
      else setRefreshError(t("bewauto.refreshFailed"));
    } catch (e) {
      const msg = resolveBewError(e, t, (p) => router.replace(p));
      if (msg !== null) setRefreshError(msg);
    } finally {
      setRefreshing(false);
    }
  }

  const c = view.campaign;
  const queued = view.applications.filter((a) => a.status === "queued").length;
  const inSending = view.applications.filter((a) => a.status === "sending").length;
  const sent = c.sent_count;
  const failed = view.applications.filter((a) => a.status === "failed").length;
  const attention = view.applications.filter((a) => a.status === "needs_attention").length;

  return (
    <Card className="p-5">
      <div className="mb-5">
        <h2 className="text-lg font-bold text-ink">{t("bewauto.step5Title")}</h2>
        <p className="mt-1 max-w-2xl text-sm leading-6 text-muted">{t("bewauto.step5Body")}</p>
      </div>

      {/* Pre-send blocker messages */}
      {error && <p role="alert" className="mb-4 text-sm font-medium text-danger">{error}</p>}
      {!view.senderEmail && (
        <div role="alert" className="mb-4 flex items-start gap-2.5 rounded-2xl border border-danger/30 bg-danger-soft px-4 py-3 text-sm text-danger">
          <Icon name="alert" size={16} className="mt-0.5 shrink-0" />
          <span>{t("bewauto.noSender")}</span>
        </div>
      )}
      {view.senderEmail && !docs.cv && (
        <p role="alert" className="mb-4 text-sm font-medium text-danger">{t("bewauto.flagMissingCv")}</p>
      )}
      {view.senderEmail && docs.cv && !docs.certs && (
        <p role="alert" className="mb-4 text-sm font-medium text-danger">{t("bewauto.flagMissingCerts")}</p>
      )}
      {view.senderEmail && !emailComplete && (
        <div role="alert" className="mb-4 flex items-start gap-2.5 rounded-2xl border border-danger/30 bg-danger-soft px-4 py-3 text-sm text-danger">
          <Icon name="alert" size={16} className="mt-0.5 shrink-0" />
          <span>{t("bewauto.flagEmailIncomplete")}</span>
        </div>
      )}

       {/* Scheduled batch that is still PENDING (not yet due): show the exact
           instant + timezone, the eligible count, and Cancel / Reschedule.
           The refresh icon re-reads the persisted status (and lets the
           server continue the queue once it is due) without a page reload. */}
       {sending && scheduledPending && scheduledIso && scheduledZone && (
         <div className="mb-6 rounded-2xl border border-accent/30 bg-accent-soft/40 p-4" role="status">
           <div className="mb-2 flex items-center justify-between gap-3">
             <p className="text-sm font-semibold text-ink-soft">{t("bewauto.scheduledTitle")}</p>
             <button
               type="button"
               onClick={() => void refreshStatus()}
               disabled={refreshing}
               aria-label={t("bewauto.refreshStatus")}
               title={t("bewauto.refreshStatus")}
               className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border border-line-strong bg-surface text-ink-soft transition hover:border-faint hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
             >
               <Icon name="refresh" size={14} className={refreshing ? "animate-spin" : undefined} />
             </button>
           </div>
           <p className="text-sm font-medium text-ink">
             {t("bewauto.scheduledFor", {
               when: formatScheduledLocal(scheduledIso, scheduledZone, locale),
               tz: scheduledZone,
               offset: offsetLabelAt(scheduledIso, scheduledZone),
             })}
           </p>
           {refreshError && (
             <p role="alert" className="mt-2 text-xs font-medium text-danger">{refreshError}</p>
           )}
           {refreshNotice && !refreshError && (
             <p className="mt-2 text-xs font-medium text-success">{refreshNotice}</p>
           )}
           <p className="mt-2 text-xs leading-5 text-muted">{t("bewauto.scheduledHint")}</p>
           <div className="mt-3">
             <StatusPill tone="neutral" label={t("bewauto.stQueuedCount", { n: queued })} />
           </div>
          <div className="mt-4 flex flex-wrap gap-3">
            <Button variant="ghost" size="sm" disabled={busy} className="text-danger hover:text-danger" onClick={onCancelSend}>
              <Icon name="stop" size={14} />
              {t("bewauto.cancelSend")}
            </Button>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => setRescheduleOpen(true)}>
              <Icon name="clock" size={14} />
              {t("bewauto.reschedule")}
            </Button>
          </div>
        </div>
      )}
      {/* Live progress while draining (immediate send, or a schedule now due) */}
      {sending && !scheduledPending && (
        <div className="mb-6 rounded-2xl border border-line bg-surface-2/40 p-4" role="status">
          <p className="mb-3 text-sm font-semibold text-ink-soft">{t("bewauto.progressTitle")}</p>
          <div className="flex flex-wrap gap-2">
            <StatusPill tone="success" label={t("bewauto.stSentCount", { n: sent })} />
            <StatusPill tone="running" label={t("bewauto.stSendingCount", { n: inSending })} />
            <StatusPill tone="neutral" label={t("bewauto.stQueuedCount", { n: queued })} />
            <StatusPill tone="blocked" label={t("bewauto.stFailedCount", { n: failed })} />
            <StatusPill tone="unverified" label={t("bewauto.stAttentionCount", { n: attention })} />
          </div>
          {(queued > 0 || inSending > 0) && (
            <div className="mt-4">
              <Button variant="ghost" size="sm" disabled={busy} className="text-danger hover:text-danger" onClick={onCancelSend}>
                <Icon name="stop" size={14} />
                {t("bewauto.cancelSend")}
              </Button>
            </div>
          )}
        </div>
      )}

      {/* Final outcome */}
      {!sending && (sent + failed + attention > 0) && (
        <div className="mb-6 rounded-2xl border border-line bg-surface-2/40 p-4">
          <p className="text-sm font-semibold text-ink-soft">{t("bewauto.resultTitle")}</p>
          <p className="mt-2 text-sm text-ink-soft">
            {t("bewauto.sentSummary", { sent, failed, attention })}
          </p>
          {attention > 0 && (
            <p className="mt-2 text-xs leading-5 text-muted">{t("bewauto.attentionNote")}</p>
          )}
        </div>
      )}

      {/* The explicit send trigger — a choice between immediate and scheduled */}
      {!sending && (
        <div className="flex flex-col items-start gap-3 rounded-2xl border border-accent/30 bg-accent-soft/40 p-5">
          <div className="flex w-full flex-col gap-3 sm:flex-row">
            <Button
              size="lg"
              disabled={busy || n === 0 || !view.senderEmail || !(docs.cv && docs.certs) || !emailComplete}
              onClick={() => setConfirmOpen(true)}
              className="w-full flex-1"
            >
              <Icon name="send" size={18} />
              {t("bewauto.nowSend", { n })}
            </Button>
            <Button
              size="lg"
              variant="ghost"
              disabled={busy || n === 0 || !view.senderEmail || !(docs.cv && docs.certs) || !emailComplete}
              onClick={() => setScheduleOpen(true)}
              className="w-full flex-1"
            >
              <Icon name="clock" size={18} />
              {t("bewauto.scheduledSend", { n })}
            </Button>
          </div>
          {n === 0 && (
            <p className="text-xs text-muted">{t("bewauto.nothingToSend")}</p>
          )}
          {n > 0 && !emailComplete && (
            <p className="text-xs text-muted">{t("bewauto.flagEmailIncomplete")}</p>
          )}
        </div>
      )}

      {/* Final confirmation dialog */}
      {confirmOpen && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-6"
          role="dialog"
          aria-modal="true"
          aria-label={t("bewauto.confirmTitle")}
          onClick={(e) => {
            if (e.target === e.currentTarget) setConfirmOpen(false);
          }}
        >
          <div className="w-full max-w-lg rounded-t-3xl bg-surface p-5 shadow-2xl sm:rounded-3xl">
            <h3 className="text-lg font-bold text-ink">{t("bewauto.confirmTitle")}</h3>
            <dl className="mt-4 space-y-2.5 text-sm">
              <ConfirmRow label={t("bewauto.confirmRecipients", { n })} />
              <ConfirmRow
                label={
                  view.senderEmail
                    ? t("bewauto.confirmSender", { email: view.senderEmail })
                    : t("bewauto.noSender")
                }
              />
              <ConfirmRow
                label={t("bewauto.confirmAttachments", { n: certCount + 1 })}
              />
              <ConfirmRow
                label={
                  view.usage.remaining === null ||
                  view.usage.daily_limit === null
                    ? t("bewauto.confirmQuotaUnknown")
                    : t("bewauto.confirmQuota", {
                        remaining: view.usage.remaining,
                        limit: view.usage.daily_limit,
                      })
                }
              />
            </dl>
            {plan?.overLimit && (
              <p role="alert" className="mt-4 rounded-xl border border-danger/30 bg-danger-soft px-3 py-2.5 text-xs leading-5 text-danger">
                {t("bewauto.overLimitNote", { batch: plan.batch, total: n, deferred: plan.deferred })}
              </p>
            )}
            <div className="mt-6 flex items-center justify-end gap-3">
              <Button variant="ghost" size="sm" onClick={() => setConfirmOpen(false)}>
                {t("bewauto.confirmCancel")}
              </Button>
              <Button size="sm" disabled={busy} onClick={() => void confirmAndSend()}>
                <Icon name="send" size={15} />
                {t("bewauto.confirmGo")}
              </Button>
            </div>
            {/* iPhone safe area: on phones the sheet is bottom-anchored, so
                reserve the home-indicator inset below the action row (zero
                height where the inset is 0 / at >= sm). */}
            <div aria-hidden="true" className="max-sm:h-[env(safe-area-inset-bottom)]" />
          </div>
        </div>
      )}

      {/* Schedule dialog (initial) — reuses the existing ScheduleForm picker
          (day/month/year + 24h hour/minute + IANA zone + live UTC preview +
          DST handling). The hidden inputs carry campaignId + selectedSeqs. */}
      {scheduleOpen && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-6"
          role="dialog"
          aria-modal="true"
          aria-label={t("bewauto.scheduleTitle")}
          onClick={(e) => {
            if (e.target === e.currentTarget) setScheduleOpen(false);
          }}
        >
          <div className="max-h-[92dvh] w-full max-w-lg overflow-y-auto rounded-t-3xl bg-surface p-5 shadow-2xl sm:rounded-3xl">
            <h3 className="text-lg font-bold text-ink">{t("bewauto.scheduleTitle")}</h3>
            <p className="mt-1 text-sm leading-6 text-muted">{t("bewauto.scheduleBody", { n })}</p>
            {scheduleError && (
              <p role="alert" className="mt-3 text-sm font-medium text-danger">
                {scheduleError}
              </p>
            )}
            <div className="mt-4">
              <ScheduleForm
                action={scheduleAction}
                extraHidden={[
                  { name: "campaignId", value: view.campaign.id },
                  { name: "selectedSeqs", value: JSON.stringify(eligibleSeqs) },
                ]}
                submitLabel={t("bewauto.scheduleSubmit")}
                pendingLabel={t("bewauto.schedulePending")}
                cancelLabel={t("bewauto.scheduleClose")}
                onCancel={() => setScheduleOpen(false)}
              />
            </div>
            <div aria-hidden="true" className="max-sm:h-[env(safe-area-inset-bottom)]" />
          </div>
        </div>
      )}

      {/* Reschedule dialog — same picker, prefilled with the current instant. */}
      {rescheduleOpen && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-6"
          role="dialog"
          aria-modal="true"
          aria-label={t("bewauto.rescheduleTitle")}
          onClick={(e) => {
            if (e.target === e.currentTarget) setRescheduleOpen(false);
          }}
        >
          <div className="max-h-[92dvh] w-full max-w-lg overflow-y-auto rounded-t-3xl bg-surface p-5 shadow-2xl sm:rounded-3xl">
            <h3 className="text-lg font-bold text-ink">{t("bewauto.rescheduleTitle")}</h3>
            <p className="mt-1 text-sm leading-6 text-muted">{t("bewauto.rescheduleBody")}</p>
            {scheduleError && (
              <p role="alert" className="mt-3 text-sm font-medium text-danger">
                {scheduleError}
              </p>
            )}
            <div className="mt-4">
              <ScheduleForm
                action={rescheduleAction}
                extraHidden={[{ name: "campaignId", value: view.campaign.id }]}
                defaults={rescheduleDefaults}
                submitLabel={t("bewauto.rescheduleSubmit")}
                pendingLabel={t("bewauto.schedulePending")}
                cancelLabel={t("bewauto.scheduleClose")}
                onCancel={() => setRescheduleOpen(false)}
              />
            </div>
            <div aria-hidden="true" className="max-sm:h-[env(safe-area-inset-bottom)]" />
          </div>
        </div>
      )}
    </Card>
  );
});

function ConfirmRow({ label }: { label: string }) {
  return (
    <div className="flex items-start gap-2">
      <Icon name="check" size={15} className="mt-0.5 shrink-0 text-success" />
      <dd className="text-ink-soft">{label}</dd>
    </div>
  );
}

/** A resolved `result.error` (stable code) mapped to its localized message —
 *  the same rules `resolveBewError` applies to thrown errors. */
function codeMessage(
  code: string | undefined,
  t: (k: string, v?: Record<string, string | number>) => string,
): string {
  return resolveBewError(new Error(code ?? ""), t) ?? t("bewauto.err.UNKNOWN");
}
