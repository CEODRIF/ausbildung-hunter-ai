"use client";

/**
 * Step 4 — review every generated application before any send.
 *
 * One row per application keeps the 1:1 association visible: row N always
 * shows THAT company, THAT recipient, THAT letter and the shared attachments.
 * The preview renders the ACTUAL stored (server-sanitized) HTML — the exact
 * content that will be sent — never placeholder text. Editing re-sanitizes on
 * the server. Ineligible rows are flagged (invalid e-mail / missing letter /
 * not generated) and can never be selected for sending.
 */
import { useMemo, useState } from "react";
import {
  bewExcludeApplication,
  bewRestoreApplication,
  bewUpdateLetter,
} from "@/app/bewerbung-automation/actions";
import { useI18n } from "@/lib/i18n";
import { Button, Card } from "@/components/ui";
import { Icon } from "@/components/icon";
import { StatusPill } from "@/components/ui/feedback";
import {
  appSendFlags,
  hasRequiredDocuments,
  type BewApplicationDTO,
  type BewViewDTO,
} from "./types";

interface Props {
  view: BewViewDTO;
  refresh: () => Promise<void>;
  selectedIds: Set<string>;
  onToggle: (id: string, selected: boolean) => void;
}

type ModalState =
  | { mode: "preview" | "edit"; app: BewApplicationDTO }
  | null;

