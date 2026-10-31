"use client";

import { useState } from "react";
import Link from "next/link";
import { CalendarClock, CheckCircle2, Paperclip, Send, XCircle } from "lucide-react";
import { Button, Modal } from "@/components/ui";
import { EmptyState } from "@/components/ui/feedback";
import { ScheduleForm } from "@/components/schedule-form";
import { useI18n } from "@/lib/i18n";
import { isValidEmail, resolveAutoBewerbRecipient, type AutoBewerbCompanyView } from "@/lib/auto-bewerb/schema";
import {
  approveCompanyAction,
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
 *  - the ONE global e-mail configuration (Step 6) is the exact content for
 *    EVERY selected company — the client passes only company ids;
 *  - a send only happens after a confirmation modal that lists the EXACT
 *    shared subject/body/account/attachments + the per-company delivery
 *    destination (each company's verified address);
 *  - statuses are honest: "sent" only when the provider confirmed, "queued"
 *    when dispatched to the scheduler, failures stay per-company (isolation);
 *  - scheduling reuses the existing cron pipeline (the tick endpoint) and
 *    resolves the SAME global configuration at schedule time.
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
  const [approvingId, setApprovingId] = useState<string | null>(null);

  const s = ws.emailSettings; // null = legacy database (per-company rows)
  const globalComplete = Boolean(s && s.body.trim() && s.subject.trim() && s.accountId);

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

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectedViews = ws.companies.filter((c) => selected.has(c.company.id) && sendable(c));

  const doSend = async () => {
    setSending(true);
    setConfirmOpen(false);
    // ONLY company ids + the explicit confirmation — every e-mail setting is
    // resolved server-side from the ONE global configuration (no override).
    const inputs = selectedViews.map((v) => ({ companyId: v.company.id, confirmed: true }));
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

  if (ws.companies.length === 0) {
    return <EmptyState title={t("autoBewerb.reviewEmpty")} body={t("autoBewerb.reviewEmptyBody")} illustration={<Send size={34} strokeWidth={1.6} />} ctaIcon={<Button variant="primary" onClick={() => goToStep(2)}>{t("autoBewerb.goToCompanies")}</Button>} />;
  }

  const resultFor = (id: string) => results?.find((r) => r.companyId === id) ?? null;

  /** Honest, ACTIONABLE per-company result text (an approval failure names
   *  the exact fix instead of a bare code). */
  const resultText = (r: SendCompanyResult): string => {
    if (r.ok) {
      if (r.dispatchStatus === "sent") return t("autoBewerb.resultSent");
      if (r.dispatchStatus === "queued") return t("autoBewerb.resultQueued");
      if (r.dispatchStatus === "duplicate") return t("autoBewerb.resultDuplicate");
      if (r.scheduledAt) return t("autoBewerb.resultScheduled", { time: new Date(r.scheduledAt).toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" }) });
      return t("autoBewerb.resultSent");
    }
    const code = r.failureCode ?? r.code ?? "";
    if (code === "already_sent") return t("autoBewerb.alreadySentNote");
    if (code === "not_approved") return t("autoBewerb.notApprovedResult");
    if (code === "no_email_account") return t("autoBewerb.emailAccountNoneBody");
    return t("autoBewerb.resultFailed", { code });
  };

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
              const text = resultText(r);
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
            const cfg = emailCfg(v);
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
                    {r.approved && (
                      <span className="rounded-full border border-success/30 bg-success-soft/50 px-2 py-0.5 text-[10px] font-bold text-success">
                        {t("autoBewerb.approvedChip")}
                      </span>
                    )}
                    {res && (
                      <span className={`text-xs font-semibold ${res.ok ? "text-success" : "text-danger"}`}>
                        {res.ok ? (res.dispatchStatus === "queued" || res.scheduledAt ? t("autoBewerb.resultQueued") : t("autoBewerb.resultSent")) : resultText(res)}
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
                {r.status === "scheduled" && v.latestAttempt && (
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
