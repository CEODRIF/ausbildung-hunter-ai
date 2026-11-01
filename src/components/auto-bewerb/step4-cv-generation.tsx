"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, Check, CheckCircle2, Download, Eye, FileText, Fullscreen, Loader2, Maximize, Minimize, RefreshCw, Sparkles, ZoomIn, ZoomOut } from "lucide-react";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import { Button, Input, Modal, Textarea } from "@/components/ui";
import { EmptyState } from "@/components/ui/feedback";
import { useI18n } from "@/lib/i18n";
import type { CvDocument } from "@/lib/templates/cv";
import { isPhotoRef } from "@/lib/auto-bewerb/profile-photo";
import { verifyCvAgainstAd, type CvVerificationReport } from "@/lib/auto-bewerb/cv-verification";
import type { AutoBewerbCompanyView } from "@/lib/auto-bewerb/schema";
import {
  markDocumentReviewedAction,
  saveCompanyDocumentAction,
} from "@/app/auto-bewerb/actions";
import { companyLabel, Note, SectionCard, useAutoBewerb } from "./shared";

const s2a = (s: string): string[] => s.split(/[,;\n]/).map((x) => x.trim()).filter(Boolean);
const a2s = (a: string[]): string => a.join(", ");

/**
 * Step 4 — BULK tailored CV (Lebenslauf) for ALL companies.
 *
 * One action generates + SAVES a tailored CV for every company in the
 * workflow, sequentially (bounded: one AI call in flight at a time — the
 * existing per-company quota reservation and rate limits of the
 * generate-cv route apply to every call). Each CV is persisted via
 * saveCompanyDocumentAction BEFORE it counts as successful; a failure in
 * one company never stops the others and can be retried individually.
 *
 * Companies that already have a saved CV are skipped (a valid CV is never
 * overwritten). Preview is per-company (saved version or unsaved draft);
 * PDF export renders that company's saved CV server-side.
 */
