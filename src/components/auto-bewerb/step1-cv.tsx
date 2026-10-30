"use client";

import { useRef, useState } from "react";
import { FileText, Image as ImageIcon, RefreshCw, Trash2, UploadCloud } from "lucide-react";
import { Button, Input, Modal, Textarea } from "@/components/ui";
import { EmptyState } from "@/components/ui/feedback";
import { useI18n } from "@/lib/i18n";
import type { CandidateProfile } from "@/lib/bewerbung-schema";
import {
  deleteProfileAction,
  saveProfileExtractAction,
} from "@/app/auto-bewerb/actions";
import { Note, SectionCard, useAutoBewerb, useSaveFlash } from "./shared";

const ACCEPT = ".pdf,.doc,.docx,.png,.jpg,.jpeg";
const PHOTO_ACCEPT = ".jpg,.jpeg,.png,.webp";
const PHOTO_MAX_BYTES = 5 * 1024 * 1024;
/** Client pre-check only — the server re-validates from magic bytes. */
const PHOTO_CLIENT_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);
/** Same-origin, cookie-authenticated preview (private bucket, no public URL). */
const photoPreviewUrl = (uploadedAt: string) => `/api/auto-bewerb/profile-photo?ts=${encodeURIComponent(uploadedAt)}`;

/** Compact byte size (de-style). */
function fmtSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fmtDate(iso: string, locale: string): string {
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));
  } catch {
    return iso;
  }
}

const s2a = (s: string | null | undefined): string[] =>
  s ? s.split(/[,;\n]/).map((x) => x.trim()).filter(Boolean) : [];
const a2s = (a: string[]): string => a.join(", ");

/**
 * Step 1 — CV upload + analysis + review/correction.
 *
 * Upload → POST /api/auto-bewerb/cv-analyze (the route persists the profile
 * server-side; the client only refreshes). Review → local draft of the
 * CandidateProfile, saved via saveProfileExtractAction (the uploaded file is
 * NEVER touched — corrections only change the extracted data).
 */
