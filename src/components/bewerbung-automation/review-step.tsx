"use client";

/**
 * Step 4 — review every generated application before any send.
 *
 * One row per application keeps the 1:1 association visible: row N always
 * shows THAT company, THAT recipient, THAT letter and the shared attachments.
 *
 * The letter is NEVER shown as raw HTML: the preview renders the stored
 * (server-sanitized) content as PLAIN-TEXT paragraphs on an A4-style page —
 * exactly the content the generated Anschreiben PDF contains. Editing uses
 * structured fields (subject, greeting, body paragraphs, closing, signature)
 * and the save path re-escapes every part on the server.
 */
import { memo, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  bewExcludeApplication,
  bewRestoreApplication,
  bewUpdateLetter,
} from "@/app/bewerbung-automation/actions";
import { useI18n } from "@/lib/i18n";
import {
  formatGermanDate,
  htmlToParagraphs,
  letterParagraphsToHtml,
  letterPdfFilename,
  splitAddressLines,
  splitLetterParagraphs,
} from "@/lib/bewerbung-automation";
import { isBewEmailComplete } from "@/lib/bewerbung-automation";
import {
  renderPersonalizedMessage,
  type RenderedMessage,
} from "@/lib/personalization";
import { Button, Card } from "@/components/ui";
import { Icon } from "@/components/icon";
import { StatusPill } from "@/components/ui/feedback";
import { EmailMessageCard } from "./email-message";
import {
  appSendFlags,
  hasRequiredDocuments,
  resolveBewError,
  type BewApplicationDTO,
  type BewViewDTO,
} from "./types";

interface Props {
  view: BewViewDTO;
  refresh: () => Promise<unknown>;
  selectedIds: Set<string>;
  onToggle: (id: string, selected: boolean) => void;
  /** The applicant's profile name (sender block of the A4 preview). */
  applicantName: string;
  /** The applicant's profile e-mail (sender block of the A4 preview). */
  applicantEmail: string;
}

type ModalState =
  | { mode: "preview" | "edit"; app: BewApplicationDTO }
  | null;

/** The stored letter as readable plain-text parts (never HTML). */
function parseLetter(
  app: BewApplicationDTO,
  applicantName: string,
): { greeting: string; body: string[]; closing: string; signature: string } {
  return splitLetterParagraphs(htmlToParagraphs(app.body_html), applicantName);
}

/** Plain-text excerpt for the table (tags removed, entities decoded). */
function letterExcerpt(app: BewApplicationDTO, max = 80): string {
  return htmlToParagraphs(app.body_html).join(" ").slice(0, max);
}

