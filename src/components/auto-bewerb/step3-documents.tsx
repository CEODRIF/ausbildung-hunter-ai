"use client";

import { useRef, useState } from "react";
import { FilePlus2, Paperclip, Pencil, Trash2 } from "lucide-react";
import { Button, Input, Modal } from "@/components/ui";
import { EmptyState } from "@/components/ui/feedback";
import { useI18n } from "@/lib/i18n";
import { selectDocumentAction } from "@/app/auto-bewerb/actions";
import type { AutoBewerbAttachmentRow } from "@/lib/auto-bewerb/schema";
import { CompanyPicker, Note, SectionCard, useAutoBewerb } from "./shared";

const CATEGORY_KEYS: Record<string, string> = {
  school_certificate: "autoBewerb.catSchool",
  professional_qualification: "autoBewerb.catProQual",
  language_certificate: "autoBewerb.catLanguage",
  reference: "autoBewerb.catReference",
  other: "autoBewerb.catOther",
};

const DOC_ACCEPT = ".pdf,.doc,.docx,.png,.jpg,.jpeg";

function fmtSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Step 3 — OPTIONAL supporting-document library (user-level, reusable across
 * companies) + per-company selection. Uploads go through
 * POST /api/auto-bewerb/upload-document (sha256 dedupe: identical bytes reuse
 * the stored row — surfaced as "already in your library", never a duplicate).
 */