export function ReviewStep({ view, refresh, selectedIds, onToggle }: Props) {
  const { t } = useI18n();
  const [modal, setModal] = useState<ModalState>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const docs = hasRequiredDocuments(view.documents);
  const cvDocs = view.documents.filter((d) => d.kind === "cv");
  const certDocs = view.documents.filter(
    (d) => d.kind === "certificate" || d.kind === "supporting",
  );
  const apps = useMemo(
    () => [...view.applications].sort((a, b) => a.seq - b.seq),
    [view.applications],
  );
  const selectable = apps.filter(
    (a) => appSendFlags(a).length === 0 && docs.cv && docs.certs,
  );
  const selectedCount = selectable.filter((a) => selectedIds.has(a.id)).length;

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError(errMessage(e, t));
    } finally {
      setBusy(false);
    }
  }

  function exclude(app: BewApplicationDTO) {
    void run(async () => {
      const fd = new FormData();
      fd.set("applicationId", app.id);
      await bewExcludeApplication(fd);
      onToggle(app.id, false);
    });
  }

  function restore(app: BewApplicationDTO) {
    void run(async () => {
      const fd = new FormData();
      fd.set("applicationId", app.id);
      await bewRestoreApplication(fd);
    });
  }

  return (
    <div>
      <Card className="p-6">
        <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-bold text-ink">{t("bewauto.step4Title")}</h2>
            <p className="mt-1 max-w-2xl text-sm leading-6 text-muted">{t("bewauto.step4Body")}</p>
          </div>
          <StatusPill
            tone={selectedCount > 0 ? "success" : "neutral"}
            label={t("bewauto.selectedCount", { n: selectedCount })}
          />
        </div>

        {(!docs.cv || !docs.certs) && (
          <div role="alert" className="mb-4 flex items-start gap-2.5 rounded-2xl border border-danger/30 bg-danger-soft px-4 py-3 text-sm text-danger">
            <Icon name="alert" size={16} className="mt-0.5 shrink-0" />
            <span>{t("bewauto.docsMissingReview")}</span>
          </div>
        )}
        {error && <p role="alert" className="mb-4 text-sm font-medium text-danger">{error}</p>}

        <div className="overflow-auto rounded-2xl border border-line">
          <table className="w-full min-w-[900px] border-collapse text-sm">
            <thead className="sticky top-0 z-10 bg-surface-2 text-xs uppercase tracking-wide text-muted">
              <tr>
                <Th><span className="sr-only">{t("bewauto.select")}</span></Th>
                <Th>{t("bewauto.colRow")}</Th>
                <Th>{t("bewauto.colCompany")}</Th>
                <Th>{t("bewauto.colEmail")}</Th>
                <Th>{t("bewauto.colAddress")}</Th>
                <Th>{t("bewauto.colLetter")}</Th>
                <Th>{t("bewauto.colAttachments")}</Th>
                <Th>{t("bewauto.colStatus")}</Th>
                <Th>{t("bewauto.colActions")}</Th>
              </tr>
            </thead>
            <tbody>
              {apps.map((app) => {
                const flags = appSendFlags(app);
                const docsOk = docs.cv && docs.certs;
                const eligible = flags.length === 0 && docsOk;
                const checked = eligible && selectedIds.has(app.id);
                return (
                  <tr key={app.id} className="border-t border-line align-top">
                    <td className="px-3 py-2.5">
                      <input
                        type="checkbox"
                        className="h-4 w-4 accent-[var(--glow-accent)]"
                        checked={checked}
                        disabled={!eligible}
                        onChange={(e) => onToggle(app.id, e.target.checked)}
                        aria-label={t("bewauto.selectRow", { n: app.seq })}
                      />
                    </td>
                    <td className="px-3 py-2.5 text-xs font-semibold text-faint">{app.seq}</td>
                    <td className="px-3 py-2.5">
                      <p className="font-medium text-ink">{app.company_name || "—"}</p>
                      {app.contact_name && (
                        <p className="text-xs text-muted">{app.contact_name}</p>
                      )}
                    </td>
                    <td className="px-3 py-2.5">
                      <span className={flags.includes("bad_email") ? "text-danger" : "text-ink-soft"}>
                        {app.company_email || "—"}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-xs text-muted">{app.company_address || "—"}</td>
                    <td className="px-3 py-2.5">
                      {app.body_html ? (
                        <span className="line-clamp-1 block max-w-48 text-xs italic text-muted">
                          {stripTags(app.body_html).slice(0, 80)}…
                        </span>
                      ) : (
                        <span className="text-xs text-faint">—</span>
                      )}
                      {flags.includes("empty_letter") && (
                        <span className="text-xs text-danger">{t("bewauto.flagEmptyLetter")}</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="flex max-w-44 flex-col gap-0.5 text-xs text-muted">
                        <span className="flex items-center gap-1">
                          <Icon name="file" size={12} />
                          {docsOk ? (cvDocs[0]?.filename ?? "—") : t("bewauto.flagMissingCv")}
                        </span>
                        <span className="flex items-center gap-1">
                          <Icon name="file" size={12} />
                          {docsOk
                            ? certDocs.map((d) => d.filename).join(", ") || "—"
                            : t("bewauto.flagMissingCerts")}
                        </span>
                      </div>
                    </td>
                    <td className="px-3 py-2.5">
                      <AppStatusPill status={app.status} t={t} />
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="flex items-center gap-1.5">
                        <Button size="sm" variant="ghost" onClick={() => setModal({ mode: "preview", app })}>
                          <Icon name="search" size={14} />
                          {t("bewauto.preview")}
                        </Button>
                        {app.status === "generated" && (
                          <Button size="sm" variant="ghost" onClick={() => setModal({ mode: "edit", app })}>
                            <Icon name="edit" size={14} />
                            {t("bewauto.edit")}
                          </Button>
                        )}
                        {app.status === "excluded" ? (
                          <Button size="sm" variant="ghost" disabled={busy} onClick={() => restore(app)}>
                            {t("bewauto.restore")}
                          </Button>
                        ) : (
                          app.status !== "sent" &&
                          !["queued", "sending", "generating"].includes(app.status) && (
                            <Button size="sm" variant="ghost" disabled={busy} onClick={() => exclude(app)}>
                              {t("bewauto.exclude")}
                            </Button>
                          )
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      {modal && (
        <LetterModal
          app={modal.app}
          mode={modal.mode}
          view={view}
          busy={busy}
          onClose={() => setModal(null)}
          onSave={async (subject, bodyHtml) => {
            const fd = new FormData();
            fd.set("applicationId", modal.app.id);
            fd.set("subject", subject);
            fd.set("bodyHtml", bodyHtml);
            await bewUpdateLetter(fd);
            setModal(null);
            await refresh();
          }}
          t={t}
        />
      )}
    </div>
  );
}

/* ---------------- letter modal (preview shows the EXACT send content) ---------------- */

function LetterModal({
  app,
  mode,
  view,
  busy,
  onClose,
  onSave,
  t,
}: {
  app: BewApplicationDTO;
  mode: "preview" | "edit";
  view: BewViewDTO;
  busy: boolean;
  onClose: () => void;
  onSave: (subject: string, bodyHtml: string) => Promise<void>;
  t: (k: string, v?: Record<string, string | number>) => string;
}) {
  const [subject, setSubject] = useState(app.subject);
  const [body, setBody] = useState(app.body_html);
  const cvDocs = view.documents.filter((d) => d.kind === "cv");
  const certDocs = view.documents.filter(
    (d) => d.kind === "certificate" || d.kind === "supporting",
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-label={t("bewauto.letterPreviewTitle", { company: app.company_name })}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex max-h-[92vh] w-full max-w-3xl flex-col rounded-t-3xl bg-surface shadow-2xl sm:rounded-3xl">
        <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-4">
          <div>
            <h3 className="text-base font-bold text-ink">
              {t("bewauto.letterPreviewTitle", { company: app.company_name || `#${app.seq}` })}
            </h3>
            <p className="text-xs text-muted">
              {t("bewauto.recipient")}: {app.company_email}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl p-2 text-muted hover:bg-surface-2 hover:text-ink"
            aria-label={t("bewauto.close")}
          >
            <Icon name="x" size={18} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {mode === "edit" ? (
            <div className="space-y-4">
              <label className="block">
                <span className="mb-1.5 block text-xs font-semibold text-ink-soft">{t("bewauto.subjectLabel")}</span>
                <input
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  className="w-full rounded-xl border border-line-strong bg-surface px-3 py-2 text-sm text-ink outline-none focus:border-accent"
                />
              </label>
              <label className="block">
                <span className="mb-1.5 block text-xs font-semibold text-ink-soft">{t("bewauto.editBodyLabel")}</span>
                <textarea
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  rows={16}
                  className="w-full rounded-xl border border-line-strong bg-surface px-3 py-2 font-mono text-xs leading-5 text-ink outline-none focus:border-accent"
                />
              </label>
            </div>
          ) : (
            <div>
              <p className="mb-2 text-sm font-semibold text-ink">{app.subject}</p>
              {/* Server-sanitized HTML — the exact payload that will be sent. */}
              <div
                className="rounded-2xl border border-line bg-surface-2/40 px-4 py-3 text-sm leading-6 text-ink"
                dangerouslySetInnerHTML={{ __html: app.body_html }}
              />
            </div>
          )}

          <div className="mt-4 rounded-2xl border border-line bg-surface-2/40 p-3">
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">
              {t("bewauto.attachments")}
            </p>
            <ul className="space-y-1 text-sm text-ink-soft">
              {cvDocs.map((d) => (
                <li key={d.id} className="flex items-center gap-2">
                  <Icon name="file" size={14} className="text-muted" />
                  {d.filename} <span className="text-xs text-faint">({t("bewauto.kindCv")})</span>
                </li>
              ))}
              {certDocs.map((d) => (
                <li key={d.id} className="flex items-center gap-2">
                  <Icon name="file" size={14} className="text-muted" />
                  {d.filename} <span className="text-xs text-faint">({d.kind === "certificate" ? t("bewauto.kindCertificate") : t("bewauto.kindSupporting")})</span>
                </li>
              ))}
              {cvDocs.length + certDocs.length === 0 && (
                <li className="text-danger">{t("bewauto.flagMissingDocs")}</li>
              )}
            </ul>
          </div>
        </div>

        <div className="flex items-center justify-end gap-3 border-t border-line px-5 py-4">
          <Button variant="ghost" size="sm" onClick={onClose}>
            {t("bewauto.close")}
          </Button>
          {mode === "edit" && (
            <Button size="sm" disabled={busy || !body.trim()} onClick={() => void onSave(subject, body)}>
              {t("bewauto.saveLetter")}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

/* ---------------- helpers ---------------- */

function AppStatusPill({
  status,
  t,
}: {
  status: string;
  t: (k: string, v?: Record<string, string | number>) => string;
}) {
  const map: Record<string, { tone: "success" | "blocked" | "unverified" | "running" | "neutral"; label: string }> = {
    generated: { tone: "success", label: t("bewauto.stGenerated") },
    sent: { tone: "success", label: t("bewauto.stSent") },
    queued: { tone: "running", label: t("bewauto.stQueued") },
    sending: { tone: "running", label: t("bewauto.stSending") },
    failed: { tone: "blocked", label: t("bewauto.stFailed") },
    needs_attention: { tone: "blocked", label: t("bewauto.stNeedsAttention") },
    pending: { tone: "unverified", label: t("bewauto.stPending") },
    generating: { tone: "running", label: t("bewauto.stGenerating") },
    excluded: { tone: "neutral", label: t("bewauto.stExcluded") },
    cancelled: { tone: "neutral", label: t("bewauto.stCancelled") },
  };
  const m = map[status] ?? { tone: "neutral" as const, label: status };
  return <StatusPill tone={m.tone} label={m.label} />;
}

function Th({ children }: { children?: React.ReactNode }) {
  return <th className="px-3 py-2.5 text-start font-semibold">{children}</th>;
}

function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function errMessage(e: unknown, t: (k: string, v?: Record<string, string | number>) => string): string {
  const code = e instanceof Error ? e.message : "";
  const key = `bewauto.err.${code}`;
  const translated = t(key);
  return translated === key ? t("bewauto.err.UNKNOWN") : translated;
}
