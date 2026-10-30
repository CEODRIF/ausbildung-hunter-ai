"use client";

import { useState } from "react";
import Link from "next/link";
import { AlertTriangle, Mail, Save, Sparkles } from "lucide-react";
import { Button, Input, Textarea } from "@/components/ui";
import { EmptyState } from "@/components/ui/feedback";
import { useI18n } from "@/lib/i18n";
import { AUTO_BEWERB_EMAIL_TEMPLATE_MAX, isValidEmail, resolveAutoBewerbRecipient } from "@/lib/auto-bewerb/schema";
import { saveEmailSettingsAction, saveEmailTemplateAction } from "@/app/auto-bewerb/actions";
import { Note, SectionCard, companyLabel, useAutoBewerb } from "./shared";

/**
 * Step 6 — ONE global e-mail configuration for the ENTIRE batch.
 *
 * Supported mode (email-settings migration applied): a single shared
 * configuration — recipient (optional), subject, body, sending account and
 * attachment flags — saved with ONE button. Every company receives the
 * EXACT SAME subject and body (sent verbatim, no substitution); the only
 * per-company value is the delivery destination, which stays that
 * company's verified application email (or the explicit global recipient
 * when the user deliberately sets one). Supporting documents are GLOBAL:
 * the whole user library is attached to every application.
 *
 * Legacy mode (migration not applied yet): the pre-existing per-company
 * values (if any) are displayed READ-ONLY and still honored by the send
 * engine; the shared body stays editable above. A pending-migration notice
 * explains how to unlock the single global configuration.
 */
