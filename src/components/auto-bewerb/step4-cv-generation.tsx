"use client";

import { useEffect, useState, type ReactNode } from "react";
import { AlertTriangle, Check, CheckCircle2, Download, Eye, FileText, Loader2, RefreshCw, Sparkles } from "lucide-react";
import { Button, Input, Modal, Textarea } from "@/components/ui";
import { EmptyState } from "@/components/ui/feedback";
import { useI18n } from "@/lib/i18n";
import type { CvDocument } from "@/lib/templates/cv";
import { isPhotoRef } from "@/lib/auto-bewerb/profile-photo";
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
      >
        {previewView && previewDoc && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
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

            {/* A4 document view — the ACTUAL PDF (same bytes as the export),
                white page on the dark app, native zoom + scroll + pages.
                Rendered via CvPdfPreview: the bytes are fetched through the
                SAME session, verified, and shown inline — never downloaded. */}
            {previewView.cv && viewMode === "doc" && !previewDraft ? (
              <div className="space-y-2">
                <div className="overflow-hidden rounded-xl bg-ink/70 p-2 sm:p-3">
                  <CvPdfPreview
                    companyId={previewView.company.id}
                    version={previewView.cvVersion ?? 0}
                    name={companyLabel(previewView.company).name}
                  />
                </div>
                <p className="text-xs text-faint">{t("autoBewerb.cvDocViewHint")}</p>
              </div>
            ) : (
              <>
                {previewDraft && previewView.cv && viewMode === "doc" && (
                  <Note kind="info">{t("autoBewerb.cvDocDraftNote")}</Note>
                )}
                <CvPreview doc={previewDoc} editable={Boolean(previewDraft)} onChange={previewDraft ? (patch) => setDraft("cv", previewView.company.id, patch) : undefined} />
              </>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}

// ---------------------------------------------------------------------------

/** Last COMPLETED preview load, keyed by company:version:attempt. While
 *  `done.key` differs from the current key, the viewer is "loading". */
type CvPreviewDone =
  | { key: string; ok: true; url: string }
  | { key: string; ok: false; message: string }
  | null;

/**
 * Inline CV PDF preview — NEVER downloads.
 *
 * The SAME endpoint the Export button uses is fetched through the current
 * session (`&preview=1` → `Content-Disposition: inline`), the response is
 * VERIFIED before rendering (HTTP status + `application/pdf` + the `%PDF-`
 * file signature — so an HTML error page, a JSON error or a redirect can
 * never be mistaken for the document), and only then is it shown in the
 * native PDF viewer via a blob URL (zoom + scroll + all pages work).
 *
 * States: loading (spinner, bounded by the fetch), error (clear message +
 * Retry — incl. an expired-session variant for 401/403), ready (iframe).
 * A stale in-flight request is aborted and its blob URL revoked when the
 * company/version changes — one company's preview can never render
 * another company's document.
 */
function CvPdfPreview({ companyId, version, name }: { companyId: string; version: number; name: string }) {
  const { t } = useI18n();
  const [done, setDone] = useState<CvPreviewDone>(null);
  const [attempt, setAttempt] = useState(0);

  // No synchronous setState in the effect (React Compiler rule): loading is
  // DERIVED — while no load completed for the current key, we are loading.
  const key = `${companyId}:${version}:${attempt}`;
  const current = done && done.key === key ? done : null;

  useEffect(() => {
    const controller = new AbortController();
    let objectUrl: string | null = null;
    let httpStatus: number | null = null;
    const k = `${companyId}:${version}:${attempt}`;
    void (async () => {
      try {
        const res = await fetch(
          `/api/auto-bewerb/export-pdf?companyId=${encodeURIComponent(companyId)}&doc=cv&preview=1`,
          { cache: "no-store", signal: controller.signal },
        );
        if (!res.ok) {
          httpStatus = res.status;
          throw new Error(`status ${res.status}`);
        }
        const contentType = res.headers.get("content-type") ?? "";
        const bytes = new Uint8Array(await res.arrayBuffer());
        // "%PDF" (0x25 0x50 0x44 0x46) at byte 0 — the IETF file signature.
        const isPdf =
          bytes.length > 5 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46;
        if (!contentType.startsWith("application/pdf") || !isPdf) {
          throw new Error("response is not a PDF document");
        }
        objectUrl = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
        setDone({ key: k, ok: true, url: objectUrl });
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setDone({
          key: k,
          ok: false,
          message:
            httpStatus === 401 || httpStatus === 403
              ? t("autoBewerb.previewSessionError")
              : t("autoBewerb.cvPreviewError"),
        });
      }
    })();
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
    }, [companyId, version, attempt, t]);

  if (!current) {
    return (
      <div className="flex h-[75vh] min-h-[480px] w-full flex-col items-center justify-center gap-3 rounded-md bg-white">
        <Loader2 size={22} className="animate-spin text-muted" />
        <p className="text-xs font-semibold text-muted">{t("autoBewerb.cvPreviewLoading")}</p>
      </div>
    );
  }

  if (!current.ok) {
    return (
      <div className="flex h-[75vh] min-h-[480px] w-full flex-col items-center justify-center gap-3 rounded-md bg-white p-6 text-center">
        <AlertTriangle size={22} className="text-danger" />
        <p className="max-w-sm text-xs font-semibold leading-5 text-danger">{current.message}</p>
        <Button variant="secondary" size="sm" onClick={() => setAttempt((a) => a + 1)}>
          <RefreshCw size={13} /> {t("autoBewerb.retry")}
        </Button>
      </div>
    );
  }

  return (
    <iframe
      src={current.url}
      title={`${name} — Lebenslauf`}
      className="h-[75vh] min-h-[480px] w-full rounded-md bg-white"
    />
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
