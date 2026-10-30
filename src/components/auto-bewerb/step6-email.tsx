"use client";

import { useState } from "react";
import Link from "next/link";
import { AlertTriangle, Mail, Save, Sparkles } from "lucide-react";
import { Button, Input, Textarea } from "@/components/ui";
import { EmptyState } from "@/components/ui/feedback";
import { useI18n } from "@/lib/i18n";
import {
  AUTO_BEWERB_EMAIL_TEMPLATE_MAX,
  AUTO_BEWERB_EMAIL_TOKENS,
  isValidEmail,
  renderAutoBewerbEmailBody,
  type AutoBewerbCompanyView,
} from "@/lib/auto-bewerb/schema";
import { saveEmailTemplateAction, updateCompanyAction } from "@/app/auto-bewerb/actions";
import { CompanyPicker, Note, SectionCard, companyLabel, useAutoBewerb } from "./shared";

const TOKEN_KEYS: Record<string, string> = {
  "{company}": "autoBewerb.tokenCompany",
  "{position}": "autoBewerb.tokenPosition",
  "{contactName}": "autoBewerb.tokenContact",
};

/**
 * Step 6 — shared email template (one row per user) + per-company email
 * preparation (recipient, subject, body override, account).
 * The shared body stays consistent UNLESS the user deliberately sets a
 * per-company override (stored null = "use template").
 * Supporting documents are GLOBAL: the whole user library (ws.attachments)
 * is attached to every application — there is no per-company selection.
 */