export function Step6Email() {
  const { ws, refresh, notify, goToStep } = useAutoBewerb();
  const { t } = useI18n();
  const supported = ws.emailSettingsSupported;
  const s = ws.emailSettings;

  // Local edits are buffered against the server value (the body as a DRAFT,
  // null = follow the server) — step navigation never discards an unsaved
  // edit. ALL global settings live in the parent, so the AI draft can apply
  // to the configuration as a whole (body + shared subject).
  const [templateDraft, setTemplateDraft] = useState<string | null>(null);
  const [recipient, setRecipient] = useState(s?.recipient ?? "");
  const [subject, setSubject] = useState(s?.subject ?? "");
  const [accountId, setAccountId] = useState(s?.accountId ?? "");
  const [attachCv, setAttachCv] = useState(s?.attachCv ?? true);
  const [attachLetter, setAttachLetter] = useState(s?.attachLetter ?? true);
  const [savingTemplate, setSavingTemplate] = useState(false);
  const [saving, setSaving] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const [draftResult, setDraftResult] = useState<{ subject: string; body: string } | null>(null);

  const templateText = templateDraft ?? ws.emailTemplate;
  const templateDirty = templateDraft !== null && templateDraft !== ws.emailTemplate;
  const templateTooLong = templateText.length > AUTO_BEWERB_EMAIL_TEMPLATE_MAX;
  const settingsDirty =
    recipient !== (s?.recipient ?? "") ||
    subject !== (s?.subject ?? "") ||
    accountId !== (s?.accountId ?? "") ||
    attachCv !== (s?.attachCv ?? true) ||
    attachLetter !== (s?.attachLetter ?? true);

  const saveTemplate = async () => {
    setSavingTemplate(true);
    const res = await saveEmailTemplateAction(templateText);
    setSavingTemplate(false);
    if (res.ok) {
      setTemplateDraft(null);
      await refresh();
      notify("success", t("autoBewerb.saved"));
    } else notify("error", t("autoBewerb.saveError"));
  };

  /** One Save — the complete global configuration (body included). */
  const saveSettings = async () => {
    setSaving(true);
    const res = await saveEmailSettingsAction({
      body: templateText,
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

  /** GLOBAL library — every application carries all of these documents. */
  const sharedDocNames = ws.attachments.map((a) => a.display_name);

  const generateDraft = async () => {
    setDrafting(true);
    setDraftResult(null);
    try {
      // GLOBAL template draft — no company input (the e-mail must stay
      // company-neutral; only the shared document library is contextual).
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

  const applyDraft = (d: { subject: string; body: string }) => {
    setTemplateDraft(d.body);
    // Supported mode: the draft's subject fills the ONE shared subject.
    // Legacy mode: subjects stay per company — only the body is applied.
    if (supported) setSubject(d.subject);
  };

  return (
    <div className="space-y-5">
      {!supported && <Note kind="error">{t("autoBewerb.emailSettingsMigrationPending")}</Note>}

      {/* Shared e-mail body (one for ALL companies — sent verbatim) */}
      <SectionCard
        title={t("autoBewerb.templateTitle")}
        aside={
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" onClick={() => void generateDraft()} disabled={drafting}>
              <Sparkles size={14} />
              {drafting ? t("autoBewerb.generatingButton") : t("autoBewerb.emailDraftButton")}
            </Button>
            {/* LEGACY mode only: without the settings migration the body is
                saved separately (per-company settings stay in the row below). */}
            {!supported && (
              <Button variant="primary" size="sm" onClick={() => void saveTemplate()} disabled={savingTemplate || !templateDirty || templateTooLong}>
                <Save size={14} />
                {t("autoBewerb.templateSaveButton")}
              </Button>
            )}
          </div>
        }
      >
        <Textarea
          label={t("autoBewerb.templateLabel")}
          hint={`${templateText.length} / ${AUTO_BEWERB_EMAIL_TEMPLATE_MAX}`}
          rows={8}
          value={templateText}
          onChange={(e) => setTemplateDraft(e.target.value)}
        />
        {templateTooLong && (
          <div className="mt-2">
            <Note kind="error">{t("autoBewerb.templateTooLong")}</Note>
          </div>
        )}
        <p className="mt-2 text-xs leading-5 text-muted">{t("autoBewerb.templateHint")}</p>

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
          templateText={templateText}
          dirty={settingsDirty || templateDirty}
          saving={saving}
          onSave={() => void saveSettings()}
          recipient={recipient}
          onRecipientChange={setRecipient}
          subject={subject}
          onSubjectChange={setSubject}
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
    </div>
  );
}

// ---------------------------------------------------------------------------
// Supported mode — ONE global configuration + global preview + delivery list
// ---------------------------------------------------------------------------

function GlobalEmailSettings(props: {
  templateText: string;
  dirty: boolean;
  saving: boolean;
  onSave: () => void;
  recipient: string;
  onRecipientChange: (v: string) => void;
  subject: string;
  onSubjectChange: (v: string) => void;
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
    templateText,
    dirty,
    saving,
    onSave,
    recipient,
    onRecipientChange,
    subject,
    onSubjectChange,
    accountId,
    onAccountIdChange,
    attachCv,
    onAttachCvChange,
    attachLetter,
    onAttachLetterChange,
  } = props;

  const issues: string[] = [];
  if (!templateText.trim()) issues.push(t("autoBewerb.templateEmptyNote"));
  if (!subject.trim()) issues.push(t("autoBewerb.missingSubject"));
  if (!accountId) issues.push(t("autoBewerb.missingAccount"));
  if (recipient.trim() && !isValidEmail(recipient)) issues.push(t("autoBewerb.invalidRecipient"));
  const missingDest = ws.companies.filter(
    (c) => !resolveAutoBewerbRecipient(recipient, c.company.recipient_email, c.company.ad_extracted),
  );
  if (missingDest.length > 0) issues.push(t("autoBewerb.missingRecipient"));

  const account = ws.emailAccounts.find((a) => a.id === accountId);
  const specificAttachments = [attachCv ? t("autoBewerb.attachCvPdf") : null, attachLetter ? t("autoBewerb.attachLetterPdf") : null].filter(
    Boolean,
  ) as string[];
  const sharedAttachments = ws.attachments.map((a) => a.display_name);

  return (
    <div className="space-y-5">
      <div className="grid gap-5 lg:grid-cols-2">
        {/* ONE shared configuration — one Save for everything */}
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
            <Input label={t("autoBewerb.globalSubjectLabel")} value={subject} onChange={(e) => onSubjectChange(e.target.value)} />
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
              <Button variant="primary" size="sm" onClick={onSave} disabled={saving || !dirty || templateText.length > AUTO_BEWERB_EMAIL_TEMPLATE_MAX}>
                <Save size={14} />
                {t("autoBewerb.globalSaveButton")}
              </Button>
            </div>
          </div>
        </SectionCard>

        {/* Global preview — the EXACT e-mail every company receives */}
        <SectionCard title={t("autoBewerb.globalPreviewTitle")}>
          <div className="rounded-2xl border border-line bg-surface-2/30 p-4">
            <div className="space-y-1 border-b border-line pb-3 text-xs text-muted">
              <p>
                <span className="font-semibold text-ink-soft">{t("autoBewerb.previewTo")}:</span>{" "}
                {recipient.trim() || t("autoBewerb.deliveryListHint")}
              </p>
              <p>
                <span className="font-semibold text-ink-soft">{t("autoBewerb.previewSubject")}:</span> {subject || "—"}
              </p>
              <p>
                <span className="font-semibold text-ink-soft">{t("autoBewerb.previewAccount")}:</span> {account ? account.email : t("autoBewerb.missingAccount")}
              </p>
              <p>
                <span className="font-semibold text-ink-soft">{t("autoBewerb.previewAttachments")}:</span>{" "}
                {specificAttachments.length > 0 ? specificAttachments.join(", ") : t("autoBewerb.noAttachments")}
              </p>
              {sharedAttachments.length > 0 && (
                <p>
                  <span className="font-semibold text-ink-soft">{t("autoBewerb.attachSharedDocs")}:</span> {sharedAttachments.join(", ")}
                </p>
              )}
            </div>
            <pre className="mt-3 whitespace-pre-wrap text-sm leading-6 text-ink-soft">{templateText || t("autoBewerb.templateEmptyNote")}</pre>
          </div>
          <p className="mt-2 text-xs text-muted">{t("autoBewerb.previewCount", { count: ws.companies.length })}</p>
        </SectionCard>
      </div>

      {/* Read-only delivery list — each company keeps its verified address */}
      <SectionCard title={t("autoBewerb.deliveryListTitle")}>
        <p className="mb-3 text-xs text-muted">{t("autoBewerb.deliveryListHint")}</p>
        <ul className="divide-y divide-line">
          {ws.companies.map((c) => {
            const { name, job } = companyLabel(c.company);
            const dest = resolveAutoBewerbRecipient(recipient, c.company.recipient_email, c.company.ad_extracted);
            return (
              <li key={c.company.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 py-2 text-sm">
                <span className="font-semibold text-ink">
                  {name} {job ? <span className="font-normal text-ink-soft">— {job}</span> : null}
                </span>
                <span className={dest ? "font-mono text-xs text-ink-soft" : "text-xs font-semibold text-warning"}>
                  {dest || t("autoBewerb.deliveryNoDest")}
                </span>
              </li>
            );
          })}
        </ul>
      </SectionCard>
    </div>
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
