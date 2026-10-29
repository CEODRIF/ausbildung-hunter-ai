"use client";

/**
 * AI Bewerbung Studio — Section D (tailored Lebenslauf), Section E
 * (company-specific Anschreiben) and Section F (additional documents).
 *
 * D: generation reuses the existing `resume_ai`-metered route; the result is
 *    fact-guarded server-side (422 on invented data) and stored as a
 *    SEPARATE application document — the canonical CV in localStorage is
 *    only an input and is never overwritten.
 * E: generation reuses the existing /api/ai/cover-letter route
 *    (`cover_letter` meter); the stored letter is plain text (greeting …
 *    closing) with an inline editor + DIN 5008 print preview.
 * F: uploads go to the PRIVATE `application-attachments` bucket through the
 *    ownership-checked API (magic-byte validated, plan-capped); the
 *    checklist compares uploads against the ad's requested documents —
 *    it never claims authenticity.
 */

import { useCallback, useMemo, useRef, useState } from "react";
import { CvDocument, type CvLabels } from "@/components/cv-document";
import { CV_TEMPLATE_LIST, TEMPLATE_NAME_KEYS, type CvTemplateId } from "@/components/cv-templates";
import { Icon } from "@/components/icon";
import { Button, Input, Textarea } from "@/components/ui";
import { useI18n } from "@/lib/i18n";
import { extractSummaryText } from "@/lib/studio/prompts";
import {
  ATTACHMENT_CATEGORIES,
  type AdExtract,
  type StudioAttachmentRow,
  type StudioLetterContent,
} from "@/lib/studio/schema";
import {
  cvHasContent,
  sanitizeCvDocument,
  type CvDocument as CvDoc,
  type CvEducation,
  type CvExperience,
  type CvLanguage,
  type CvPersonal,
} from "@/lib/templates/cv";
import { BusyButton, Field, Note, SectionCard, StudioPrintRoot, usePrintClass } from "./studio-ui";
import type { ApiOutcome } from "./studio-client";

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function useCvLabels(): CvLabels {
  const { t } = useI18n();
  return useMemo<CvLabels>(
    () => ({
      summary: t("templates.docSummary"),
      experience: t("templates.docExperience"),
      education: t("templates.docEducation"),
      skills: t("templates.docSkills"),
      languages: t("templates.docLanguages"),
      certificates: t("templates.docCertificates"),
      projects: t("templates.docProjects"),
      interests: t("templates.docInterests"),
      present: t("templates.docPresent"),
      documentTitle: t("templates.docTitle"),
    }),
    [t],
  );
}

// ===========================================================================
// Section D — tailored CV
// ===========================================================================

