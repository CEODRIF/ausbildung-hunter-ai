"use client";

/**
 * Step 4 — the campaign e-mail message (independent from the cover letter).
 *
 * The outgoing e-mail is written ONCE per campaign (subject + rich-text
 * body) and personalized per recipient at send time via the stable
 * lib/personalization tokens. The per-company Anschreiben is a SEPARATE
 * artifact: it travels as its own PDF attachment, and nothing in this card
 * edits, regenerates or re-renders the letter.
 *
 * Draft persistence (the project's existing pattern):
 *   - the parent (ReviewStep) stays MOUNTED across wizard steps, so unsaved
 *     edits survive navigating away and back,
 *   - "Speichern" persists via the bewSaveEmail action (server-sanitized),
 *     so a page refresh restores the last saved message,
 *   - a refresh while the draft is DIRTY never clobbers local edits; it is
 *     only adopted when the card is clean.
 */
import { useEffect, useMemo, useState } from "react";
import { bewSaveEmail } from "@/app/bewerbung-automation/actions";
import { isBewEmailComplete } from "@/lib/bewerbung-automation";
import {
  renderPersonalizedMessage,
  type RenderedMessage,
} from "@/lib/personalization";
import { Button, Card } from "@/components/ui";
import { Icon } from "@/components/icon";
import { RichEmailEditor, type EmailVariable } from "@/components/rich-email-editor";
import { useI18n } from "@/lib/i18n";
import { bewEmailTemplateFor } from "./email-templates";
import type { BewApplicationDTO, BewViewDTO } from "./types";

interface Props {
  view: BewViewDTO;
  refresh: () => Promise<unknown>;
  /** The applicant's profile name — resolves {{candidate_name}} in the
   *  preview (the real send re-resolves it server-side). */
  applicantName: string;
}

const BEW_TERMINAL = new Set(["completed", "partially_failed", "cancelled"]);

/** Rows the preview can render for: generated + valid recipient, by seq. */
function previewRecipients(view: BewViewDTO): BewApplicationDTO[] {
  return [...view.applications]
    .filter(
      (a) =>
        a.status === "generated" &&
        a.company_email.trim() !== "" &&
        a.company_name.trim() !== "",
    )
    .sort((a, b) => a.seq - b.seq);
}

