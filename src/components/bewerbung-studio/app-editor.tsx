"use client";

/**
 * AI Bewerbung Studio — per-application editor (one opened application).
 *
 * Mounted with `key={applicationId}` by the workspace shell, so every
 * application gets FRESH local state: switching companies can never leak
 * another company's letter, email or attachments into the open form.
 *
 * The eight step sections stay MOUNTED (hidden) while the application is
 * open — form values survive step changes and viewport resizes. Durable
 * state lives server-side (studio_* tables); this component mirrors it and
 * refreshes after every state-changing action.
 *
 * Explicit confirmations (ad / profile / cv / letter / checklist) are the
 * completion requirements the batch unlock model reads — each has a visible
 * "bestätigen" action and a visible "confirmed" state, and re-editing the
 * underlying data invalidates the confirmation server-side.
 */

import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import {
  approveApplicationAction,
  cancelSendAction,
  confirmStepAction,
  refreshApplicationAction,
  saveDocumentAction,
  sendApplicationAction,
  updateApplicationAction,
} from "@/app/bewerbung-studio/actions";
import { Icon } from "@/components/icon";
import { useI18n } from "@/lib/i18n";
import type { CandidateProfile } from "@/lib/bewerbung-schema";
import {
  type AdAnalysis,
  type AdExtract,
  type StudioApplicationRow,
  type StudioAttachmentRow,
  type StudioEmailContent,
  type StudioLetterContent,
  type StudioSendAttemptRow,
} from "@/lib/studio/schema";
import { docsChecklistCovered } from "@/lib/studio/completion";
import type { StudioConfirmField } from "@/lib/studio";
import { cvHasContent, type CvDocument } from "@/lib/templates/cv";
import { AnalysisPanel, ProfilePanel } from "./panels-input";
import { CvPanel, DocsPanel, LetterPanel } from "./panels-docs";
import { EmailPanel, QualityPanel, SendPanel } from "./panels-review";
import { BusyButton, StepIndicator, StatusBadge, type StudioStep } from "./studio-ui";
import type { ApiOutcome, StudioInitial } from "./studio-client";

export interface AppEditorBundle {
  app: StudioApplicationRow;
  documents: {
    cv: CvDocument | null;
    cover_letter: StudioLetterContent | null;
    email: StudioEmailContent | null;
  };
  attachments: StudioAttachmentRow[];
  attempts: StudioSendAttemptRow[];
}

interface AppEditorProps {
  bundle: AppEditorBundle;
  userId: string;
  userFacts: StudioInitial["userFacts"];
  emailAccounts: StudioInitial["emailAccounts"];
  profile: CandidateProfile | null;
  baseCv: CvDocument | null;
  baseCvLoaded: boolean;
  /** Transient notification (shell renders it). */
  onNotice: (msg: string | null) => void;
  /** Durable batch-level state changed (confirm/approve/send/…) → the
   *  shell refreshes the navigator from the server. */
  onBatchChanged: () => void;
}