export function CvPanel({
  active,
  applicationId,
  baseCv,
  cv,
  onCvChange,
  onSaveCv,
  onGoProfile,
}: {
  active: boolean;
  applicationId: string;
  baseCv: CvDoc | null;
  cv: CvDoc | null;
  onCvChange: (cv: CvDoc | null) => void;
  onSaveCv: (cv: CvDoc) => Promise<boolean>;
  onGoProfile: () => void;
}) {
  const { t } = useI18n();
  const labels = useCvLabels();
  const [generating, setGenerating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [factWarning, setFactWarning] = useState(false);

  usePrintClass("cv", active);

  const startFromBase = useCallback(() => {
    if (baseCv && cvHasContent(baseCv)) {
      onCvChange(sanitizeCvDocument(baseCv) as CvDoc);
      setFactWarning(false);
      setError(null);
    }
  }, [baseCv, onCvChange]);

  const generate = useCallback(
    async (templateId: CvTemplateId) => {
      if (!baseCv || !cvHasContent(baseCv)) {
        setError(t("studio.cvEmpty"));
        return;
      }
      setGenerating(true);
      setError(null);
      setFactWarning(false);
      try {
        const res = await fetch("/api/bewerbung-studio/generate-cv", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ applicationId, cv: baseCv, templateId }),
        });
        const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        if (res.status === 422) {
          setFactWarning(true);
          const base = typeof data.error === "string" ? data.error : t("studio.factWarning");
          // The server returns the exact offending fields — show them so the
          // candidate sees WHAT to fix, not just that something failed.
          const violations = Array.isArray(data.violations)
            ? (data.violations as Array<{ field?: unknown; value?: unknown }>)
            : [];
          const fields = violations
            .slice(0, 3)
            .map((v) =>
              [typeof v.field === "string" ? v.field : "", typeof v.value === "string" ? v.value : ""]
                .filter(Boolean)
                .join(": "),
            )
            .filter(Boolean)
            .join(", ");
          setError(fields ? `${base} — ${t("studio.factFields", { fields })}` : base);
          return;
        }
        if (!res.ok) {
          if (res.status === 429 && typeof data.error === "string") setError(data.error);
          else setError(typeof data.error === "string" ? data.error : t("studio.error"));
          return;
        }
        const doc = sanitizeCvDocument(data.cv);
        if (!doc) {
          setError(t("studio.analysisError"));
          return;
        }
        onCvChange(doc);
        await onSaveCv(doc);
      } catch {
        setError(t("studio.error"));
      } finally {
        setGenerating(false);
      }
    },
    [applicationId, baseCv, onCvChange, onSaveCv, t],
  );

  const save = useCallback(async () => {
    if (!cv) return;
    setSaving(true);
    await onSaveCv(cv);
    setSaving(false);
  }, [cv, onSaveCv]);

  return (
    <div className="space-y-6">
      <SectionCard
        title={t("studio.cvTitle")}
        subtitle={t("studio.cvSubtitle")}
        actions={
          cv ? (
            <>
              <select
                aria-label={t("studio.cvTitle")}
                className="rounded-lg border border-border bg-surface px-2 py-1.5 text-sm"
                value={cv.templateId}
                onChange={(e) =>
                  onCvChange({ ...cv, templateId: e.target.value as CvTemplateId })
                }
              >
                {CV_TEMPLATE_LIST.map((id) => (
                  <option key={id} value={id}>
                    {t(TEMPLATE_NAME_KEYS[id])}
                  </option>
                ))}
              </select>
              <BusyButton size="sm" variant="secondary" busy={saving} onClick={save}>
                {t("studio.saveAnalysis")}
              </BusyButton>
              <BusyButton
                size="sm"
                busy={saving}
                onClick={() => {
                  window.print();
                }}
                title={t("studio.cvPrintHint")}
              >
                <Icon name="download" size={14} />
                {t("studio.cvPrint")}
              </BusyButton>
            </>
          ) : (
            <>
              {baseCv && cvHasContent(baseCv) ? (
                <Button size="sm" variant="secondary" onClick={startFromBase}>
                  {t("studio.cvGo")}
                </Button>
              ) : (
                <Button size="sm" variant="secondary" onClick={onGoProfile}>
                  {t("studio.profileGo")}
                </Button>
              )}
              <BusyButton
                size="sm"
                busy={generating}
                onClick={() => generate("modern")}
                disabled={!baseCv || !cvHasContent(baseCv)}
              >
                {generating ? t("studio.cvGenerating") : t("studio.cvGenerate")}
              </BusyButton>
            </>
          )
        }
      >
        {!baseCv || !cvHasContent(baseCv) ? (
          <Note kind="warning">
            {t("studio.cvEmpty")}{" "}
            <button type="button" className="font-medium underline" onClick={onGoProfile}>
              {t("studio.cvGo")}
            </button>
          </Note>
        ) : null}
        {error ? (
          <div className="mt-3">
            <Note kind="danger">{error}</Note>
          </div>
        ) : null}
        {factWarning ? (
          <div className="mt-3">
            <Note kind="warning">{t("studio.factWarning")}</Note>
          </div>
        ) : null}
        {cv ? (
          <>
            <div className="mt-4">
              <CvEditor cv={cv} onChange={onCvChange} />
            </div>
            <div className="mt-6 overflow-x-auto rounded-xl border border-border bg-white p-2">
              <div className="mx-auto" style={{ width: 794 }}>
                <CvDocument cv={cv} labels={labels} />
              </div>
            </div>
          </>
        ) : (
          <p className="mt-3 text-sm text-muted">{t("studio.noCv")}</p>
        )}
        {active && cv ? (
          <StudioPrintRoot>
            <CvDocument cv={cv} labels={labels} />
          </StudioPrintRoot>
        ) : null}
      </SectionCard>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Compact inline CV editor (all generated fields are editable)
// ---------------------------------------------------------------------------

function CvEditor({ cv, onChange }: { cv: CvDoc; onChange: (cv: CvDoc) => void }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);

  const setPersonal = (patch: Partial<CvPersonal>) =>
    onChange({ ...cv, personal: { ...cv.personal, ...patch } });
  const setSummary = (value: string) => onChange({ ...cv, summary: value });
  const setSkills = (value: string) =>
    onChange({ ...cv, skills: value.split(",").map((s) => s.trim()).filter(Boolean) });

  const updateEducation = (id: string, patch: Partial<CvEducation>) =>
    onChange({
      ...cv,
      education: cv.education.map((e) => (e.id === id ? { ...e, ...patch } : e)),
    });
  const addEducation = () =>
    onChange({
      ...cv,
      education: [
        ...cv.education,
        { id: crypto.randomUUID(), degree: "", institution: "", location: "", start: "", end: "", description: "" },
      ],
    });
  const removeEducation = (id: string) =>
    onChange({ ...cv, education: cv.education.filter((e) => e.id !== id) });

  const updateExperience = (id: string, patch: Partial<CvExperience>) =>
    onChange({
      ...cv,
      experience: cv.experience.map((x) => (x.id === id ? { ...x, ...patch } : x)),
    });
  const addExperience = () =>
    onChange({
      ...cv,
      experience: [
        ...cv.experience,
        {
          id: crypto.randomUUID(),
          jobTitle: "",
          company: "",
          location: "",
          start: "",
          end: "",
          isCurrent: false,
          responsibilities: [],
          achievements: [],
        },
      ],
    });
  const removeExperience = (id: string) =>
    onChange({ ...cv, experience: cv.experience.filter((x) => x.id !== id) });

  const updateLanguage = (id: string, patch: Partial<CvLanguage>) =>
    onChange({
      ...cv,
      languages: cv.languages.map((l) => (l.id === id ? { ...l, ...patch } : l)),
    });
  const addLanguage = () =>
    onChange({ ...cv, languages: [...cv.languages, { id: crypto.randomUUID(), language: "", level: "" }] });
  const removeLanguage = (id: string) =>
    onChange({ ...cv, languages: cv.languages.filter((l) => l.id !== id) });

  const p = cv.personal;
  return (
    <div className="rounded-xl border border-border">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between px-4 py-2.5 text-sm font-semibold"
        aria-expanded={open}
      >
        {t("studio.editPersonal")}
        <Icon name="chevron" size={16} className={open ? "rotate-180" : ""} />
      </button>
      {open ? (
        <div className="grid gap-3 border-t border-border p-4 sm:grid-cols-2">
          <Field id="stcv-name" label="Name">
            <Input id="stcv-name" value={p.fullName} onChange={(e) => setPersonal({ fullName: e.target.value })} />
          </Field>
          <Field id="stcv-title" label="Berufsbezeichnung">
            <Input id="stcv-title" value={p.professionalTitle} onChange={(e) => setPersonal({ professionalTitle: e.target.value })} />
          </Field>
          <Field id="stcv-email" label="E-Mail">
            <Input id="stcv-email" type="email" value={p.email} onChange={(e) => setPersonal({ email: e.target.value })} />
          </Field>
          <Field id="stcv-phone" label="Telefon">
            <Input id="stcv-phone" value={p.phone} onChange={(e) => setPersonal({ phone: e.target.value })} />
          </Field>
          <Field id="stcv-loc" label="Wohnort">
            <Input id="stcv-loc" value={p.location} onChange={(e) => setPersonal({ location: e.target.value })} />
          </Field>
          <Field id="stcv-li" label="LinkedIn">
            <Input id="stcv-li" value={p.linkedin} onChange={(e) => setPersonal({ linkedin: e.target.value })} />
          </Field>
          <div className="sm:col-span-2">
            <Field id="stcv-summary" label={t("studio.editSummary")}>
              <Textarea id="stcv-summary" rows={3} value={cv.summary} onChange={(e) => setSummary(e.target.value)} />
            </Field>
          </div>

          <h4 className="sm:col-span-2 text-sm font-semibold">{t("studio.editEducation")}</h4>
          {cv.education.map((e) => (
            <div key={e.id} className="grid gap-2 sm:col-span-2 sm:grid-cols-2">
              <Input aria-label="Abschluss" value={e.degree} onChange={(ev) => updateEducation(e.id, { degree: ev.target.value })} placeholder="Abschluss" />
              <Input aria-label="Schule/Universität" value={e.institution} onChange={(ev) => updateEducation(e.id, { institution: ev.target.value })} placeholder="Einrichtung" />
              <Input aria-label="Beginn" value={e.start} onChange={(ev) => updateEducation(e.id, { start: ev.target.value })} placeholder="von" />
              <Input aria-label="Ende" value={e.end} onChange={(ev) => updateEducation(e.id, { end: ev.target.value })} placeholder="bis" />
              <button
                type="button"
                onClick={() => removeEducation(e.id)}
                className="inline-flex items-center gap-1 text-xs text-danger sm:col-span-2"
              >
                <Icon name="trash" size={12} /> {t("studio.delete")}
              </button>
            </div>
          ))}
          <button type="button" onClick={addEducation} className="text-sm font-medium text-primary sm:col-span-2">
            + {t("studio.addEducation")}
          </button>

          <h4 className="sm:col-span-2 mt-2 text-sm font-semibold">{t("studio.editExperience")}</h4>
          {cv.experience.map((x) => (
            <div key={x.id} className="grid gap-2 sm:col-span-2 sm:grid-cols-2">
              <Input aria-label="Position" value={x.jobTitle} onChange={(ev) => updateExperience(x.id, { jobTitle: ev.target.value })} placeholder="Position" />
              <Input aria-label="Arbeitgeber" value={x.company} onChange={(ev) => updateExperience(x.id, { company: ev.target.value })} placeholder="Arbeitgeber" />
              <Input aria-label="Beginn" value={x.start} onChange={(ev) => updateExperience(x.id, { start: ev.target.value })} placeholder="von" />
              <Input aria-label="Ende" value={x.end} onChange={(ev) => updateExperience(x.id, { end: ev.target.value, isCurrent: false })} placeholder="bis" />
              <label className="flex items-center gap-2 text-sm sm:col-span-2">
                <input
                  type="checkbox"
                  checked={x.isCurrent}
                  onChange={(ev) => updateExperience(x.id, { isCurrent: ev.target.checked })}
                />
                Aktuelle Tätigkeit
              </label>
              <button
                type="button"
                onClick={() => removeExperience(x.id)}
                className="inline-flex items-center gap-1 text-xs text-danger sm:col-span-2"
              >
                <Icon name="trash" size={12} /> {t("studio.delete")}
              </button>
            </div>
          ))}
          <button type="button" onClick={addExperience} className="text-sm font-medium text-primary sm:col-span-2">
            + {t("studio.addExperience")}
          </button>

          <div className="sm:col-span-2">
            <Field id="stcv-skills" label={t("studio.editSkills")}>
              <Input id="stcv-skills" value={cv.skills.join(", ")} onChange={(e) => setSkills(e.target.value)} />
            </Field>
          </div>
          <h4 className="sm:col-span-2 text-sm font-semibold">{t("studio.editLanguages")}</h4>
          {cv.languages.map((l) => (
            <div key={l.id} className="grid gap-2 sm:col-span-2 sm:grid-cols-2">
              <Input aria-label="Sprache" value={l.language} onChange={(ev) => updateLanguage(l.id, { language: ev.target.value })} placeholder="Sprache" />
              <div className="flex gap-2">
                <Input aria-label="Niveau" value={l.level} onChange={(ev) => updateLanguage(l.id, { level: ev.target.value })} placeholder="Niveau (z. B. C1)" />
                <button type="button" onClick={() => removeLanguage(l.id)} className="shrink-0 rounded-lg border border-danger/30 px-2 text-danger" aria-label={t("studio.delete")}>
                  <Icon name="trash" size={14} />
                </button>
              </div>
            </div>
          ))}
          <button type="button" onClick={addLanguage} className="text-sm font-medium text-primary sm:col-span-2">
            + {t("studio.addEducation")}
          </button>
        </div>
      ) : null}
    </div>
  );
}

