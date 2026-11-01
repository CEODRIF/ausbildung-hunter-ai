"use client";

import { useState } from "react";
import { Building2, CalendarClock, CheckCheck, ChevronRight, Pencil, RefreshCw, Search, Trash2 } from "lucide-react";
import { Button, Input, Modal, Textarea } from "@/components/ui";
import { EmptyState } from "@/components/ui/feedback";
import { useI18n } from "@/lib/i18n";
import {
  addCompanyAction,
  deleteCompanyAction,
  updateCompanyAction,
} from "@/app/auto-bewerb/actions";
import {
  AUTO_BEWERB_COMPANY_LIMIT,
  isValidEmail,
  normalizeCompanyKey,
  type AdAnalysis,
  type AdExtract,
  type AutoBewerbCompanyRow,
} from "@/lib/auto-bewerb/schema";
import { Note, SectionCard, companyLabel, statusPill, useAutoBewerb } from "./shared";

interface PendingAnalysis {
  extract: AdExtract;
  analysis: AdAnalysis;
  profileHash: string | null;
  reused: boolean;
}

/**
 * Step 2 — job-ad input with TWO distinct actions:
 *  "Analyze" (POST /api/auto-bewerb/analyze-ad → local preview only) and
 *  "Add company" (server action; the company is shown as saved ONLY after the
 *  server confirms). A failed add never clears the text or the preview
 *  (nothing is silently discarded).
 *
 * Companies render as COMPACT, collapsed cards (name / job / status /
 * actions) — the full analysis details are revealed on demand per card
 * (independent expand state). Every successfully saved company is
 * AUTO-CONFIRMED server-side (ad_confirmed_at stamped inside the insert),
 * so there is no manual "Ad confirmed" step.
 */