export function Step6Email() {
  const { ws, refresh, notify, companyId, selectCompany, goToStep } = useAutoBewerb();
  const { t } = useI18n();
  // Local template edits are buffered as a DRAFT against the server value
  // (null = follow the server) — step navigation never discards an unsaved edit.
  const [templateDraft, setTemplateDraft] = useState<string | null>(null);
  const [savingTemplate, setSavingTemplate] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const [draftResult, setDraftResult] = useState<{ subject: string; body: string } | null>(null);

  const templateText = templateDraft ?? ws.emailTemplate;
  const templateDirty = templateDraft !== null && templateDraft !== ws.emailTemplate;
  const templateTooLong = templateText.length > AUTO_BEWERB_EMAIL_TEMPLATE_MAX;

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

  if (ws.companies.length === 0) {
    return <EmptyState title={t("autoBewerb.emailEmpty")} body={t("autoBewerb.emailEmptyBody")} illustration={<Mail size={34} strokeWidth={1.6} />} ctaIcon={<Button variant="primary" onClick={() => goToStep(2)}>{t("autoBewerb.goToCompanies")}</Button>} />;
  }

  const active = ws.companies.find((c) => c.company.id === companyId) ?? ws.companies[0];
  const activeId = active.company.id;

  /** GLOBAL library — every application carries all of these documents. */
  const sharedDocNames = ws.attachments.map((a) => a.display_name);

  const generateDraft = async () => {
    setDrafting(true);
    setDraftResult(null);
    try {
      const res = await fetch("/api/auto-bewerb/generate-email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          companyId: activeId,
          attachmentNames: [...(active.company.email_attach_cv ? [t("autoBewerb.attachCvPdf")] : []), ...(active.company.email_attach_letter ? [t("autoBewerb.attachLetterPdf")] : []), ...sharedDocNames].slice(0, 10),
        }),
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

  const applyDraftToCompany = async () => {
    if (!draftResult) return;
    const res = await updateCompanyAction(activeId, {
      emailSubject: draftResult.subject,
      emailBody: draftResult.body,
    });
    if (res.ok) {
      setDraftResult(null);
      await refresh();
      notify("success", t("autoBewerb.saved"));
    } else notify("error", t("autoBewerb.saveError"));
  };

  return (
    <div className="space-y-5">
      {/* Shared template */}
      <SectionCard
        title={t("autoBewerb.templateTitle")}
        aside={
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" onClick={() => void generateDraft()} disabled={drafting}>
              <Sparkles size={14} />
              {drafting ? t("autoBewerb.generatingButton") : t("autoBewerb.emailDraftButton")}
            </Button>
            <Button variant="primary" size="sm" onClick={() => void saveTemplate()} disabled={savingTemplate || !templateDirty || templateTooLong}>
              <Save size={14} />
              {t("autoBewerb.templateSaveButton")}
            </Button>
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
        {templateTooLong && <div className="mt-2"><Note kind="error">{t("autoBewerb.templateTooLong")}</Note></div>}
        <div className="mt-3 flex flex-wrap gap-2">
          {AUTO_BEWERB_EMAIL_TOKENS.map((tok) => (
            <button
              key={tok}
              type="button"
              title={t(TOKEN_KEYS[tok] as "autoBewerb.tokenCompany")}
              onClick={() =>
                setTemplateDraft((s) => {
                  const base = s ?? ws.emailTemplate;
                  return `${base}${base.endsWith(" ") || base.length === 0 ? "" : " "}${tok}`;
                })
              }
              className="rounded-full border border-line-strong bg-surface-2 px-3 py-1 font-mono text-xs text-ink-soft transition-colors hover:border-accent hover:text-accent"
            >
              {tok}
            </button>
          ))}
        </div>
        <p className="mt-2 text-xs leading-5 text-muted">{t("autoBewerb.templateHint")}</p>

        {draftResult && (
          <div className="mt-4 rounded-2xl border border-accent/30 bg-accent-soft/30 p-4">
            <p className="mb-1 text-xs font-bold text-ink">{t("autoBewerb.emailDraftTitle")}</p>
            <p className="text-xs font-semibold text-ink-soft">{t("autoBewerb.subjectLabel")}: {draftResult.subject}</p>
            <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded-xl bg-surface p-3 text-xs leading-5 text-ink-soft">{draftResult.body}</pre>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button variant="secondary" size="sm" onClick={() => setTemplateDraft(draftResult.body)}>
                {t("autoBewerb.applyDraftToTemplate")}
              </Button>
              <Button variant="primary" size="sm" onClick={() => void applyDraftToCompany()}>
                {t("autoBewerb.applyDraftToCompany")}
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

      {/* Per-company editor */}
      <CompanyPicker value={companyId} onChange={selectCompany} />
      {/* Key includes the server row's updated_at: after save/refresh the editor
          re-initializes from the new row via remount (no state-sync effect). */}
      <CompanyEmailEditor key={`${activeId}:${active.company.updated_at}`} view={active} template={templateText} />
    </div>
  );
}

// ---------------------------------------------------------------------------

function CompanyEmailEditor({ view, template }: { view: AutoBewerbCompanyView; template: string }) {
  const { ws, refresh, notify } = useAutoBewerb();
  const { t } = useI18n();
  const row = view.company;
  const [recipient, setRecipient] = useState(row.recipient_email ?? "");
  const [subject, setSubject] = useState(row.email_subject ?? "");
  const [bodyOverride, setBodyOverride] = useState(row.email_body ?? "");
  const [attachCv, setAttachCv] = useState(row.email_attach_cv);
  const [attachLetter, setAttachLetter] = useState(row.email_attach_letter);
  const [accountId, setAccountId] = useState(row.email_account_id ?? "");
  const [saving, setSaving] = useState(false);

  const dirty =
    recipient !== (row.recipient_email ?? "") ||
    subject !== (row.email_subject ?? "") ||
    bodyOverride !== (row.email_body ?? "") ||
    attachCv !== row.email_attach_cv ||
    attachLetter !== row.email_attach_letter ||
    accountId !== (row.email_account_id ?? "");

  const save = async () => {
    setSaving(true);
    const res = await updateCompanyAction(row.id, {
      recipientEmail: recipient || null,
      emailSubject: subject || null,
      emailBody: bodyOverride || null,
      emailAttachCv: attachCv,
      emailAttachLetter: attachLetter,
      emailAccountId: accountId || null,
    });
    setSaving(false);
    if (res.ok) {
      await refresh();
      notify("success", t("autoBewerb.saved"));
    } else notify("error", t("autoBewerb.saveError"));
  };

  const issues: string[] = [];
  if (!recipient.trim()) issues.push(t("autoBewerb.missingRecipient"));
  else if (!isValidEmail(recipient)) issues.push(t("autoBewerb.invalidRecipient"));
  if (!subject.trim()) issues.push(t("autoBewerb.missingSubject"));
  if (attachCv && !view.cv) issues.push(t("autoBewerb.missingCv"));
  if (attachLetter && !view.letter) issues.push(t("autoBewerb.missingLetter"));
  if (!accountId) issues.push(t("autoBewerb.missingAccount"));

  const renderedBody = renderAutoBewerbEmailBody(bodyOverride || template, row.ad_extracted);
  const { name } = companyLabel(row);
  // Company-SPECIFIC documents (rendered per application) vs the GLOBAL
  // shared library — the two groups are shown distinctly.
  const specificAttachments = [
    attachCv ? t("autoBewerb.attachCvPdf") : null,
    attachLetter ? t("autoBewerb.attachLetterPdf") : null,
  ].filter(Boolean) as string[];
  const sharedAttachments = ws.attachments.map((a) => a.display_name);

  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <SectionCard title={t("autoBewerb.companyEmailTitle")} aside={dirty ? <span className="text-xs font-semibold text-warning">{t("autoBewerb.unsavedChanges")}</span> : undefined}>
        <div className="space-y-3">
          <Input
            label={t("autoBewerb.recipientLabel")}
            type="email"
            value={recipient}
            onChange={(e) => setRecipient(e.target.value)}
            error={recipient && !isValidEmail(recipient) ? t("autoBewerb.invalidEmail") : undefined}
            hint={row.ad_extracted?.applicationEmail ? `${t("autoBewerb.fromAd")}: ${row.ad_extracted.applicationEmail}` : undefined}
          />
          <Input label={t("autoBewerb.subjectLabel")} value={subject} onChange={(e) => setSubject(e.target.value)} />
          <Textarea
            label={t("autoBewerb.bodyOverrideLabel")}
            hint={t("autoBewerb.bodyOverrideHint")}
            rows={6}
            value={bodyOverride}
            onChange={(e) => setBodyOverride(e.target.value)}
          />
          {bodyOverride && (
            <button type="button" onClick={() => setBodyOverride("")} className="text-xs font-semibold text-accent underline underline-offset-2">
              {t("autoBewerb.bodyOverrideReset")}
            </button>
          )}
          <div className="flex flex-wrap gap-4">
            <label className="flex items-center gap-2 text-sm font-medium text-ink-soft">
              <input type="checkbox" checked={attachCv} onChange={(e) => setAttachCv(e.target.checked)} className="h-4 w-4 accent-[var(--color-accent)]" />
              {t("autoBewerb.attachCvLabel")}
            </label>
            <label className="flex items-center gap-2 text-sm font-medium text-ink-soft">
              <input type="checkbox" checked={attachLetter} onChange={(e) => setAttachLetter(e.target.checked)} className="h-4 w-4 accent-[var(--color-accent)]" />
              {t("autoBewerb.attachLetterLabel")}
            </label>
          </div>
          {ws.emailAccounts.length > 0 && (
            <div>
              <span className="mb-1.5 block text-xs font-semibold text-ink-soft">{t("autoBewerb.emailAccountLabel")}</span>
              <select
                value={accountId}
                onChange={(e) => setAccountId(e.target.value)}
                className="h-11 w-full max-w-sm rounded-xl border border-line-strong bg-surface px-3 text-sm font-medium text-ink outline-none focus:border-accent"
              >
                <option value="">{t("autoBewerb.selectAccount")}</option>
                {ws.emailAccounts.map((a) => (
                  <option key={a.id} value={a.id} disabled={a.requires_reconnect}>
                    {a.email} ({a.provider}){a.requires_reconnect ? ` — ${t("autoBewerb.accountReconnect")}` : ""}
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
            <Button variant="primary" size="sm" onClick={() => void save()} disabled={saving || !dirty}>
              <Save size={14} />
              {t("autoBewerb.saveButton")}
            </Button>
          </div>
        </div>
      </SectionCard>

      {/* Full preview (what the recipient will see) */}
      <SectionCard title={t("autoBewerb.emailPreviewTitle")}>
        <div className="rounded-2xl border border-line bg-surface-2/30 p-4">
          <div className="space-y-1 border-b border-line pb-3 text-xs text-muted">
            <p>
              <span className="font-semibold text-ink-soft">{t("autoBewerb.previewTo")}:</span> {recipient || t("autoBewerb.missingRecipient")}
            </p>
            <p>
              <span className="font-semibold text-ink-soft">{t("autoBewerb.previewSubject")}:</span> {subject || "—"}
            </p>
            <p>
              <span className="font-semibold text-ink-soft">{t("autoBewerb.previewAttachments")}:</span>{" "}
              {specificAttachments.length > 0 ? specificAttachments.join(", ") : t("autoBewerb.noAttachments")}
            </p>
            {sharedAttachments.length > 0 && (
              <p>
                <span className="font-semibold text-ink-soft">{t("autoBewerb.attachSharedDocs")}:</span>{" "}
                {sharedAttachments.join(", ")}
              </p>
            )}
          </div>
          <pre className="mt-3 whitespace-pre-wrap text-sm leading-6 text-ink-soft">{renderedBody || t("autoBewerb.templateEmptyNote")}</pre>
        </div>
        <p className="mt-2 text-xs text-muted">
          {bodyOverride ? t("autoBewerb.previewOverrideNote") : t("autoBewerb.previewSharedNote", { company: name })}
        </p>
      </SectionCard>
    </div>
  );
}
