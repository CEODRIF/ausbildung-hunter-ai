"use client";

/**
 * Step 2 — personal documents.
 *
 * Files are uploaded ONCE to the owner-scoped document library
 * (`uploadBewDocument` → private `application-attachments` bucket) and then
 * ATTACHED to the campaign, where they are shared by every application.
 * Nothing is public: the engine only ever resolves storage paths it
 * ownership-verified, and the janitor now knows `bew_documents` as a
 * reference table (see storage-reconcile BUCKETS).
 */
import { useEffect, useRef, useState } from "react";
import {
  bewAttachDocument,
  bewDetachDocument,
  bewListDocuments,
} from "@/app/bewerbung-automation/actions";
import { useI18n } from "@/lib/i18n";
import type { DocumentKind } from "@/lib/bewerbung-automation";
import { Button, Card } from "@/components/ui";
import { Icon } from "@/components/icon";
import { StatusPill } from "@/components/ui/feedback";
import type { BewCampaignDocumentDTO, BewViewDTO } from "./types";

/**
 * Upload via the /api/bew/documents route (NOT a server action — server
 * actions cap the request body at 1 MB by default, so a multi-MB certificate
 * was 413'd by the framework before the engine ever ran; a small CV passed,
 * a larger second document failed with a generic error). Throws the route's
 * STABLE CODE so `errMessage` can localize it.
 */
async function uploadDocumentViaRoute(
  fd: FormData,
): Promise<{ id: string; filename: string; kind: string }> {
  const res = await fetch("/api/bew/documents", { method: "POST", body: fd });
  let payload: { error?: string; id?: string; filename?: string; kind?: string } = {};
  try {
    payload = await res.json();
  } catch {
    payload = {};
  }
  if (!res.ok || !payload.id) {
    throw new Error(payload.error ?? "INTERNAL");
  }
  return { id: payload.id, filename: payload.filename ?? "", kind: payload.kind ?? "cv" };
}

interface Props {
  view: BewViewDTO;
  refresh: () => Promise<void>;
}