export function Step1Cv() {
  const { ws, refresh, notify, goToStep } = useAutoBewerb();
  const { t, lang } = useI18n();
  const locale = { de: "de-DE", en: "en-GB", fr: "fr-FR", ar: "ar-EG" }[lang] ?? "de-DE";
  const fileInput = useRef<HTMLInputElement>(null);
  const replaceInput = useRef<HTMLInputElement>(null);
  const photoInput = useRef<HTMLInputElement>(null);
  const photoReplaceInput = useRef<HTMLInputElement>(null);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [confirmPhotoRemove, setConfirmPhotoRemove] = useState(false);
  const [removingPhoto, setRemovingPhoto] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [analyzeError, setAnalyzeError] = useState<string | null>(null);
  const [reused, setReused] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [draft, setDraft] = useState<CandidateProfile | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, flashSaved] = useSaveFlash();

  const profile = ws.profile;
  const extracted = profile?.extracted ?? null;

  const onFile = async (file: File | undefined | null) => {
    if (!file) return;
    setAnalyzing(true);
    setAnalyzeError(null);
    setReused(false);
    setDraft(null);
    const fd = new FormData();
    fd.append("file", file);
    try {
      const res = await fetch("/api/auto-bewerb/cv-analyze", { method: "POST", body: fd });
      const data = (await res.json().catch(() => ({}))) as { error?: string; reused?: boolean };
      if (!res.ok) {
        setAnalyzeError(data.error ?? t("autoBewerb.cvAnalyzeError"));
      } else {
        setReused(Boolean(data.reused));
        await refresh();
        notify("success", t("autoBewerb.saved"));
      }
    } catch {
      setAnalyzeError(t("autoBewerb.cvAnalyzeError"));
    } finally {
      setAnalyzing(false);
      if (fileInput.current) fileInput.current.value = "";
      if (replaceInput.current) replaceInput.current.value = "";
    }
  };

  const startEdit = () => {
    if (extracted) setDraft(structuredClone(extracted));
  };

  const saveDraft = async () => {
    if (!draft) return;
    setSaving(true);
    // graduation_year accepts a 4-digit year as a number (schema: number|string|null).
    const normalized = structuredClone(draft) as CandidateProfile;
    for (const ed of normalized.education) {
      if (typeof ed.graduation_year === "string" && /^\d{4}$/.test(ed.graduation_year.trim())) {
        ed.graduation_year = Number(ed.graduation_year.trim());
      }
    }
    const res = await saveProfileExtractAction(normalized);
    setSaving(false);
    if (res.ok) {
      setDraft(null);
      await refresh();
      flashSaved();
      notify("success", t("autoBewerb.saved"));
    } else {
      notify("error", t("autoBewerb.saveError"));
    }
  };

  const onDelete = async () => {
    setDeleting(true);
    const res = await deleteProfileAction();
    setDeleting(false);
    setConfirmDelete(false);
    if (res.ok) {
      setDraft(null);
      await refresh();
      notify("success", t("autoBewerb.saved"));
    } else {
      notify("error", t("autoBewerb.saveError"));
    }
  };

  // --- profile photo (optional — the workflow continues without one) ------
  const photo = ws.photo;

  const onPhotoFile = async (file: File | undefined | null) => {
    if (!file) return;
    setPhotoError(null);
    if (!PHOTO_CLIENT_MIME.has(file.type)) {
      setPhotoError(t("autoBewerb.photoErrorType"));
      return;
    }
    if (file.size > PHOTO_MAX_BYTES) {
      setPhotoError(t("autoBewerb.photoErrorSize"));
      return;
    }
    setPhotoBusy(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/auto-bewerb/profile-photo", { method: "POST", body: fd });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setPhotoError(data.error ?? t("autoBewerb.photoErrorUpload"));
      } else {
        await refresh();
        notify("success", t("autoBewerb.saved"));
      }
    } catch {
      setPhotoError(t("autoBewerb.photoErrorUpload"));
    } finally {
      setPhotoBusy(false);
      if (photoInput.current) photoInput.current.value = "";
      if (photoReplaceInput.current) photoReplaceInput.current.value = "";
    }
  };

  const onPhotoRemove = async () => {
    setRemovingPhoto(true);
    try {
      const res = await fetch("/api/auto-bewerb/profile-photo", { method: "DELETE" });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        notify("error", data.error ?? t("autoBewerb.photoErrorRemove"));
        return;
      }
      setConfirmPhotoRemove(false);
      await refresh();
      notify("success", t("autoBewerb.saved"));
    } catch {
      notify("error", t("autoBewerb.photoErrorRemove"));
    } finally {
      setRemovingPhoto(false);
    }
  };

  const editing = draft !== null;
  const d = draft;

  return (
    <div className="space-y-5">
      <input ref={fileInput} type="file" accept={ACCEPT} className="hidden" onChange={(e) => void onFile(e.target.files?.[0])} />
      <input ref={replaceInput} type="file" accept={ACCEPT} className="hidden" onChange={(e) => void onFile(e.target.files?.[0])} />
      <input ref={photoInput} type="file" accept={PHOTO_ACCEPT} className="hidden" onChange={(e) => void onPhotoFile(e.target.files?.[0])} />
      <input ref={photoReplaceInput} type="file" accept={PHOTO_ACCEPT} className="hidden" onChange={(e) => void onPhotoFile(e.target.files?.[0])} />

      {/* Upload / file meta */}
      <SectionCard
        title={t("autoBewerb.cvUploadTitle")}
        aside={
          profile && (
            <div className="flex items-center gap-2">
              <Button variant="secondary" size="sm" onClick={() => replaceInput.current?.click()}>
                <RefreshCw size={14} />
                {t("autoBewerb.cvUploadReplace")}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(true)}>
                <Trash2 size={14} />
                {t("autoBewerb.cvDeleteButton")}
              </Button>
            </div>
          )
        }
      >
        {!profile ? (
          <div>
            <p className="mb-4 text-sm leading-6 text-muted">{t("autoBewerb.cvUploadHint")}</p>
            <button
              type="button"
              onClick={() => fileInput.current?.click()}
              disabled={analyzing}
              className="flex w-full flex-col items-center gap-3 rounded-3xl border-2 border-dashed border-line-strong bg-surface-2/50 px-6 py-12 text-center transition-colors hover:border-accent hover:bg-accent-soft/30 disabled:opacity-60"
            >
              <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-accent-soft text-accent">
                {analyzing ? <RefreshCw size={26} className="animate-spin" /> : <UploadCloud size={26} strokeWidth={1.6} />}
              </span>
              <span className="text-sm font-bold text-ink">
                {analyzing ? t("autoBewerb.cvAnalyzing") : t("autoBewerb.cvUploadButton")}
              </span>
              <span className="text-xs text-muted">{t("autoBewerb.cvUploadHint")}</span>
            </button>
            {analyzeError && (
              <div className="mt-4">
                <Note kind="error">{analyzeError}</Note>
              </div>
            )}
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
            <span className="flex items-center gap-2 font-semibold text-ink">
              <FileText size={16} className="text-accent" />
              {profile.fileName}
            </span>
            <span className="text-muted">{fmtSize(profile.sizeBytes)}</span>
            <span className="text-muted">
              {t("autoBewerb.cvAnalyzedAt")}: {fmtDate(profile.analyzedAt, locale)}
            </span>
          </div>
        )}
        {reused && profile && (
          <div className="mt-3">
            <Note kind="info">{t("autoBewerb.cvReusedNote")}</Note>
          </div>
        )}
        {profile && !profile.extracted && (
          <div className="mt-3">
            <Note kind="error">{t("autoBewerb.cvNoExtract")}</Note>
          </div>
        )}
      </SectionCard>

      {/* Profile photo — optional, automatically used in every generated CV */}
      <SectionCard title={`${t("autoBewerb.photoTitle")} (${t("autoBewerb.photoOptional")})`}>
        {!ws.photoSupported ? (
          <Note kind="info">{t("autoBewerb.photoSetupPending")}</Note>
        ) : photo ? (
          <div className="flex flex-wrap items-start gap-5">
            <img
              src={photoPreviewUrl(photo.uploadedAt)}
              alt={t("autoBewerb.photoTitle")}
              className="h-36 w-28 rounded-2xl border border-line bg-surface-2 object-cover"
            />
            <div className="min-w-0 flex-1">
              <p className="text-sm leading-6 text-muted">{t("autoBewerb.photoDesc")}</p>
              <p className="mt-1 text-xs text-faint">
                {fmtSize(photo.sizeBytes)} · {t("autoBewerb.photoUploadedAt")}: {fmtDate(photo.uploadedAt, locale)}
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button variant="secondary" size="sm" onClick={() => photoReplaceInput.current?.click()} disabled={photoBusy}>
                  <RefreshCw size={14} className={photoBusy ? "animate-spin" : undefined} />
                  {photoBusy ? t("autoBewerb.photoUploading") : t("autoBewerb.photoReplace")}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setConfirmPhotoRemove(true)} disabled={photoBusy || removingPhoto}>
                  <Trash2 size={14} />
                  {t("autoBewerb.photoRemove")}
                </Button>
              </div>
            </div>
          </div>
        ) : (
          <div>
            <p className="mb-4 text-sm leading-6 text-muted">{t("autoBewerb.photoDesc")}</p>
            <button
              type="button"
              onClick={() => photoInput.current?.click()}
              disabled={photoBusy}
              className="flex w-full flex-col items-center gap-3 rounded-3xl border-2 border-dashed border-line-strong bg-surface-2/50 px-6 py-10 text-center transition-colors hover:border-accent hover:bg-accent-soft/30 disabled:opacity-60"
            >
              <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-accent-soft text-accent">
                {photoBusy ? <RefreshCw size={22} className="animate-spin" /> : <ImageIcon size={22} strokeWidth={1.6} />}
              </span>
              <span className="text-sm font-bold text-ink">{photoBusy ? t("autoBewerb.photoUploading") : t("autoBewerb.photoUploadButton")}</span>
              <span className="text-xs text-muted">{t("autoBewerb.photoFormats")}</span>
            </button>
            {photoError && (
              <div className="mt-4">
                <Note kind="error">{photoError}</Note>
              </div>
            )}
          </div>
        )}
      </SectionCard>

      {/* Review / correction */}
      {extracted && (
        <SectionCard
          title={t("autoBewerb.cvReviewTitle")}
          aside={
            editing ? (
              <div className="flex items-center gap-2">
                <Button variant="secondary" size="sm" onClick={() => setDraft(null)}>
                  {t("common.cancel")}
                </Button>
                <Button variant="primary" size="sm" onClick={() => void saveDraft()} disabled={saving}>
                  {saving ? t("autoBewerb.saving") : saved ? t("autoBewerb.saved") : t("autoBewerb.cvSaveButton")}
                </Button>
              </div>
            ) : (
              <Button variant="secondary" size="sm" onClick={startEdit}>
                {t("autoBewerb.editButton")}
              </Button>
            )
          }
        >
          <p className="mb-4 text-xs leading-5 text-muted">{t("autoBewerb.aiNote")}</p>
          {editing && d ? (
            <div className="space-y-5">
              {/* Candidate */}
              <div className="grid gap-3 sm:grid-cols-2">
                <Input label={t("autoBewerb.fullName")} value={d.candidate.full_name ?? ""} onChange={(e) => setDraft({ ...d, candidate: { ...d.candidate, full_name: e.target.value || null } })} />
                <Input label={t("autoBewerb.currentLocation")} value={d.candidate.current_location ?? ""} onChange={(e) => setDraft({ ...d, candidate: { ...d.candidate, current_location: e.target.value || null } })} />
                <Input label={t("autoBewerb.email")} type="email" value={d.candidate.contact.email ?? ""} onChange={(e) => setDraft({ ...d, candidate: { ...d.candidate, contact: { ...d.candidate.contact, email: e.target.value || null } } })} />
                <Input label={t("autoBewerb.phone")} value={d.candidate.contact.phone ?? ""} onChange={(e) => setDraft({ ...d, candidate: { ...d.candidate, contact: { ...d.candidate.contact, phone: e.target.value || null } } })} />
                <Input label="LinkedIn" value={d.candidate.contact.linkedin ?? ""} onChange={(e) => setDraft({ ...d, candidate: { ...d.candidate, contact: { ...d.candidate.contact, linkedin: e.target.value || null } } })} />
                <Input label={t("autoBewerb.targetLocations")} hint={t("autoBewerb.commaHint")} value={a2s(d.candidate.target_location)} onChange={(e) => setDraft({ ...d, candidate: { ...d.candidate, target_location: s2a(e.target.value) } })} />
              </div>

              {/* Goal */}
              <div>
                <span className="mb-1.5 block text-xs font-semibold text-ink-soft">{t("autoBewerb.goalSection")}</span>
                <div className="flex gap-2">
                  {(["ausbildung", "arbeit"] as const).map((g) => (
                    <button
                      key={g}
                      type="button"
                      onClick={() => setDraft({ ...d, goal: g })}
                      className={`rounded-xl border px-4 py-2 text-sm font-semibold transition-colors ${
                        d.goal === g ? "border-accent bg-accent-soft text-accent" : "border-line bg-surface text-muted hover:border-line-strong"
                      }`}
                    >
                      {g === "ausbildung" ? t("autoBewerb.goalAusbildung") : t("autoBewerb.goalArbeit")}
                    </button>
                  ))}
                </div>
              </div>

              {/* Education */}
              <div>
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-xs font-semibold text-ink-soft">{t("autoBewerb.educationSection")}</span>
                  <Button variant="secondary" size="sm" onClick={() => setDraft({ ...d, education: [...d.education, { school: null, university: null, degree: null, field_of_study: null, graduation_year: null, education_level: null, source: "user_provided" as const }] })}>
                    {t("autoBewerb.addEntry")}
                  </Button>
                </div>
                <div className="space-y-3">
                  {d.education.map((ed, i) => (
                    <div key={i} className="rounded-2xl border border-line bg-surface-2/40 p-3">
                      <div className="grid gap-2 sm:grid-cols-3">
                        <Input label={t("autoBewerb.institution")} value={ed.school ?? ed.university ?? ""} onChange={(e) => setDraft({ ...d, education: d.education.map((x, j) => (j === i ? { ...x, school: e.target.value || null, university: e.target.value || null } : x)) })} />
                        <Input label={t("autoBewerb.degree")} value={ed.degree ?? ""} onChange={(e) => setDraft({ ...d, education: d.education.map((x, j) => (j === i ? { ...x, degree: e.target.value || null } : x)) })} />
                        <Input label={t("autoBewerb.fieldOfStudy")} value={ed.field_of_study ?? ""} onChange={(e) => setDraft({ ...d, education: d.education.map((x, j) => (j === i ? { ...x, field_of_study: e.target.value || null } : x)) })} />
                      </div>
                      <div className="mt-2 flex items-center gap-2">
                        <Input label={t("autoBewerb.graduationYear")} value={String(ed.graduation_year ?? "")} onChange={(e) => setDraft({ ...d, education: d.education.map((x, j) => (j === i ? { ...x, graduation_year: e.target.value || null } : x)) })} className="max-w-[140px]" />
                        <button type="button" onClick={() => setDraft({ ...d, education: d.education.filter((_, j) => j !== i) })} className="ml-auto rounded-lg px-2 py-1 text-xs font-semibold text-danger hover:bg-danger-soft">
                          {t("autoBewerb.removeEntry")}
                        </button>
                      </div>
                    </div>
                  ))}
                  {d.education.length === 0 && <p className="text-xs text-muted">{t("autoBewerb.noEntries")}</p>}
                </div>
              </div>

              {/* Experience */}
              <div>
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-xs font-semibold text-ink-soft">{t("autoBewerb.experienceSection")}</span>
                  <Button variant="secondary" size="sm" onClick={() => setDraft({ ...d, experience: [...d.experience, { job_title: "", company: null, responsibilities: [], start_date: null, end_date: null, type: "employment" as const, source: "user_provided" as const }] })}>
                    {t("autoBewerb.addEntry")}
                  </Button>
                </div>
                <div className="space-y-3">
                  {d.experience.map((ex, i) => (
                    <div key={i} className="rounded-2xl border border-line bg-surface-2/40 p-3">
                      <div className="grid gap-2 sm:grid-cols-2">
                        <Input label={t("autoBewerb.jobTitleField")} value={ex.job_title} onChange={(e) => setDraft({ ...d, experience: d.experience.map((x, j) => (j === i ? { ...x, job_title: e.target.value } : x)) })} />
                        <Input label={t("autoBewerb.companyField")} value={ex.company ?? ""} onChange={(e) => setDraft({ ...d, experience: d.experience.map((x, j) => (j === i ? { ...x, company: e.target.value || null } : x)) })} />
                        <Input label={t("autoBewerb.from")} value={ex.start_date ?? ""} onChange={(e) => setDraft({ ...d, experience: d.experience.map((x, j) => (j === i ? { ...x, start_date: e.target.value || null } : x)) })} />
                        <Input label={t("autoBewerb.to")} value={ex.end_date ?? ""} onChange={(e) => setDraft({ ...d, experience: d.experience.map((x, j) => (j === i ? { ...x, end_date: e.target.value || null } : x)) })} />
                      </div>
                      <div className="mt-2">
                        <Textarea label={t("autoBewerb.responsibilities")} hint={t("autoBewerb.newlineHint")} rows={2} value={ex.responsibilities.join("\n")} onChange={(e) => setDraft({ ...d, experience: d.experience.map((x, j) => (j === i ? { ...x, responsibilities: s2a(e.target.value.replace(/,/g, "\n")) } : x)) })} />
                      </div>
                      <div className="mt-2 flex justify-end">
                        <button type="button" onClick={() => setDraft({ ...d, experience: d.experience.filter((_, j) => j !== i) })} className="rounded-lg px-2 py-1 text-xs font-semibold text-danger hover:bg-danger-soft">
                          {t("autoBewerb.removeEntry")}
                        </button>
                      </div>
                    </div>
                  ))}
                  {d.experience.length === 0 && <p className="text-xs text-muted">{t("autoBewerb.noEntries")}</p>}
                </div>
              </div>

              {/* Skills */}
              <div>
                <span className="mb-2 block text-xs font-semibold text-ink-soft">{t("autoBewerb.skillsSection")}</span>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Input label={t("autoBewerb.skillsSoft")} hint={t("autoBewerb.commaHint")} value={a2s(d.skills.soft)} onChange={(e) => setDraft({ ...d, skills: { ...d.skills, soft: s2a(e.target.value) } })} />
                  <Input label={t("autoBewerb.skillsTechnical")} hint={t("autoBewerb.commaHint")} value={a2s(d.skills.technical)} onChange={(e) => setDraft({ ...d, skills: { ...d.skills, technical: s2a(e.target.value) } })} />
                  <Input label={t("autoBewerb.skillsIt")} hint={t("autoBewerb.commaHint")} value={a2s(d.skills.it)} onChange={(e) => setDraft({ ...d, skills: { ...d.skills, it: s2a(e.target.value) } })} />
                  <Input label={t("autoBewerb.skillsTools")} hint={t("autoBewerb.commaHint")} value={a2s(d.skills.software_tools)} onChange={(e) => setDraft({ ...d, skills: { ...d.skills, software_tools: s2a(e.target.value) } })} />
                </div>
              </div>

              {/* Languages */}
              <div>
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-xs font-semibold text-ink-soft">{t("autoBewerb.languagesSection")}</span>
                  <Button variant="secondary" size="sm" onClick={() => setDraft({ ...d, languages: [...d.languages, { language: "", level: null, level_is_inferred: false, source: "user_provided" as const }] })}>
                    {t("autoBewerb.addEntry")}
                  </Button>
                </div>
                <div className="space-y-2">
                  {d.languages.map((l, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <Input value={l.language} placeholder={t("autoBewerb.language")} onChange={(e) => setDraft({ ...d, languages: d.languages.map((x, j) => (j === i ? { ...x, language: e.target.value } : x)) })} className="flex-1" />
                      <Input value={l.level ?? ""} placeholder={t("autoBewerb.level")} onChange={(e) => setDraft({ ...d, languages: d.languages.map((x, j) => (j === i ? { ...x, level: e.target.value || null } : x)) })} className="w-32" />
                      <button type="button" onClick={() => setDraft({ ...d, languages: d.languages.filter((_, j) => j !== i) })} className="rounded-lg px-2 py-1 text-xs font-semibold text-danger hover:bg-danger-soft">
                        {t("autoBewerb.removeEntry")}
                      </button>
                    </div>
                  ))}
                  {d.languages.length === 0 && <p className="text-xs text-muted">{t("autoBewerb.noEntries")}</p>}
                </div>
              </div>

              {/* Read-only context (kept visible, not editable here) */}
              {(d.missing_information.length > 0 || d.potential_concerns.length > 0) && (
                <div className="rounded-2xl border border-line bg-surface-2/40 p-4">
                  <p className="mb-1 text-xs font-semibold text-ink-soft">{t("autoBewerb.missingInfoSection")}</p>
                  <ul className="list-inside list-disc space-y-0.5 text-xs text-muted">
                    {d.missing_information.map((m, i) => (
                      <li key={`m${i}`}>{m}</li>
                    ))}
                    {d.potential_concerns.map((m, i) => (
                      <li key={`c${i}`}>{m}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-4 text-sm">
              <div className="grid gap-3 sm:grid-cols-2">
                <MetaLine label={t("autoBewerb.fullName")} value={extracted.candidate.full_name} />
                <MetaLine label={t("autoBewerb.currentLocation")} value={extracted.candidate.current_location} />
                <MetaLine label={t("autoBewerb.email")} value={extracted.candidate.contact.email} />
                <MetaLine label={t("autoBewerb.phone")} value={extracted.candidate.contact.phone} />
                <MetaLine label={t("autoBewerb.targetLocations")} value={a2s(extracted.candidate.target_location)} />
                <MetaLine label={t("autoBewerb.goalSection")} value={extracted.goal === "ausbildung" ? t("autoBewerb.goalAusbildung") : t("autoBewerb.goalArbeit")} />
              </div>
              <ReadOnlyList label={t("autoBewerb.educationSection")} items={extracted.education.map((e) => [e.school ?? e.university, e.degree, e.field_of_study, String(e.graduation_year ?? "")].filter(Boolean).join(" · "))} />
              <ReadOnlyList label={t("autoBewerb.experienceSection")} items={extracted.experience.map((e) => [e.job_title, e.company, e.start_date, e.end_date].filter(Boolean).join(" · "))} />
              <ReadOnlyList label={t("autoBewerb.skillsSection")} items={[...extracted.skills.soft, ...extracted.skills.technical, ...extracted.skills.it, ...extracted.skills.software_tools]} />
              <ReadOnlyList label={t("autoBewerb.languagesSection")} items={extracted.languages.map((l) => `${l.language}${l.level ? ` (${l.level})` : ""}`)} />
              {extracted.missing_information.length > 0 && (
                <div className="rounded-2xl border border-warning/30 bg-warning-soft/50 p-4">
                  <p className="mb-1 text-xs font-semibold text-warning">{t("autoBewerb.missingInfoSection")}</p>
                  <ul className="list-inside list-disc space-y-0.5 text-xs text-ink-soft">
                    {extracted.missing_information.map((m, i) => (
                      <li key={i}>{m}</li>
                    ))}
                  </ul>
                </div>
              )}
              {!editing && (
                <div className="flex justify-end">
                  <Button variant="primary" size="sm" onClick={() => goToStep(2)}>
                    {t("common.continue")}
                  </Button>
                </div>
              )}
            </div>
          )}
        </SectionCard>
      )}

      {/* Empty state: nothing uploaded yet */}
      {!profile && !analyzing && (
        <EmptyState
          title={t("autoBewerb.cvEmptyTitle")}
          body={t("autoBewerb.cvEmptyBody")}
          illustration={<FileText size={34} strokeWidth={1.6} />}
        />
      )}

      <Modal open={confirmDelete} onClose={() => !deleting && setConfirmDelete(false)} title={t("autoBewerb.cvDeleteTitle")}>
        <p className="text-sm leading-6 text-muted">{t("autoBewerb.cvDeleteBody")}</p>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setConfirmDelete(false)} disabled={deleting}>
            {t("common.cancel")}
          </Button>
          <Button variant="secondary" className="border-danger/40 text-danger hover:bg-danger-soft" onClick={() => void onDelete()} disabled={deleting}>
            {t("autoBewerb.deleteButton")}
          </Button>
        </div>
      </Modal>

      <Modal open={confirmPhotoRemove} onClose={() => !removingPhoto && setConfirmPhotoRemove(false)} title={t("autoBewerb.photoRemoveTitle")}>
        <p className="text-sm leading-6 text-muted">{t("autoBewerb.photoRemoveBody")}</p>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setConfirmPhotoRemove(false)} disabled={removingPhoto}>
            {t("common.cancel")}
          </Button>
          <Button variant="secondary" className="border-danger/40 text-danger hover:bg-danger-soft" onClick={() => void onPhotoRemove()} disabled={removingPhoto}>
            {t("autoBewerb.photoRemove")}
          </Button>
        </div>
      </Modal>
    </div>
  );
}

function MetaLine({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className="min-w-0">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-faint">{label}</p>
      <p className="truncate text-sm font-medium text-ink">{value || "—"}</p>
    </div>
  );
}

function ReadOnlyList({ label, items }: { label: string; items: string[] }) {
  return (
    <div>
      <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-faint">{label}</p>
      {items.length === 0 ? (
        <p className="text-sm text-muted">—</p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {items.map((it, i) => (
            <span key={i} className="rounded-full bg-surface-2 px-2.5 py-1 text-xs font-medium text-ink-soft">
              {it}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
