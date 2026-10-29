"use client";

import { useState, type ReactNode } from "react";
import { CheckCheck, Download, FileText, RefreshCw, Sparkles } from "lucide-react";
import { Button, Input, Textarea } from "@/components/ui";
import { EmptyState } from "@/components/ui/feedback";
import { useI18n } from "@/lib/i18n";
import type { CvDocument } from "@/lib/templates/cv";
import {
  markDocumentReviewedAction,
  saveCompanyDocumentAction,
} from "@/app/auto-bewerb/actions";
import { CompanyPicker, Note, SectionCard, useAutoBewerb } from "./shared";

const s2a = (s: string): string[] => s.split(/[,;\n]/).map((x) => x.trim()).filter(Boolean);
const a2s = (a: string[]): string => a.join(", ");

/**
 * Step 4 — tailored CV per company.
 *
 * Generation: POST /api/auto-bewerb/generate-cv {companyId} → local draft
 * (fast preview, clearly "unsaved"). Persistence: saveCompanyDocumentAction
 * (versioned row per company — regenerating company A never touches B).
 * PDF export renders the SAVED, reviewed version server-side.
 */
export function Step4CvGeneration() {
  const { ws, refresh, notify, companyId, selectCompany, drafts, setDraft, goToStep } = useAutoBewerb();
  const { t } = useI18n();
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [reviewing, setReviewing] = useState(false);

  if (ws.companies.length === 0) {
    return <EmptyState title={t("autoBewerb.cvGenEmpty")} body={t("autoBewerb.cvGenEmptyBody")} illustration={<FileText size={34} strokeWidth={1.6} />} ctaIcon={<Button variant="primary" onClick={() => goToStep(2)}>{t("autoBewerb.goToCompanies")}</Button>} />;
  }

  const active = ws.companies.find((c) => c.company.id === companyId) ?? ws.companies[0];
  const row = active.company;
  const draft = companyId ? (drafts.cv[companyId] ?? null) : null;
  const shown: CvDocument | null = draft ?? active.cv;
  const hasSaved = Boolean(active.cv);
  const reviewed = Boolean(row.cv_reviewed_at);

  const generate = async (isRegen: boolean) => {
    if (!active) return;
    setGenerating(true);
    setGenError(null);
    try {
      const res = await fetch("/api/auto-bewerb/generate-cv", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companyId: active.company.id }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; code?: string; cv?: CvDocument };
      if (!res.ok || !data.cv) {
        setGenError(
          data.code === "fact_violations"
            ? t("autoBewerb.cvFactGuardError")
            : data.error ?? t("autoBewerb.generateError"),
        );
      } else {
        setDraft("cv", active.company.id, data.cv);
        notify("success", isRegen ? t("autoBewerb.regeneratedNote") : t("autoBewerb.generatedNote"));
      }
    } catch {
      setGenError(t("autoBewerb.generateError"));
    } finally {
      setGenerating(false);
    }
  };

  const save = async () => {
    if (!active || !draft) return;
    setSaving(true);
    const res = await saveCompanyDocumentAction(active.company.id, "cv", draft);
    setSaving(false);
    if (res.ok) {
      setDraft("cv", active.company.id, null);
      await refresh();
      notify("success", t("autoBewerb.docSavedVersion", { version: res.value.version }));
    } else {
      notify("error", t("autoBewerb.saveError"));
    }
  };

  const markReviewed = async () => {
    if (!active) return;
    setReviewing(true);
    const res = await markDocumentReviewedAction(active.company.id, "cv");
    setReviewing(false);
    if (res.ok) {
      await refresh();
      notify("success", t("autoBewerb.docReviewedNote"));
    } else notify("error", t("autoBewerb.saveError"));
  };

  return (
    <div className="space-y-5">
      <CompanyPicker value={companyId} onChange={selectCompany} />

      {!ws.profile?.extracted && (
        <Note kind="error">
          {t("autoBewerb.profileRequired")}{" "}
          <button type="button" className="font-semibold text-accent underline underline-offset-2" onClick={() => goToStep(1)}>
            {t("autoBewerb.goToStep1")}
          </button>
        </Note>
      )}

      <SectionCard
        title={t("autoBewerb.cvGenTitle")}
        aside={
          <div className="flex flex-wrap items-center gap-2">
            {draft && <Note kind="info">{t("autoBewerb.cvUnsavedNote")}</Note>}
            {hasSaved && (
              <span className="text-xs font-semibold text-muted">{t("autoBewerb.cvVersion", { version: active.cvVersion ?? 1 })}</span>
            )}
            {reviewed && !draft && (
              <span className="inline-flex items-center gap-1 text-xs font-semibold text-success">
                <CheckCheck size={13} /> {t("autoBewerb.docReviewedNote")}
              </span>
            )}
            <Button variant="secondary" size="sm" onClick={() => void generate(false)} disabled={generating || !ws.profile?.extracted}>
              <Sparkles size={14} />
              {generating ? t("autoBewerb.generatingButton") : hasSaved ? t("autoBewerb.regenerateButton") : t("autoBewerb.generateCvButton")}
            </Button>
            {draft && (
              <Button variant="primary" size="sm" onClick={() => void save()} disabled={saving}>
                {t("autoBewerb.docSaveButton")}
              </Button>
            )}
            {hasSaved && !draft && !reviewed && (
              <Button variant="secondary" size="sm" onClick={() => void markReviewed()} disabled={reviewing}>
                <CheckCheck size={14} />
                {t("autoBewerb.docReviewMark")}
              </Button>
            )}
            {hasSaved && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => window.open(`/api/auto-bewerb/export-pdf?companyId=${encodeURIComponent(active.company.id)}&doc=cv`, "_blank")}
              >
                <Download size={14} />
                {t("autoBewerb.exportPdfButton")}
              </Button>
            )}
          </div>
        }
      >
        {genError && (
          <div className="mb-4">
            <Note kind="error">{genError}</Note>
          </div>
        )}
        {!shown ? (
          <div className="flex flex-col items-center gap-3 py-10 text-center">
            <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-surface-2 text-muted">
              <RefreshCw size={24} strokeWidth={1.6} />
            </span>
            <p className="max-w-sm text-sm text-muted">{t("autoBewerb.cvNotGenerated")}</p>
          </div>
        ) : (
          <CvPreview doc={shown} editable={Boolean(draft)} onChange={draft ? (patch) => setDraft("cv", active.company.id, patch) : undefined} />
        )}
      </SectionCard>
    </div>
  );
}

// ---------------------------------------------------------------------------

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

  return (
    <div className="space-y-4">
      {/* Personal */}
      <div className="rounded-2xl border border-line bg-surface-2/40 p-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Input label={t("autoBewerb.fullName")} value={p.fullName} disabled={!editable} onChange={(e) => setPersonal({ fullName: e.target.value })} />
          <Input label={t("autoBewerb.professionalTitle")} value={p.professionalTitle} disabled={!editable} onChange={(e) => setPersonal({ professionalTitle: e.target.value })} />
          <Input label={t("autoBewerb.email")} value={p.email} disabled={!editable} onChange={(e) => setPersonal({ email: e.target.value })} />
          <Input label={t("autoBewerb.phone")} value={p.phone} disabled={!editable} onChange={(e) => setPersonal({ phone: e.target.value })} />
          <Input label={t("autoBewerb.currentLocation")} value={p.location} disabled={!editable} onChange={(e) => setPersonal({ location: e.target.value })} />
          <Input label="LinkedIn" value={p.linkedin} disabled={!editable} onChange={(e) => setPersonal({ linkedin: e.target.value })} />
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