interface LibraryDoc {
  id: string;
  filename: string;
  kind: string;
  sizeBytes: number;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function DocumentsStep({ view, refresh }: Props) {
  const { t } = useI18n();
  const [library, setLibrary] = useState<LibraryDoc[] | null>(null);
  const [kind, setKind] = useState<DocumentKind>("cv");
  const [attachKind, setAttachKind] = useState<DocumentKind>("cv");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const uploadRef = useRef<HTMLInputElement>(null);

  /* Initial library load — the setState happens in the promise callbacks,
     i.e. when the external fetch settles, not synchronously in the effect. */
  useEffect(() => {
    bewListDocuments()
      .then((docs) => setLibrary(docs))
      .catch(() => setLibrary([]));
  }, []);

  async function reloadLibrary() {
    try {
      setLibrary(await bewListDocuments());
    } catch {
      // Keep the current list on a transient read failure.
    }
  }

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await fn();
      await refresh();
      await reloadLibrary();
    } catch (e) {
      setError(errMessage(e, t));
    } finally {
      setBusy(false);
    }
  }

  function handleUpload(file: File) {
    void run(async () => {
      const fd = new FormData();
      fd.set("file", file);
      fd.set("kind", kind);
      const doc = await uploadDocumentViaRoute(fd);
      const fd2 = new FormData();
      fd2.set("campaignId", view.campaign.id);
      fd2.set("documentId", doc.id);
      fd2.set("kind", kind);
      await bewAttachDocument(fd2);
      setNotice(t("bewauto.docUploaded", { name: file.name }));
    });
  }

  function handleAttachLibrary(id: string) {
    void run(async () => {
      const fd = new FormData();
      fd.set("campaignId", view.campaign.id);
      fd.set("documentId", id);
      fd.set("kind", attachKind);
      await bewAttachDocument(fd);
      setNotice(t("bewauto.docAttached"));
    });
  }

  function handleDetach(doc: BewCampaignDocumentDTO) {
    void run(async () => {
      const fd = new FormData();
      fd.set("campaignId", view.campaign.id);
      fd.set("documentId", doc.document_id);
      await bewDetachDocument(fd);
      setNotice(t("bewauto.docDetached"));
    });
  }

  const cv = view.documents.find((d) => d.kind === "cv");
  const certs = view.documents.filter(
    (d) => d.kind === "certificate" || d.kind === "supporting",
  );
  const attachedIds = new Set(view.documents.map((d) => d.document_id));
  const libraryCandidates = (library ?? []).filter(
    (d) => !attachedIds.has(d.id),
  );

  return (
    <Card className="p-6">
      <div className="mb-5">
        <h2 className="text-lg font-bold text-ink">{t("bewauto.step2Title")}</h2>
        <p className="mt-1 max-w-2xl text-sm leading-6 text-muted">{t("bewauto.step2Body")}</p>
      </div>

      {/* Slots */}
      <div className="grid gap-4 lg:grid-cols-2">
        <DocSlot
          title={t("bewauto.slotCv")}
          required
          docs={cv ? [cv] : []}
          onDetach={handleDetach}
          t={t}
        />
        <DocSlot
          title={t("bewauto.slotCerts")}
          required
          docs={certs}
          onDetach={handleDetach}
          t={t}
        />
      </div>

      {error && <p role="alert" className="mt-4 text-sm font-medium text-danger">{error}</p>}
      {notice && !error && <p role="status" className="mt-4 text-sm font-medium text-success">{notice}</p>}

      {/* Upload new */}
      <div className="mt-6 rounded-2xl border border-line bg-surface-2/40 p-4">
        <p className="text-sm font-semibold text-ink-soft">{t("bewauto.uploadTitle")}</p>
        <p className="mt-0.5 text-xs leading-5 text-muted">{t("bewauto.uploadHint")}</p>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <KindSelect value={kind} onChange={setKind} t={t} />
          <input
            ref={uploadRef}
            type="file"
            accept="application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,image/png,image/jpeg"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) handleUpload(f);
              if (uploadRef.current) uploadRef.current.value = "";
            }}
          />
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => uploadRef.current?.click()}>
            <Icon name="upload" size={15} />
            {t("bewauto.uploadBtn")}
          </Button>
        </div>
      </div>

      {/* Attach from library */}
      {libraryCandidates.length > 0 && (
        <div className="mt-4 rounded-2xl border border-line bg-surface-2/40 p-4">
          <p className="text-sm font-semibold text-ink-soft">{t("bewauto.libraryTitle")}</p>
          <div className="mt-3 space-y-2">
            {libraryCandidates.map((doc) => (
              <div key={doc.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line bg-surface px-3 py-2">
                <div className="flex min-w-0 items-center gap-2">
                  <Icon name="file" size={15} className="shrink-0 text-muted" />
                  <span className="truncate text-sm text-ink">{doc.filename}</span>
                  <span className="text-xs text-faint">{formatBytes(doc.sizeBytes)}</span>
                </div>
                <div className="flex items-center gap-2">
                  <KindSelect value={attachKind} onChange={setAttachKind} t={t} compact />
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => handleAttachLibrary(doc.id)}>
                    {t("bewauto.attach")}
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </Card>
  );
}

function DocSlot({
  title,
  required,
  docs,
  onDetach,
  t,
}: {
  title: string;
  required: boolean;
  docs: BewCampaignDocumentDTO[];
  onDetach: (doc: BewCampaignDocumentDTO) => void;
  t: (k: string, v?: Record<string, string | number>) => string;
}) {
  return (
    <div className="rounded-2xl border border-line bg-surface p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <p className="text-sm font-semibold text-ink-soft">{title}</p>
        <StatusPill
          tone={docs.length > 0 ? "success" : required ? "blocked" : "neutral"}
          label={docs.length > 0 ? t("bewauto.filled") : required ? t("bewauto.missing") : t("bewauto.optional")}
        />
      </div>
      {docs.length === 0 ? (
        <p className="text-xs leading-5 text-faint">{t("bewauto.noDocYet")}</p>
      ) : (
        <ul className="space-y-2">
          {docs.map((doc) => (
            <li key={doc.id} className="flex items-center justify-between gap-2 rounded-xl border border-line bg-surface-2 px-3 py-2">
              <div className="flex min-w-0 items-center gap-2">
                <Icon name="file" size={15} className="shrink-0 text-muted" />
                <span className="truncate text-sm text-ink">{doc.filename}</span>
                <span className="shrink-0 text-xs text-faint">{formatBytes(doc.size_bytes)}</span>
              </div>
              <button
                type="button"
                onClick={() => onDetach(doc)}
                className="shrink-0 rounded-lg p-1.5 text-faint transition hover:bg-surface hover:text-danger"
                aria-label={t("bewauto.detach")}
              >
                <Icon name="trash" size={15} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function KindSelect({
  value,
  onChange,
  t,
  compact = false,
}: {
  value: DocumentKind;
  onChange: (k: DocumentKind) => void;
  t: (k: string, v?: Record<string, string | number>) => string;
  compact?: boolean;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as DocumentKind)}
      aria-label={t("bewauto.kindLabel")}
      className={`${
        compact ? "h-8 rounded-lg text-xs" : "h-10 rounded-xl text-sm"
      } border border-line-strong bg-surface px-2.5 text-ink outline-none transition focus:border-accent`}
    >
      <option value="cv">{t("bewauto.kindCv")}</option>
      <option value="certificate">{t("bewauto.kindCertificate")}</option>
      <option value="supporting">{t("bewauto.kindSupporting")}</option>
    </select>
  );
}

/** Map a thrown error to a localized, user-safe message (stable codes only). */
export function errMessage(
  e: unknown,
  t: (k: string, v?: Record<string, string | number>) => string,
): string {
  const code = e instanceof Error ? e.message : "";
  const key = `bewauto.err.${code}`;
  const translated = t(key);
  return translated === key ? t("bewauto.err.UNKNOWN") : translated;
}