export function Step2Companies() {
  const { ws, refresh, notify, companyId, selectCompany, goToStep } = useAutoBewerb();
  const { t } = useI18n();
  const [adText, setAdText] = useState("");
  const [analyzing, setAnalyzing] = useState(false);
  const [analyzeError, setAnalyzeError] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingAnalysis | null>(null);
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [editing, setEditing] = useState<AutoBewerbCompanyRow | null>(null);
  const [deleting, setDeleting] = useState<AutoBewerbCompanyRow | null>(null);
  const [busy, setBusy] = useState(false);

  // GLOBAL capacity — PERSISTED server counters (the active list is the same
  // reserved set; the server value is the truth for the "X / 100" display and
  // survives concurrent sessions). HONEST states:
  //   - `ws.capacity` object  → the server's persisted counter (the truth);
  //   - `ws.capacity === null`→ the counter could NOT be read → show "—" +
  //     the unavailable note, NEVER a fake "0 / 100 · 100 places available"
  //     (a failed read must not look like an empty workflow — the server
  //     still enforces the limit on the real rows);
  //   - `ws.capacity === undefined` → pre-feature snapshot → the active
  //     list length is the fallback (same reserved set, same user).
  const capacity = ws.capacity?.capacity ?? AUTO_BEWERB_COMPANY_LIMIT;
  const capacityUnknown = ws.capacity === null;
  const listCount = ws.companies.length;
  // CROSS-CHECK INVARIANT: the counter and the active list count the SAME
  // persisted reserved set (same user, same reserved statuses, list capped at
  // the same 100), so the counter can never legitimately be BELOW the list
  // length. When the workspace response is internally inconsistent (a
  // degraded read served a stale/zero counter next to the full list — the
  // production symptom "0 / 100" while the add is refused), the LIST is the
  // server-confirmed truth: show the maximum, never a fake "0 / 100".
  const reserved = ws.capacity ? Math.max(ws.capacity.reserved, listCount) : listCount;
  if (ws.capacity && ws.capacity.reserved < listCount) {
    // Safe client-side signal (counts only — no names or ad text); the
    // server logs the same divergence with source + build id.
    console.warn(
      `[auto-bewerb][capacity] UI cross-check: server counter ${ws.capacity.reserved} < active list ${listCount} — showing the list length (stale/degraded counter in the workspace response)`,
    );
  }
  const atLimit = !capacityUnknown && reserved >= capacity;

  const analyze = async () => {
    setAnalyzing(true);
    setAnalyzeError(null);
    setPending(null);
    try {
      const res = await fetch("/api/auto-bewerb/analyze-ad", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ adText }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        extract?: AdExtract;
        analysis?: AdAnalysis;
        reused?: boolean;
        profileHash?: string | null;
      };
      if (!res.ok || !data.extract || !data.analysis) {
        setAnalyzeError(data.error ?? t("autoBewerb.analyzeError"));
      } else {
        setPending({ extract: data.extract, analysis: data.analysis, profileHash: data.profileHash ?? null, reused: Boolean(data.reused) });
      }
    } catch {
      setAnalyzeError(t("autoBewerb.analyzeError"));
    } finally {
      setAnalyzing(false);
    }
  };

  const duplicateOf =
    pending?.extract.company &&
    ws.companies.find(
      (c) =>
        normalizeCompanyKey(c.company.company || c.company.ad_extracted?.company || "") ===
        normalizeCompanyKey(pending.extract!.company),
    );

  const addCompany = async () => {
    if (!pending) return;
    setAdding(true);
    setAddError(null);
    const res = await addCompanyAction({
      adRaw: adText,
      company: pending.extract.company || null,
      extract: pending.extract,
      analysis: pending.analysis,
      profileHash: pending.profileHash,
    });
    setAdding(false);
    if (res.ok) {
      setAdText("");
      setPending(null);
      await refresh();
      notify("success", t("autoBewerb.saved"));
    } else {
      // Keep the text + preview — the user decides what to do next.
      setAddError(
        res.code === "workflow_full"
          ? t("autoBewerb.companyLimitNote")
          : res.code === "company_duplicate"
            ? t("autoBewerb.companyDuplicateNote")
            : t("autoBewerb.saveError"),
      );
      // A rejected add proves the server sees state this UI does not (the
      // counter is stale or was an unreadable fake) — re-read the workspace
      // immediately so the counter shows the persisted truth next to the
      // error, instead of the old false "0 / 100".
      if (res.code === "workflow_full") await refresh();
    }
  };

  const doDelete = async () => {
    if (!deleting) return;
    setBusy(true);
    const res = await deleteCompanyAction(deleting.id);
    setBusy(false);
    const wasSelected = deleting.id === companyId;
    setDeleting(null);
    if (res.ok) {
      if (wasSelected) selectCompany(null);
      await refresh();
      notify("success", t("autoBewerb.saved"));
    } else {
      notify(
        "error",
        res.code === "scheduled_protected" ? t("autoBewerb.scheduledProtectedNote") : t("autoBewerb.saveError"),
      );
    }
  };

  return (
    <div className="space-y-5">
      {/* Ad input */}
      <SectionCard
        title={t("autoBewerb.adInputTitle")}
        aside={
          <div className="flex flex-col items-end gap-0.5 text-xs">
            <span className="font-semibold text-muted">{capacityUnknown ? "—" : `${reserved} / ${capacity}`}</span>
            <span className="font-medium text-faint">
              {capacityUnknown
                ? t("autoBewerb.capacityUnavailable")
                : t("autoBewerb.capacityAvailable", { count: Math.max(0, capacity - reserved) })}
            </span>
          </div>
        }
      >
        <div className="space-y-3">
          <Textarea
            label={t("autoBewerb.adInputLabel")}
            hint={t("autoBewerb.adInputHint")}
            rows={7}
            value={adText}
            disabled={atLimit}
            onChange={(e) => {
              setAdText(e.target.value);
              setAddError(null);
            }}
            placeholder={t("autoBewerb.adPlaceholder")}
          />
          {atLimit ? (
            <Note kind="info">{t("autoBewerb.companyLimitNote")}</Note>
          ) : (
            <div className="flex flex-wrap items-center gap-3">
              <Button variant="secondary" onClick={() => void analyze()} disabled={analyzing || adText.trim().length < 40}>
                {analyzing ? <RefreshCw size={15} className="animate-spin" /> : <Search size={15} />}
                {analyzing ? t("autoBewerb.analyzingButton") : t("autoBewerb.analyzeButton")}
              </Button>
              <Button variant="primary" onClick={() => void addCompany()} disabled={adding || !pending || Boolean(duplicateOf)}>
                {adding ? <RefreshCw size={15} className="animate-spin" /> : <Building2 size={15} />}
                {adding ? t("autoBewerb.addingButton") : t("autoBewerb.addCompanyButton")}
              </Button>
              {adText.trim().length > 0 && adText.trim().length < 40 && (
                <span className="text-xs text-muted">{t("autoBewerb.adTooShort")}</span>
              )}
            </div>
          )}
          {analyzeError && <Note kind="error">{analyzeError}</Note>}
          {addError && <Note kind="error">{addError}</Note>}
          {pending && (
            <div className="space-y-3 rounded-2xl border border-accent/25 bg-accent-soft/30 p-4">
              <p className="text-xs font-semibold text-accent">
                {t("autoBewerb.analysisPreviewTitle")}
                {pending.reused ? ` · ${t("autoBewerb.reusedNote")}` : ""}
              </p>
              <div className="grid gap-x-4 gap-y-1 text-xs text-ink-soft sm:grid-cols-2">
                <span>{t("autoBewerb.fCompany")}: <b>{pending.extract.company || t("autoBewerb.unavailable")}</b></span>
                <span>{t("autoBewerb.fJobTitle")}: <b>{pending.extract.jobTitle || t("autoBewerb.unavailable")}</b></span>
                <span>{t("autoBewerb.fOccupation")}: <b>{pending.extract.occupation || t("autoBewerb.unavailable")}</b></span>
                <span>{t("autoBewerb.fContact")}: <b>{pending.extract.contactPerson || t("autoBewerb.unavailable")}</b></span>
                <span>{t("autoBewerb.fEmail")}: <b>{pending.extract.applicationEmail || t("autoBewerb.unavailable")}</b></span>
                <span>{t("autoBewerb.fDeadline")}: <b>{pending.extract.applicationDeadline || t("autoBewerb.unavailable")}</b></span>
              </div>
              {duplicateOf && <Note kind="error">{t("autoBewerb.companyDuplicateNote")}</Note>}
            </div>
          )}
        </div>
      </SectionCard>

      {/* Preserved history note — sent companies auto-leave THIS list */}
      {(ws.sendHistory?.length ?? 0) > 0 && <Note kind="info">{t("autoBewerb.sentAutoRemovedNote")}</Note>}

      {/* Company cards */}
      {ws.companies.length === 0 ? (
        <EmptyState title={t("autoBewerb.noCompaniesTitle")} body={t("autoBewerb.noCompaniesBody")} illustration={<Building2 size={34} strokeWidth={1.6} />} />
      ) : (
        <div className="flex flex-col gap-4">
          {ws.companies.map((c) => (
            <CompanyCard
              key={c.company.id}
              view={c}
              selected={companyId === c.company.id}
              onSelect={() => selectCompany(c.company.id)}
              onEdit={() => setEditing(c.company)}
              onDelete={() => setDeleting(c.company)}
              onGoToReview={() => goToStep(7)}
            />
          ))}
        </div>
      )}

      {/* Edit modal */}
      <EditCompanyModal
        row={editing}
        onClose={() => setEditing(null)}
        onSaved={async () => {
          setEditing(null);
          await refresh();
        }}
      />

      {/* Delete modal */}
      <Modal open={Boolean(deleting)} onClose={() => !busy && setDeleting(null)} title={t("autoBewerb.deleteTitle")}>
        <p className="text-sm leading-6 text-muted">
          {t("autoBewerb.deleteBody")}
          {deleting ? ` ${companyLabel(deleting).name}` : ""}
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setDeleting(null)} disabled={busy}>
            {t("common.cancel")}
          </Button>
          <Button variant="secondary" className="border-danger/40 text-danger hover:bg-danger-soft" onClick={() => void doDelete()} disabled={busy}>
            {t("autoBewerb.deleteButton")}
          </Button>
        </div>
      </Modal>
    </div>
  );
}

