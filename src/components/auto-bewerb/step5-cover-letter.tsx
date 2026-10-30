"use client";

import { useState } from "react";
import { AlertTriangle, Check, CheckCircle2, Download, Eye, Loader2, Mail, Pencil, RefreshCw, Sparkles } from "lucide-react";
import { Button, Modal, Textarea } from "@/components/ui";
import { EmptyState } from "@/components/ui/feedback";
import { useI18n } from "@/lib/i18n";
import type { AutoBewerbCompanyView, AutoBewerbLetter } from "@/lib/auto-bewerb/schema";
import {
  markDocumentReviewedAction,
  saveCompanyDocumentAction,
} from "@/app/auto-bewerb/actions";
import { companyLabel, Note, SectionCard, useAutoBewerb } from "./shared";
import { LetterPdfPreview } from "./letter-pdf-preview";

/**
 * Step 5 — BULK individualized cover letters (Anschreiben) for ALL companies.
 *
 * Same UX and interaction pattern as Step 4 (Tailored CV Generation): one
 * action generates + SAVES an individualized letter for every company in
 * the workflow, sequentially (bounded: one AI call in flight at a time —
 * the existing per-company quota reservation, rate limits and the
 * single-flight guard of the generate-letter route apply to every call).
 * Each letter is persisted via saveCompanyDocumentAction BEFORE it counts
 * as successful; a failure in one company never stops the others and can
 * be retried individually.
 *
 * Companies that already have a saved letter are skipped (a valid letter
 * is never overwritten). The per-company preview shows the SAVED letter on
 * its actual A4 PDF pages (inline, never a download); PDF export renders
 * that company's saved letter server-side (same bytes as the preview).
 *
 * Content: the letter is built server-side from the verified candidate
 * profile + the company's full advertisement + extracted requirements +
 * the stored profile-vs-ad match analysis — individualized per company,
 * never a swapped-name template (see buildAutoBewerbLetterPrompt).
 */
