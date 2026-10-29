"use client";

/**
 * AI Bewerbung Studio — Section A (ad input + verified extraction) and
 * Section B (requirements vs. profile) and Section C (candidate profile).
 *
 * The pasted advertisement is UNTRUSTED: it only reaches the AI as fenced
 * data (see src/lib/studio/prompts.ts) and the structured result is
 * zod-validated server-side before it lands here. The user reviews and
 * corrects every extracted field before it is used for generation.
 */

import { useCallback, useState } from "react";
import Link from "next/link";
import { Icon } from "@/components/icon";
import { Button, Input, Textarea } from "@/components/ui";
import { useI18n } from "@/lib/i18n";
import type { CandidateProfile } from "@/lib/bewerbung-schema";
import { type AdAnalysis, type AdExtract } from "@/lib/studio/schema";
import { cvHasContent, type CvDocument } from "@/lib/templates/cv";
import { BusyButton, Field, Note, SectionCard } from "./studio-ui";
import type { ApiOutcome } from "./studio-client";

// ---------------------------------------------------------------------------
// Extraction field edit helpers
// ---------------------------------------------------------------------------

const EMPTY_EXTRACT: AdExtract = {
  jobTitle: "",
  occupation: "",
  company: "",
  companyAddress: "",
  location: "",
  startDate: "",
  applicationDeadline: "",
  requiredQualifications: [],
  preferredQualifications: [],
  technicalSkills: [],
  softSkills: [],
  languageRequirements: [],
  educationRequirement: "",
  responsibilities: [],
  requestedDocuments: [],
  applicationMethod: "",
  contactPerson: "",
  applicationEmail: "",
  companyNotes: [],
  missingOrAmbiguous: [],
};

function linesToText(lines: string[]): string {
  return lines.filter((l) => l.trim()).join("\n");
}

