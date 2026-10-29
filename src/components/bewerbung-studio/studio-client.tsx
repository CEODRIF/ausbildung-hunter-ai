"use client";

/**
 * AI Bewerbung Studio — multi-application workspace (client shell).
 *
 * One page manages a BATCH of up to 10 individualized applications with
 * strict sequential unlocking (slot N+1 unlocks only when slot N is
 * complete AND saved — sending is NOT required). Layout:
 *
 *   header (title + batch progress + batch-send entry)
 *   ┌────────────┬──────────────────────────────────────────┐
 *   │ navigator  │  main column:                            │
 *   │ (desktop:  │   • no app → new-application ad intake   │
 *   │  left col; │   • app open → <AppEditor key={id}>      │
 *   │  mobile:   │     (8 mounted-hidden steps, fresh state │
 *   │  top strip)│     per company)                         │
 *   │            │   • batch send → <BatchSendPanel>        │
 *   └────────────┴──────────────────────────────────────────┘
 *
 * Navigation between applications is URL-driven (`?app=<id>`): the server
 * re-renders the owned bundle and the editor remounts via its key, so a
 * different company can never inherit another company's letter, email or
 * attachments.
 *
 * Safety invariants (server-enforced, mirrored here):
 *  - nothing sends an email until `app.approved === true` AND an explicit
 *    (batch or single) send confirmation;
 *  - the canonical CV (localStorage `aha:cv:<userId>`) is input only —
 *    per-application documents are separate studio_documents rows;
 *  - the schema-pending state is a graceful notice, not an error.
 */

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  createApplicationAction,
  deleteApplicationAction,
  refreshBatchAction,
} from "@/app/bewerbung-studio/actions";
import { Icon } from "@/components/icon";
import { Button, LoadingState } from "@/components/ui";
import { useI18n } from "@/lib/i18n";
import type { CandidateProfile } from "@/lib/bewerbung-schema";
import type { StudioBatchView } from "@/lib/studio";
import {
  type AdAnalysis,
  type AdExtract,
  type StudioAppStatus,
  type StudioApplicationRow,
} from "@/lib/studio/schema";
import { sanitizeCvDocument, cvHasContent, type CvDocument } from "@/lib/templates/cv";
import { AnalysisPanel } from "./panels-input";
import { Note, StatusBadge } from "./studio-ui";
import { BatchNavigator } from "./batch-navigator";
import { BatchSendPanel } from "./batch-send";
import { AppEditor, type AppEditorBundle } from "./app-editor";

// ---------------------------------------------------------------------------
// Initial payload (serialized from the server page)
// ---------------------------------------------------------------------------

export interface StudioInitial {
  available: boolean;
  /** Studio tables that are missing right now (empty = ready). Shown as the
   *  exact prerequisite in the setup-pending notice. */
  missingTables?: string[];
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
  /** Server-computed batch workspace view (slots, completion, sequential
   *  unlock). `null` only when the schema is pending. */
  batch: StudioBatchView | null;
  bundle: AppEditorBundle | null;
  profile: CandidateProfile | null;
}

// ---------------------------------------------------------------------------
// Shared API error shape (also used by the panels)
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

export { jsonApi };

const cvStorageKey = (userId: string) => `aha:cv:${userId}`;

// ---------------------------------------------------------------------------
// Main component — the workspace shell
// ---------------------------------------------------------------------------

