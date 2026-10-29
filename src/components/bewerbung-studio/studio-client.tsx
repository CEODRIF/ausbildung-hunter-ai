"use client";

/**
 * AI Bewerbung Studio — one-page workflow client.
 *
 * The candidate pastes a job advertisement and progresses through eight
 * steps (analyse → profil → lebenslauf → anschreiben → dokumente →
 * prüfung → e-mail → versand) WITHOUT leaving the page. Durable state
 * lives server-side (studio_* tables); this component mirrors it locally
 * and refreshes from the server after every state-changing action.
 *
 * Safety invariants mirrored from the server:
 *  - nothing sends an email until `app.approved === true` (explicit
 *    approval) AND the user confirms the exact recipient in the send
 *    step;
 *  - the user's canonical CV (localStorage `aha:cv:<userId>`) is only
 *    ever an INPUT — generated application documents are saved as
 *    separate studio_documents rows;
 *  - the schema-pending state is a graceful notice, not an error.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  approveApplicationAction,
  cancelSendAction,
  createApplicationAction,
  refreshApplicationAction,
  saveDocumentAction,
  sendApplicationAction,
  updateApplicationAction,
} from "@/app/bewerbung-studio/actions";
import { Icon } from "@/components/icon";
import { Button, LoadingState } from "@/components/ui";
import { useI18n } from "@/lib/i18n";
import type { CandidateProfile } from "@/lib/bewerbung-schema";
import {
  type AdAnalysis,
  type AdExtract,
  type StudioAppStatus,
  type StudioApplicationRow,
  type StudioAttachmentRow,
  type StudioEmailContent,
  type StudioLetterContent,
  type StudioSendAttemptRow,
} from "@/lib/studio/schema";
import { sanitizeCvDocument, cvHasContent, type CvDocument } from "@/lib/templates/cv";
import { AnalysisPanel, ProfilePanel } from "./panels-input";
import { CvPanel, DocsPanel, LetterPanel } from "./panels-docs";
import { EmailPanel, QualityPanel, SendPanel } from "./panels-review";
import { Note, StepIndicator, type StudioStep } from "./studio-ui";

// ---------------------------------------------------------------------------
// Initial payload (serialized from the server page)
// ---------------------------------------------------------------------------

export interface StudioInitial {
  available: boolean;
  userId: string;
  userFacts: {
    fullName: string;
    email: string;
    phone: string | null;
    location: string | null;
    linkedin: string | null;
  };
  emailAccounts: Array<{
    id: string;
    provider: "gmail" | "outlook";
    email: string;
    is_active: boolean;
    requires_reconnect: boolean;
  }>;
  appSummaries: Array<{
    id: string;
    company: string;
    jobTitle: string;
    status: StudioAppStatus;
    createdAt: string;
  }>;
  bundle: null | {
    app: StudioApplicationRow;
    documents: {
      cv: CvDocument | null;
      cover_letter: StudioLetterContent | null;
      email: StudioEmailContent | null;
    };
    attachments: StudioAttachmentRow[];
    attempts: StudioSendAttemptRow[];
  };
  profile: CandidateProfile | null;
}

// ---------------------------------------------------------------------------
// Shared API error shape
// ---------------------------------------------------------------------------

export interface ApiError {
  ok: false;
  code: string;
  error: string;
}

export type ApiOutcome<T> = { ok: true; value: T } | ApiError;

async function jsonApi<T>(res: Response): Promise<ApiOutcome<T>> {
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    return {
      ok: false,
      code: typeof data.code === "string" ? data.code : `http_${res.status}`,
      error:
        typeof data.error === "string" ? data.error : "Unbekannter Fehler. Bitte erneut versuchen.",
    };
  }
  return { ok: true, value: data as unknown as T };
}

const cvStorageKey = (userId: string) => `aha:cv:${userId}`;

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function StudioClient({ initial }: { initial: StudioInitial }) {
  const { t, lang } = useI18n();
  const router = useRouter();

  const [app, setApp] = useState<StudioApplicationRow | null>(initial.bundle?.app ?? null);
  const [extract, setExtract] = useState<AdExtract | null>(initial.bundle?.app?.ad_extracted ?? null);
  const [analysis, setAnalysis] = useState<AdAnalysis | null>(initial.bundle?.app?.ad_analysis ?? null);
  const [atts, setAtts] = useState<StudioAttachmentRow[]>(initial.bundle?.attachments ?? []);
  const [attempts, setAttempts] = useState<StudioSendAttemptRow[]>(initial.bundle?.attempts ?? []);
  const [cv, setCv] = useState<CvDocument | null>(initial.bundle?.documents.cv ?? null);
  const [letter, setLetter] = useState<StudioLetterContent | null>(initial.bundle?.documents.cover_letter ?? null);
  const [emailDraft, setEmailDraft] = useState<StudioEmailContent | null>(initial.bundle?.documents.email ?? null);
  const [recipient, setRecipient] = useState<string>(initial.bundle?.app?.recipient_email ?? "");
  const [step, setStep] = useState<StudioStep>("analysis");

  // The user's canonical CV (browser source of truth) — INPUT only.
  const [baseCv, setBaseCv] = useState<CvDocument | null>(null);
  const [baseCvLoaded, setBaseCvLoaded] = useState(false);
  useEffect(() => {
    let stored: CvDocument | null = null;
    try {
      const raw = localStorage.getItem(cvStorageKey(initial.userId));
      if (raw) stored = sanitizeCvDocument(JSON.parse(raw)) as CvDocument | null;
    } catch {
      stored = null;
    }
    // Intentional post-hydration restore of the persisted CV (localStorage);
    // the server render uses null on purpose (no mismatch).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setBaseCv(stored);
    setBaseCvLoaded(true);
  }, [initial.userId]);

  const [adText, setAdText] = useState<string>(initial.bundle?.app?.ad_raw ?? "");
  const [notice, setNotice] = useState<string | null>(null);

  const flash = useCallback((msg: string | null) => {
    setNotice(msg);
    if (msg) window.setTimeout(() => setNotice((cur) => (cur === msg ? null : cur)), 4000);
  }, []);

  // -----------------------------------------------------------------------
  // Navigation
  // -----------------------------------------------------------------------

  const openApplication = useCallback(
    (id: string) => router.push(`/bewerbung-studio?app=${encodeURIComponent(id)}`),
    [router],
  );

  const backToList = useCallback(() => router.push("/bewerbung-studio"), [router]);

  // -----------------------------------------------------------------------
  // AI: advertisement analysis (new or re-analysis)
  // -----------------------------------------------------------------------

  const analyzeAd = useCallback(
    async (text: string): Promise<ApiOutcome<{ extract: AdExtract; analysis: AdAnalysis }>> => {
      try {
        const res = await fetch("/api/bewerbung-studio/analyze-ad", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ adText: text, cv: baseCv }),
        });
        return await jsonApi(res);
      } catch {
        return { ok: false, code: "network", error: t("studio.error") };
      }
    },
    [baseCv, t],
  );

  /** Persist analysis into an EXISTING application. */
  const persistAnalysis = useCallback(
    async (nextExtract: AdExtract, nextAnalysis: AdAnalysis | null): Promise<boolean> => {
      if (!app) return false;
      const res = await updateApplicationAction(app.id, {
        extract: nextExtract,
        analysis: nextAnalysis,
      });
      if (res.ok) {
        setApp(res.value);
        setExtract(nextExtract);
        if (nextAnalysis) setAnalysis(nextAnalysis);
        return true;
      }
      flash(res.message);
      return false;
    },
    [app, flash],
  );

  /** Create a NEW application from the analyzed ad (then load its bundle). */
  const createFromAnalysis = useCallback(
    async (
      text: string,
      nextExtract: AdExtract,
      nextAnalysis: AdAnalysis | null,
    ): Promise<boolean> => {
      const res = await createApplicationAction({
        adRaw: text,
        extract: nextExtract,
        analysis: nextAnalysis,
        profileSnapshot: {
          name: initial.userFacts.fullName || null,
          email: initial.userFacts.email || null,
          phone: initial.userFacts.phone,
          location: initial.userFacts.location,
          cvContent: baseCv ? cvHasContent(baseCv) : false,
          at: new Date().toISOString(),
        },
      });
      if (!res.ok) {
        flash(res.message);
        return false;
      }
      // Full server round-trip: the page reloads the owned bundle (?app=).
      openApplication(res.value.id);
      return true;
    },
    [initial.userFacts, baseCv, flash, openApplication],
  );

  // -----------------------------------------------------------------------
  // Document persistence
  // -----------------------------------------------------------------------

  const saveDoc = useCallback(
    async (docType: "cv" | "cover_letter" | "email", content: unknown): Promise<boolean> => {
      if (!app) return false;
      const res = await saveDocumentAction(app.id, docType, content);
      if (!res.ok) {
        flash(res.message);
        return false;
      }
      flash(t("studio.saved"));
      return true;
    },
    [app, flash, t],
  );

  // -----------------------------------------------------------------------
  // Attachments
  // -----------------------------------------------------------------------

  const uploadAttachment = useCallback(
    async (file: File, category: string): Promise<ApiOutcome<StudioAttachmentRow>> => {
      if (!app) return { ok: false, code: "no_app", error: t("studio.error") };
      const fd = new FormData();
      fd.append("file", file);
      fd.append("applicationId", app.id);
      fd.append("category", category);
      try {
        const res = await fetch("/api/bewerbung-studio/attachments", { method: "POST", body: fd });
        const outcome = await jsonApi<StudioAttachmentRow>(res);
        if (outcome.ok) setAtts((prev) => [...prev, outcome.value]);
        return outcome;
      } catch {
        return { ok: false, code: "network", error: t("studio.error") };
      }
    },
    [app, t],
  );

  const renameAttachment = useCallback(
    async (attachmentId: string, name: string): Promise<boolean> => {
      try {
        const res = await fetch("/api/bewerbung-studio/attachments", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ attachmentId, name }),
        });
        const outcome = await jsonApi(res);
        if (!outcome.ok) {
          flash(outcome.error);
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
        const outcome = await jsonApi(res);
        if (!outcome.ok) {
          flash(outcome.error);
          return false;
        }
        setAtts((prev) => prev.filter((a) => a.id !== attachmentId));
        setEmailDraft((prev) =>
          prev ? { ...prev, attachmentIds: prev.attachmentIds.filter((id) => id !== attachmentId) } : prev,
        );
        return true;
      } catch {
        flash(t("studio.error"));
        return false;
      }
    },
    [flash, t],
  );

  // -----------------------------------------------------------------------
  // Quality check
  // -----------------------------------------------------------------------

  const runQuality = useCallback(
    async (withAi: boolean): Promise<ApiOutcome<{ issues: import("@/lib/studio/schema").QualityIssue[]; aiChecked: boolean }>> => {
      const scheduledMs = app?.scheduled_at ? new Date(app.scheduled_at).getTime() : null;
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
        return await jsonApi(res);
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
    if (!app) return false;
    const res = await approveApplicationAction(app.id);
    if (!res.ok) {
      flash(res.message);
      return false;
    }
    setApp(res.value);
    flash(t("studio.saved"));
    return true;
  }, [app, flash, t]);

  const send = useCallback(
    async (input: {
      recipientEmail: string;
      emailAccountId: string;
      subject: string;
      body: string;
      attachmentIds: string[];
      schedule: { timeZone: string; year: number; month: number; day: number; hour: number; minute: number } | null;
    }): Promise<ApiOutcome<{ attemptId: string; scheduledAt: string | null; dispatchStatus?: string; failureCode?: string | null }>> => {
      if (!app) return { ok: false, code: "no_app", error: t("studio.error") };
      const res = await sendApplicationAction({ ...input, applicationId: app.id, confirmed: true });
      if (!res.ok) return { ok: false, code: res.code, error: res.message };
      const v = res.value;
      // Local state refresh (the server already updated both rows).
      setAttempts((prev) => {
        const rest = prev.filter((a) => a.id !== v.attemptId);
        if (!v.attemptId) return rest;
        return [
          {
            id: v.attemptId,
            application_id: app.id,
            user_id: initial.userId,
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
      return { ok: true, value: v };
    },
    [app, initial.userId, t],
  );

  const cancelScheduled = useCallback(async (attemptId: string): Promise<boolean> => {
    const res = await cancelSendAction(attemptId);
    if (!res.ok) {
      flash(res.message);
      return false;
    }
    setAttempts((prev) => prev.map((a) => (a.id === attemptId ? { ...a, status: "cancelled" } : a)));
    setApp((prev) => (prev ? { ...prev, status: "ready", scheduled_at: null, schedule_timezone: null } : prev));
    flash(t("studio.saved"));
    return true;
  }, [flash, t]);

  const refresh = useCallback(async (): Promise<boolean> => {
    if (!app) return false;
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
  }, [app, flash]);

  // -----------------------------------------------------------------------
  // Derived
  // -----------------------------------------------------------------------

  const done = useMemo<Record<StudioStep, boolean>>(
    () => ({
      analysis: Boolean(extract?.company || extract?.jobTitle),
      profile: baseCvLoaded && ((baseCv ? cvHasContent(baseCv) : false) || Boolean(initial.profile)),
      cv: cv ? cvHasContent(cv) : false,
      letter: Boolean(letter?.text?.trim()),
      docs: atts.length > 0,
      quality: false,
      email: Boolean(emailDraft?.subject && emailDraft?.body),
      send: Boolean(app?.approved) || app?.status === "sent",
    }),
    [extract, baseCv, baseCvLoaded, initial.profile, cv, letter, atts, emailDraft, app],
  );

  const latestAttempt = attempts[0] ?? null;

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------

  if (!initial.available) {
    return (
      <div className="mx-auto max-w-3xl p-4 sm:p-6">
        <Note kind="info">{t("studio.schemaPending")}</Note>
      </div>
    );
  }

  if (!baseCvLoaded) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <LoadingState label={t("studio.analyzing")} />
      </div>
    );
  }

  // ---- List view (no application selected) -------------------------------
  if (!app) {
    return (
      <div className="mx-auto max-w-5xl space-y-6 p-4 sm:p-6">
        <AnalysisPanel
          mode="new"
          adText={adText}
          onAdTextChange={setAdText}
          onAnalyze={analyzeAd}
          onCreate={createFromAnalysis}
          extract={null}
          analysis={null}
          onExtractChange={() => undefined}
          onPersist={async () => false}
          onGoProfile={() => undefined}
        />
        <section className="rounded-2xl border border-border bg-surface p-5 shadow-sm sm:p-6">
          <h2 className="mb-4 text-base font-semibold">{t("studio.listTitle")}</h2>
          {initial.appSummaries.length === 0 ? (
            <p className="text-sm text-muted">{t("studio.listEmpty")}</p>
          ) : (
            <ul className="divide-y divide-border">
              {initial.appSummaries.map((s) => (
                <li key={s.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{s.company}</p>
                    <p className="truncate text-sm text-muted">
                      {s.jobTitle} · {new Date(s.createdAt).toLocaleDateString(lang === "ar" ? "ar" : lang)}
                    </p>
                  </div>
                  <div className="flex items-center gap-3">
                    <AppStatusLabel status={s.status} />
                    <Button size="sm" variant="secondary" onClick={() => openApplication(s.id)}>
                      {t("studio.openLabel")}
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    );
  }

  // ---- Wizard view (an application is open) ------------------------------
  return (
    <div className="mx-auto max-w-5xl space-y-6 p-4 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <button
            type="button"
            onClick={backToList}
            className="mb-1 inline-flex items-center gap-1 text-xs font-medium text-muted hover:text-foreground"
          >
            <Icon name="arrowLeft" size={12} />
            {t("studio.backToList")}
          </button>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-lg font-semibold">{extract?.company || "—"}</h1>
            <span className="text-sm text-muted">· {extract?.jobTitle || extract?.occupation || "—"}</span>
            <AppStatusLabel status={app.status} />
          </div>
        </div>
        {notice ? <Note kind="info">{notice}</Note> : null}
      </div>

      <StepIndicator current={step} done={done} onGo={setStep} />

      <div className="space-y-6">
        <section
          className={step === "analysis" ? "block" : "hidden"}
          aria-hidden={step !== "analysis"}
        >
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
        </section>

        <section className={step === "profile" ? "block" : "hidden"} aria-hidden={step !== "profile"}>
          <ProfilePanel
            userFacts={initial.userFacts}
            baseCv={baseCv}
            scannerProfile={initial.profile}
            onGoCv={() => setStep("cv")}
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
        </section>

        <section className={step === "docs" ? "block" : "hidden"} aria-hidden={step !== "docs"}>
          <DocsPanel
            extract={extract}
            atts={atts}
            onUpload={uploadAttachment}
            onRename={renameAttachment}
            onDelete={deleteAttachment}
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
            userFacts={initial.userFacts}
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
            emailAccounts={initial.emailAccounts}
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

function AppStatusLabel({ status }: { status: StudioAppStatus }) {
  const { t } = useI18n();
  const keys: Record<StudioAppStatus, string> = {
    draft: "studio.statusDraft",
    ready: "studio.statusReady",
    scheduled: "studio.statusScheduled",
    sending: "studio.statusSending",
    sent: "studio.statusSent",
    failed: "studio.statusFailed",
    cancelled: "studio.statusCancelled",
  };
  const tone: Record<StudioAppStatus, string> = {
    draft: "bg-muted text-muted",
    ready: "bg-primary/10 text-primary",
    scheduled: "bg-warning/10 text-warning",
    sending: "bg-warning/10 text-warning",
    sent: "bg-success/10 text-success",
    failed: "bg-danger/10 text-danger",
    cancelled: "bg-muted text-muted",
  };
  return <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${tone[status]}`}>{t(keys[status])}</span>;
}

