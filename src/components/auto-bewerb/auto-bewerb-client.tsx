"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ErrorState } from "@/components/ui/feedback";
import { useI18n } from "@/lib/i18n";
import type {
  AutoBewerbLetter,
  AutoBewerbWorkspace,
} from "@/lib/auto-bewerb/schema";
import type { CvDocument } from "@/lib/templates/cv";
import { refreshWorkspaceAction } from "@/app/auto-bewerb/actions";
import {
  AutoBewerbContext,
  StepShell,
  ToastHost,
  type AutoBewerbDrafts,
  type ToastKind,
} from "./shared";
import { Step1Cv } from "./step1-cv";
import { Step2Companies } from "./step2-companies";
import { Step3Documents } from "./step3-documents";
import { Step4CvGeneration } from "./step4-cv-generation";
import { Step5CoverLetter } from "./step5-cover-letter";
import { Step6Email } from "./step6-email";
import { Step7Review } from "./step7-review";

const STEP_TITLE_KEYS = [
  "autoBewerb.step1Title",
  "autoBewerb.step2Title",
  "autoBewerb.step3Title",
  "autoBewerb.step4Title",
  "autoBewerb.step5Title",
  "autoBewerb.step6Title",
  "autoBewerb.step7Title",
] as const;

const STEP_SUBTITLE_KEYS = [
  "autoBewerb.step1Subtitle",
  "autoBewerb.step2Subtitle",
  "autoBewerb.step3Subtitle",
  "autoBewerb.step4Subtitle",
  "autoBewerb.step5Subtitle",
  "autoBewerb.step6Subtitle",
  "autoBewerb.step7Subtitle",
] as const;

/**
 * AUTO BEWERB — the workflow controller.
 *
 * Owns the workspace snapshot (initialized by the server page), the step
 * position, the shared company selection, and unsaved generated documents.
 * Every durable change flows through the server actions in
 * `@/app/auto-bewerb/actions` and is followed by `refresh()` — the database
 * is the single source of truth, the UI is a projection of it.
 */
export function AutoBewerbClient({ initial }: { initial: AutoBewerbWorkspace }) {
  const { t } = useI18n();
  const [ws, setWs] = useState<AutoBewerbWorkspace>(initial);
  const [step, setStep] = useState(1);
  const [toast, setToast] = useState<{ kind: ToastKind; text: string } | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [companyId, setCompanyId] = useState<string | null>(
    initial.companies[0]?.company.id ?? null,
  );
  const [drafts, setDrafts] = useState<AutoBewerbDrafts>({ cv: {}, letter: {} });

  const notify = useCallback((kind: ToastKind, text: string) => {
    setToast({ kind, text });
  }, []);

  const refresh = useCallback(
    async (silent = false) => {
      setSyncing(true);
      try {
        const res = await refreshWorkspaceAction();
        if (res.ok) {
          setWs(res.value);
        } else if (!silent) {
          notify("error", t("autoBewerb.refreshError"));
        }
      } catch {
        if (!silent) notify("error", t("autoBewerb.refreshError"));
      } finally {
        setSyncing(false);
      }
    },
    [notify, t],
  );

  // Page-load catch-up: due scheduled sends are processed server-side by the
  // refresh action itself, so the first read shows an HONEST current status.
  useEffect(() => {
    void refresh(true);
  }, [refresh]);

  const goToStep = useCallback((n: number) => {
    setStep(Math.min(7, Math.max(1, n)));
  }, []);

  const selectCompany = useCallback((id: string | null) => {
    setCompanyId(id);
  }, []);

  const setDraft = useCallback(
    (kind: "cv" | "letter", id: string, value: CvDocument | AutoBewerbLetter | null) => {
      setDrafts((d) => ({ ...d, [kind]: { ...d[kind], [id]: value } }));
    },
    [],
  );

  // Keep the shared selection valid when companies are added/removed.
  useEffect(() => {
    if (companyId && !ws.companies.some((c) => c.company.id === companyId)) {
      setCompanyId(ws.companies[0]?.company.id ?? null);
    } else if (!companyId && ws.companies.length > 0) {
      setCompanyId(ws.companies[0].company.id);
    }
  }, [ws.companies, companyId]);

  const value = useMemo(
    () => ({
      ws,
      refresh,
      step,
      goToStep,
      toast,
      notify,
      syncing,
      companyId,
      selectCompany,
      drafts,
      setDraft,
    }),
    [ws, refresh, step, goToStep, toast, notify, syncing, companyId, selectCompany, drafts, setDraft],
  );

  // SETUP PENDING: the manual migration has not been applied yet. Be honest —
  // no fake workflow data, no simulated progress.
  if (!ws.ready) {
    return (
      <div className="mx-auto w-full max-w-3xl px-4 py-16 sm:px-6">
        <ErrorState
          title={t("autoBewerb.setupPendingTitle")}
          reason={t("autoBewerb.setupPendingBody")}
          onRetry={() => void refresh()}
          retryLabel={t("autoBewerb.retry")}
        />
      </div>
    );
  }

  return (
    <AutoBewerbContext.Provider value={value}>
      <ToastHost />
      <StepShell title={t(STEP_TITLE_KEYS[step - 1])} subtitle={t(STEP_SUBTITLE_KEYS[step - 1])}>
        {step === 1 && <Step1Cv />}
        {step === 2 && <Step2Companies />}
        {step === 3 && <Step3Documents />}
        {step === 4 && <Step4CvGeneration />}
        {step === 5 && <Step5CoverLetter />}
        {step === 6 && <Step6Email />}
        {step === 7 && <Step7Review />}
      </StepShell>
    </AutoBewerbContext.Provider>
  );
}