export function Step3Documents() {
  const { ws, refresh, notify, companyId, selectCompany, goToStep } = useAutoBewerb();
  const { t, lang } = useI18n();
  const locale = { de: "de-DE", en: "en-GB", fr: "fr-FR", ar: "ar-EG" }[lang] ?? "de-DE";
  const fileInput = useRef<HTMLInputElement>(null);
  const [category, setCategory] = useState("other");
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<AutoBewerbAttachmentRow | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [deleting, setDeleting] = useState<AutoBewerbAttachmentRow | null>(null);
  const [busy, setBusy] = useState(false);
  const [toggling, setToggling] = useState<string | null>(null);

  const upload = async (file: File | undefined | null) => {
    if (!file) return;
    setUploading(true);
    setUploadError(null);
    const fd = new FormData();
    fd.append("file", file);
    fd.append("category", category);
    try {
      const res = await fetch("/api/auto-bewerb/upload-document", { method: "POST", body: fd });
      const data = (await res.json().catch(() => ({}))) as { error?: string; reused?: boolean };
      if (!res.ok) setUploadError(data.error ?? t("autoBewerb.uploadError"));
      else {
        await refresh();
        notify("success", data.reused ? t("autoBewerb.docReusedNote") : t("autoBewerb.saved"));
      }
    } catch {
      setUploadError(t("autoBewerb.uploadError"));
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  };

  const doRename = async () => {
    if (!renaming || !renameValue.trim()) return;
    setBusy(true);
    const res = await fetch("/api/auto-bewerb/upload-document", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ attachmentId: renaming.id, name: renameValue.trim() }),
    }).then((r) => r.json().catch(() => ({}))).then((d: { error?: string }) => d);
    setBusy(false);
    setRenaming(null);
    if ("error" in res && res.error) notify("error", res.error);
    else {
      await refresh();
      notify("success", t("autoBewerb.saved"));
    }
  };

  const doDelete = async () => {
    if (!deleting) return;
    setBusy(true);
    const data = await fetch("/api/auto-bewerb/upload-document", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ attachmentId: deleting.id }),
    }).then((r) => r.json().catch(() => ({}))) as { error?: string };
    setBusy(false);
    setDeleting(null);
    if (data.error) notify("error", data.error);
    else {
      await refresh();
      notify("success", t("autoBewerb.saved"));
    }
  };

  const toggle = async (att: AutoBewerbAttachmentRow, selected: boolean) => {
    if (!companyId) return;
    setToggling(att.id);
    const res = await selectDocumentAction(companyId, att.id, selected);
    setToggling(null);
    if (res.ok) {
      await refresh();
      notify("success", t("autoBewerb.saved"));
    } else {
      notify("error", t("autoBewerb.saveError"));
    }
  };

  const active = ws.companies.find((c) => c.company.id === companyId);

  return (
    <div className="space-y-5">
      <Note kind="info">{t("autoBewerb.docsOptionalNote")}</Note>

      {/* Library */}
      <SectionCard title={t("autoBewerb.docsUploadTitle")}>
        <input ref={fileInput} type="file" accept={DOC_ACCEPT} className="hidden" onChange={(e) => void upload(e.target.files?.[0])} />
        <div className="flex flex-wrap items-center gap-3">
          <div className="w-56">
            <select
              aria-label={t("autoBewerb.docCategoryLabel")}
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="h-11 w-full rounded-xl border border-line-strong bg-surface px-3 text-sm font-medium text-ink outline-none focus:border-accent"
            >
              {Object.entries(CATEGORY_KEYS).map(([value, key]) => (
                <option key={value} value={value}>
                  {t(key)}
                </option>
              ))}
            </select>
          </div>
          <Button variant="primary" onClick={() => fileInput.current?.click()} disabled={uploading}>
            <FilePlus2 size={16} />
            {uploading ? t("autoBewerb.uploading") : t("autoBewerb.docsUploadButton")}
          </Button>
        </div>
        {uploadError && (
          <div className="mt-3">
            <Note kind="error">{uploadError}</Note>
          </div>
        )}

        {ws.attachments.length === 0 ? (
          <div className="mt-4">
            <EmptyState title={t("autoBewerb.noDocs")} body={t("autoBewerb.noDocsBody")} illustration={<Paperclip size={30} strokeWidth={1.6} />} className="py-10" />
          </div>
        ) : (
          <ul className="mt-4 divide-y divide-line">
            {ws.attachments.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center gap-3 py-3">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-surface-2 text-muted">
                  <Paperclip size={15} />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-ink">{a.display_name}</p>
                  <p className="text-xs text-muted">
                    {t(CATEGORY_KEYS[a.doc_category] ?? "autoBewerb.catOther")} · {fmtSize(a.size_bytes)} ·{" "}
                    {new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(new Date(a.created_at))}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setRenaming(a);
                    setRenameValue(a.display_name);
                  }}
                >
                  <Pencil size={14} />
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setDeleting(a)}>
                  <Trash2 size={14} />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      {/* Per-company selection */}
      {ws.companies.length === 0 ? (
        <SectionCard title={t("autoBewerb.docSelectHeading")}>
          <Note kind="info">
            {t("autoBewerb.noCompanyYet")}{" "}
            <button type="button" className="font-semibold text-accent underline underline-offset-2" onClick={() => goToStep(2)}>
              {t("autoBewerb.goToCompanies")}
            </button>
          </Note>
        </SectionCard>
      ) : (
        <SectionCard
          title={t("autoBewerb.docSelectHeading")}
          aside={active && (
            <span className="text-xs font-semibold text-muted">
              {active.company.company || active.company.ad_extracted?.company || "—"}
            </span>
          )}
        >
          <CompanyPicker value={companyId} onChange={selectCompany} />
          {active &&
            (ws.attachments.length === 0 ? (
              <p className="text-sm text-muted">{t("autoBewerb.docNoSelection")}</p>
            ) : (
              <ul className="space-y-2">
                {ws.attachments.map((a) => {
                  const selected = active.selectedAttachmentIds.includes(a.id);
                  return (
                    <li key={a.id}>
                      <label className={`flex cursor-pointer items-center gap-3 rounded-2xl border px-4 py-3 transition-colors ${selected ? "border-accent bg-accent-soft/30" : "border-line bg-surface hover:border-line-strong"}`}>
                        <input
                          type="checkbox"
                          checked={selected}
                          disabled={toggling === a.id}
                          onChange={(e) => void toggle(a, e.target.checked)}
                          className="h-4 w-4 accent-[var(--color-accent)]"
                        />
                        <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink">{a.display_name}</span>
                        <span className="text-xs text-muted">{t(CATEGORY_KEYS[a.doc_category] ?? "autoBewerb.catOther")}</span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            ))}
        </SectionCard>
      )}

      {/* Rename modal */}
      <Modal open={Boolean(renaming)} onClose={() => !busy && setRenaming(null)} title={t("autoBewerb.docRenameTitle")}>
        <div className="space-y-4">
          <Input label={t("autoBewerb.docName")} value={renameValue} onChange={(e) => setRenameValue(e.target.value)} />
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setRenaming(null)} disabled={busy}>
              {t("common.cancel")}
            </Button>
            <Button variant="primary" onClick={() => void doRename()} disabled={busy || !renameValue.trim()}>
              {t("autoBewerb.saveButton")}
            </Button>
          </div>
        </div>
      </Modal>

      {/* Delete modal */}
      <Modal open={Boolean(deleting)} onClose={() => !busy && setDeleting(null)} title={t("autoBewerb.docDeleteTitle")}>
        <p className="text-sm leading-6 text-muted">
          {t("autoBewerb.docDeleteBody")} {deleting?.display_name}
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