export function EmailMessageCard({ view, refresh, applicantName }: Props) {
  const { t } = useI18n();
  const locked =
    view.campaign.status === "sending" || BEW_TERMINAL.has(view.campaign.status);

  const [subject, setSubject] = useState(view.campaign.email_subject ?? "");
  const [bodyHtml, setBodyHtml] = useState(view.campaign.email_body_html ?? "");
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);

  /* A refresh (own save, another step's save, poll) must never clobber an
     unsaved local draft — server values are adopted only when clean.
     Guarded by `dirty`, so this can never loop (the setters do not change
     either dependency). */
  useEffect(() => {
    if (dirty) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSubject(view.campaign.email_subject ?? "");
    setBodyHtml(view.campaign.email_body_html ?? "");
  }, [view, dirty]);

  const complete = isBewEmailComplete(subject, bodyHtml);
  const recipients = useMemo(() => previewRecipients(view), [view]);

  const variables: EmailVariable[] = [
    {
      token: "{{candidate_name}}",
      label: t("bewauto.emailVarCandidate"),
      title: `${t("bewauto.emailVarCandidate")} — {{candidate_name}}`,
    },
    {
      token: "{{contact_name}}",
      label: t("bewauto.emailVarContact"),
      title: `${t("bewauto.emailVarContact")} — {{contact_name}}`,
    },
    {
      token: "{{company_name}}",
      label: t("bewauto.emailVarCompany"),
      title: `${t("bewauto.emailVarCompany")} — {{company_name}}`,
    },
    {
      token: "{{greeting}}",
      label: t("bewauto.emailVarGreeting"),
      title: `${t("bewauto.emailVarGreeting")} — {{greeting}}`,
    },
  ];

  async function save() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const fd = new FormData();
      fd.set("campaignId", view.campaign.id);
      fd.set("subject", subject);
      fd.set("bodyHtml", bodyHtml);
      await bewSaveEmail(fd);
      setDirty(false);
      await refresh();
      setNotice(t("bewauto.emailSaved"));
    } catch (e) {
      setError(errMessage(e, t));
    } finally {
      setBusy(false);
    }
  }

  /** A template fills the DRAFT only — it never sends anything and never
   *  touches the per-company Anschreiben (or its PDF). */
  function applyTemplate(purpose: string) {
    const template = bewEmailTemplateFor(purpose);
    if (!template) return;
    setSubject(template.subject);
    setBodyHtml(template.bodyHtml);
    setDirty(true);
    setError(null);
    setNotice(null);
  }

  return (
    <Card className="p-5">
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-ink">{t("bewauto.emailTitle")}</h2>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-muted">
            {t("bewauto.emailBody")}
          </p>
        </div>
        {!complete && (
          <span className="inline-flex items-center gap-1.5 rounded-xl border border-warning/40 bg-warning-soft px-3 py-1.5 text-xs font-semibold text-warning">
            <Icon name="alert" size={13} />
            {t("bewauto.emailIncomplete")}
          </span>
        )}
      </div>

      {locked && (
        <p className="mb-4 rounded-xl border border-line bg-surface-2/50 px-3 py-2.5 text-xs leading-5 text-muted">
          {t("bewauto.emailLocked")}
        </p>
      )}
      {error && <p role="alert" className="mb-4 text-sm font-medium text-danger">{error}</p>}
      {notice && !error && (
        <p className="mb-4 text-sm font-medium text-success">{notice}</p>
      )}

      <label className="block">
        <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-muted">
          {t("bewauto.emailSubjectLabel")}
        </span>
        <input
          type="text"
          value={subject}
          disabled={locked}
          onChange={(e) => {
            setSubject(e.target.value);
            setDirty(true);
            setNotice(null);
          }}
          placeholder={t("bewauto.emailSubjectPlaceholder")}
          className="h-11 w-full rounded-xl border border-line-strong bg-surface px-3.5 text-base text-ink outline-none transition focus:border-accent focus:ring-4 focus:ring-accent/10 disabled:cursor-not-allowed disabled:opacity-50 lg:text-sm"
        />
      </label>

      <div className="mt-4">
        <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs font-semibold uppercase tracking-wide text-muted">
            {t("bewauto.emailMessageLabel")}
          </span>
          <span className="text-[11px] text-faint">{t("bewauto.emailMessageHint")}</span>
        </div>
        <RichEmailEditor
          value={bodyHtml}
          onChange={(html) => {
            setBodyHtml(html);
            setDirty(true);
            setNotice(null);
          }}
          variables={variables}
        />
      </div>

      {/* Ready-made templates (fill subject + body, send nothing) */}
      <div className="mt-4 grid gap-3 sm:grid-cols-[1fr_auto]">
        <div className="rounded-2xl border border-line bg-surface-2/40 p-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted">
            {t("bewauto.emailTemplates")}
          </p>
          <p className="mb-2 mt-0.5 text-[11px] text-faint">{t("bewauto.emailTemplatesHint")}</p>
          <div className="flex flex-wrap gap-2">
            {(["ausbildung", "arbeit", "praktikum"] as const).map((purpose) => (
              <button
                key={purpose}
                type="button"
                disabled={locked}
                onClick={() => applyTemplate(purpose)}
                className="rounded-xl border border-line-strong bg-surface px-3 py-2 text-xs font-semibold text-ink-soft transition hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-50"
              >
                {t(`bewauto.emailTemplate${purpose.charAt(0).toUpperCase()}${purpose.slice(1)}`)}
              </button>
            ))}
          </div>
        </div>
        <div className="flex items-end gap-2">
          <Button variant="secondary" size="sm" disabled={recipients.length === 0} onClick={() => setPreviewOpen(true)}>
            <Icon name="search" size={14} />
            {t("bewauto.emailPreview")}
          </Button>
          <Button size="sm" disabled={locked || busy} onClick={() => void save()}>
            <Icon name="check" size={14} />
            {t("bewauto.emailSave")}
          </Button>
        </div>
      </div>

      {previewOpen && (
        <EmailPreviewModal
          view={view}
          subject={subject}
          bodyHtml={bodyHtml}
          applicantName={applicantName}
          onClose={() => setPreviewOpen(false)}
          t={t}
        />
      )}
    </Card>
  );
}

/* ---------------- final rendered e-mail preview (per recipient) ---------------- */