export function AppEditor({
  bundle,
  userId,
  userFacts,
  emailAccounts,
  profile,
  baseCv,
  baseCvLoaded,
  onNotice,
  onBatchChanged,
}: AppEditorProps) {
  const { t } = useI18n();

  const [app, setApp] = useState<StudioApplicationRow>(bundle.app);
  const [extract, setExtract] = useState<AdExtract | null>(bundle.app.ad_extracted ?? null);
  const [analysis, setAnalysis] = useState<AdAnalysis | null>(bundle.app.ad_analysis ?? null);
  const [atts, setAtts] = useState<StudioAttachmentRow[]>(bundle.attachments);
  const [attempts, setAttempts] = useState<StudioSendAttemptRow[]>(bundle.attempts);
  const [cv, setCv] = useState<CvDocument | null>(bundle.documents.cv);
  const [letter, setLetter] = useState<StudioLetterContent | null>(bundle.documents.cover_letter);
  const [emailDraft, setEmailDraft] = useState<StudioEmailContent | null>(bundle.documents.email);
  const [recipient, setRecipient] = useState<string>(bundle.app.recipient_email ?? "");
  const [step, setStep] = useState<StudioStep>("analysis");
  const [adText, setAdText] = useState<string>(bundle.app.ad_raw ?? "");

  const flash = useCallback((msg: string | null) => {
    onNotice(msg);
    if (msg) window.setTimeout(() => onNotice(null), 4000);
  }, [onNotice]);

  // -----------------------------------------------------------------------
  // AI: advertisement analysis (re-analysis of the OPEN application)
  // -----------------------------------------------------------------------

  const analyzeAd = useCallback(
    async (text: string): Promise<ApiOutcome<{ extract: AdExtract; analysis: AdAnalysis }>> => {
      try {
        const res = await fetch("/api/bewerbung-studio/analyze-ad", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ adText: text, cv: baseCv }),
        });
        const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        if (!res.ok) {
          return {
            ok: false,
            code: typeof data.code === "string" ? data.code : `http_${res.status}`,
            error: typeof data.error === "string" ? data.error : t("studio.error"),
          };
        }
        return { ok: true, value: data as unknown as { extract: AdExtract; analysis: AdAnalysis } };
      } catch {
        return { ok: false, code: "network", error: t("studio.error") };
      }
    },
    [baseCv, t],
  );

  /** Persist analysis into the OPEN application. */
  const persistAnalysis = useCallback(
    async (nextExtract: AdExtract, nextAnalysis: AdAnalysis | null): Promise<boolean> => {
      const res = await updateApplicationAction(app.id, {
        extract: nextExtract,
        analysis: nextAnalysis,
      });
      if (res.ok) {
        setApp(res.value);
        setExtract(nextExtract);
        if (nextAnalysis) setAnalysis(nextAnalysis);
        onBatchChanged(); // the extraction changed → completion re-derived
        return true;
      }
      flash(res.message);
      return false;
    },
    [app.id, flash, onBatchChanged],
  );

  // -----------------------------------------------------------------------
  // Document persistence
  // -----------------------------------------------------------------------

  const saveDoc = useCallback(
    async (docType: "cv" | "cover_letter" | "email", content: unknown): Promise<boolean> => {
      const res = await saveDocumentAction(app.id, docType, content);
      if (!res.ok) {
        flash(res.message);
        return false;
      }
      flash(t("studio.saved"));
      onBatchChanged(); // a new document version invalidates its review
      return true;
    },
    [app.id, flash, t, onBatchChanged],
  );

  // -----------------------------------------------------------------------
  // Explicit step confirmations (server-owned timestamps)
  // -----------------------------------------------------------------------

  const [confirming, setConfirming] = useState<StudioConfirmField | null>(null);

  const confirmStep = useCallback(
    async (field: StudioConfirmField) => {
      setConfirming(field);
      const res = await confirmStepAction(app.id, field);
      setConfirming(null);
      if (!res.ok) {
        flash(res.message);
        return;
      }
      setApp(res.value);
      flash(t("studio.saved"));
      onBatchChanged();
    },
    [app.id, flash, t, onBatchChanged],
  );

  // -----------------------------------------------------------------------
  // Attachments
  // -----------------------------------------------------------------------

  const uploadAttachment = useCallback(
    async (file: File, category: string): Promise<ApiOutcome<StudioAttachmentRow>> => {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("applicationId", app.id);
      fd.append("category", category);
      try {
        const res = await fetch("/api/bewerbung-studio/attachments", { method: "POST", body: fd });
        const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        if (!res.ok) {
          return {
            ok: false,
            code: typeof data.code === "string" ? data.code : `http_${res.status}`,
            error: typeof data.error === "string" ? data.error : t("studio.error"),
          };
        }
        const row = data as unknown as StudioAttachmentRow;
        setAtts((prev) => [...prev, row]);
        onBatchChanged();
        return { ok: true, value: row };
      } catch {
        return { ok: false, code: "network", error: t("studio.error") };
      }
    },
    [app.id, t, onBatchChanged],
  );

  const renameAttachment = useCallback(
    async (attachmentId: string, name: string): Promise<boolean> => {
      try {
        const res = await fetch("/api/bewerbung-studio/attachments", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ attachmentId, name }),
        });
        const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        if (!res.ok) {
          flash(typeof data.error === "string" ? data.error : t("studio.error"));
          return false;
        }
        setAtts((prev) => prev.map((a) => (a.id === attachmentId ? { ...a, display_name: name } : a)));
        return true;
      } catch {
        flash(t("studio.error"));
        return false;
      }
    },
    [flash, t],
  );

  const deleteAttachment = useCallback(
    async (attachmentId: string): Promise<boolean> => {
      try {
        const res = await fetch("/api/bewerbung-studio/attachments", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ attachmentId }),
        });
        const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        if (!res.ok) {
          flash(typeof data.error === "string" ? data.error : t("studio.error"));
          return false;
        }
        setAtts((prev) => prev.filter((a) => a.id !== attachmentId));
        setEmailDraft((prev) =>
          prev ? { ...prev, attachmentIds: prev.attachmentIds.filter((id) => id !== attachmentId) } : prev,
        );
        onBatchChanged();
        return true;
      } catch {
        flash(t("studio.error"));
        return false;
      }
    },
    [flash, t, onBatchChanged],
  );

  // -----------------------------------------------------------------------
  // Quality check
  // -----------------------------------------------------------------------

  const runQuality = useCallback(
    async (withAi: boolean): Promise<ApiOutcome<{ issues: import("@/lib/studio/schema").QualityIssue[]; aiChecked: boolean }>> => {
      const scheduledMs = app.scheduled_at ? new Date(app.scheduled_at).getTime() : null;
      try {
        const res = await fetch("/api/bewerbung-studio/quality-check", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            extract,
            analysis,
            cv,
            letter,
            email: emailDraft ? { subject: emailDraft.subject, body: emailDraft.body, attachmentIds: emailDraft.attachmentIds } : null,
            recipientEmail: recipient || null,
            attachments: atts,
            scheduledAtMs: scheduledMs,
            withAi,
          }),
        });
        const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        if (!res.ok) {
          return {
            ok: false,
            code: typeof data.code === "string" ? data.code : `http_${res.status}`,
            error: typeof data.error === "string" ? data.error : t("studio.error"),
          };
        }
        return { ok: true, value: data as unknown as { issues: import("@/lib/studio/schema").QualityIssue[]; aiChecked: boolean } };
      } catch {
        return { ok: false, code: "network", error: t("studio.error") };
      }
    },
    [extract, analysis, cv, letter, emailDraft, recipient, atts, app, t],
  );

  // -----------------------------------------------------------------------
  // Approval + send
  // -----------------------------------------------------------------------

  const approve = useCallback(async (): Promise<boolean> => {
    const res = await approveApplicationAction(app.id);
    if (!res.ok) {
      flash(res.message);
      return false;
    }
    setApp(res.value);
    flash(t("studio.saved"));
    onBatchChanged();
    return true;
  }, [app.id, flash, t, onBatchChanged]);

  const send = useCallback(
    async (input: {
      recipientEmail: string;
      emailAccountId: string;
      subject: string;
      body: string;
      attachmentIds: string[];
      schedule: { timeZone: string; year: number; month: number; day: number; hour: number; minute: number } | null;
    }): Promise<ApiOutcome<{ attemptId: string; scheduledAt: string | null; dispatchStatus?: string; failureCode?: string | null }>> => {
      const res = await sendApplicationAction({ ...input, applicationId: app.id, confirmed: true });
      if (!res.ok) return { ok: false, code: res.code, error: res.message };
      const v = res.value;
      setAttempts((prev) => {
        const rest = prev.filter((a) => a.id !== v.attemptId);
        if (!v.attemptId) return rest;
        return [
          {
            id: v.attemptId,
            application_id: app.id,
            user_id: userId,
            idempotency_key: "",
            recipient_email: input.recipientEmail.toLowerCase(),
            subject: input.subject,
            payload: { html: "", text: input.body, attachments: [] },
            status: v.scheduledAt ? "queued" : v.dispatchStatus === "sent" ? "sent" : v.dispatchStatus === "failed" ? "failed" : "sending",
            scheduled_at: v.scheduledAt,
            attempt_count: 0,
            next_attempt_at: null,
            provider_message_id: null,
            failure_code: v.failureCode ?? null,
            failure_message: null,
            sent_at: v.dispatchStatus === "sent" ? new Date().toISOString() : null,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          },
          ...rest,
        ];
      });
      setApp((prev) =>
        prev
          ? {
              ...prev,
              status: v.scheduledAt ? "scheduled" : v.dispatchStatus === "sent" ? "sent" : v.dispatchStatus === "failed" ? "failed" : "sending",
              recipient_email: input.recipientEmail.toLowerCase(),
              email_account_id: input.emailAccountId,
              scheduled_at: v.scheduledAt ?? prev.scheduled_at,
            }
          : prev,
      );
      onBatchChanged();
      return { ok: true, value: v };
    },
    [app.id, userId, onBatchChanged],
  );

  const cancelScheduled = useCallback(
    async (attemptId: string): Promise<boolean> => {
      const res = await cancelSendAction(attemptId);
      if (!res.ok) {
        flash(res.message);
        return false;
      }
      setAttempts((prev) => prev.map((a) => (a.id === attemptId ? { ...a, status: "cancelled" } : a)));
      setApp((prev) => (prev ? { ...prev, status: "ready", scheduled_at: null, schedule_timezone: null } : prev));
      flash(t("studio.saved"));
      onBatchChanged();
      return true;
    },
    [flash, t, onBatchChanged],
  );

  const refresh = useCallback(async (): Promise<boolean> => {
    const res = await refreshApplicationAction(app.id);
    if (!res.ok) {
      flash(res.message);
      return false;
    }
    const v = res.value;
    if (v.app) setApp(v.app);
    setExtract(v.app?.ad_extracted ?? null);
    setAnalysis(v.app?.ad_analysis ?? null);
    setRecipient(v.app?.recipient_email ?? "");
    return true;
  }, [app.id, flash]);

  // -----------------------------------------------------------------------
  // Derived
  // -----------------------------------------------------------------------

  const done = useMemo<Record<StudioStep, boolean>>(
    () => ({
      analysis: Boolean(extract?.company || extract?.jobTitle),
      profile: baseCvLoaded && ((baseCv ? cvHasContent(baseCv) : false) || Boolean(profile)),
      cv: cv ? cvHasContent(cv) : false,
      letter: Boolean(letter?.text?.trim()),
      docs: atts.length > 0,
      quality: false,
      email: Boolean(emailDraft?.subject && emailDraft?.body),
      send: Boolean(app.approved) || app.status === "sent",
    }),
    [extract, baseCv, baseCvLoaded, profile, cv, letter, atts, emailDraft, app],
  );

  const docsCovered = useMemo(() => docsChecklistCovered(extract, atts), [extract, atts]);
  const latestAttempt = attempts[0] ?? null;

  const reqLabel = (k: string) => t(k);

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------

  return (
    <div className="space-y-6">
      {/* application header — the current company, unambiguous */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="truncate text-lg font-semibold">{extract?.company || "—"}</h2>
            <span className="truncate text-sm text-muted">
              · {extract?.jobTitle || extract?.occupation || "—"}
              {extract?.location?.trim() ? ` · ${extract.location.trim()}` : ""}
            </span>
            <StatusBadge status={app.status} />
          </div>
        </div>
      </div>

      <StepIndicator current={step} done={done} onGo={setStep} />

      <div className="space-y-6">
        <section className={step === "analysis" ? "block" : "hidden"} aria-hidden={step !== "analysis"}>
          <AnalysisPanel
            mode="edit"
            adText={adText}
            onAdTextChange={setAdText}
            onAnalyze={analyzeAd}
            onCreate={null}
            extract={extract}
            analysis={analysis}
            onExtractChange={setExtract}
            onPersist={persistAnalysis}
            onGoProfile={() => setStep("profile")}
          />
          <ConfirmBar
            confirmed={Boolean(app.ad_confirmed_at)}
            enabled={Boolean(extract?.company?.trim() && extract?.jobTitle?.trim())}
            busy={confirming === "ad"}
            label={t("studio.confirmAd")}
            doneLabel={t("studio.confirmed")}
            hint={t("studio.confirmHint")}
            onConfirm={() => confirmStep("ad")}
          />
        </section>

        <section className={step === "profile" ? "block" : "hidden"} aria-hidden={step !== "profile"}>
          <ProfilePanel
            userFacts={userFacts}
            baseCv={baseCv}
            scannerProfile={profile}
            onGoCv={() => setStep("cv")}
          />
          <ConfirmBar
            confirmed={Boolean(app.profile_confirmed_at)}
            enabled={baseCvLoaded && ((baseCv ? cvHasContent(baseCv) : false) || Boolean(profile))}
            busy={confirming === "profile"}
            label={t("studio.confirmProfile")}
            doneLabel={t("studio.confirmed")}
            hint={t("studio.confirmHint")}
            onConfirm={() => confirmStep("profile")}
          />
        </section>

        <section className={step === "cv" ? "block" : "hidden"} aria-hidden={step !== "cv"}>
          <CvPanel
            active={step === "cv"}
            applicationId={app.id}
            baseCv={baseCv}
            cv={cv}
            onCvChange={setCv}
            onSaveCv={(next) => saveDoc("cv", next)}
            onGoProfile={() => setStep("profile")}
          />
          <ConfirmBar
            confirmed={Boolean(app.cv_reviewed_at)}
            enabled={Boolean(cv && cvHasContent(cv))}
            busy={confirming === "cv"}
            label={t("studio.confirmCv")}
            doneLabel={t("studio.confirmed")}
            hint={t("studio.confirmHint")}
            onConfirm={() => confirmStep("cv")}
          />
        </section>

        <section className={step === "letter" ? "block" : "hidden"} aria-hidden={step !== "letter"}>
          <LetterPanel
            active={step === "letter"}
            extract={extract}
            adRaw={app.ad_raw}
            baseCv={baseCv}
            letter={letter}
            onLetterChange={setLetter}
            onSaveLetter={(next) => saveDoc("cover_letter", next)}
          />
          <ConfirmBar
            confirmed={Boolean(app.letter_reviewed_at)}
            enabled={Boolean(letter?.text?.trim())}
            busy={confirming === "letter"}
            label={t("studio.confirmLetter")}
            doneLabel={t("studio.confirmed")}
            hint={t("studio.confirmHint")}
            onConfirm={() => confirmStep("letter")}
          />
        </section>

        <section className={step === "docs" ? "block" : "hidden"} aria-hidden={step !== "docs"}>
          <DocsPanel
            extract={extract}
            atts={atts}
            onUpload={uploadAttachment}
            onRename={renameAttachment}
            onDelete={deleteAttachment}
          />
          <ConfirmBar
            confirmed={Boolean(app.checklist_ack_at)}
            enabled={true}
            busy={confirming === "checklist"}
            label={docsCovered ? t("studio.confirmDocs") : t("studio.confirmDocsAck")}
            doneLabel={t("studio.confirmed")}
            hint={
              docsCovered
                ? t("studio.confirmHint")
                : reqLabel("studio.docsUnverified")
            }
            onConfirm={() => confirmStep("checklist")}
          />
        </section>

        <section className={step === "quality" ? "block" : "hidden"} aria-hidden={step !== "quality"}>
          <QualityPanel onRun={runQuality} />
        </section>

        <section className={step === "email" ? "block" : "hidden"} aria-hidden={step !== "email"}>
          <EmailPanel
            applicationId={app.id}
            extract={extract}
            letter={letter}
            atts={atts}
            userFacts={userFacts}
            emailDraft={emailDraft}
            onEmailDraftChange={setEmailDraft}
            recipient={recipient}
            onRecipientChange={setRecipient}
            onSaveEmail={(next) => saveDoc("email", next)}
          />
        </section>

        <section className={step === "send" ? "block" : "hidden"} aria-hidden={step !== "send"}>
          <SendPanel
            app={app}
            extract={extract}
            cv={cv}
            letter={letter}
            emailDraft={emailDraft}
            atts={atts}
            recipient={recipient}
            onRecipientChange={setRecipient}
            emailAccounts={emailAccounts}
            latestAttempt={latestAttempt}
            onApprove={approve}
            onSend={send}
            onCancelScheduled={cancelScheduled}
            onRefresh={refresh}
          />
        </section>
      </div>

      <p className="pb-4 text-xs text-muted">
        <Link href="/dashboard/templates" className="hover:underline">
          {t("studio.cvGo")}
        </Link>
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Confirm bar (explicit completion requirement)
// ---------------------------------------------------------------------------

function ConfirmBar({
  confirmed,
  enabled,
  busy,
  label,
  doneLabel,
  hint,
  onConfirm,
}: {
  confirmed: boolean;
  enabled: boolean;
  busy: boolean;
  label: string;
  doneLabel: string;
  hint: string;
  onConfirm: () => void;
}) {
  return (
    <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-surface-2 px-4 py-3">
      <span className="min-w-0 text-xs leading-5 text-muted">{hint}</span>
      {confirmed ? (
        <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-success/10 px-3 py-1 text-xs font-medium text-success">
          <Icon name="check" size={12} strokeWidth={3} />
          {doneLabel}
        </span>
      ) : (
        <BusyButton size="sm" variant="secondary" disabled={!enabled} busy={busy} onClick={onConfirm} className="shrink-0">
          {label}
        </BusyButton>
      )}
    </div>
  );
}
