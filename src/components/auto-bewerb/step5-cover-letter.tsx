"use client";

import { useState } from "react";
import { CheckCheck, Download, FileText, Mail, Sparkles } from "lucide-react";
import { Button, Textarea } from "@/components/ui";
import { EmptyState } from "@/components/ui/feedback";
import { useI18n } from "@/lib/i18n";
import type { AutoBewerbLetter } from "@/lib/auto-bewerb/schema";
import {
  markDocumentReviewedAction,
  saveCompanyDocumentAction,
} from "@/app/auto-bewerb/actions";
import { CompanyPicker, Note, SectionCard, companyLabel, useAutoBewerb } from "./shared";

/**
 * Step 5 — individualized Anschreiben per company (German business letter).
 * Generation: POST /api/auto-bewerb/generate-letter {companyId, currentText}
 * (regeneration is anchored on the user's current wording when present).
 * The draft is local until saved (per-company versioned row); the PDF renders
 * the SAVED version with the account letterhead server-side.
 */
export function Step5CoverLetter() {
  const { ws, refresh, notify, companyId, selectCompany, drafts, setDraft, goToStep } = useAutoBewerb();
  const { t } = useI18n();
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [reviewing, setReviewing] = useState(false);

  if (ws.companies.length === 0) {
    return <EmptyState title={t("autoBewerb.letterGenEmpty")} body={t("autoBewerb.letterGenEmptyBody")} illustration={<Mail size={34} strokeWidth={1.6} />} ctaIcon={<Button variant="primary" onClick={() => goToStep(2)}>{t("autoBewerb.goToCompanies")}</Button>} />;
  }

  const active = ws.companies.find((c) => c.company.id === companyId) ?? ws.companies[0];
  const row = active.company;
  const draft = companyId ? (drafts.letter[companyId] ?? null) : null;
  const shown: AutoBewerbLetter | null = draft ?? active.letter;
  const hasSaved = Boolean(active.letter);
  const reviewed = Boolean(row.letter_reviewed_at);
  const { name, job } = companyLabel(row);

  const generate = async (isRegen: boolean) => {
    setGenerating(true);
    setGenError(null);
    try {
      const res = await fetch("/api/auto-bewerb/generate-letter", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companyId: active.company.id, currentText: draft?.text }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; letter?: AutoBewerbLetter };
      if (!res.ok || !data.letter) {
        setGenError(data.error ?? t("autoBewerb.generateError"));
      } else {
        setDraft("letter", active.company.id, data.letter);
        notify("success", isRegen ? t("autoBewerb.regeneratedNote") : t("autoBewerb.generatedNote"));
      }
    } catch {
      setGenError(t("autoBewerb.generateError"));
    } finally {
      setGenerating(false);
    }
  };

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    const res = await saveCompanyDocumentAction(active.company.id, "cover_letter", {
      text: draft.text,
      tone: draft.tone,
    });
    setSaving(false);
    if (res.ok) {
      setDraft("letter", active.company.id, null);
      await refresh();
      notify("success", t("autoBewerb.docSavedVersion", { version: res.value.version }));
    } else {
      notify("error", t("autoBewerb.saveError"));
    }
  };

  const markReviewed = async () => {
    setReviewing(true);
    const res = await markDocumentReviewedAction(active.company.id, "cover_letter");
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
        title={t("autoBewerb.letterGenTitle")}
        aside={
          <div className="flex flex-wrap items-center gap-2">
            {draft && <Note kind="info">{t("autoBewerb.letterUnsavedNote")}</Note>}
            {hasSaved && (
              <span className="text-xs font-semibold text-muted">{t("autoBewerb.cvVersion", { version: active.letterVersion ?? 1 })}</span>
            )}
            {reviewed && !draft && (
              <span className="inline-flex items-center gap-1 text-xs font-semibold text-success">
                <CheckCheck size={13} /> {t("autoBewerb.docReviewedNote")}
              </span>
            )}
            <Button variant="secondary" size="sm" onClick={() => void generate(false)} disabled={generating || !ws.profile?.extracted}>
              <Sparkles size={14} />
              {generating ? t("autoBewerb.generatingButton") : hasSaved ? t("autoBewerb.regenerateButton") : t("autoBewerb.generateLetterButton")}
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
                onClick={() => window.open(`/api/auto-bewerb/export-pdf?companyId=${encodeURIComponent(active.company.id)}&doc=letter`, "_blank")}
              >
                <Download size={14} />
                {t("autoBewerb.exportPdfButton")}
              </Button>
            )}
          </div>
        }
      >
        <p className="mb-4 text-xs text-muted">
          {t("autoBewerb.letterFor", { company: name, job: job || "—" })}
        </p>
        {genError && (
          <div className="mb-4">
            <Note kind="error">{genError}</Note>
          </div>
        )}
        {shown ? (
          draft ? (
            <Textarea
              label={t("autoBewerb.letterPreviewTitle")}
              rows={18}
              value={draft.text}
              onChange={(e) => setDraft("letter", active.company.id, { ...draft, text: e.target.value })}
              className="font-mono text-[13px] leading-6"
            />
          ) : (
            <div className="rounded-2xl border border-line bg-surface-2/30 p-5">
              <p className="whitespace-pre-wrap font-serif text-sm leading-7 text-ink-soft">{shown.text}</p>
            </div>
          )
        ) : (
          <div className="flex flex-col items-center gap-3 py-10 text-center">
            <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-surface-2 text-muted">
              <FileText size={24} strokeWidth={1.6} />
            </span>
            <p className="max-w-sm text-sm text-muted">{t("autoBewerb.letterNotGenerated")}</p>
          </div>
        )}
      </SectionCard>
    </div>
  );
}