function EmailPreviewModal({
  view,
  subject,
  bodyHtml,
  applicantName,
  onClose,
  t,
}: {
  view: BewViewDTO;
  subject: string;
  bodyHtml: string;
  applicantName: string;
  onClose: () => void;
  t: (k: string, v?: Record<string, string | number>) => string;
}) {
  const recipients = useMemo(() => previewRecipients(view), [view]);
  const [seq, setSeq] = useState<number>(recipients[0]?.seq ?? 0);
  const app = recipients.find((a) => a.seq === seq) ?? recipients[0];

  /** The SAME pure resolver the send pipeline uses — the preview is what
   *  this recipient would actually receive. The rendered HTML is the user's
   *  own draft (server-sanitized on save + again at send time). */
  const rendered: RenderedMessage | null = useMemo(() => {
    if (!app) return null;
    try {
      return renderPersonalizedMessage(
        { subject, bodyHtml, bodyText: "" },
        {
          email: app.company_email,
          companyName: app.company_name,
          contactName: app.contact_name,
        },
        { candidateName: applicantName },
      );
    } catch {
      return null; // unresolved token for this recipient — flagged below
    }
  }, [app, subject, bodyHtml, applicantName]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-label={t("bewauto.emailPreviewTitle")}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex max-h-[92vh] w-full max-w-2xl flex-col rounded-t-3xl bg-surface shadow-2xl sm:rounded-3xl">
        <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-4">
          <h3 className="text-base font-bold text-ink">{t("bewauto.emailPreviewTitle")}</h3>
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
          <label className="mb-4 block">
            <span className="mb-1.5 block text-xs font-semibold text-ink-soft">
              {t("bewauto.emailPreviewRecipient")}
            </span>
            <select
              value={app?.seq ?? 0}
              onChange={(e) => setSeq(Number(e.target.value))}
              className="h-11 w-full rounded-xl border border-line-strong bg-surface px-3.5 text-sm text-ink outline-none focus:border-accent"
            >
              {recipients.map((r) => (
                <option key={r.id} value={r.seq}>
                  {r.seq}. {r.company_name} — {r.company_email}
                </option>
              ))}
            </select>
          </label>

          {app && !completeLocal(subject, bodyHtml) ? (
            <p className="rounded-xl border border-warning/40 bg-warning-soft px-3 py-2.5 text-xs leading-5 text-warning">
              {t("bewauto.emailIncomplete")}
            </p>
          ) : rendered && app ? (
            <div className="rounded-2xl border border-line bg-white p-6">
              <div className="border-b border-line pb-3">
                <p className="text-xs text-muted">
                  {t("bewauto.recipient")}: <span className="text-ink">{app.company_email}</span>
                </p>
                <p className="mt-2 text-sm font-bold text-ink">
                  {t("bewauto.emailPreviewSubject")}: {rendered.subject}
                </p>
              </div>
              <div
                className="mt-4 text-sm leading-7 text-ink"
                dangerouslySetInnerHTML={{ __html: rendered.bodyHtml }}
              />
            </div>
          ) : rendered === null && app ? (
            <p className="rounded-xl border border-danger/30 bg-danger-soft px-3 py-2.5 text-xs leading-5 text-danger">
              {t("bewauto.emailPreviewUnresolved")}
            </p>
          ) : null}

          <p className="mt-3 text-xs leading-5 text-faint">{t("bewauto.emailPreviewNote")}</p>
        </div>

        <div className="flex items-center justify-end gap-3 border-t border-line px-5 py-4">
          <Button variant="ghost" size="sm" onClick={onClose}>
            {t("bewauto.close")}
          </Button>
        </div>
        {/* iPhone safe area: on phones the sheet is bottom-anchored, so
            reserve the home-indicator inset below the action row (zero
            height where the inset is 0 / at >= sm). */}
        <div aria-hidden="true" className="max-sm:h-[env(safe-area-inset-bottom)]" />
      </div>
    </div>
  );
}

/** Local completeness check for the preview (no i18n side effects). */
function completeLocal(subject: string, bodyHtml: string): boolean {
  return isBewEmailComplete(subject, bodyHtml);
}

function errMessage(e: unknown, t: (k: string, v?: Record<string, string | number>) => string): string {
  const code = e instanceof Error ? e.message : "";
  const key = `bewauto.err.${code}`;
  const translated = t(key);
  return translated === key ? t("bewauto.err.UNKNOWN") : translated;
}