export function Step5CoverLetter() {
  const { ws, refresh, notify, drafts, setDraft, goToStep } = useAutoBewerb();
  const { t } = useI18n();

  /** Per-company in-flight / failure state (saved letters derive from ws).
   *  A string value is the ACTUAL error message to display. */
  const [perCompany, setPerCompany] = useState<Record<string, "generating" | string>>({});
  /** Bulk run progress (null = never started / finished and summarized). */
  const [bulk, setBulk] = useState<{ total: number; done: number; failed: number; currentId: string | null; finished: boolean } | null>(null);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<"doc" | "edit">("doc");
  const [saving, setSaving] = useState(false);
  const [reviewing, setReviewing] = useState(false);

  const running = Boolean(bulk && !bulk.finished);
  const targets = ws.companies.filter((c) => !c.letter);

  if (ws.companies.length === 0) {
    return <EmptyState title={t("autoBewerb.letterGenEmpty")} body={t("autoBewerb.letterGenEmptyBody")} illustration={<Mail size={34} strokeWidth={1.6} />} ctaIcon={<Button variant="primary" onClick={() => goToStep(2)}>{t("autoBewerb.goToCompanies")}</Button>} />;
  }

  /** Generate AND persist one company's letter. Resolves to `null` on
   *  success (only after the server confirmed the save) or the ACTUAL
   *  error message (provider / quota / network / persistence). */
  const generateOne = async (view: AutoBewerbCompanyView): Promise<string | null> => {
    // Regeneration is anchored on the user's current wording when present
    // (the unsaved draft for THIS company — never another company's).
    const draftText = drafts.letter[view.company.id]?.text;
    try {
      const res = await fetch("/api/auto-bewerb/generate-letter", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companyId: view.company.id, currentText: draftText }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; letter?: AutoBewerbLetter };
      if (!res.ok || !data.letter) return data.error ?? t("autoBewerb.generateError");
      const saveRes = await saveCompanyDocumentAction(view.company.id, "cover_letter", data.letter);
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
   *  on a single failure, skips companies that already have a saved
   *  letter (no unnecessary overwrite). */
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

  /** Retry ONE failed company — successful letters are never regenerated. */
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
    return c.letter ? "ready" : "none";
  };

  // --- per-company preview (independent; keyed by company id) -------------
  const previewView = previewId ? (ws.companies.find((c) => c.company.id === previewId) ?? null) : null;
  const previewDraft = previewView ? (drafts.letter[previewView.company.id] ?? null) : null;
  const savedLetter: AutoBewerbLetter | null = previewView?.letter ?? null;
  const previewReviewed = Boolean(previewView?.company.letter_reviewed_at);
  // The saved-letter document view is the wide "document workspace" modal;
  // the edit view stays in the compact dialog (same split as Step 4).
  const showDocWorkspace = Boolean(savedLetter && viewMode === "doc" && !previewDraft);

  const openPreview = (c: AutoBewerbCompanyView, mode: "doc" | "edit") => {
    setPreviewId(c.company.id);
    setViewMode(mode);
    // Edit seeds an editable draft from the SAVED letter (nothing is
    // overwritten silently — the explicit Save creates a NEW version).
    if (mode === "edit" && c.letter && !drafts.letter[c.company.id]) {
      setDraft("letter", c.company.id, { ...c.letter });
    }
  };

  const savePreview = async () => {
    if (!previewView || !previewDraft) return;
    setSaving(true);
    const res = await saveCompanyDocumentAction(previewView.company.id, "cover_letter", previewDraft);
    setSaving(false);
    if (res.ok) {
      setDraft("letter", previewView.company.id, null);
      await refresh();
      notify("success", t("autoBewerb.docSavedVersion", { version: res.value.version }));
    } else notify("error", t("autoBewerb.saveError"));
  };

  const markPreviewReviewed = async () => {
    if (!previewView) return;
    setReviewing(true);
    const res = await markDocumentReviewedAction(previewView.company.id, "cover_letter");
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
      <SectionCard title={t("autoBewerb.letterBulkTitle")} className="bg-gradient-to-br from-accent-soft/40 via-surface to-surface">
        <p className="max-w-2xl text-sm leading-6 text-muted">{t("autoBewerb.letterBulkDesc")}</p>

        <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-4">
          <Button
            variant="primary"
            onClick={() => void generateAll()}
            disabled={running || targets.length === 0 || !ws.profile?.extracted}
            className="w-full sm:w-auto"
          >
            {running ? <Loader2 size={16} className="animate-spin" /> : <Sparkles size={16} />}
            {running ? t("autoBewerb.letterBulkRunning") : t("autoBewerb.letterBulkButton")}
          </Button>
          <span className="text-sm font-medium text-muted">
            {targets.length > 0
              ? t("autoBewerb.letterBulkCount", { count: targets.length })
              : t("autoBewerb.letterBulkAllDone")}
          </span>
        </div>

        {/* Live progress */}
        {bulk && !bulk.finished && (
          <div className="mt-5 rounded-2xl border border-line bg-surface-2/50 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2 text-sm font-semibold">
              <span className="text-ink">
                {t("autoBewerb.letterBulkProgress", { done: bulk.done, total: bulk.total })}
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
              {t("autoBewerb.letterBulkOk", { count: bulk.done - bulk.failed })}
              {bulk.failed > 0 && <> · {t("autoBewerb.letterBulkFailedSummary", { count: bulk.failed })}</>}
            </p>
          </div>
        )}

        {/* Completion summary */}
        {bulk?.finished && (
          <div className="mt-5">
            {bulk.failed === 0 ? (
              <Note kind="success">{t("autoBewerb.letterBulkOk", { count: bulk.done })}</Note>
            ) : (
              <Note kind="error">
                {t("autoBewerb.letterBulkOk", { count: bulk.done - bulk.failed })} · {t("autoBewerb.letterBulkFailedSummary", { count: bulk.failed })}
              </Note>
            )}
          </div>
        )}
      </SectionCard>

      {/* ------------------------------------------------------------------ */}
      {/* Companies list                                                     */}
      {/* ------------------------------------------------------------------ */}
      <SectionCard title={t("autoBewerb.letterCompaniesTitle", { count: ws.companies.length })}>
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
                      <AlertTriangle size={13} /> {t("autoBewerb.letterStatusNone")}
                    </span>
                  )}
                  {st === "generating" && (
                    <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-accent">
                      <Loader2 size={13} className="animate-spin" /> {t("autoBewerb.letterStatusGenerating")}
                    </span>
                  )}
                  {st === "ready" && (
                    <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-success">
                      <CheckCircle2 size={13} /> {t("autoBewerb.letterStatusReady")}
                    </span>
                  )}
                  {st === "failed" && (
                    <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-danger">
                      <AlertTriangle size={13} /> {t("autoBewerb.letterStatusFailed")}
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
                      <RefreshCw size={13} /> {t("autoBewerb.letterRetry")}
                    </Button>
                  ) : null}
                  <Button
                    variant={st === "ready" ? "secondary" : "ghost"}
                    size="sm"
                    onClick={() => openPreview(c, "doc")}
                    disabled={st !== "ready"}
                    title={st !== "ready" ? t("autoBewerb.letterPreviewDisabledHint") : undefined}
                  >
                    <Eye size={13} /> {t("autoBewerb.letterPreviewButton")}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => openPreview(c, "edit")}
                    disabled={st !== "ready"}
                    title={st !== "ready" ? t("autoBewerb.letterPreviewDisabledHint") : undefined}
                  >
                    <Pencil size={13} /> {t("autoBewerb.letterEditButton")}
                  </Button>
                  {st === "ready" && (
                    <Button
                      variant="ghost"
                      size="sm"
                      title={t("autoBewerb.exportPdfButton")}
                      onClick={() => window.open(`/api/auto-bewerb/export-pdf?companyId=${encodeURIComponent(c.company.id)}&doc=letter`, "_blank")}
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
      {/* Per-company letter preview modal (saved version, editable as draft) */}
      {/* ------------------------------------------------------------------ */}
      <Modal
        open={Boolean(previewView && (savedLetter || previewDraft))}
        onClose={() => setPreviewId(null)}
        title={previewView ? companyLabel(previewView.company).name : ""}
        size={showDocWorkspace ? "wide" : "form"}
      >
        {previewView && (savedLetter || previewDraft) && (
          <div className="flex min-h-0 flex-1 flex-col gap-3">
            {/* Stable toolbar — never scrolls away: document state + the
                Document/Edit switch, Export PDF, Save, Mark as reviewed. */}
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              {previewDraft && <Note kind="info">{t("autoBewerb.letterUnsavedNote")}</Note>}
              {!previewDraft && savedLetter && (
                <span className="text-xs font-semibold text-muted">{t("autoBewerb.cvVersion", { version: previewView.letterVersion ?? 1 })}</span>
              )}
              {previewReviewed && !previewDraft && (
                <span className="inline-flex items-center gap-1 text-xs font-semibold text-success">
                  <Check size={13} /> {t("autoBewerb.docReviewedNote")}
                </span>
              )}
              <div className="ml-auto flex items-center gap-2">
                {savedLetter && (
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
                        onClick={() => {
                          setViewMode("edit");
                          if (!previewDraft) setDraft("letter", previewView.company.id, { ...savedLetter });
                        }}
                        className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors ${viewMode === "edit" ? "bg-surface text-ink shadow-sm" : "text-muted hover:text-ink-soft"}`}
                      >
                        {t("autoBewerb.cvEditView")}
                      </button>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      title={t("autoBewerb.exportPdfButton")}
                      onClick={() => window.open(`/api/auto-bewerb/export-pdf?companyId=${encodeURIComponent(previewView.company.id)}&doc=letter`, "_blank")}
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
                {savedLetter && !previewDraft && !previewReviewed && (
                  <Button variant="secondary" size="sm" onClick={() => void markPreviewReviewed()} disabled={reviewing}>
                    <Check size={13} /> {t("autoBewerb.docReviewMark")}
                  </Button>
                )}
              </div>
            </div>

            {/* A4 document view — the ACTUAL saved letter PDF (the same
                bytes the export serves), rendered by pdf.js onto canvases:
                white A4 folio pages, zoom + scroll, NEVER downloaded. */}
            {savedLetter && viewMode === "doc" && !previewDraft ? (
              <div className="flex min-h-0 flex-1 flex-col gap-2">
                {/* The dark stage fills the modal height — the letter is
                    the main visual focus, not a small inset. */}
                <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl bg-ink/70 p-2 sm:p-3">
                  <LetterPdfPreview
                    companyId={previewView.company.id}
                    version={previewView.letterVersion ?? 0}
                    name={companyLabel(previewView.company).name}
                  />
                </div>
                <p className="shrink-0 text-xs text-faint">{t("autoBewerb.letterDocViewHint")}</p>
              </div>
            ) : (
              /* Edit view: the form scrolls INSIDE the capped dialog —
                 the header + toolbar above stay visible at all times. */
              <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
                {savedLetter && viewMode === "doc" && previewDraft && (
                  <Note kind="info">{t("autoBewerb.cvDocDraftNote")}</Note>
                )}
                <Textarea
                  label={t("autoBewerb.letterPreviewTitle")}
                  rows={18}
                  value={(previewDraft ?? savedLetter)!.text}
                  onChange={(e) =>
                    previewDraft
                      ? setDraft("letter", previewView.company.id, { ...previewDraft, text: e.target.value })
                      : undefined
                  }
                  className="font-serif text-[13px] leading-6"
                />
              </div>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}