// ===========================================================================
// Section E — cover letter
// ===========================================================================

export function LetterPanel({
  active,
  extract,
  adRaw,
  baseCv,
  letter,
  onLetterChange,
  onSaveLetter,
}: {
  active: boolean;
  extract: AdExtract | null;
  adRaw: string;
  baseCv: CvDoc | null;
  letter: StudioLetterContent | null;
  onLetterChange: (l: StudioLetterContent | null) => void;
  onSaveLetter: (l: StudioLetterContent) => Promise<boolean>;
}) {
  const { t } = useI18n();
  const [generating, setGenerating] = useState(false);
  const [improving, setImproving] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  usePrintClass("letter", active);

  const callApi = useCallback(
    async (mode: "generate" | "improve"): Promise<ApiOutcome<{ text: string }>> => {
      try {
        const res = await fetch("/api/ai/cover-letter", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            mode,
            position: extract?.jobTitle || extract?.occupation || "",
            company: extract?.company || "",
            jobDescription: extract ? extractSummaryText(extract) : adRaw.slice(0, 8000),
            tone: "professional",
            language: "de",
            cv: baseCv,
            body: mode === "improve" && letter ? letter.text.slice(0, 12000) : "",
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
        if (typeof data.text !== "string" || !data.text.trim())
          return { ok: false, code: "empty", error: t("studio.error") };
        return { ok: true, value: { text: data.text } };
      } catch {
        return { ok: false, code: "network", error: t("studio.error") };
      }
    },
    [extract, adRaw, baseCv, letter, t],
  );

  const generate = useCallback(async () => {
    setGenerating(true);
    setError(null);
    const out = await callApi("generate");
    setGenerating(false);
    if (!out.ok) {
      setError(out.code === "quota_exhausted" ? t("studio.quotaError") : out.error);
      return;
    }
    onLetterChange({ text: out.value.text, tone: "professional" });
  }, [callApi, onLetterChange, t]);

  const improve = useCallback(async () => {
    if (!letter) return;
    setImproving(true);
    setError(null);
    const out = await callApi("improve");
    setImproving(false);
    if (!out.ok) {
      setError(out.code === "quota_exhausted" ? t("studio.quotaError") : out.error);
      return;
    }
    onLetterChange({ ...letter, text: out.value.text });
  }, [callApi, letter, onLetterChange, t]);

  const save = useCallback(async () => {
    if (!letter) return;
    setSaving(true);
    await onSaveLetter(letter);
    setSaving(false);
  }, [letter, onSaveLetter]);

  const toneLabel: Record<StudioLetterContent["tone"], string> = {
    professional: "Professionell",
    formal: "Formell",
    engaged: "Engagiert",
  };

  return (
    <SectionCard
      title={t("studio.letterTitle")}
      subtitle={t("studio.letterSubtitle")}
      actions={
        letter ? (
          <>
            <span className="text-xs text-muted">{toneLabel[letter.tone] ?? letter.tone}</span>
            <BusyButton size="sm" variant="secondary" busy={improving} onClick={improve}>
              {t("studio.letterImprove")}
            </BusyButton>
            <BusyButton size="sm" variant="secondary" busy={saving} onClick={save}>
              {t("studio.saveAnalysis")}
            </BusyButton>
            <BusyButton
              size="sm"
              onClick={() => window.print()}
              title={t("studio.cvPrintHint")}
            >
              <Icon name="download" size={14} />
              {t("studio.letterPrint")}
            </BusyButton>
          </>
        ) : (
          <BusyButton
            size="sm"
            busy={generating}
            onClick={generate}
            disabled={!baseCv || !cvHasContent(baseCv) || !extract}
            title={!extract ? t("studio.noAnalysis") : t("studio.cvEmpty")}
          >
            {generating ? t("studio.letterGenerating") : t("studio.letterGenerate")}
          </BusyButton>
        )
      }
    >
      {error ? (
        <div className="mb-3">
          <Note kind="danger">{error}</Note>
        </div>
      ) : null}
      {letter ? (
        <>
          <Textarea
            id="studio-letter-text"
            aria-label={t("studio.letterTitle")}
            value={letter.text}
            onChange={(e) => onLetterChange({ ...letter, text: e.target.value })}
            rows={14}
            className="text-sm leading-6"
          />
          <div className="mt-4 rounded-xl border border-border bg-white p-6" style={{ fontFamily: "Georgia, 'Times New Roman', serif" }}>
            <div className="space-y-4 whitespace-pre-line text-sm text-neutral-900">
              {letter.text.split(/\n{2,}/).map((para, i) => (
                <p key={i}>{para}</p>
              ))}
            </div>
          </div>
          <p className="mt-3 text-xs text-muted">{t("studio.letterConsistency")}</p>
          {active ? (
            <StudioPrintRoot>
              <div className="studio-letter-sheet">
                <p>{letter.text}</p>
              </div>
            </StudioPrintRoot>
          ) : null}
        </>
      ) : (
        <p className="text-sm text-muted">{t("studio.noLetter")}</p>
      )}
    </SectionCard>
  );
}

// ===========================================================================
// Section F — additional documents
// ===========================================================================

const CATEGORY_KEYS: Record<string, string> = {
  school_certificate: "studio.catSchool",
  professional_qualification: "studio.catProfessional",
  language_certificate: "studio.catLanguage",
  reference: "studio.catReference",
  other: "studio.catOther",
};

export function DocsPanel({
  extract,
  atts,
  onUpload,
  onRename,
  onDelete,
}: {
  extract: AdExtract | null;
  atts: StudioAttachmentRow[];
  onUpload: (file: File, category: string) => Promise<ApiOutcome<StudioAttachmentRow>>;
  onRename: (id: string, name: string) => Promise<boolean>;
  onDelete: (id: string) => Promise<boolean>;
}) {
  const { t } = useI18n();
  const [category, setCategory] = useState<string>("other");
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const handleFile = useCallback(
    async (file: File | null) => {
      if (!file) return;
      setUploading(true);
      setError(null);
      const out = await onUpload(file, category);
      setUploading(false);
      if (!out.ok) setError(out.error);
      if (fileRef.current) fileRef.current.value = "";
    },
    [onUpload, category],
  );

  const requested = extract?.requestedDocuments ?? [];
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  const attNames = atts.map((a) => norm(a.display_name));
  const catNorms: Array<[string, string]> = [
    ["zeugnis", "schule"],
    ["note", "schule"],
    ["abschl", "professional"],
    ["sprach", "language"],
    ["arbeitszeugnis", "reference"],
    ["referenz", "reference"],
  ];

  return (
    <div className="space-y-6">
      <SectionCard
        title={t("studio.docsTitle")}
        subtitle={t("studio.docsSubtitle")}
        actions={
          <div className="flex items-center gap-2">
            <select
              aria-label={t("studio.docsCategory")}
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="rounded-lg border border-border bg-surface px-2 py-1.5 text-sm"
            >
              {ATTACHMENT_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {t(CATEGORY_KEYS[c] ?? "studio.catOther")}
                </option>
              ))}
            </select>
            <BusyButton size="sm" busy={uploading} onClick={() => fileRef.current?.click()}>
              <Icon name="upload" size={14} />
              {t("studio.docsUpload")}
            </BusyButton>
            <input
              ref={fileRef}
              type="file"
              accept=".pdf,.doc,.docx,.png,.jpg,.jpeg"
              className="hidden"
              aria-hidden="true"
              tabIndex={-1}
              onChange={(e) => handleFile(e.target.files?.[0] ?? null)}
            />
          </div>
        }
      >
        <p className="mb-3 text-xs text-muted">{t("studio.docsUploadHint")}</p>
        {error ? (
          <div className="mb-3">
            <Note kind="danger">{error}</Note>
          </div>
        ) : null}
        {atts.length === 0 ? (
          <p className="text-sm text-muted">{t("studio.docsEmpty")}</p>
        ) : (
          <ul className="divide-y divide-border">
            {atts.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                <div className="flex min-w-0 items-center gap-2">
                  <Icon name="file" size={16} className="shrink-0 text-muted" />
                  {renaming === a.id ? (
                    <form
                      className="flex items-center gap-2"
                      onSubmit={async (e) => {
                        e.preventDefault();
                        if (!renameValue.trim()) return;
                        setBusyId(a.id);
                        const ok = await onRename(a.id, renameValue);
                        setBusyId(null);
                        if (ok) setRenaming(null);
                      }}
                    >
                      <Input
                        value={renameValue}
                        onChange={(e) => setRenameValue(e.target.value)}
                        className="max-w-52"
                        aria-label={t("studio.rename")}
                      />
                      <Button size="sm" type="submit" disabled={busyId === a.id}>
                        {t("studio.saveAnalysis")}
                      </Button>
                    </form>
                  ) : (
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{a.display_name}</p>
                      <p className="text-xs text-muted">
                        {t(CATEGORY_KEYS[a.doc_category] ?? "studio.catOther")} · {formatBytes(a.size_bytes)}
                      </p>
                    </div>
                  )}
                </div>
                {renaming !== a.id ? (
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      className="rounded-lg p-1.5 text-muted hover:bg-surface-2 hover:text-foreground"
                      onClick={() => {
                        setRenaming(a.id);
                        setRenameValue(a.display_name);
                      }}
                      aria-label={t("studio.rename")}
                    >
                      <Icon name="edit" size={14} />
                    </button>
                    <button
                      type="button"
                      className="rounded-lg p-1.5 text-danger hover:bg-danger/10"
                      disabled={busyId === a.id}
                      onClick={async () => {
                        setBusyId(a.id);
                        await onDelete(a.id);
                        setBusyId(null);
                      }}
                      aria-label={t("studio.delete")}
                    >
                      <Icon name="trash" size={14} />
                    </button>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        <div className="mt-4">
          <Note kind="info">{t("studio.docsUnverified")}</Note>
        </div>
      </SectionCard>

      {requested.length > 0 ? (
        <SectionCard title={t("studio.checkTitle")}>
          <ul className="space-y-2">
            {requested.map((req, i) => {
              const rn = norm(req);
              const hit = attNames.find((an) => {
                if (rn.includes(an) || an.includes(rn)) return true;
                // loose category hints (Zeugnis → schulzeugnis etc.)
                for (const [word, kind] of catNorms) {
                  if (rn.includes(word)) {
                    const cat = atts.find((a) => a.doc_category === kind && norm(a.display_name) === an);
                    if (cat) return true;
                  }
                }
                return false;
              });
              return (
                <li key={i} className="flex items-center justify-between gap-3 rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm">
                  <span>{req}</span>
                  {hit ? (
                    <span className="flex items-center gap-1.5 text-xs font-medium text-success">
                      <Icon name="check" size={12} /> {t("studio.reqUploaded")}
                    </span>
                  ) : (
                    <span className="flex items-center gap-1.5 text-xs font-medium text-danger">
                      <Icon name="x" size={12} /> {t("studio.reqMissing")}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </SectionCard>
      ) : null}
    </div>
  );
}