export const ReviewStep = memo(function ReviewStep({
  view,
  refresh,
  selectedIds,
  onToggle,
  applicantName,
  applicantEmail,
}: Props) {
  const { t } = useI18n();
  const router = useRouter();
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
      // `null` = session expired → navigating to /login (no error shown).
      const msg = resolveBewError(e, t, (p) => router.replace(p));
      if (msg !== null) setError(msg);
    } finally {
      setBusy(false);
    }
  }

  function exclude(app: BewApplicationDTO) {
    void run(async () => {
      const fd = new FormData();
      fd.set("applicationId", app.id);
      // The action RESOLVES with a stable code on failure (a thrown error
      // can be re-wrapped in transit). Treating `ok: false` as success was
      // a fake-success hole: the row got deselected although the server
      // kept it. Throw so run() shows the localized message.
      const res = await bewExcludeApplication(fd);
      if (!res.ok) throw new Error(res.code);
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
      {/* The campaign e-mail message — written once, personalized per
          recipient at send time. A DISTINCT artifact from the per-company
          Anschreiben, which stays the PDF attachment. */}
      <EmailMessageCard view={view} refresh={refresh} applicantName={applicantName} />

      <div className="mt-6">
      <Card className="p-5">
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
                const hasErrorLine =
                  (app.status === "failed" || app.status === "needs_attention") &&
                  (app.error_code === "pdf_generation_failed" ||
                    (app.error_message ?? "").trim().length > 0);
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
                          {letterExcerpt(app)}…
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
                        <span className="flex items-center gap-1">
                          <Icon name="file" size={12} />
                          {letterPdfFilename(app.company_name)}
                        </span>
                      </div>
                    </td>
                    <td className="px-3 py-2.5">
                      <AppStatusPill status={app.status} t={t} />
                      {hasErrorLine && (
                        <p className="mt-1 max-w-44 text-xs leading-4 text-danger">
                          {app.error_code === "pdf_generation_failed"
                            ? t("bewauto.errPdfGeneration")
                            : app.error_message}
                        </p>
                      )}
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
      </div>

      {modal && (
        <LetterModal
          key={modal.app.id}
          app={modal.app}
          mode={modal.mode}
          view={view}
          busy={busy}
          applicantName={applicantName}
          applicantEmail={applicantEmail}
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
});

/* ---------------- letter modal (A4 preview, structured editing) ---------------- */

/** Exported for the SSR regression tests (renderToString assertions). */
export function LetterModal({
  app,
  mode,
  view,
  busy,
  applicantName,
  applicantEmail,
  onClose,
  onSave,
  t,
}: {
  app: BewApplicationDTO;
  mode: "preview" | "edit";
  view: BewViewDTO;
  busy: boolean;
  applicantName: string;
  applicantEmail: string;
  onClose: () => void;
  onSave: (subject: string, bodyHtml: string) => Promise<void>;
  t: (k: string, v?: Record<string, string | number>) => string;
}) {
  const letter = useMemo(
    () => parseLetter(app, applicantName),
    [app, applicantName],
  );
  const [subject, setSubject] = useState(app.subject);
  const [body, setBody] = useState(letter.body.join("\n\n"));
  const cvDocs = view.documents.filter((d) => d.kind === "cv");
  const certDocs = view.documents.filter(
    (d) => d.kind === "certificate" || d.kind === "supporting",
  );
  /** What the user typed, as paragraph list (blank line = new paragraph). */
  const bodyParagraphs = useMemo(
    () =>
      body
        .split(/\n{2,}/)
        .map((p) => p.replace(/\s*\n\s*/g, " ").trim())
        .filter(Boolean),
    [body],
  );
  const router = useRouter();
  /** Own save guard: the parent's `busy` does not cover this async path, so
   *  without it a double-click fired two concurrent letter saves. */
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  async function save() {
    if (busy || saving || bodyParagraphs.length === 0) return;
    setSaving(true);
    setSaveError(null);
    try {
      await onSave(
        subject.trim(),
        letterParagraphsToHtml(letter.greeting, bodyParagraphs, letter.closing, letter.signature),
      );
      // Success: the parent closes the modal (and refreshes).
    } catch (e) {
      // Failure: the modal stays OPEN with the edits intact and shows the
      // localized reason (the old `void onSave(...)` swallowed the rejection
      // — the user never learned that the letter was NOT saved). An expired
      // session navigates to /login instead of showing an error.
      const msg = resolveBewError(e, t, (p) => router.replace(p));
      if (msg !== null) setSaveError(msg);
    } finally {
      setSaving(false);
    }
  }

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
                  className="w-full rounded-xl border border-line-strong bg-surface px-3 py-2 text-base text-ink outline-none focus:border-accent lg:text-sm"
                />
              </label>
              <ReadonlyField label={t("bewauto.letterGreetingLabel")} value={letter.greeting} />
              <label className="block">
                <span className="mb-1.5 block text-xs font-semibold text-ink-soft">{t("bewauto.letterBodyLabel")}</span>
                <textarea
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  rows={14}
                  className="w-full rounded-xl border border-line-strong bg-surface px-3 py-2 text-base leading-7 text-ink outline-none focus:border-accent lg:text-sm lg:leading-6"
                />
                <span className="mt-1 block text-xs text-faint">{t("bewauto.letterBodyHint")}</span>
              </label>
              <ReadonlyField label={t("bewauto.letterClosingLabel")} value={letter.closing} />
              <ReadonlyField label={t("bewauto.letterSignatureLabel")} value={letter.signature} />
            </div>
          ) : (
            <div className="space-y-4">
              {/* The outgoing e-mail message for THIS recipient — a distinct
                  item from the cover letter below (the PDF is listed again in
                  the attachments block). */}
              <EmailForRecipient view={view} app={app} applicantName={applicantName} t={t} />
              <LetterA4Preview
                app={app}
                letter={letter}
                applicantName={applicantName}
                applicantEmail={applicantEmail}
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
              <li className="flex items-center gap-2">
                <Icon name="file" size={14} className="text-muted" />
                {letterPdfFilename(app.company_name)}
                <span className="text-xs text-faint">({t("bewauto.letterPdf")})</span>
              </li>
              {cvDocs.length + certDocs.length === 0 && (
                <li className="text-danger">{t("bewauto.flagMissingDocs")}</li>
              )}
            </ul>
            <p className="mt-2 text-xs leading-4 text-faint">
              {app.status === "sent"
                ? t("bewauto.letterPdfSentNote")
                : t("bewauto.letterPdfNote")}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3 border-t border-line px-5 py-4">
          {saveError && (
            <p role="alert" className="min-w-0 flex-1 text-sm text-danger">
              {saveError}
            </p>
          )}
          <div className="ml-auto flex items-center gap-3">
            <Button variant="ghost" size="sm" onClick={onClose}>
              {t("bewauto.close")}
            </Button>
            {mode === "edit" && (
              <Button
                size="sm"
                disabled={busy || saving || bodyParagraphs.length === 0}
                onClick={() => void save()}
              >
                {saving ? t("bewauto.saving") : t("bewauto.saveLetter")}
              </Button>
            )}
          </div>
        </div>
        {/* iPhone safe area: on phones the sheet is bottom-anchored
            (items-end, no backdrop padding), so reserve the home-indicator
            inset below the action row. Zero height everywhere the inset is
            0 (incl. >= sm, where the sheet is centered). */}
        <div aria-hidden="true" className="max-sm:h-[env(safe-area-inset-bottom)]" />
      </div>
    </div>
  );
}

/** A4-style rendering of the letter — plain text only, the exact content
 *  the generated PDF contains (sender top-right, date, recipient block,
 *  bold subject, greeting, justified body, closing + signature area). */
function LetterA4Preview({
  app,
  letter,
  applicantName,
  applicantEmail,
}: {
  app: BewApplicationDTO;
  letter: { greeting: string; body: string[]; closing: string; signature: string };
  applicantName: string;
  applicantEmail: string;
}) {
  const addressLines = splitAddressLines(app.company_address);
  return (
    <div className="mx-auto max-w-[540px] rounded-2xl border border-line bg-white p-8 shadow-sm sm:p-10">
      {/* Sender block — top right (only data that actually exists) */}
      <div className="text-right text-[13px] leading-6">
        {applicantName && (
          <p className="font-bold uppercase tracking-wide text-ink">{applicantName}</p>
        )}
        {applicantEmail && <p className="text-muted">{applicantEmail}</p>}
        <p className="mt-2 font-semibold text-ink">{formatGermanDate(new Date())}</p>
      </div>

      {/* The reference document's clear separation between date and recipient */}
      <div className="h-16" />

      <div className="text-[13px] leading-6">
        <p className="font-bold text-ink">{app.company_name || "—"}</p>
        {app.contact_name && <p className="text-ink">{app.contact_name}</p>}
        {addressLines.map((line) => (
          <p key={line} className="text-muted">{line}</p>
        ))}
      </div>

      <div className="h-10" />

      {app.subject && <p className="text-[13px] font-bold text-ink">{app.subject}</p>}

      <div className="h-6" />
      {letter.greeting && (
        <p className="text-[13px] leading-6 text-ink">{letter.greeting}</p>
      )}
      <div className="mt-1 space-y-3">
        {letter.body.map((paragraph, i) => (
          <p key={i} className="text-justify text-[13px] leading-6 text-ink">
            {paragraph}
          </p>
        ))}
      </div>

      <div className="h-6" />
      {letter.closing && (
        <p className="text-[13px] text-ink">{letter.closing}</p>
      )}
      {/* Signature space (kept together with the closing, as in the PDF) */}
      <div className="h-14" />
      {letter.signature && (
        <p className="text-[13px] text-ink">{letter.signature}</p>
      )}
    </div>
  );
}

/** The campaign e-mail message rendered for ONE recipient (the same pure
 *  resolver the send pipeline uses) — shown in the review so the email
 *  body and the cover letter are clearly separate items. */
function EmailForRecipient({
  view,
  app,
  applicantName,
  t,
}: {
  view: BewViewDTO;
  app: BewApplicationDTO;
  applicantName: string;
  t: (k: string, v?: Record<string, string | number>) => string;
}) {
  const { email_subject: subject, email_body_html: bodyHtml } = view.campaign;
  const complete = isBewEmailComplete(subject, bodyHtml);
  let rendered: RenderedMessage | null = null;
  if (complete) {
    try {
      rendered = renderPersonalizedMessage(
        { subject: subject ?? "", bodyHtml: bodyHtml ?? "", bodyText: "" },
        {
          email: app.company_email,
          companyName: app.company_name,
          contactName: app.contact_name,
        },
        { candidateName: applicantName },
      );
    } catch {
      rendered = null; // a variable cannot be resolved for this recipient
    }
  }
  return (
    <div className="rounded-2xl border border-line bg-surface-2/40 p-4">
      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">
        {t("bewauto.emailInReviewTitle")}
      </p>
      {!complete ? (
        <p className="text-xs leading-5 text-warning">{t("bewauto.emailEmptyHint")}</p>
      ) : rendered ? (
        <div>
          <p className="text-sm font-semibold text-ink">{rendered.subject}</p>
          <div
            className="mt-2 max-h-52 overflow-y-auto text-sm leading-6 text-ink-soft"
            dangerouslySetInnerHTML={{ __html: rendered.bodyHtml }}
          />
        </div>
      ) : (
        <p className="text-xs leading-5 text-danger">{t("bewauto.emailPreviewUnresolved")}</p>
      )}
    </div>
  );
}

/** A labeled read-only line (greeting/closing/signature are fixed by the
 *  letter assembly — shown so the user knows exactly what will be sent). */
function ReadonlyField({ label, value }: { label: string; value: string }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-semibold text-ink-soft">{label}</span>
      <input
        value={value}
        readOnly
        aria-readonly="true"
        className="w-full cursor-default rounded-xl border border-line bg-surface-2/60 px-3 py-2 text-base text-muted outline-none lg:text-sm"
      />
    </label>
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

/* Error mapping lives in `resolveBewError` (./types) — the per-step copies
   were removed so re-authentication and digest re-wrapping are handled in
   exactly one place. */