export function Step4CvGeneration() {
  const { ws, refresh, notify, drafts, setDraft, goToStep } = useAutoBewerb();
  const { t } = useI18n();

  /** Per-company in-flight / failure state (saved CVs derive from ws).
   *  A string value is the ACTUAL error message to display. */
  const [perCompany, setPerCompany] = useState<Record<string, "generating" | string>>({});
  /** Bulk run progress (null = never started / finished and summarized). */
  const [bulk, setBulk] = useState<{ total: number; done: number; failed: number; currentId: string | null; finished: boolean } | null>(null);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<"doc" | "edit">("doc");
  const [saving, setSaving] = useState(false);
  const [reviewing, setReviewing] = useState(false);

  const running = Boolean(bulk && !bulk.finished);
  const targets = ws.companies.filter((c) => !c.cv);

  if (ws.companies.length === 0) {
    return <EmptyState title={t("autoBewerb.cvGenEmpty")} body={t("autoBewerb.cvGenEmptyBody")} illustration={<FileText size={34} strokeWidth={1.6} />} ctaIcon={<Button variant="primary" onClick={() => goToStep(2)}>{t("autoBewerb.goToCompanies")}</Button>} />;
  }

  /** Generate AND persist one company's CV. Resolves to `null` on success
   *  (only after the server confirmed the save) or the ACTUAL error message
   *  (provider / quota / network / persistence). */
  const generateOne = async (view: AutoBewerbCompanyView): Promise<string | null> => {
    try {
      const res = await fetch("/api/auto-bewerb/generate-cv", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companyId: view.company.id }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; cv?: CvDocument };
      if (!res.ok || !data.cv) return data.error ?? t("autoBewerb.generateError");
      const saveRes = await saveCompanyDocumentAction(view.company.id, "cv", data.cv);
      return saveRes.ok ? null : t("autoBewerb.saveError");
    } catch {
      return t("autoBewerb.generateError");
    }
  };

  const clearCompanyState = (id: string) =>
    setPerCompany((p) => {
      const next = { ...p };
      delete next[id];
      return next;
    });

  /** The bulk operation — sequential, one AI call at a time, never stops
   *  on a single failure, skips companies that already have a saved CV. */
  const generateAll = async () => {
    if (running || targets.length === 0 || !ws.profile?.extracted) return;
    setBulk({ total: targets.length, done: 0, failed: 0, currentId: targets[0].company.id, finished: false });
    for (const c of targets) {
      setBulk((b) => (b ? { ...b, currentId: c.company.id } : b));
      setPerCompany((p) => ({ ...p, [c.company.id]: "generating" }));
      const failure = await generateOne(c);
      if (failure === null) {
        clearCompanyState(c.company.id);
        await refresh(true); // server is the source of truth — the row now shows "ready"
      } else {
        setPerCompany((p) => ({ ...p, [c.company.id]: failure }));
      }
      setBulk((b) => (b ? { ...b, done: b.done + 1, failed: b.failed + (failure === null ? 0 : 1), currentId: null } : b));
    }
    setBulk((b) => (b ? { ...b, finished: true, currentId: null } : b));
  };

  /** Retry ONE failed company — successful CVs are never regenerated. */
  const retryOne = async (c: AutoBewerbCompanyView) => {
    if (running) return;
    setPerCompany((p) => ({ ...p, [c.company.id]: "generating" }));
    const failure = await generateOne(c);
    if (failure === null) {
      clearCompanyState(c.company.id);
      await refresh(true);
      notify("success", t("autoBewerb.generatedNote"));
    } else {
      setPerCompany((p) => ({ ...p, [c.company.id]: failure }));
    }
  };

  const stateOf = (c: AutoBewerbCompanyView): "none" | "generating" | "failed" | "ready" => {
    const p = perCompany[c.company.id];
    if (p === "generating") return "generating";
    if (typeof p === "string") return "failed";
    return c.cv ? "ready" : "none";
  };

  // --- per-company preview (independent; keyed by company id) -------------
  const previewView = previewId ? (ws.companies.find((c) => c.company.id === previewId) ?? null) : null;
  const previewDraft = previewView ? (drafts.cv[previewView.company.id] ?? null) : null;
  const previewDoc: CvDocument | null = previewView ? (previewDraft ?? previewView.cv) : null;
  const previewReviewed = Boolean(previewView?.company.cv_reviewed_at);
  // The saved-CV document view is the wide "document workspace" modal;
  // edit view and the unsaved-draft variant stay in the compact popup.
  const showDocWorkspace = Boolean(previewView?.cv && previewDoc && viewMode === "doc" && !previewDraft);

  const savePreview = async () => {
    if (!previewView || !previewDraft) return;
    setSaving(true);
    const res = await saveCompanyDocumentAction(previewView.company.id, "cv", previewDraft);
    setSaving(false);
    if (res.ok) {
      setDraft("cv", previewView.company.id, null);
      await refresh();
      notify("success", t("autoBewerb.docSavedVersion", { version: res.value.version }));
    } else notify("error", t("autoBewerb.saveError"));
  };

  const markPreviewReviewed = async () => {
    if (!previewView) return;
    setReviewing(true);
    const res = await markDocumentReviewedAction(previewView.company.id, "cv");
    setReviewing(false);
    if (res.ok) {
      await refresh();
      notify("success", t("autoBewerb.docReviewedNote"));
    } else notify("error", t("autoBewerb.saveError"));
  };

  const currentName = bulk?.currentId ? companyLabel(ws.companies.find((c) => c.company.id === bulk.currentId)?.company ?? ws.companies[0].company).name : null;

  return (
    <div className="space-y-5">
      {!ws.profile?.extracted && (
        <Note kind="error">
          {t("autoBewerb.profileRequired")}{" "}
          <button type="button" className="font-semibold text-accent underline underline-offset-2" onClick={() => goToStep(1)}>
            {t("autoBewerb.goToStep1")}
          </button>
        </Note>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* Global generation panel                                            */}
      {/* ------------------------------------------------------------------ */}
      <SectionCard title={t("autoBewerb.cvBulkTitle")} className="bg-gradient-to-br from-accent-soft/40 via-surface to-surface">
        <p className="max-w-2xl text-sm leading-6 text-muted">{t("autoBewerb.cvBulkDesc")}</p>

        <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-4">
          <Button
            variant="primary"
            onClick={() => void generateAll()}
            disabled={running || targets.length === 0 || !ws.profile?.extracted}
            className="w-full sm:w-auto"
          >
            {running ? <Loader2 size={16} className="animate-spin" /> : <Sparkles size={16} />}
            {running ? t("autoBewerb.cvBulkRunning") : t("autoBewerb.cvBulkButton")}
          </Button>
          <span className="text-sm font-medium text-muted">
            {targets.length > 0
              ? t("autoBewerb.cvBulkCount", { count: targets.length })
              : t("autoBewerb.cvBulkAllDone")}
          </span>
        </div>

        {/* Live progress */}
        {bulk && !bulk.finished && (
          <div className="mt-5 rounded-2xl border border-line bg-surface-2/50 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2 text-sm font-semibold">
              <span className="text-ink">
                {t("autoBewerb.cvBulkProgress", { done: bulk.done, total: bulk.total })}
              </span>
              {currentName && (
                <span className="flex min-w-0 items-center gap-2 text-accent">
                  <Loader2 size={14} className="shrink-0 animate-spin" />
                  <span className="truncate">{currentName}</span>
                </span>
              )}
            </div>
            <div className="mt-3 h-2 overflow-hidden rounded-full bg-line" role="progressbar" aria-valuenow={bulk.done} aria-valuemin={0} aria-valuemax={bulk.total}>
              <div className="h-full rounded-full bg-accent transition-all duration-300" style={{ width: `${Math.round((bulk.done / bulk.total) * 100)}%` }} />
            </div>
            <p className="mt-2 text-xs text-muted">
              {t("autoBewerb.cvBulkOk", { count: bulk.done - bulk.failed })}
              {bulk.failed > 0 && <> · {t("autoBewerb.cvBulkFailedSummary", { count: bulk.failed })}</>}
            </p>
          </div>
        )}

        {/* Completion summary */}
        {bulk?.finished && (
          <div className="mt-5">
            {bulk.failed === 0 ? (
              <Note kind="success">{t("autoBewerb.cvBulkOk", { count: bulk.done })}</Note>
            ) : (
              <Note kind="error">
                {t("autoBewerb.cvBulkOk", { count: bulk.done - bulk.failed })} · {t("autoBewerb.cvBulkFailedSummary", { count: bulk.failed })}
              </Note>
            )}
          </div>
        )}
      </SectionCard>

      {/* ------------------------------------------------------------------ */}
      {/* Companies list                                                     */}
      {/* ------------------------------------------------------------------ */}
      <SectionCard title={t("autoBewerb.cvCompaniesTitle", { count: ws.companies.length })}>
        <ul className="divide-y divide-line">
          {ws.companies.map((c) => {
            const st = stateOf(c);
            const { name, job } = companyLabel(c.company);
            return (
              <li key={c.company.id} className="flex flex-col gap-3 py-4 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:gap-4">
                {/* Company */}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-ink">{name}</p>
                  <p className="truncate text-xs text-muted">{job || "—"}</p>
                </div>

                {/* Status */}
                <div className="sm:w-52">
                  {st === "none" && (
                    <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-danger">
                      <AlertTriangle size={13} /> {t("autoBewerb.cvStatusNone")}
                    </span>
                  )}
                  {st === "generating" && (
                    <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-accent">
                      <Loader2 size={13} className="animate-spin" /> {t("autoBewerb.cvStatusGenerating")}
                    </span>
                  )}
                  {st === "ready" && (
                    <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-success">
                      <CheckCircle2 size={13} /> {t("autoBewerb.cvStatusReady")}
                    </span>
                  )}
                  {st === "failed" && (
                    <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-danger">
                      <AlertTriangle size={13} /> {t("autoBewerb.cvStatusFailed")}
                    </span>
                  )}
                  {st === "failed" && (
                    <p className="mt-1 line-clamp-2 text-xs leading-5 text-danger/80 sm:max-w-60">{perCompany[c.company.id] as string}</p>
                  )}
                </div>

                {/* Actions */}
                <div className="flex items-center gap-2">
                  {st === "failed" ? (
                    <Button variant="secondary" size="sm" onClick={() => void retryOne(c)} disabled={running}>
                      <RefreshCw size={13} /> {t("autoBewerb.cvRetry")}
                    </Button>
                  ) : null}
                  <Button
                    variant={st === "ready" ? "secondary" : "ghost"}
                    size="sm"
                    onClick={() => {
                      setPreviewId(c.company.id);
                      setViewMode(c.cv ? "doc" : "edit");
                    }}
                    disabled={st !== "ready"}
                    title={st !== "ready" ? t("autoBewerb.cvPreviewDisabledHint") : undefined}
                  >
                    <Eye size={13} /> {t("autoBewerb.cvPreviewButton")}
                  </Button>
                  {st === "ready" && (
                    <Button
                      variant="ghost"
                      size="sm"
                      title={t("autoBewerb.exportPdfButton")}
                      onClick={() => window.open(`/api/auto-bewerb/export-pdf?companyId=${encodeURIComponent(c.company.id)}&doc=cv`, "_blank")}
                    >
                      <Download size={13} />
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </SectionCard>

      {/* ------------------------------------------------------------------ */}
      {/* Per-company CV preview modal (saved version, editable as draft)    */}
      {/* ------------------------------------------------------------------ */}
      <Modal
        open={Boolean(previewView && previewDoc)}
        onClose={() => setPreviewId(null)}
        title={previewView ? companyLabel(previewView.company).name : ""}
        size={showDocWorkspace ? "wide" : "form"}
      >
        {previewView && previewDoc && (
          <div className="flex min-h-0 flex-1 flex-col gap-3">
            {/* Stable toolbar — never scrolls away: document state + the
                Document/Edit switch, Export PDF, Save, Mark as reviewed. */}
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              {previewDraft && <Note kind="info">{t("autoBewerb.cvUnsavedNote")}</Note>}
              {!previewDraft && (
                <span className="text-xs font-semibold text-muted">{t("autoBewerb.cvVersion", { version: previewView.cvVersion ?? 1 })}</span>
              )}
              {previewReviewed && !previewDraft && (
                <span className="inline-flex items-center gap-1 text-xs font-semibold text-success">
                  <Check size={13} /> {t("autoBewerb.docReviewedNote")}
                </span>
              )}
              <div className="ml-auto flex items-center gap-2">
                {previewView.cv && (
                  <>
                    {/* Document / Edit toggle */}
                    <div className="flex items-center gap-1 rounded-xl bg-surface-2 p-1">
                      <button
                        type="button"
                        onClick={() => setViewMode("doc")}
                        className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors ${viewMode === "doc" ? "bg-surface text-ink shadow-sm" : "text-muted hover:text-ink-soft"}`}
                      >
                        {t("autoBewerb.cvDocView")}
                      </button>
                      <button
                        type="button"
                        onClick={() => setViewMode("edit")}
                        className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors ${viewMode === "edit" ? "bg-surface text-ink shadow-sm" : "text-muted hover:text-ink-soft"}`}
                      >
                        {t("autoBewerb.cvEditView")}
                      </button>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => window.open(`/api/auto-bewerb/export-pdf?companyId=${encodeURIComponent(previewView.company.id)}&doc=cv`, "_blank")}
                    >
                      <Download size={13} /> {t("autoBewerb.exportPdfButton")}
                    </Button>
                  </>
                )}
                {previewDraft && (
                  <Button variant="primary" size="sm" onClick={() => void savePreview()} disabled={saving}>
                    {t("autoBewerb.docSaveButton")}
                  </Button>
                )}
                {!previewDraft && !previewReviewed && (
                  <Button variant="secondary" size="sm" onClick={() => void markPreviewReviewed()} disabled={reviewing}>
                    <Check size={13} /> {t("autoBewerb.docReviewMark")}
                  </Button>
                )}
                </div>
              </div>

              {/* Requirement coverage — the deterministic pre-export check:
                  every requirement of THIS ad vs. this CV (present / in
                  which section / auto-added from the ad). Shown in both
                  document view and edit view, before the Export button. */}
              {previewView.company.ad_extracted && (
                <RequirementVerificationPanel
                  report={verifyCvAgainstAd({ cv: previewDoc, extract: previewView.company.ad_extracted })}
                />
              )}

              {/* A4 document view — the ACTUAL PDF (same bytes as the export),
                  white pages on the dark app, pdf.js-rendered onto canvases
                  (zoom + scroll + all pages). CvPdfPreview fetches through
                  the SAME session, verifies the bytes, draws them itself —
                  never downloaded, never dependent on the native viewer. */}
            {previewView.cv && viewMode === "doc" && !previewDraft ? (
              <div className="flex min-h-0 flex-1 flex-col gap-2">
                {/* The dark stage fills the modal height — the CV is the
                    main visual focus, not a small inset. */}
                <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl bg-ink/70 p-2 sm:p-3">
                  <CvPdfPreview
                    companyId={previewView.company.id}
                    version={previewView.cvVersion ?? 0}
                    name={companyLabel(previewView.company).name}
                  />
                </div>
                <p className="shrink-0 text-xs text-faint">{t("autoBewerb.cvDocViewHint")}</p>
              </div>
            ) : (
              /* Edit view: the form scrolls INSIDE the capped dialog —
                 the header + toolbar above stay visible at all times and
                 no field or action is ever clipped. */
              <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
                {previewDraft && previewView.cv && viewMode === "doc" && (
                  <Note kind="info">{t("autoBewerb.cvDocDraftNote")}</Note>
                )}
                <CvPreview doc={previewDoc} editable={Boolean(previewDraft)} onChange={previewDraft ? (patch) => setDraft("cv", previewView.company.id, patch) : undefined} />
              </div>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}

// ---------------------------------------------------------------------------

/**
 * The deterministic REQUIREMENT-COVERAGE panel (Step 4, before export):
 * every requirement of THIS company's ad vs. THIS CV — present in which
 * section, auto-added from the ad (flagged for the user's confirmation),
 * or a visible gap. Pure client-side computation over the stored data
 * (verifyCvAgainstAd) — no AI, no network, no state.
 */
function RequirementVerificationPanel({ report }: { report: CvVerificationReport }) {
  const { t } = useI18n();
  if (report.total === 0) return null;
  const allCovered = report.allCovered;
  const gaps = report.items.filter((i) => i.status === "missing" || i.status === "partial");
  const added = report.items.filter((i) => i.addedFromAd);
  const categoryLabel = (c: string): string =>
    c === "technical"
      ? t("autoBewerb.cvVerifyCategoryTechnical")
      : c === "soft"
        ? t("autoBewerb.cvVerifyCategorySoft")
        : c === "qualification"
          ? t("autoBewerb.cvVerifyCategoryQualification")
          : c === "language"
            ? t("autoBewerb.cvVerifyCategoryLanguage")
            : c === "education"
              ? t("autoBewerb.cvVerifyCategoryEducation")
              : t("autoBewerb.cvVerifyCategoryDocument");

  return (
    <div className={`shrink-0 rounded-2xl border px-4 py-3 ${allCovered ? "border-success/25 bg-success-soft/60" : "border-danger/25 bg-danger-soft/60"}`}>
      <div className="flex flex-wrap items-center gap-2">
        {allCovered ? (
          <CheckCircle2 size={15} className="shrink-0 text-success" />
        ) : (
          <AlertTriangle size={15} className="shrink-0 text-danger" />
        )}
        <span className={`text-sm font-semibold ${allCovered ? "text-success" : "text-danger"}`}>
          {t("autoBewerb.cvVerifyTitle")}
        </span>
        <span className="text-xs font-semibold text-muted">
          {t("autoBewerb.cvVerifyCovered", { covered: report.covered, total: report.total })}
        </span>
      </div>
      <p className="mt-1 text-xs leading-5 text-muted">
        {allCovered ? t("autoBewerb.cvVerifyAllCovered") : t("autoBewerb.cvVerifyGaps", { count: gaps.length })}
      </p>

      {/* Auto-added ad requirements — explicitly flagged for the user. */}
      {added.length > 0 && (
        <div className="mt-2 rounded-xl border border-accent/30 bg-surface-2/60 px-3 py-2">
          <p className="text-xs font-semibold text-ink">{t("autoBewerb.cvVerifyAddedTitle", { count: added.length })}</p>
          <div className="mt-1 flex flex-wrap gap-1">
            {added.map((i) => (
              <span key={`${i.category}:${i.requirement}`} className="rounded-full border border-line bg-surface px-2 py-0.5 text-[11px] font-medium text-muted">
                {i.requirement}
              </span>
            ))}
          </div>
          <p className="mt-1.5 text-[11px] leading-4 text-muted">{t("autoBewerb.cvVerifyAddedHint")}</p>
        </div>
      )}

      {/* Full per-requirement report (expanded while gaps exist). */}
      <details className="mt-2" open={!allCovered}>
        <summary className="cursor-pointer select-none text-xs font-semibold text-muted hover:text-ink">
          {t("autoBewerb.cvVerifyShowAll", { total: report.total })}
        </summary>
        <ul className="mt-2 max-h-44 space-y-1 overflow-y-auto pr-1">
          {report.items.map((i) => (
            <li key={`${i.category}:${i.requirement}`} className="flex items-start gap-1.5 text-[11px] leading-4">
              <span
                aria-hidden
                className={`mt-px shrink-0 font-bold ${
                  i.status === "covered" ? "text-success" : i.status === "info" ? "text-muted" : "text-danger"
                }`}
              >
                {i.status === "covered" ? "✓" : i.status === "info" ? "ℹ" : "✗"}
              </span>
              <span className="min-w-0 flex-1 break-words text-ink-soft">
                <span className="font-medium">{i.requirement}</span>
                <span className="text-muted"> · {categoryLabel(i.category)}</span>
                {i.section ? (
                  <span className="text-muted">
                    {" "}
                    · {t("autoBewerb.cvVerifySection")} {i.section}
                  </span>
                ) : null}
                {i.addedFromAd ? (
                  <span className="ml-1 rounded-full border border-accent/30 bg-surface px-1.5 py-px text-[10px] font-semibold text-accent">
                    {t("autoBewerb.cvVerifyAddedBadge")}
                  </span>
                ) : null}
                {i.detail ? <span className="block text-muted">{i.detail}</span> : null}
              </span>
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}

// ---------------------------------------------------------------------------

/** A preview fetch failure: HTTP status (null = body verified as NOT a PDF). */
class CvPreviewFetchError extends Error {
  constructor(
    readonly status: number | null,
    readonly truncated = false,
  ) {
    super(`CV preview fetch failed (status=${status ?? "n/a"}${truncated ? ", truncated body" : ""})`);
  }
}

/**
 * Fetch the stored CV PDF through the current session and verify that the
 * response actually IS the complete document:
 *   1. HTTP 200 (the route answers 4xx/5xx with JSON, never a fake PDF),
 *   2. `application/pdf` Content-Type,
 *   3. the `%PDF-` file signature at byte 0 — an HTML error page, a JSON
 *      error or a redirect can never be mistaken for the document,
 *   4. a COMPLETE body: when `Content-Length` is present, the received byte
 *      count must match it — a truncated response is a hard error, because
 *      a partial PDF renders as a broken document in every viewer.
 *
 * Returns the complete bytes. The SAME endpoint + renderer the Export
 * button uses (`&preview=1` only switches the disposition to inline), so
 * preview and export are byte-identical by construction.
 */
export async function fetchCvPreviewPdf(companyId: string, signal: AbortSignal): Promise<Uint8Array> {
  const res = await fetch(
    `/api/auto-bewerb/export-pdf?companyId=${encodeURIComponent(companyId)}&doc=cv&preview=1`,
    { cache: "no-store", signal },
  );
  if (!res.ok) throw new CvPreviewFetchError(res.status);
  const contentType = res.headers.get("content-type") ?? "";
  const bytes = new Uint8Array(await res.arrayBuffer());
  // "%PDF" (0x25 0x50 0x44 0x46) at byte 0 — the IETF file signature.
  const isPdf =
    bytes.length > 5 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46;
  // Diagnostics without document content: transport facts only (no body,
  // no personal data) — this is exactly the state a "broken document"
  // symptom used to hide in.
  console.info("[auto-bewerb] CV preview:", {
    status: res.status,
    contentType,
    contentLength: res.headers.get("content-length"),
    bytesReceived: bytes.byteLength,
    signature: isPdf,
  });
  if (!contentType.startsWith("application/pdf") || !isPdf) throw new CvPreviewFetchError(null);
  const contentLength = res.headers.get("content-length");
  if (contentLength !== null && Number.isInteger(Number(contentLength)) && bytes.byteLength !== Number(contentLength)) {
    throw new CvPreviewFetchError(res.status, true);
  }
  return bytes;
}

/** Last COMPLETED preview load, keyed by company:version:attempt. While
 *  `done.key` differs from the current key, the viewer is "loading". */
type CvPreviewDone =
  | { key: string; ok: true; pdf: PDFDocumentProxy }
  | { key: string; ok: false; message: string }
  | null;

/**
 * Inline CV PDF preview — NEVER downloads.
 *
 * The verified bytes (see fetchCvPreviewPdf) are rendered by pdf.js
 * DIRECTLY onto canvas elements — page by page, all pages, vertical
 * scroll, zoom. The native browser PDF viewer (iframe + blob URL) is
 * deliberately NOT used: a valid `%PDF-` signature does not guarantee
 * that PDFium can render the blob URL in this app (the gray frame with
 * the broken-document icon this fix replaces). With pdf.js, everything
 * the bytes contain is drawn, and a parse failure surfaces as the
 * explicit error state with Retry — never a gray rectangle.
 *
 * The pdf.js worker is imported as a main-thread module (registers
 * `globalThis.pdfjsWorker` → the documented "fake worker" path — the same
 * pattern the server-side extraction uses in src/lib/pdf-extract.ts): no
 * worker file to ship, resolve or load cross-origin, no CSP surface.
 *
 * States: loading (spinner, bounded by fetch + parse), error (clear
 * message + Retry — incl. an expired-session variant for 401/403), ready
 * (canvas pages). Company isolation: a stale in-flight request is
 * aborted, a stale document destroyed, and in-flight page renders
 * cancelled when the company/version/attempt changes — one company's
 * preview can never render another company's document.
 */
export function CvPdfPreview({ companyId, version, name }: { companyId: string; version: number; name: string }) {
  const { t } = useI18n();
  const [done, setDone] = useState<CvPreviewDone>(null);
  const [attempt, setAttempt] = useState(0);

  // No synchronous setState in the effect (React Compiler rule): loading is
  // DERIVED — while no load completed for the current key, we are loading.
  const key = `${companyId}:${version}:${attempt}`;
  const current = done && done.key === key ? done : null;

  useEffect(() => {
    const controller = new AbortController();
    let pdf: PDFDocumentProxy | null = null;
    const k = `${companyId}:${version}:${attempt}`;
    void (async () => {
      try {
        const bytes = await fetchCvPreviewPdf(companyId, controller.signal);
        // Worker module first (side effect: globalThis.pdfjsWorker), so
        // getDocument deterministically takes the main-thread path.
        await import("pdfjs-dist/build/pdf.worker.min.mjs");
        const pdfjs = await import("pdfjs-dist");
        if (controller.signal.aborted) return;
        pdf = await pdfjs.getDocument({ data: bytes, isEvalSupported: false }).promise;
        if (controller.signal.aborted) {
          void pdf.destroy().catch(() => undefined);
          return;
        }
        console.info("[auto-bewerb] CV preview parsed:", { pages: pdf.numPages });
        setDone({ key: k, ok: true, pdf });
      } catch (err) {
        if (controller.signal.aborted || (err instanceof DOMException && err.name === "AbortError")) return;
        const status = err instanceof CvPreviewFetchError ? err.status : null;
        setDone({
          key: k,
          ok: false,
          message:
            status === 401 || status === 403
              ? t("autoBewerb.previewSessionError")
              : t("autoBewerb.cvPreviewError"),
        });
      }
    })();
    return () => {
      controller.abort();
      if (pdf) void pdf.destroy().catch(() => undefined);
    };
  }, [companyId, version, attempt, t]);

  if (!current) {
    return (
      <div className="flex h-full min-h-[420px] w-full flex-col items-center justify-center gap-3 rounded-md bg-white">
        <Loader2 size={22} className="animate-spin text-muted" />
        <p className="text-xs font-semibold text-muted">{t("autoBewerb.cvPreviewLoading")}</p>
      </div>
    );
  }

  if (!current.ok) {
    return (
      <div className="flex h-full min-h-[420px] w-full flex-col items-center justify-center gap-3 rounded-md bg-white p-6 text-center">
        <AlertTriangle size={22} className="text-danger" />
        <p className="max-w-sm text-xs font-semibold leading-5 text-danger">{current.message}</p>
        <Button variant="secondary" size="sm" onClick={() => setAttempt((a) => a + 1)}>
          <RefreshCw size={13} /> {t("autoBewerb.retry")}
        </Button>
      </div>
    );
  }

  return <CvPdfCanvasView key={key} doc={current.pdf} name={name} />;
}

const ZOOM_MIN = 0.5;
const ZOOM_MAX = 3;
const ZOOM_STEP = 0.25;
/** Horizontal padding of the page row (`p-3` = 12px per side) — subtracted
 *  from the measured stage width so fit-to-width (100%) NEVER produces a
 *  horizontal scrollbar. */
const STAGE_PAD_X = 24;

/**
 * The parsed document as white A4 sheets on the dark stage: vertical
 * scroll, zoom (50%–300%, fit-to-width = 100%), one page per canvas.
 * `scale` = fit-to-width base ((stage width − row padding) / widest page
 * width in pt) × the user zoom — each page renders itself at that scale,
 * so the first page is immediately readable at the default zoom.
 *
 * The toolbar (page position, zoom, fit, fullscreen) is INTEGRATED into
 * the top of the document stage and stays visible while scrolling
 * (sticky). The whole viewer can enter the browser fullscreen — the CV
 * then becomes the full screen's document.
 */
function CvPdfCanvasView({ doc, name }: { doc: PDFDocumentProxy; name: string }) {
  const { t } = useI18n();
  const [zoom, setZoom] = useState(1);
  const [containerWidth, setContainerWidth] = useState(0);
  const [pageSizes, setPageSizes] = useState<{ width: number; height: number }[] | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const stageRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<HTMLDivElement>(null);
  const pageEls = useRef<Array<HTMLDivElement | null>>([]);
  const rafPending = useRef(false);

  // Measure the live stage width (no hard-coded modal width) — the fit
  // base scale follows window/modal resizing (recalculated on every
  // resize, as required).
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const measure = (w: number) => {
      if (w > 0) setContainerWidth(w);
    };
    measure(el.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => measure(entries[0]?.contentRect.width ?? el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Page sizes in PDF points (scale 1) — synchronous getViewport once the
  // page is available (getPage results are cached by pdf.js).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const sizes: { width: number; height: number }[] = [];
      for (let p = 1; p <= doc.numPages; p += 1) {
        const page = await doc.getPage(p);
        if (cancelled) return;
        const v = page.getViewport({ scale: 1 });
        sizes.push({ width: v.width, height: v.height });
      }
      if (!cancelled) setPageSizes(sizes);
    })();
    return () => {
      cancelled = true;
    };
  }, [doc]);

  // Fullscreen state (browser Fullscreen API, no extra dependency).
  useEffect(() => {
    const onFsChange = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onFsChange);
    return () => document.removeEventListener("fullscreenchange", onFsChange);
  }, []);

  const toggleFullscreen = () => {
    const el = viewRef.current;
    if (!el) return;
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => undefined);
    } else {
      void el.requestFullscreen?.().catch(() => undefined);
    }
  };

  // Current page = the page whose top is nearest at/above the stage's
  // vertical middle. rAF-throttled scroll handler (event, not effect —
  // setState here is safe).
  const handleStageScroll = () => {
    if (rafPending.current) return;
    rafPending.current = true;
    requestAnimationFrame(() => {
      rafPending.current = false;
      const stage = stageRef.current;
      if (!stage) return;
      const stageTop = stage.getBoundingClientRect().top;
      const mid = stage.clientHeight * 0.5;
      let page = 1;
      pageEls.current.forEach((el, i) => {
        if (!el) return;
        if (el.getBoundingClientRect().top - stageTop <= mid) page = i + 1;
      });
      setCurrentPage((prev) => (prev === page ? prev : page));
    });
  };

  const widest = pageSizes?.reduce((m, s) => Math.max(m, s.width), 0) ?? 0;
  const fitWidth = Math.max(0, containerWidth - STAGE_PAD_X);
  const baseScale = fitWidth > 0 && widest > 0 ? fitWidth / widest : 0;
  const scale = baseScale * zoom;

  return (
    <div
      ref={viewRef}
      className="flex h-full min-h-[420px] w-full flex-col overflow-hidden rounded-md bg-white [&:fullscreen]:min-h-0 [&:fullscreen]:rounded-none [&:fullscreen]:shadow-none"
    >
      {/* Document stage — vertical scroll (horizontal only when zoomed
          past the width). The toolbar is sticky INSIDE the stage, so it
          stays visible above the document while scrolling. */}
      <div
        ref={stageRef}
        onScroll={handleStageScroll}
        className="relative flex-1 overflow-auto bg-surface-2/40 [scrollbar-gutter:stable]"
        role="region"
        aria-label={`${name} — Lebenslauf`}
      >
        {/* Integrated toolbar: page position + zoom controls */}
        <div className="sticky top-0 z-10 flex items-center justify-between gap-2 border-b border-line/60 bg-white/95 px-2 py-1.5 backdrop-blur">
          <span
            className="flex shrink-0 items-center gap-1.5 text-[11px] font-semibold tabular-nums text-muted"
            aria-label={t("autoBewerb.cvPreviewPageLabel", { page: currentPage, count: doc.numPages })}
          >
            <FileText size={13} />
            {currentPage} / {doc.numPages}
          </span>
          <div className="flex items-center gap-0.5" role="group" aria-label={`${name} — Zoom`}>
            <button
              type="button"
              title={t("autoBewerb.cvPreviewZoomOut")}
              aria-label={t("autoBewerb.cvPreviewZoomOut")}
              disabled={zoom <= ZOOM_MIN}
              onClick={() => setZoom((z) => Math.max(ZOOM_MIN, Number((z - ZOOM_STEP).toFixed(3))))}
              className="rounded-md p-1.5 text-ink-soft transition-colors hover:bg-surface-2 disabled:opacity-40"
            >
              <ZoomOut size={14} />
            </button>
            <span className="w-10 text-center text-[11px] font-semibold tabular-nums text-ink">
              {Math.round(zoom * 100)}%
            </span>
            <button
              type="button"
              title={t("autoBewerb.cvPreviewZoomIn")}
              aria-label={t("autoBewerb.cvPreviewZoomIn")}
              disabled={zoom >= ZOOM_MAX}
              onClick={() => setZoom((z) => Math.min(ZOOM_MAX, Number((z + ZOOM_STEP).toFixed(3))))}
              className="rounded-md p-1.5 text-ink-soft transition-colors hover:bg-surface-2 disabled:opacity-40"
            >
              <ZoomIn size={14} />
            </button>
            <button
              type="button"
              title={t("autoBewerb.cvPreviewFit")}
              aria-label={t("autoBewerb.cvPreviewFit")}
              disabled={zoom === 1}
              onClick={() => setZoom(1)}
              className="rounded-md p-1.5 text-ink-soft transition-colors hover:bg-surface-2 disabled:opacity-40"
            >
              <Maximize size={14} />
            </button>
            <button
              type="button"
              title={isFullscreen ? t("autoBewerb.cvPreviewExitFullscreen") : t("autoBewerb.cvPreviewFullscreen")}
              aria-label={isFullscreen ? t("autoBewerb.cvPreviewExitFullscreen") : t("autoBewerb.cvPreviewFullscreen")}
              onClick={toggleFullscreen}
              className="rounded-md p-1.5 text-ink-soft transition-colors hover:bg-surface-2"
            >
              {isFullscreen ? <Minimize size={14} /> : <Fullscreen size={14} />}
            </button>
          </div>
        </div>

        {/* Pages — centered, A4 aspect preserved, fit-to-width initial */}
        {scale > 0 && pageSizes ? (
          <div className="mx-auto flex w-max min-w-full flex-col items-center gap-4 p-3">
            {pageSizes.map((size, i) => (
              <div
                key={i + 1}
                ref={(el) => {
                  pageEls.current[i] = el;
                }}
                className="shrink-0"
              >
                <CvPdfPage
                  doc={doc}
                  pageNumber={i + 1}
                  pageCount={doc.numPages}
                  width={size.width * scale}
                  height={size.height * scale}
                  scale={scale}
                />
              </div>
            ))}
          </div>
        ) : (
          <div className="flex h-full min-h-[320px] items-center justify-center">
            <Loader2 size={20} className="animate-spin text-muted" />
          </div>
        )}
      </div>
    </div>
  );
}

type CvPdfPageDone = { scale: number; ok: boolean } | null;

/** One page: its own canvas, its own render task (cancellable), its own
 *  done-flag DERIVED from the last completed render scale — a zoom change
 *  immediately re-arms the spinner until the new render lands. */
function CvPdfPage({
  doc,
  pageNumber,
  pageCount,
  width,
  height,
  scale,
}: {
  doc: PDFDocumentProxy;
  pageNumber: number;
  pageCount: number;
  width: number;
  height: number;
  scale: number;
}) {
  const { t } = useI18n();
  const [done, setDone] = useState<CvPdfPageDone>(null);
  const [attempt, setAttempt] = useState(0);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dpr = Math.min(typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1, 2);

  const current = done && Math.abs(done.scale - scale) < 1e-9 ? done : null;
  const rendered = current?.ok === true;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let task: RenderTask | null = null;
    let cancelled = false;
    void (async () => {
      try {
        const page = await doc.getPage(pageNumber);
        if (cancelled) return;
        const viewport = page.getViewport({ scale });
        // pdf.js v5: pass the canvas element (it acquires the 2d context
        // itself); `transform` applies the devicePixelRatio upscaling.
        task = page.render({
          canvas,
          viewport,
          transform: [dpr, 0, 0, dpr, 0, 0],
        });
        await task.promise;
        if (!cancelled) setDone({ scale, ok: true });
      } catch (err) {
        if (cancelled || (err instanceof Error && err.name === "RenderingCancelledException")) return;
        console.error("[auto-bewerb] CV preview page render failed:", { page: pageNumber, error: err });
        if (!cancelled) setDone({ scale, ok: false });
      }
    })();
    return () => {
      cancelled = true;
      try {
        task?.cancel();
      } catch {
        /* already finished */
      }
    };
  }, [doc, pageNumber, scale, dpr, attempt]);

  return (
    <div className="relative shrink-0" style={{ width: Math.floor(width), height: Math.floor(height) }}>
      <canvas
        ref={canvasRef}
        width={Math.max(1, Math.floor(width * dpr))}
        height={Math.max(1, Math.floor(height * dpr))}
        style={{ width: Math.floor(width), height: Math.floor(height) }}
        aria-label={t("autoBewerb.cvPreviewPageLabel", { page: pageNumber, count: pageCount })}
        className="block bg-white shadow-[0_2px_14px_rgba(0,0,0,0.35)]"
      />
      {!rendered && (
        <div className="absolute inset-0 flex items-center justify-center bg-white">
          {current?.ok === false ? (
            <div className="flex flex-col items-center gap-2 p-4 text-center">
              <AlertTriangle size={20} className="text-danger" />
              <p className="max-w-48 text-[11px] font-semibold leading-4 text-danger">{t("autoBewerb.cvPreviewParseError")}</p>
              <Button variant="secondary" size="sm" onClick={() => setAttempt((a) => a + 1)}>
                <RefreshCw size={12} /> {t("autoBewerb.retry")}
              </Button>
            </div>
          ) : (
            <Loader2 size={20} className="animate-spin text-muted" />
          )}
        </div>
      )}
    </div>
  );
}

function CvPreview({
  doc,
  editable,
  onChange,
}: {
  doc: CvDocument;
  editable: boolean;
  onChange?: (cv: CvDocument) => void;
}) {
  const { t } = useI18n();
  const p = doc.personal;
  const setPersonal = (patch: Partial<typeof p>) => onChange?.({ ...doc, personal: { ...p, ...patch } });
  const setSkills = (v: string) => onChange?.({ ...doc, skills: s2a(v) });
  // The document's FROZEN photo (server-owned reference or legacy data URL):
  // the ownership-checked preview route resolves it — same image the PDF
  // export renders (never a client-supplied URL).
  const photoSrc = p.photo
    ? isPhotoRef(p.photo)
      ? `/api/auto-bewerb/profile-photo?ref=${encodeURIComponent(p.photo)}`
      : p.photo
    : null;

  return (
    <div className="space-y-4">
      {/* Personal */}
      <div className="rounded-2xl border border-line bg-surface-2/40 p-4">
        <div className="flex flex-wrap items-start gap-4">
          <div className="grid flex-1 gap-3 sm:grid-cols-2">
            <Input label={t("autoBewerb.fullName")} value={p.fullName} disabled={!editable} onChange={(e) => setPersonal({ fullName: e.target.value })} />
            <Input label={t("autoBewerb.professionalTitle")} value={p.professionalTitle} disabled={!editable} onChange={(e) => setPersonal({ professionalTitle: e.target.value })} />
            <Input label={t("autoBewerb.email")} value={p.email} disabled={!editable} onChange={(e) => setPersonal({ email: e.target.value })} />
            <Input label={t("autoBewerb.phone")} value={p.phone} disabled={!editable} onChange={(e) => setPersonal({ phone: e.target.value })} />
            <Input label={t("autoBewerb.currentLocation")} value={p.location} disabled={!editable} onChange={(e) => setPersonal({ location: e.target.value })} />
            <Input label="LinkedIn" value={p.linkedin} disabled={!editable} onChange={(e) => setPersonal({ linkedin: e.target.value })} />
          </div>
          {photoSrc && (
            <img
              src={photoSrc}
              alt=""
              className="h-28 w-20 shrink-0 rounded-xl border border-line bg-surface object-cover"
            />
          )}
        </div>
      </div>

      {/* Summary */}
      {editable ? (
        <Textarea label={t("autoBewerb.summary")} rows={3} value={doc.summary} onChange={(e) => onChange?.({ ...doc, summary: e.target.value })} />
      ) : (
        doc.summary && (
          <div>
            <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-faint">{t("autoBewerb.summary")}</p>
            <p className="text-sm leading-6 text-ink-soft">{doc.summary}</p>
          </div>
        )
      )}

      {/* Education / Experience */}
      {doc.education.length > 0 && (
        <CvSection title={t("autoBewerb.educationSection")}>
          {doc.education.map((e) => (
            <div key={e.id} className="mb-2 text-sm">
              <p className="font-semibold text-ink">{[e.degree, e.institution].filter(Boolean).join(" · ") || "—"}</p>
              <p className="text-xs text-muted">{[e.location, e.start, e.end].filter(Boolean).join(" · ")}</p>
              {e.description && <p className="mt-0.5 text-xs text-ink-soft">{e.description}</p>}
            </div>
          ))}
        </CvSection>
      )}
      {doc.experience.length > 0 && (
        <CvSection title={t("autoBewerb.experienceSection")}>
          {doc.experience.map((e) => (
            <div key={e.id} className="mb-2 text-sm">
              <p className="font-semibold text-ink">{[e.jobTitle, e.company].filter(Boolean).join(" · ")}</p>
              <p className="text-xs text-muted">{[e.location, e.start, e.isCurrent ? t("autoBewerb.current") : e.end].filter(Boolean).join(" · ")}</p>
              {(e.responsibilities.length > 0 || e.achievements.length > 0) && (
                <ul className="mt-0.5 list-inside list-disc text-xs text-ink-soft">
                  {[...e.responsibilities, ...e.achievements].map((r, i) => (
                    <li key={i}>{r}</li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </CvSection>
      )}

      {/* Skills */}
      {editable ? (
        <Textarea label={t("autoBewerb.skillsSection")} hint={t("autoBewerb.commaHint")} rows={2} value={a2s(doc.skills)} onChange={(e) => setSkills(e.target.value)} />
      ) : (
        doc.skills.length > 0 && (
          <CvSection title={t("autoBewerb.skillsSection")}>
            <div className="flex flex-wrap gap-1.5">
              {doc.skills.map((s, i) => (
                <span key={i} className="rounded-full bg-surface-2 px-2.5 py-1 text-xs font-medium text-ink-soft">
                  {s}
                </span>
              ))}
            </div>
          </CvSection>
        )
      )}

      {/* Languages */}
      {doc.languages.length > 0 && (
        <CvSection title={t("autoBewerb.languagesSection")}>
          <div className="flex flex-wrap gap-1.5">
            {doc.languages.map((l, i) => (
              <span key={i} className="rounded-full bg-surface-2 px-2.5 py-1 text-xs font-medium text-ink-soft">
                {l.language}
                {l.level ? ` (${l.level})` : ""}
              </span>
            ))}
          </div>
        </CvSection>
      )}

      {/* Certificates / Projects / Interests (read-only, fact-guarded) */}
      {doc.certificates.length > 0 && (
        <CvSection title={t("autoBewerb.certificatesSection")}>
          <ul className="list-inside list-disc space-y-0.5 text-sm text-ink-soft">
            {doc.certificates.map((c, i) => (
              <li key={i}>
                {c.name}
                {c.issuer ? ` — ${c.issuer}` : ""}
                {c.date ? ` (${c.date})` : ""}
              </li>
            ))}
          </ul>
        </CvSection>
      )}
      {doc.projects.length > 0 && (
        <CvSection title={t("autoBewerb.projectsSection")}>
          <ul className="list-inside list-disc space-y-0.5 text-sm text-ink-soft">
            {doc.projects.map((pr, i) => (
              <li key={i}>
                {pr.name}
                {pr.description ? ` — ${pr.description}` : ""}
              </li>
            ))}
          </ul>
        </CvSection>
      )}
    </div>
  );
}

function CvSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-faint">{title}</p>
      {children}
    </div>
  );
}
