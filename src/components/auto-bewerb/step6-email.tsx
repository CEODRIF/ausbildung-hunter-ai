"use client";

import { useState } from "react";
import Link from "next/link";
import { AlertTriangle, Eye, Mail, Save, Sparkles } from "lucide-react";
import { Button, Input } from "@/components/ui";
import { EmptyState } from "@/components/ui/feedback";
import { useI18n } from "@/lib/i18n";
import {
  AUTO_BEWERB_EMAIL_TEMPLATE_MAX,
  AUTO_BEWERB_EMAIL_DEFAULT_BODY,
  AUTO_BEWERB_EMAIL_DEFAULT_SUBJECT,
  buildAutoBewerbGreeting,
  isValidEmail,
  resolveAutoBewerbRecipient,
  substituteEmailTokens,
} from "@/lib/auto-bewerb/schema";
import { sanitizeEmailHtml } from "@/lib/email-sanitize";
import { saveEmailSettingsAction, saveEmailTemplateAction } from "@/app/auto-bewerb/actions";
import { EmailRichEditor } from "./email-rich-editor";
import { AttachmentManifest } from "./attachment-manifest";
import { Note, SectionCard, companyLabel, useAutoBewerb } from "./shared";

/**
 * Step 6 — professional e-mail editor + ONE global configuration + manifest.
 *
 * Supported mode (email-settings migration applied): a rich-text editor for the
 * SHARED e-mail (subject + body), a live preview, ONE global configuration
 * (optional shared recipient, sending account, attach-CV / attach-letter
 * flags) saved with a single button, and a read-only per-company attachment
 * manifest. The body is sanitized HTML; the supported {{tokens}} are
 * personalized per recipient at send time (missing → empty, never invented).
 * Each company keeps its verified delivery address + its OWN CV/Anschreiben.
 *
 * Legacy mode (migration not applied yet): the shared body is still editable
 * (saved separately); the per-company values are shown READ-ONLY and still
 * honored by the send engine. A pending-migration notice explains the upgrade.
 */

const looksLikeHtml = (s: string) => /<[a-z][\s\/>]/i.test(s);
/** Render legacy PLAIN-TEXT bodies as paragraphs so they stay readable in the
 *  rich-text editor; HTML passes through untouched. */
function plainToHtmlSafe(s: string): string {
  if (!s || looksLikeHtml(s)) return s;
  const esc = (x: string) => x.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return s
    .split(/\n{2,}/)
    .map((p) => esc(p.trim()).replace(/\n/g, "<br>"))
    .filter(Boolean)
    .map((p) => `<p>${p}</p>`)
    .join("\n");
}