function textToLines(value: string): string[] {
  return value.split("\n").map((l) => l.trim()).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Section A + B
// ---------------------------------------------------------------------------

export function AnalysisPanel({
  mode,
  adText,
  onAdTextChange,
  onAnalyze,
  onCreate,
  extract,
  analysis,
  onExtractChange,
  onPersist,
  onGoProfile,
}: {
  mode: "new" | "edit";
  adText: string;
  onAdTextChange: (v: string) => void;
  onAnalyze: (text: string) => Promise<ApiOutcome<{ extract: AdExtract; analysis: AdAnalysis }>>;
  /** New mode only: create the application from the analysis. */
  onCreate: ((text: string, extract: AdExtract, analysis: AdAnalysis | null) => Promise<boolean>) | null;
  extract: AdExtract | null;
  analysis: AdAnalysis | null;
  onExtractChange: (e: AdExtract) => void;
  /** Edit mode: persist extract+analysis into the existing application. */
  onPersist: (extract: AdExtract, analysis: AdAnalysis | null) => Promise<boolean>;
  onGoProfile: () => void;
}) {
  const { t } = useI18n();
  const [analyzing, setAnalyzing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [createBusy, setCreateBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<AdExtract | null>(extract);
  /** Re-analysis result pending in EDIT mode (applied on explicit save —
   *  re-analysis must never overwrite persisted data silently). */
  const [pendingAnalysis, setPendingAnalysis] = useState<AdAnalysis | null | undefined>(undefined);

  const tooShort = adText.trim().length < 40;

  const handleAnalyze = useCallback(async () => {
    if (tooShort) return;
    setAnalyzing(true);
    setError(null);
    const outcome = await onAnalyze(adText);
    setAnalyzing(false);
    if (!outcome.ok) {
      if (outcome.code === "quota_exhausted") setError(t("studio.quotaError"));
      else setError(outcome.error);
      return;
    }
    if (mode === "new") {
      // New application: the extraction becomes the working extract
      // immediately (nothing is persisted until onCreate succeeds).
      onExtractChange(outcome.value.extract);
    }
    setDraft(outcome.value.extract);
    setPendingAnalysis(outcome.value.analysis);
    if (mode === "new" && onCreate) {
      // Create immediately — the analysis is the point of no return for a
      // fresh application. The user can still correct every field afterwards.
      setCreateBusy(true);
      const created = await onCreate(adText, outcome.value.extract, outcome.value.analysis);
      setCreateBusy(false);
      if (!created) setError(t("studio.error"));
    }
  }, [adText, tooShort, onAnalyze, onExtractChange, onCreate, mode, t]);

  const handleSave = useCallback(async () => {
    if (!draft) return;
    setSaving(true);
    const ok = await onPersist(draft, pendingAnalysis !== undefined ? pendingAnalysis : analysis);
    setSaving(false);
    setPendingAnalysis(undefined);
    if (!ok) setError(t("studio.error"));
    else setError(null);
  }, [draft, analysis, pendingAnalysis, onPersist, t]);

  const set = (patch: Partial<AdExtract>) => setDraft((d) => ({ ...(d ?? EMPTY_EXTRACT), ...patch }));
  const setArr = (key: keyof AdExtract, value: string) =>
    set({ [key]: textToLines(value) } as Partial<AdExtract>);

  const d = draft ?? EMPTY_EXTRACT;
  const missingCount = analysis?.missing.length ?? 0;

  return (
    <div className="space-y-6">
      {/* ---- A: raw advertisement ------------------------------------- */}
      <SectionCard
        title={t("studio.adTitle")}
        subtitle={t("studio.adSubtitle")}
        actions={
          mode === "edit" ? (
            <BusyButton
              size="sm"
              variant="secondary"
              busy={analyzing}
              disabled={tooShort}
              onClick={handleAnalyze}
              title={tooShort ? t("studio.adTooShort") : undefined}
            >
              {analyzing ? t("studio.analyzing") : t("studio.analyzeButton")}
            </BusyButton>
          ) : undefined
        }
      >
        <Textarea
          id="studio-ad-text"
          value={adText}
          onChange={(e) => onAdTextChange(e.target.value)}
          placeholder={t("studio.adPlaceholder")}
          rows={10}
          className="font-mono text-xs leading-5"
          aria-describedby={tooShort ? "studio-ad-too-short" : undefined}
        />
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-muted">
            {adText.trim().length} / 20000
            {tooShort ? (
              <span id="studio-ad-too-short" className="ml-2 text-danger">
                {t("studio.adTooShort")}
              </span>
            ) : null}
          </p>
          {mode === "new" ? (
            <BusyButton
              busy={analyzing || createBusy}
              disabled={tooShort}
              onClick={handleAnalyze}
              title={tooShort ? t("studio.adTooShort") : undefined}
            >
              {analyzing || createBusy ? t("studio.analyzing") : t("studio.analyzeButton")}
            </BusyButton>
          ) : null}
        </div>
        <Note kind="info">
          Der Anzeigentext wird nur als Datenmaterial verarbeitet — Anweisungen in
          eingefügten Texten (z. B. „ignoriere vorherige Regeln“) werden nicht befolgt.
        </Note>
        {error ? <div className="mt-3"><Note kind="danger">{error}</Note></div> : null}
      </SectionCard>

      {/* ---- A/B: verified extraction + profile match ------------------ */}
      {(extract || draft) && (
        <SectionCard
          title={t("studio.fieldsTitle")}
          actions={
            mode === "edit" ? (
              <BusyButton size="sm" variant="secondary" busy={saving} onClick={handleSave}>
                {t("studio.saveAnalysis")}
              </BusyButton>
            ) : undefined
          }
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="st-jobTitle" label={t("studio.fJobTitle")}>
              <Input id="st-jobTitle" value={d.jobTitle} onChange={(e) => set({ jobTitle: e.target.value })} />
            </Field>
            <Field id="st-occupation" label={t("studio.fOccupation")}>
              <Input id="st-occupation" value={d.occupation} onChange={(e) => set({ occupation: e.target.value })} />
            </Field>
            <Field id="st-company" label={t("studio.fCompany")}>
              <Input id="st-company" value={d.company} onChange={(e) => set({ company: e.target.value })} />
            </Field>
            <Field id="st-location" label={t("studio.fLocation")}>
              <Input id="st-location" value={d.location} onChange={(e) => set({ location: e.target.value })} />
            </Field>
            <Field id="st-address" label={t("studio.fAddress")}>
              <Input id="st-address" value={d.companyAddress} onChange={(e) => set({ companyAddress: e.target.value })} />
            </Field>
            <Field id="st-startDate" label={t("studio.fStartDate")}>
              <Input id="st-startDate" value={d.startDate} onChange={(e) => set({ startDate: e.target.value })} />
            </Field>
            <Field id="st-deadline" label={t("studio.fDeadline")}>
              <Input id="st-deadline" value={d.applicationDeadline} onChange={(e) => set({ applicationDeadline: e.target.value })} />
            </Field>
            <Field id="st-method" label={t("studio.fApplicationMethod")}>
              <Input id="st-method" value={d.applicationMethod} onChange={(e) => set({ applicationMethod: e.target.value })} />
            </Field>
            <Field id="st-contact" label={t("studio.fContactPerson")}>
              <Input id="st-contact" value={d.contactPerson} onChange={(e) => set({ contactPerson: e.target.value })} />
            </Field>
            <Field id="st-email" label={t("studio.fEmail")}>
              <Input id="st-email" type="email" value={d.applicationEmail} onChange={(e) => set({ applicationEmail: e.target.value })} />
            </Field>
            <div className="sm:col-span-2">
              <Field id="st-quals" label={t("studio.fQualifications")}>
                <Textarea id="st-quals" rows={4} value={linesToText(d.requiredQualifications)} onChange={(e) => setArr("requiredQualifications", e.target.value)} />
              </Field>
            </div>
            <div className="sm:col-span-2">
              <Field id="st-resp" label={t("studio.fResponsibilities")}>
                <Textarea id="st-resp" rows={4} value={linesToText(d.responsibilities)} onChange={(e) => setArr("responsibilities", e.target.value)} />
              </Field>
            </div>
            <div className="sm:col-span-2">
              <Field id="st-docs" label={t("studio.fRequestedDocs")}>
                <Textarea id="st-docs" rows={3} value={linesToText(d.requestedDocuments)} onChange={(e) => setArr("requestedDocuments", e.target.value)} />
              </Field>
            </div>
          </div>
          {mode === "edit" ? (
            <div className="mt-4 flex justify-end">
              <BusyButton busy={saving} onClick={handleSave}>
                {t("studio.saveAnalysis")}
              </BusyButton>
            </div>
          ) : null}
        </SectionCard>
      )}

      {/* ---- B: profile comparison -------------------------------------- */}
      {analysis && (
        <SectionCard
          title={t("studio.matchTitle")}
          actions={
            <div className="text-right">
              <p className="text-xs font-medium text-muted">{t("studio.matchScore")}</p>
              <p className="text-xl font-semibold text-primary">{analysis.matchScore} %</p>
            </div>
          }
        >
          <p className="mb-4 text-xs text-muted">{t("studio.matchScoreNote")}</p>
          <div className="grid gap-4 lg:grid-cols-3">
            <MatchList title={t("studio.matchedLabel")} items={analysis.matched} tone="ok" />
            <MatchList title={t("studio.missingLabel")} items={analysis.missing} tone="warn" />
            <MatchList title={t("studio.transferableLabel")} items={analysis.transferable} tone="info" />
          </div>
          {analysis.weaknesses.length > 0 ? (
            <div className="mt-4">
              <h3 className="mb-1 text-sm font-semibold">{t("studio.weaknesses")}</h3>
              <ul className="list-disc space-y-1 pl-5 text-sm text-muted">
                {analysis.weaknesses.map((w, i) => <li key={i}>{w}</li>)}
              </ul>
            </div>
          ) : null}
          {analysis.recommendations.length > 0 ? (
            <div className="mt-4">
              <h3 className="mb-1 text-sm font-semibold">{t("studio.recommendations")}</h3>
              <ul className="list-disc space-y-1 pl-5 text-sm text-muted">
                {analysis.recommendations.map((r, i) => <li key={i}>{r}</li>)}
              </ul>
            </div>
          ) : null}
          {analysis.questions.length > 0 ? (
            <div className="mt-4">
              <h3 className="mb-1 text-sm font-semibold">{t("studio.questions")}</h3>
              <ul className="list-disc space-y-1 pl-5 text-sm">
                {analysis.questions.map((q, i) => <li key={i}>{q}</li>)}
              </ul>
            </div>
          ) : null}
          {d.missingOrAmbiguous.length > 0 ? (
            <div className="mt-4">
              <h3 className="mb-1 text-sm font-semibold">{t("studio.missingTitle")}</h3>
              <ul className="list-disc space-y-1 pl-5 text-sm text-warning">
                {d.missingOrAmbiguous.map((m, i) => <li key={i}>{m}</li>)}
              </ul>
            </div>
          ) : null}
          <div className="mt-5 flex items-center gap-3">
            <Button size="sm" onClick={onGoProfile}>
              {t("studio.stepProfile")}
              <Icon name="arrowRight" size={14} />
            </Button>
            {missingCount > 0 ? (
              <span className="text-xs text-muted">
                {missingCount} {t("studio.missingLabel").toLowerCase()}
              </span>
            ) : null}
          </div>
        </SectionCard>
      )}
    </div>
  );
}

function MatchList({
  title,
  items,
  tone,
}: {
  title: string;
  items: AdAnalysis["matched"];
  tone: "ok" | "warn" | "info";
}) {
  const dot = { ok: "bg-success", warn: "bg-danger", info: "bg-primary" }[tone];
  return (
    <div className="rounded-xl border border-border bg-surface-2 p-3">
      <h3 className="mb-2 text-sm font-semibold">{title}</h3>
      {items.length === 0 ? (
        <p className="text-xs text-muted">—</p>
      ) : (
        <ul className="space-y-1.5">
          {items.map((m, i) => (
            <li key={i} className="text-sm">
              <span className={`mr-2 inline-block h-2 w-2 rounded-full ${dot}`} />
              <span className="font-medium">{m.requirement}</span>
              {m.note ? <span className="block pl-4 text-xs text-muted">{m.note}</span> : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Section C — candidate profile (verified facts only)
// ---------------------------------------------------------------------------

export function ProfilePanel({
  userFacts,
  baseCv,
  scannerProfile,
  onGoCv,
}: {
  userFacts: {
    fullName: string;
    email: string;
    phone: string | null;
    location: string | null;
    linkedin: string | null;
  };
  baseCv: CvDocument | null;
  scannerProfile: CandidateProfile | null;
  onGoCv: () => void;
}) {
  const { t } = useI18n();
  const hasCv = baseCv ? cvHasContent(baseCv) : false;

  const rows: Array<[string, string | null | undefined]> = [
    [t("studio.fromProfile"), userFacts.fullName || null],
    ["E-Mail", userFacts.email || null],
    ["Telefon", userFacts.phone],
    ["Wohnort", userFacts.location],
    ["LinkedIn", userFacts.linkedin],
  ];

  return (
    <div className="space-y-6">
      <SectionCard title={t("studio.profileTitle")} subtitle={t("studio.profileSubtitle")}>
        <dl className="grid gap-3 sm:grid-cols-2">
          {rows
            .filter(([, v]) => v)
            .map(([k, v], i) => (
              <div key={i} className="rounded-xl border border-border bg-surface-2 p-3">
                <dt className="text-xs font-medium text-muted">{k}</dt>
                <dd className="mt-0.5 text-sm">{v}</dd>
              </div>
            ))}
        </dl>
        <div className="mt-4 flex flex-wrap gap-2">
          <Link
            href="/dashboard/templates"
            className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm font-medium hover:bg-surface-2"
          >
            <Icon name="edit" size={14} />
            {t("studio.profileGo")}
          </Link>
        </div>
      </SectionCard>

      {hasCv ? (
        <SectionCard title={t("studio.fromCv")} subtitle={t("studio.cvLinked")}>
          <ul className="grid gap-2 text-sm sm:grid-cols-2">
            {baseCv!.education.length > 0 ? (
              <li className="rounded-lg bg-surface-2 p-2">
                {baseCv!.education.length} × {t("studio.editEducation").toLowerCase()}
              </li>
            ) : null}
            {baseCv!.experience.length > 0 ? (
              <li className="rounded-lg bg-surface-2 p-2">
                {baseCv!.experience.length} × {t("studio.editExperience").toLowerCase()}
              </li>
            ) : null}
            {baseCv!.skills.filter(Boolean).length > 0 ? (
              <li className="rounded-lg bg-surface-2 p-2">
                {baseCv!.skills.filter(Boolean).length} × {t("studio.editSkills").toLowerCase()}
              </li>
            ) : null}
            {baseCv!.languages.filter((l) => l.language).length > 0 ? (
              <li className="rounded-lg bg-surface-2 p-2">
                {baseCv!.languages.filter((l) => l.language).length} × {t("studio.editLanguages").toLowerCase()}
              </li>
            ) : null}
          </ul>
          <div className="mt-4">
            <Button size="sm" onClick={onGoCv}>
              {t("studio.stepCv")}
              <Icon name="arrowRight" size={14} />
            </Button>
          </div>
        </SectionCard>
      ) : (
        <Note kind="warning">
          {t("studio.cvEmpty")}{" "}
          <Link href="/dashboard/templates" className="font-medium underline">
            {t("studio.cvGo")}
          </Link>
        </Note>
      )}

      {scannerProfile ? (
        <SectionCard title={t("studio.fromScanner")}>
          <p className="text-sm text-muted">
            {scannerProfile.education.filter((e) => e.degree || e.school || e.university).length} ×{" "}
            {t("studio.editEducation").toLowerCase()} ·{" "}
            {scannerProfile.candidate.full_name ?? "—"}
          </p>
        </SectionCard>
      ) : null}
    </div>
  );
}