// ---------------------------------------------------------------------------

/**
 * Compact company card — COLLAPSED by default (the essential row: expand
 * arrow, name, job title, status, edit, delete). The full stored analysis
 * is revealed inside the same card via `expanded` — a per-card local state,
 * so expanding one company never touches another card.
 *
 * Status chip: a server-confirmed company (ad_confirmed_at — stamped inside
 * the successful insert, re-stamped on content edits) shows the green
 * "Confirmed" indicator; legacy rows saved before auto-confirmation show
 * their workflow status instead.
 */
function CompanyCard({
  view,
  selected,
  onSelect,
  onEdit,
  onDelete,
  onGoToReview,
}: {
  view: { company: AutoBewerbCompanyRow };
  selected: boolean;
  onSelect: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onGoToReview: () => void;
}) {
  const { t } = useI18n();
  const c = view.company;
  const ex = c.ad_extracted;
  const an = c.ad_analysis;
  const { name, job } = companyLabel(c);
  // Scheduled = PENDING application: the server protects it (delete is
  // refused with scheduled_protected); the UI shows the scheduled indicator
  // and disables the manual actions so the user cannot fight the server.
  const scheduled = c.status === "scheduled";
  const locked = c.status === "sent" || c.status === "sending" || scheduled;
  const [expanded, setExpanded] = useState(false);

  return (
    <div
      className={`rounded-3xl border transition-colors ${
        selected ? "border-accent bg-accent-soft/20" : "border-line bg-surface"
      }`}
    >
      {/* Collapsed header — the only thing visible by default */}
      <div className="flex items-center gap-2 p-3 sm:p-4">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          title={expanded ? t("autoBewerb.detailsHide") : t("autoBewerb.detailsToggle")}
          className="shrink-0 rounded-lg p-1.5 text-muted transition-colors hover:bg-surface-2 hover:text-ink"
        >
          <ChevronRight size={16} className={`transition-transform duration-150 ${expanded ? "rotate-90" : ""}`} />
        </button>
        <div className="min-w-0 flex-1">
          <button type="button" onClick={onSelect} className="block max-w-full truncate text-left text-sm font-bold text-ink hover:text-accent">
            {name}
          </button>
          {job && <p className="truncate text-xs text-muted">{job}</p>}
        </div>
        {scheduled ? (
          <span
            className="inline-flex shrink-0 items-center gap-1 rounded-full bg-accent-soft px-2.5 py-1 text-[11px] font-semibold text-accent"
            title={t("autoBewerb.scheduledProtectedNote")}
          >
            <CalendarClock size={12} /> {t("autoBewerb.statusScheduled")}
          </span>
        ) : c.ad_confirmed_at ? (
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-success-soft px-2.5 py-1 text-[11px] font-semibold text-success">
            <CheckCheck size={12} /> {t("autoBewerb.confirmedLabel")}
          </span>
        ) : (
          <span className="shrink-0">{statusPill(c.status, t)}</span>
        )}
        <div className="flex shrink-0 items-center gap-1">
          <Button variant="ghost" size="sm" onClick={onEdit} disabled={locked} title={t("autoBewerb.editCompany")}>
            <Pencil size={14} />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={onDelete}
            disabled={locked}
            title={scheduled ? t("autoBewerb.scheduledProtectedNote") : t("autoBewerb.deleteCompany")}
          >
            <Trash2 size={14} />
          </Button>
        </div>
      </div>

      {/* Expanded details — stored analysis only, never invented values */}
      {expanded && (
        <div className="space-y-4 border-t border-line p-4 sm:px-5">
          {ex ? (
            <div className="grid gap-x-6 gap-y-1.5 text-xs text-ink-soft sm:grid-cols-2">
              <DetailField label={t("autoBewerb.fCompany")} value={ex.company} />
              <DetailField label={t("autoBewerb.fJobTitle")} value={ex.jobTitle || ex.occupation} />
              <DetailField label={t("autoBewerb.fAddress")} value={ex.companyAddress} />
              <DetailField label={t("autoBewerb.fLocation")} value={ex.location} />
              <DetailField label={t("autoBewerb.fContact")} value={ex.contactPerson} />
              <DetailField label={t("autoBewerb.fEmail")} value={ex.applicationEmail || undefined} ok={ex.applicationEmail ? isValidEmail(ex.applicationEmail) : undefined} />
              <DetailField label={t("autoBewerb.fDeadline")} value={ex.applicationDeadline} />
              <DetailField label={t("autoBewerb.fStartDate")} value={ex.startDate} />
              <DetailField label={t("autoBewerb.fEducation")} value={ex.educationRequirement} />
              <DetailField label={t("autoBewerb.fMethod")} value={ex.applicationMethod} />
            </div>
          ) : (
            <Note kind="info">{t("autoBewerb.noExtract")}</Note>
          )}

          {ex && (
            <div className="space-y-2 text-xs text-ink-soft">
              <ChipList label={t("autoBewerb.fRequired")} items={ex.requiredQualifications} />
              <ChipList label={t("autoBewerb.fPreferred")} items={ex.preferredQualifications} />
              <ChipList label={t("autoBewerb.fTechnical")} items={ex.technicalSkills} />
              <ChipList label={t("autoBewerb.fSoft")} items={ex.softSkills} />
              <ChipList label={t("autoBewerb.fLanguages")} items={ex.languageRequirements} />
              <ChipList label={t("autoBewerb.fRequestedDocs")} items={ex.requestedDocuments} />
              <ChipList label={t("autoBewerb.fMissing")} items={ex.missingOrAmbiguous} warn />
            </div>
          )}

          {an && (
            <div className="space-y-2 rounded-2xl bg-surface-2/40 p-3 text-xs">
              <p className="font-semibold text-ink">
                {t("autoBewerb.matchScore")}: <span className="text-accent">{an.matchScore}/100</span>
              </p>
              <ChipList label={t("autoBewerb.matchedLabel")} items={an.matched.map((m) => m.requirement)} />
              <ChipList label={t("autoBewerb.missingLabel")} items={an.missing.map((m) => m.requirement)} warn />
              {an.questions.length > 0 && (
                <div className="rounded-xl bg-warning-soft/60 p-3">
                  <p className="mb-1 font-semibold text-warning">{t("autoBewerb.questionsLabel")}</p>
                  <ul className="list-inside list-disc space-y-0.5 text-ink-soft">
                    {an.questions.map((q, i) => (
                      <li key={i}>{q}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}

          <div>
            <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-faint">{t("autoBewerb.originalAdTitle")}</p>
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-xl bg-surface-2/60 p-3 text-[11px] leading-4 text-muted">{c.ad_raw}</pre>
          </div>

          <div className="flex justify-end border-t border-line pt-3">
            <Button variant="ghost" size="sm" onClick={onGoToReview}>
              {t("autoBewerb.reviewStep")}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Label + value that WRAPS (long emails / company names) instead of
 *  truncating; empty values render the translated "not specified". */
function DetailField({ label, value, ok }: { label: string; value: string | null | undefined; ok?: boolean | null }) {
  const { t } = useI18n();
  return (
    <p className="min-w-0 break-words text-xs text-ink-soft">
      <span className="text-faint">{label}:</span>{" "}
      <b className={ok === false ? "text-warning" : "font-semibold"}>{value || t("autoBewerb.unavailable")}</b>
    </p>
  );
}

function ChipList({ label, items, warn = false }: { label: string; items: string[]; warn?: boolean }) {
  return (
    <div>
      <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-faint">{label}</p>
      {items.length === 0 ? (
        <span className="text-muted">—</span>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {items.map((it, i) => (
            <span key={i} className={`rounded-full px-2.5 py-1 text-xs font-medium ${warn ? "bg-warning-soft text-warning" : "bg-surface-2 text-ink-soft"}`}>
              {it}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function EditCompanyModal({ row, onClose, onSaved }: { row: AutoBewerbCompanyRow | null; onClose: () => void; onSaved: () => Promise<void> }) {
  const { notify } = useAutoBewerb();
  const { t } = useI18n();
  const [saving, setSaving] = useState(false);
  const [company, setCompany] = useState("");
  const [adRaw, setAdRaw] = useState("");
  const [contact, setContact] = useState("");
  const [email, setEmail] = useState("");
  const [deadline, setDeadline] = useState("");
  const [key, setKey] = useState<string | null>(null);

  // Re-init when a different row is opened.
  if (row && row.id !== key) {
    setKey(row.id);
    setCompany(row.company || row.ad_extracted?.company || "");
    setAdRaw(row.ad_raw);
    setContact(row.ad_extracted?.contactPerson ?? "");
    setEmail(row.ad_extracted?.applicationEmail ?? "");
    setDeadline(row.ad_extracted?.applicationDeadline ?? "");
  }

  const save = async () => {
    if (!row) return;
    setSaving(true);
    const extract: AdExtract | null = row.ad_extracted
      ? {
          ...row.ad_extracted,
          company: company || row.ad_extracted.company,
          contactPerson: contact || row.ad_extracted.contactPerson,
          applicationEmail: email || row.ad_extracted.applicationEmail,
          applicationDeadline: deadline || row.ad_extracted.applicationDeadline,
        }
      : null;
    const res = await updateCompanyAction(row.id, {
      company: company || undefined,
      adRaw,
      extract,
    });
    setSaving(false);
    if (res.ok) {
      await onSaved();
      notify("success", t("autoBewerb.saved"));
    } else {
      notify("error", t("autoBewerb.saveError"));
    }
  };

  return (
    <Modal open={Boolean(row)} onClose={() => !saving && onClose()} title={t("autoBewerb.editCompany")}>
      {row && (
        <div className="space-y-3">
          <Input label={t("autoBewerb.fCompany")} value={company} onChange={(e) => setCompany(e.target.value)} />
          <div className="grid gap-3 sm:grid-cols-2">
            <Input label={t("autoBewerb.fContact")} value={contact} onChange={(e) => setContact(e.target.value)} />
            <Input label={t("autoBewerb.fEmail")} value={email} onChange={(e) => setEmail(e.target.value)} error={email && !isValidEmail(email) ? t("autoBewerb.invalidEmail") : undefined} />
            <Input label={t("autoBewerb.fDeadline")} value={deadline} onChange={(e) => setDeadline(e.target.value)} />
          </div>
          <Textarea label={t("autoBewerb.originalAdTitle")} rows={6} value={adRaw} onChange={(e) => setAdRaw(e.target.value)} />
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="secondary" onClick={onClose} disabled={saving}>
              {t("common.cancel")}
            </Button>
            <Button variant="primary" onClick={() => void save()} disabled={saving || adRaw.trim().length < 40}>
              {t("autoBewerb.saveButton")}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