export function Step6Email() {
  const { ws, refresh, notify, goToStep } = useAutoBewerb();
  const { t } = useI18n();
  const supported = ws.emailSettingsSupported;
  const s = ws.emailSettings;

  // Local edits are buffered against the server value (body as a DRAFT, null =
  // follow the server) — step navigation never discards an unsaved edit.
  const [templateDraft, setTemplateDraft] = useState<string | null>(null);
  const [recipient, setRecipient] = useState(s?.recipient ?? "");
  const [subject, setSubject] = useState(supported && s ? s.subject || AUTO_BEWERB_EMAIL_DEFAULT_SUBJECT : "");
  const [accountId, setAccountId] = useState(s?.accountId ?? "");
  const [attachCv, setAttachCv] = useState(s?.attachCv ?? true);
  const [attachLetter, setAttachLetter] = useState(s?.attachLetter ?? true);
  const [savingTemplate, setSavingTemplate] = useState(false);
  const [saving, setSaving] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const [draftResult, setDraftResult] = useState<{ subject: string; body: string } | null>(null);

  const serverBody = ws.emailTemplate;
  const bodyDisplay = templateDraft ?? plainToHtmlSafe(serverBody || AUTO_BEWERB_EMAIL_DEFAULT_BODY);
  const bodyDirty = bodyDisplay !== serverBody;
  const templateTooLong = bodyDisplay.length > AUTO_BEWERB_EMAIL_TEMPLATE_MAX;
  const globalDirty =
    bodyDirty ||
    subject !== (s?.subject ?? "") ||
    recipient !== (s?.recipient ?? "") ||
    accountId !== (s?.accountId ?? "") ||
    attachCv !== (s?.attachCv ?? true) ||
    attachLetter !== (s?.attachLetter ?? true);

  const account = ws.emailAccounts.find((a) => a.id === accountId) ?? null;

  const saveTemplate = async () => {
    setSavingTemplate(true);
    const res = await saveEmailTemplateAction(bodyDisplay);
    setSavingTemplate(false);
    if (res.ok) {
      setTemplateDraft(null);
      await refresh();
      notify("success", t("autoBewerb.saved"));
    } else notify("error", t("autoBewerb.saveError"));
  };

  /** One Save — the complete global configuration (subject + body included). */
  const saveSettings = async () => {
    setSaving(true);
    const res = await saveEmailSettingsAction({
      body: bodyDisplay,
      recipient,
      subject,
      accountId,
      attachCv,
      attachLetter,
    });
    setSaving(false);
    if (res.ok) {
      setTemplateDraft(null);
      await refresh();
      notify("success", t("autoBewerb.saved"));
    } else notify("error", t("autoBewerb.saveError"));
  };

  if (ws.companies.length === 0) {
    return <EmptyState title={t("autoBewerb.emailEmpty")} body={t("autoBewerb.emailEmptyBody")} illustration={<Mail size={34} strokeWidth={1.6} />} ctaIcon={<Button variant="primary" onClick={() => goToStep(2)}>{t("autoBewerb.goToCompanies")}</Button>} />;
  }

  const sharedDocNames = ws.attachments.map((a) => a.display_name);

  const generateDraft = async () => {
    setDrafting(true);
    setDraftResult(null);
    try {
      const res = await fetch("/api/auto-bewerb/generate-email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ attachmentNames: sharedDocNames.slice(0, 10) }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; subject?: string; body?: string };
      if (!res.ok || !data.subject || !data.body) notify("error", data.error ?? t("autoBewerb.generateError"));
      else setDraftResult({ subject: data.subject, body: data.body });
    } catch {
      notify("error", t("autoBewerb.generateError"));
    } finally {
      setDrafting(false);
    }
  };

  /** The AI draft is PLAIN text → convert to HTML for the rich editor. */
  const applyDraft = (d: { subject: string; body: string }) => {
    setTemplateDraft(plainToHtmlSafe(d.body));
    if (supported) setSubject(d.subject);
  };

  // Live preview: the SAME sanitized template, personalized for the first
  // company (a representative recipient). Rendered as sanitized HTML only.
  const previewCompany = ws.companies[0];
  const previewValues = {
    candidate_name: ws.candidateName,
    contact_person: String(previewCompany?.company.ad_extracted?.contactPerson ?? "").trim(),
    company_name: String(previewCompany?.company.ad_extracted?.company || previewCompany?.company.company || "").trim(),
    greeting: buildAutoBewerbGreeting(previewCompany?.company.ad_extracted?.contactPerson),
    position: String(previewCompany?.company.ad_extracted?.jobTitle || previewCompany?.company.ad_extracted?.occupation || "").trim(),
  };
  const previewHtml = sanitizeEmailHtml(substituteEmailTokens(bodyDisplay, previewValues));
  const previewSubject = substituteEmailTokens(subject, previewValues).trim();

  return (
    <div className="space-y-5">
      {!supported && <Note kind="error">{t("autoBewerb.emailSettingsMigrationPending")}</Note>}

      {/* E-mail message — shared subject + rich-text body + live preview */}
      <SectionCard
        title={t("autoBewerb.templateTitle")}
        aside={
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" onClick={() => void generateDraft()} disabled={drafting}>
              <Sparkles size={14} />
              {drafting ? t("autoBewerb.generatingButton") : t("autoBewerb.emailDraftButton")}
            </Button>
            {!supported && (
              <Button variant="primary" size="sm" onClick={() => void saveTemplate()} disabled={savingTemplate || !bodyDirty || templateTooLong}>
                <Save size={14} />
                {t("autoBewerb.templateSaveButton")}
              </Button>
            )}
          </div>
        }
      >
        <p className="mb-3 text-xs leading-5 text-muted">{t("autoBewerb.emailMessageIntro")}</p>

        {supported && (
          <div className="mb-3">
            <Input
              label={t("autoBewerb.globalSubjectLabel")}
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              hint={t("autoBewerb.subjectTokenHint")}
            />
          </div>
        )}

        <div className="grid gap-4 lg:grid-cols-2">
          <div>
            <span className="mb-1.5 block text-sm font-semibold text-ink-soft">{t("autoBewerb.templateLabel")}</span>
            <EmailRichEditor value={bodyDisplay} onChange={(html) => setTemplateDraft(html)} placeholder={t("autoBewerb.templateEmptyNote")} />
            <p className="mt-1.5 text-right text-xs text-faint">
              {bodyDisplay.length} / {AUTO_BEWERB_EMAIL_TEMPLATE_MAX}
            </p>
            {templateTooLong && (
              <div className="mt-2">
                <Note kind="error">{t("autoBewerb.templateTooLong")}</Note>
              </div>
            )}
            <p className="mt-2 text-xs leading-5 text-muted">{t("autoBewerb.templateHint")}</p>
          </div>

          {/* Live preview (sanitized + personalized HTML) */}
          <div>
            <span className="mb-1.5 flex items-center gap-1.5 text-sm font-semibold text-ink-soft">
              <Eye size={14} /> {t("autoBewerb.previewTitle")}
            </span>
            <div className="rounded-2xl border border-line bg-surface-2/30 p-4">
              <div className="space-y-1 border-b border-line pb-2 text-xs text-muted">
                <p>
                  <span className="font-semibold text-ink-soft">{t("autoBewerb.previewSubject")}:</span>{" "}
                  <span className="text-ink-soft">{previewSubject || "—"}</span>
                </p>
                <p>
                  <span className="font-semibold text-ink-soft">{t("autoBewerb.previewAccount")}:</span>{" "}
                  {account ? account.email : t("autoBewerb.missingAccount")}
                </p>
              </div>
              <div className="email-editor mt-3 text-sm text-ink-soft" dangerouslySetInnerHTML={{ __html: previewHtml || `<p>${t("autoBewerb.templateEmptyNote")}</p>` }} />
            </div>
            <p className="mt-2 text-xs text-muted">{t("autoBewerb.previewCount", { count: ws.companies.length })}</p>
          </div>
        </div>

        {draftResult && (
          <div className="mt-4 rounded-2xl border border-accent/30 bg-accent-soft/30 p-4">
            <p className="mb-1 text-xs font-bold text-ink">{t("autoBewerb.emailDraftTitle")}</p>
            <p className="text-xs font-semibold text-ink-soft">{t("autoBewerb.subjectLabel")}: {draftResult.subject}</p>
            <p className="mt-0.5 text-[11px] text-muted">{t("autoBewerb.emailDraftSubjectHint")}</p>
            <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded-xl bg-surface p-3 text-xs leading-5 text-ink-soft">{draftResult.body}</pre>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button variant="primary" size="sm" onClick={() => applyDraft(draftResult)}>
                {t("autoBewerb.applyDraftToTemplate")}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setDraftResult(null)}>
                {t("common.close")}
              </Button>
            </div>
          </div>
        )}
      </SectionCard>

      {/* No mailbox → explain, don't simulate */}
      {ws.emailAccounts.length === 0 && (
        <Note kind="error">
          {t("autoBewerb.emailAccountNoneBody")}{" "}
          <Link href="/settings/email" className="font-semibold text-accent underline underline-offset-2">
            {t("autoBewerb.emailAccountNoneCta")}
          </Link>
        </Note>
      )}

      {supported ? (
        <GlobalEmailSettings
          dirty={globalDirty}
          saving={saving}
          onSave={() => void saveSettings()}
          bodyEmpty={!bodyDisplay.trim()}
          recipient={recipient}
          onRecipientChange={setRecipient}
          accountId={accountId}
          onAccountIdChange={setAccountId}
          attachCv={attachCv}
          onAttachCvChange={setAttachCv}
          attachLetter={attachLetter}
          onAttachLetterChange={setAttachLetter}
        />
      ) : (
        <LegacyCompanyList />
      )}

      {/* The exact per-company documents (read-only, mirrors the send engine) */}
      <AttachmentManifest />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Supported mode — ONE global configuration (recipient / account / flags) +
// the single Save. The subject + body live in the editor card above.
// ---------------------------------------------------------------------------

function GlobalEmailSettings(props: {
  dirty: boolean;
  saving: boolean;
  onSave: () => void;
  bodyEmpty: boolean;
  recipient: string;
  onRecipientChange: (v: string) => void;
  accountId: string;
  onAccountIdChange: (v: string) => void;
  attachCv: boolean;
  onAttachCvChange: (v: boolean) => void;
  attachLetter: boolean;
  onAttachLetterChange: (v: boolean) => void;
}) {
  const { ws } = useAutoBewerb();
  const { t } = useI18n();
  const {
    dirty,
    saving,
    onSave,
    bodyEmpty,
    recipient,
    onRecipientChange,
    accountId,
    onAccountIdChange,
    attachCv,
    onAttachCvChange,
    attachLetter,
    onAttachLetterChange,
  } = props;

  const issues: string[] = [];
  if (bodyEmpty) issues.push(t("autoBewerb.templateEmptyNote"));
  if (!accountId) issues.push(t("autoBewerb.missingAccount"));
  if (recipient.trim() && !isValidEmail(recipient)) issues.push(t("autoBewerb.invalidRecipient"));
  const missingDest = ws.companies.filter(
    (c) => !resolveAutoBewerbRecipient(recipient, c.company.recipient_email, c.company.ad_extracted),
  );
  if (missingDest.length > 0) issues.push(t("autoBewerb.missingRecipient"));
  const missingCv = ws.companies.filter((c) => attachCv && !c.cv);
  if (missingCv.length > 0) issues.push(t("autoBewerb.missingCv"));
  const missingLetter = ws.companies.filter((c) => attachLetter && !c.letter);
  if (missingLetter.length > 0) issues.push(t("autoBewerb.missingLetter"));

  return (
    <SectionCard title={t("autoBewerb.emailSettingsTitle")} aside={dirty ? <span className="text-xs font-semibold text-warning">{t("autoBewerb.unsavedChanges")}</span> : undefined}>
      <div className="space-y-3">
        <Input
          label={t("autoBewerb.globalRecipientLabel")}
          type="email"
          value={recipient}
          onChange={(e) => onRecipientChange(e.target.value)}
          error={recipient && !isValidEmail(recipient) ? t("autoBewerb.invalidEmail") : undefined}
          hint={t("autoBewerb.globalRecipientHint")}
        />
        {/* The override is never silent: while a shared recipient is set, a
            prominent warning states that ALL companies route to one address. */}
        {recipient.trim() !== "" && (
          <div className="rounded-2xl border border-warning/40 bg-warning-soft/60 p-3 text-xs font-semibold leading-5 text-warning">
            {t("autoBewerb.globalRecipientOverrideWarning", { count: ws.companies.length })}
          </div>
        )}
        <div className="flex flex-wrap gap-4">
          <label className="flex items-center gap-2 text-sm font-medium text-ink-soft">
            <input type="checkbox" checked={attachCv} onChange={(e) => onAttachCvChange(e.target.checked)} className="h-4 w-4 accent-[var(--color-accent)]" />
            {t("autoBewerb.attachCvLabel")}
          </label>
          <label className="flex items-center gap-2 text-sm font-medium text-ink-soft">
            <input type="checkbox" checked={attachLetter} onChange={(e) => onAttachLetterChange(e.target.checked)} className="h-4 w-4 accent-[var(--color-accent)]" />
            {t("autoBewerb.attachLetterLabel")}
          </label>
        </div>
        {ws.emailAccounts.length > 0 && (
          <div>
            <span className="mb-1.5 block text-xs font-semibold text-ink-soft">{t("autoBewerb.emailAccountLabel")}</span>
            <select
              value={accountId}
              onChange={(e) => onAccountIdChange(e.target.value)}
              className="h-11 w-full max-w-sm rounded-xl border border-line-strong bg-surface px-3 text-sm font-medium text-ink outline-none focus:border-accent"
            >
              <option value="">{t("autoBewerb.selectAccount")}</option>
              {ws.emailAccounts.map((a) => (
                <option key={a.id} value={a.id} disabled={a.requires_reconnect}>
                  {a.email} ({a.provider})
                  {a.requires_reconnect ? ` — ${t("autoBewerb.accountReconnect")}` : ""}
                </option>
              ))}
            </select>
          </div>
        )}
        {issues.length > 0 && (
          <div className="rounded-2xl border border-warning/30 bg-warning-soft/50 p-3">
            <p className="mb-1 flex items-center gap-1.5 text-xs font-bold text-warning">
              <AlertTriangle size={13} /> {t("autoBewerb.checkListTitle")}
            </p>
            <ul className="list-inside list-disc space-y-0.5 text-xs text-ink-soft">
              {issues.map((it, i) => (
                <li key={i}>{it}</li>
              ))}
            </ul>
          </div>
        )}
        <div className="flex justify-end">
          <Button variant="primary" size="sm" onClick={onSave} disabled={saving || !dirty}>
            <Save size={14} />
            {t("autoBewerb.globalSaveButton")}
          </Button>
        </div>
      </div>
    </SectionCard>
  );
}

// ---------------------------------------------------------------------------
// Legacy mode (email-settings migration not applied) — the stored
// per-company values are displayed READ-ONLY (the send engine still honors
// them on such databases); editing them is intentionally impossible so the
// migration unlocks exactly ONE global configuration.
// ---------------------------------------------------------------------------

function LegacyCompanyList() {
  const { ws } = useAutoBewerb();
  const { t } = useI18n();
  return (
    <SectionCard title={t("autoBewerb.deliveryListTitle")}>
      <p className="mb-3 text-xs text-muted">{t("autoBewerb.emailSettingsMigrationPending")}</p>
      <ul className="divide-y divide-line">
        {ws.companies.map((c) => {
          const { name, job } = companyLabel(c.company);
          const r = c.company;
          const dest = resolveAutoBewerbRecipient("", r.recipient_email, r.ad_extracted);
          const issues: string[] = [];
          if (!dest) issues.push(t("autoBewerb.missingRecipient"));
          if (!r.email_subject) issues.push(t("autoBewerb.missingSubject"));
          if (!r.email_account_id) issues.push(t("autoBewerb.missingAccount"));
          return (
            <li key={c.company.id} className="py-2 text-sm">
              <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5">
                <span className="font-semibold text-ink">
                  {name} {job ? <span className="font-normal text-ink-soft">— {job}</span> : null}
                </span>
                <span className={dest ? "font-mono text-xs text-ink-soft" : "text-xs font-semibold text-warning"}>
                  {dest || t("autoBewerb.deliveryNoDest")}
                </span>
              </div>
              <p className="mt-0.5 text-xs text-muted">
                {t("autoBewerb.subjectLabel")}: {r.email_subject || "—"} ·{" "}
                {t("autoBewerb.emailAccountLabel")}: {r.email_account_id ? "✓" : "—"} ·{" "}
                {[r.email_attach_cv ? t("autoBewerb.attachCvPdf") : null, r.email_attach_letter ? t("autoBewerb.attachLetterPdf") : null]
                  .filter(Boolean)
                  .join(", ") || t("autoBewerb.noAttachments")}
              </p>
              {issues.length > 0 && <p className="mt-0.5 text-xs font-semibold text-warning">{issues.join(" · ")}</p>}
            </li>
          );
        })}
      </ul>
    </SectionCard>
  );
}
