"use client";

import { useState } from "react";
import Link from "next/link";
import { CalendarClock, Paperclip, Send, XCircle } from "lucide-react";
import { Button, Modal } from "@/components/ui";
import { EmptyState } from "@/components/ui/feedback";
import { ScheduleForm } from "@/components/schedule-form";
import { useI18n } from "@/lib/i18n";
import { isValidEmail, type AutoBewerbCompanyView } from "@/lib/auto-bewerb/schema";
import {
  cancelSendAction,
  scheduleCompaniesAction,
  sendCompaniesAction,
  type SendCompanyResult,
} from "@/app/auto-bewerb/actions";
import { Note, SectionCard, companyLabel, statusPill, useAutoBewerb } from "./shared";

/**
 * Step 7 — final review, explicit confirmation, send / schedule.
 *
 * Safety contract (mirrors the engine):
 *  - a send only happens after a confirmation modal that lists the EXACT
 *    recipients + attachments per company;
 *  - statuses are honest: "sent" only when the provider confirmed, "queued"
 *    when dispatched to the scheduler, failures stay per-company (isolation);
 *  - scheduling reuses the existing cron pipeline (the tick endpoint).
 */
export function Step7Review() {
  const { ws, refresh, notify, goToStep } = useAutoBewerb();
  const { t, lang } = useI18n();
  const locale = { de: "de-DE", en: "en-GB", fr: "fr-FR", ar: "ar-EG" }[lang] ?? "de-DE";
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [scheduling, setScheduling] = useState(false);
  const [results, setResults] = useState<SendCompanyResult[] | null>(null);

  const sendable = (v: AutoBewerbCompanyView): boolean => {
    const r = v.company;
    return (
      (r.status === "draft" || r.status === "ready" || r.status === "failed" || r.status === "cancelled") &&
      Boolean(r.recipient_email) &&
      isValidEmail(r.recipient_email ?? "") &&
      Boolean(r.email_subject) &&
      Boolean(v.cv) &&
      Boolean(v.letter) &&
      Boolean(r.email_account_id)
    );
  };

  const missing = (v: AutoBewerbCompanyView): string[] => {
    const r = v.company;
    const out: string[] = [];
    if (!r.recipient_email) out.push(t("autoBewerb.missingRecipient"));
    else if (!isValidEmail(r.recipient_email)) out.push(t("autoBewerb.invalidRecipient"));
    if (!r.email_subject) out.push(t("autoBewerb.missingSubject"));
    if (r.email_attach_cv && !v.cv) out.push(t("autoBewerb.missingCv"));
    if (r.email_attach_letter && !v.letter) out.push(t("autoBewerb.missingLetter"));
    if (!r.email_account_id) out.push(t("autoBewerb.missingAccount"));
    return out;
  };

  const toggle = (id: string) => {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectedViews = ws.companies.filter((c) => selected.has(c.company.id) && sendable(c));

  const doSend = async () => {
    setSending(true);
    setConfirmOpen(false);
    const inputs = selectedViews.map((v) => ({
      companyId: v.company.id,
      recipientEmail: v.company.recipient_email!,
      emailAccountId: v.company.email_account_id!,
      subject: v.company.email_subject!,
      bodyOverride: v.company.email_body,
      attachCv: v.company.email_attach_cv,
      attachLetter: v.company.email_attach_letter,
      confirmed: true,
    }));
    const res = await sendCompaniesAction(inputs);
    setSending(false);
    if (res.ok) {
      setResults(res.value);
      await refresh();
    } else {
      notify("error", t("autoBewerb.saveError"));
    }
  };

  const onSchedule = (formData: FormData) => {
    setScheduling(true);
    void scheduleCompaniesAction(Array.from(selected), formData).then((res) => {
      setScheduling(false);
      if (res.ok) {
        setResults(res.value);
        void refresh();
      } else {
        notify("error", t("autoBewerb.saveError"));
      }
    });
  };

  const cancelScheduled = async (attemptId: string) => {
    const res = await cancelSendAction(attemptId);
    if (res.ok) {
      await refresh();
      notify("success", t("autoBewerb.cancelledNote"));
    } else notify("error", t("autoBewerb.saveError"));
  };

  if (ws.companies.length === 0) {
    return <EmptyState title={t("autoBewerb.reviewEmpty")} body={t("autoBewerb.reviewEmptyBody")} illustration={<Send size={34} strokeWidth={1.6} />} ctaIcon={<Button variant="primary" onClick={() => goToStep(2)}>{t("autoBewerb.goToCompanies")}</Button>} />;
  }

  const resultFor = (id: string) => results?.find((r) => r.companyId === id) ?? null;

  return (
    <div className="space-y-5">
      <Note kind="info">{t("autoBewerb.draftNote")}</Note>

      {ws.emailAccounts.length === 0 && (
        <Note kind="error">
          {t("autoBewerb.emailAccountNoneBody")}{" "}
          <Link href="/settings/email" className="font-semibold text-accent underline underline-offset-2">
            {t("autoBewerb.emailAccountNoneCta")}
          </Link>
        </Note>
      )}

      {/* Results (honest, per company) */}
      {results && (
        <SectionCard title={t("autoBewerb.resultsTitle")}>
          <ul className="space-y-2">
            {results.map((r) => {
              const v = ws.companies.find((c) => c.company.id === r.companyId);
              const label = v ? companyLabel(v.company).name : r.companyId;
              const tone = r.ok ? "success" : "error";
              const text = r.ok
                ? r.dispatchStatus === "sent"
                  ? t("autoBewerb.resultSent")
                  : r.dispatchStatus === "queued"
                    ? t("autoBewerb.resultQueued")
                    : r.dispatchStatus === "duplicate"
                      ? t("autoBewerb.resultDuplicate")
                      : r.scheduledAt
                        ? t("autoBewerb.resultScheduled", { time: new Date(r.scheduledAt).toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" }) })
                        : t("autoBewerb.resultSent")
                : r.code === "already_sent"
                  ? t("autoBewerb.alreadySentNote")
                  : r.code === "no_email_account"
                    ? t("autoBewerb.emailAccountNoneBody")
                    : t("autoBewerb.resultFailed", { code: r.failureCode ?? r.code ?? "?" });
              return (
                <li key={r.companyId} className={`rounded-2xl border px-4 py-3 text-sm ${tone === "success" ? "border-success/25 bg-success-soft/50 text-success" : "border-danger/25 bg-danger-soft/50 text-danger"}`}>
                  <span className="font-bold">{label}:</span> {text}
                </li>
              );
            })}
          </ul>
        </SectionCard>
      )}

      {/* Review table */}
      <SectionCard
        title={t("autoBewerb.reviewHeading")}
        aside={
          selectedViews.length > 0 && (
            <div className="flex flex-wrap gap-2">
              <Button variant="primary" size="sm" onClick={() => setConfirmOpen(true)} disabled={sending}>
                <Send size={14} />
                {sending ? t("autoBewerb.sendingNote") : t("autoBewerb.sendNowButton", { count: selectedViews.length })}
              </Button>
              <Button variant="secondary" size="sm" onClick={() => document.getElementById("schedule-form")?.scrollIntoView({ behavior: "smooth" })} disabled={scheduling}>
                <CalendarClock size={14} />
                {t("autoBewerb.scheduleButton", { count: selectedViews.length })}
              </Button>
            </div>
          )
        }
      >
        <ul className="divide-y divide-line">
          {ws.companies.map((v) => {
            const r = v.company;
            const { name, job } = companyLabel(v.company);
            const canSelect = sendable(v);
            const gaps = missing(v);
            const res = resultFor(r.id);
            return (
              <li key={r.id} className="flex flex-wrap items-start gap-3 py-4">
                <input
                  type="checkbox"
                  aria-label={name}
                  checked={selected.has(r.id)}
                  disabled={!canSelect}
                  onChange={() => toggle(r.id)}
                  className="mt-1 h-4 w-4 accent-[var(--color-accent)]"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-sm font-bold text-ink">{name}</span>
                    {job && <span className="truncate text-xs text-muted">{job}</span>}
                    {statusPill(r.status, t)}
                    {res && (
                      <span className={`text-xs font-semibold ${res.ok ? "text-success" : "text-danger"}`}>
                        {res.ok
                          ? res.dispatchStatus === "queued" || res.scheduledAt
                            ? t("autoBewerb.resultQueued")
                            : t("autoBewerb.resultSent")
                          : t("autoBewerb.resultFailed", { code: res.failureCode ?? res.code ?? "?" })}
                      </span>
                    )}
                  </div>
                  <dl className="mt-1.5 grid gap-x-4 gap-y-0.5 text-xs text-muted sm:grid-cols-2">
                    <div>
                      <dt className="inline text-faint">{t("autoBewerb.recipientLabel")}: </dt>
                      <dd className={`inline font-medium ${r.recipient_email && isValidEmail(r.recipient_email) ? "text-ink-soft" : "text-warning"}`}>
                        {r.recipient_email || t("autoBewerb.unavailable")}
                      </dd>
                    </div>
                    <div>
                      <dt className="inline text-faint">{t("autoBewerb.subjectLabel")}: </dt>
                      <dd className={`inline font-medium ${r.email_subject ? "text-ink-soft" : "text-warning"}`}>{r.email_subject || t("autoBewerb.unavailable")}</dd>
                    </div>
                    <div className="flex items-center gap-1 sm:col-span-2">
                      <Paperclip size={12} />
                      <span className="font-medium text-ink-soft">
                        {[
                          v.company.email_attach_cv ? t("autoBewerb.attachCvPdf") : null,
                          v.company.email_attach_letter ? t("autoBewerb.attachLetterPdf") : null,
                        ]
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
                      {gaps.join(" · ")} —{" "}
                      <button type="button" className="font-semibold underline underline-offset-2" onClick={() => goToStep(6)}>
                        {t("autoBewerb.fixInStep6")}
                      </button>
                    </p>
                  )}
                  {r.scheduled_at && (
                    <p className="mt-1 text-xs text-ink-soft">
                      {t("autoBewerb.scheduledAtLabel")}: {new Date(r.scheduled_at).toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" })}
                    </p>
                  )}
                </div>
                {r.status === "scheduled" && v.latestAttempt && (
                  <Button variant="ghost" size="sm" onClick={() => void cancelScheduled(v.latestAttempt!.id)}>
                    <XCircle size={14} />
                    {t("autoBewerb.cancelSchedule")}
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
        {selectedViews.length === 0 && <p className="mt-3 text-xs text-muted">{t("autoBewerb.noneSelectable")}</p>}
      </SectionCard>

      {/* Schedule (existing cron pipeline) */}
      {selectedViews.length > 0 && (
        <div id="schedule-form">
          <SectionCard title={t("autoBewerb.scheduleTitle")}>
            <ScheduleForm
              action={onSchedule}
              submitLabel={scheduling ? t("autoBewerb.scheduling") : t("autoBewerb.scheduleSubmit", { count: selectedViews.length })}
              pendingLabel={t("autoBewerb.scheduling")}
            />
          </SectionCard>
        </div>
      )}

      {/* Explicit confirmation — exact recipients + attachments */}
      <Modal open={confirmOpen} onClose={() => !sending && setConfirmOpen(false)} title={t("autoBewerb.confirmTitle")}>
        <p className="text-sm leading-6 text-muted">{t("autoBewerb.confirmIntro")}</p>
        <div className="mt-3 max-h-64 space-y-2 overflow-auto">
          {selectedViews.map((v) => {
            const { name, job } = companyLabel(v.company);
            return (
              <div key={v.company.id} className="rounded-2xl border border-line bg-surface-2/40 p-3 text-xs">
                <p className="font-bold text-ink">
                  {name} {job ? `— ${job}` : ""}
                </p>
                <p className="mt-1 text-ink-soft">
                  {t("autoBewerb.recipientLabel")}: <b>{v.company.recipient_email}</b>
                </p>
                <p className="text-ink-soft">
                  {t("autoBewerb.subjectLabel")}: <b>{v.company.email_subject}</b>
                </p>
                <p className="mt-1 flex items-center gap-1 text-muted">
                  <Paperclip size={11} />
                  {[
                    v.company.email_attach_cv ? t("autoBewerb.attachCvPdf") : null,
                    v.company.email_attach_letter ? t("autoBewerb.attachLetterPdf") : null,
                  ]
                    .filter(Boolean)
                    .join(", ") || t("autoBewerb.noAttachments")}
                </p>
                {ws.attachments.length > 0 && (
                  <p className="text-muted">
                    {t("autoBewerb.attachSharedDocs")} {ws.attachments.map((a) => a.display_name).join(", ")}
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