export function StudioClient({ initial }: { initial: StudioInitial }) {
  const { t } = useI18n();
  const router = useRouter();

  // Batch navigator state — server-computed, refreshed after every
  // durable state change (create / delete / confirm / approve / send).
  const [batchView, setBatchView] = useState<StudioBatchView | null>(initial.batch);
  const [batchBusy, setBatchBusy] = useState(false);
  const [view, setView] = useState<"editor" | "batchSend">("editor");
  const [notice, setNotice] = useState<string | null>(null);

  const flash = useCallback((msg: string | null) => {
    setNotice(msg);
    if (msg) window.setTimeout(() => setNotice((cur) => (cur === msg ? null : cur)), 6000);
  }, []);

  const refreshBatch = useCallback(async () => {
    const res = await refreshBatchAction();
    if (res.ok && res.value) setBatchView(res.value);
  }, []);

  // The user's canonical CV (browser source of truth) — INPUT only,
  // shared by every application in the batch.
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

  // -----------------------------------------------------------------------
  // Navigation
  // -----------------------------------------------------------------------

  const openApplication = useCallback(
    (id: string) => {
      setView("editor");
      router.push(`/bewerbung-studio?app=${encodeURIComponent(id)}`);
    },
    [router],
  );

  const openNewApplication = useCallback(() => {
    setView("editor");
    if (initial.bundle?.app) router.push("/bewerbung-studio");
  }, [router, initial.bundle?.app]);

  // -----------------------------------------------------------------------
  // New-application intake (the "no app open" main view)
  // -----------------------------------------------------------------------

  const [adText, setAdText] = useState<string>("");

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

  /** Create a NEW application from the analyzed ad. The application id
   *  comes from the server response and drives the URL + remount. */
  const createFromAnalysis = useCallback(
    async (
      text: string,
      nextExtract: AdExtract,
      nextAnalysis: AdAnalysis | null,
    ): Promise<ApiOutcome<StudioApplicationRow>> => {
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
      if (!res.ok) return { ok: false, code: res.code, error: res.message };
      // Full server round-trip: the page reloads the owned bundle (?app=).
      openApplication(res.value.id);
      return { ok: true, value: res.value };
    },
    [initial.userFacts, baseCv, openApplication],
  );

  /** Remove an application after UI confirmation (navigator two-step). */
  const removeApplication = useCallback(
    async (id: string) => {
      setBatchBusy(true);
      const res = await deleteApplicationAction(id);
      setBatchBusy(false);
      if (!res.ok) {
        flash(res.message);
        return;
      }
      flash(t("studio.deleted"));
      if (initial.bundle?.app?.id === id) router.push("/bewerbung-studio");
      await refreshBatch();
    },
    [initial.bundle?.app?.id, router, flash, t, refreshBatch],
  );

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------

  if (!initial.available) {
    return (
      <div className="mx-auto max-w-3xl p-4 sm:p-6">
        <Note kind="info">{t("studio.schemaPending")}</Note>
        {initial.missingTables && initial.missingTables.length > 0 ? (
          <p className="mt-3 break-words font-mono text-xs text-muted">
            {t("studio.schemaMissingTables", { tables: initial.missingTables.join(", ") })}
          </p>
        ) : null}
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

  const batch = batchView;
  const activeApp = initial.bundle?.app ?? null;

  return (
    <div className="mx-auto max-w-7xl p-4 sm:p-6">
      {/* header: title + batch progress + batch-send entry */}
      <header className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight">{t("studio.pageTitle")}</h1>
          <p className="mt-0.5 text-sm text-muted">{t("studio.pageSubtitle")}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {batch ? (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-3 py-1.5 text-xs font-medium text-muted">
              <Icon name="check" size={12} strokeWidth={3} className="text-success" />
              {t("studio.wsBatchProgress", { done: batch.completeCount, limit: batch.limit })}
            </span>
          ) : null}
          <Button
            size="sm"
            variant={view === "batchSend" ? "primary" : "secondary"}
            onClick={() => setView(view === "batchSend" ? "editor" : "batchSend")}
          >
            <Icon name="send" size={14} />
            {t("studio.batchSendOpen")}
          </Button>
        </div>
      </header>

      {notice ? <div className="mb-4"><Note kind="info">{notice}</Note></div> : null}

      <div className={`grid gap-6 ${batch ? "lg:grid-cols-[300px_minmax(0,1fr)]" : ""}`}>
        {batch ? (
          <BatchNavigator
            batch={batch}
            activeAppId={view === "editor" ? activeApp?.id ?? null : null}
            onOpen={openApplication}
            onNew={openNewApplication}
            onRemove={removeApplication}
            addBusy={batchBusy}
          />
        ) : null}

        <main className="min-w-0">
          {view === "batchSend" ? (
            batch ? (
              <BatchSendPanel
                batch={batch}
                emailAccounts={initial.emailAccounts}
                onClose={() => setView("editor")}
                onBatchDone={refreshBatch}
              />
            ) : null
          ) : activeApp ? (
            initial.bundle ? (
              <AppEditor
                key={activeApp.id}
                bundle={initial.bundle}
                userId={initial.userId}
                userFacts={initial.userFacts}
                emailAccounts={initial.emailAccounts}
                profile={initial.profile}
                baseCv={baseCv}
                baseCvLoaded={baseCvLoaded}
                onNotice={flash}
                onBatchChanged={refreshBatch}
              />
            ) : null
          ) : (
            <div className="space-y-6">
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
              {/* Fallback list — only when no batch view (e.g. unit tests);
                  in production the navigator replaces this. */}
              {!batch ? (
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
                            <p className="truncate text-sm text-muted">{s.jobTitle}</p>
                          </div>
                          <div className="flex items-center gap-3">
                            <StatusBadge status={s.status} />
                            <Button size="sm" variant="secondary" onClick={() => openApplication(s.id)}>
                              {t("studio.openLabel")}
                            </Button>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              ) : null}
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
