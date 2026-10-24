"use client";

import { useMemo, useRef, useState, useTransition } from "react";
import { Plus } from "lucide-react";
import { Card, Input } from "@/components/ui";
import { RecipientManager } from "@/components/recipient-manager";
import { RecipientTable } from "@/components/recipient-table";
import { RichEmailEditor } from "@/components/rich-email-editor";
import {
  stageAttachment,
  discardStagedAttachment,
} from "@/app/applications/new/actions";
import { sendApplications } from "@/app/applications/new/send-action";
import { scheduleApplications } from "@/app/applications/new/schedule-action";
import { ScheduleForm } from "@/components/schedule-form";
import { createSendGate } from "@/lib/send-gate";
import type { ApplicationGoal } from "@/lib/application-drafts";
import type { SafeEmailAccount } from "@/lib/email-oauth";
import { useI18n } from "@/lib/i18n";
import { applicationTemplates } from "@/lib/application-templates";

type Recipient = {
  email: string;
  companyName?: string;
  contactName?: string;
  status: "valid" | "invalid" | "duplicate";
};

/** A staged attachment: the object already lives in the user's staging
 *  prefix; only the metadata travels with the composer state. No database
 *  row exists until the user sends (the campaign then owns it). */
type StagedAttachment = {
  clientKey: string;
  storage_path: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
};

/**
 * Draft-free application composer (Drafts feature removal).
 *
 * Everything the legacy composer offers — recipients, subject, the
 * personalization editor, templates (Ausbildung / Arbeit / Praktikum),
 * staged attachments, sender selection, review + "Send now / Schedule"
 * confirmation, duplicate-submit protection — but with NO persistence:
 * nothing is autosaved, no application_draft row is ever created, and the
 * review happens entirely in memory until the user confirms the send.
 * Only the SEND writes to the database (a campaign that owns its content).
 */
export function ApplicationSendComposer({
  accounts,
  initialGoal,
  initialSenderAccountId,
  initialSubject,
  initialBodyHtml,
  initialRecipient,
  prefillContext,
  prefillNotice,
  prefillError,
  praktikumSupported,
  uploadLimitMb,
}: {
  accounts: SafeEmailAccount[];
  initialGoal: ApplicationGoal;
  initialSenderAccountId: string;
  initialSubject: string;
  initialBodyHtml: string;
  /** Validated contact recipient from the opportunity prefill (server). */
  initialRecipient?: { email: string; companyName?: string | null } | null;
  /** Opportunity the composer was pre-filled from (display only). */
  prefillContext?: {
    title: string;
    company: string | null;
    href: string;
  } | null;
  prefillNotice?: string | null;
  prefillError?: string | null;
  /**
   * Server-probed: does the `application_goal` enum already carry
   * 'praktikum' (manual migration 20261109000000)? When false the third
   * option is HIDDEN instead of offered and broken — selecting an
   * unsupported type would otherwise fail the send. Safe default: hidden.
   */
  praktikumSupported?: boolean;
  /**
   * TRUE per-file upload cap in MB for this plan (server-computed,
   * min(plan cap, 10 MB platform ceiling)) — the hint must not promise a
   * size the server rejects; trial users get 2 MB (P0 quota audit,
   * upload-size copy). Safe default: 10 (the universal ceiling).
   */
  uploadLimitMb?: number;
}) {
  const { t } = useI18n();
  const [goal, setGoal] = useState<ApplicationGoal>(initialGoal);
  const praktikumOn = Boolean(praktikumSupported);
  const goalOptions: Array<{ value: ApplicationGoal; label: string }> = [
    { value: "ausbildung", label: "Ausbildung" },
    { value: "arbeit", label: "Arbeit" },
    ...(praktikumOn
      ? [{ value: "praktikum" as const, label: "Praktikum" }]
      : []),
  ];
  const [senderId, setSenderId] = useState(initialSenderAccountId);
  const [subject, setSubject] = useState(initialSubject);
  const [body, setBody] = useState(initialBodyHtml);
  const [recipients, setRecipients] = useState<Recipient[]>(
    initialRecipient
      ? [
          {
            email: initialRecipient.email,
            companyName: initialRecipient.companyName ?? undefined,
            status: "valid",
          },
        ]
      : [],
  );
  const [attachments, setAttachments] = useState<StagedAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  // Confirm dialog: "Send now" is the default; "Schedule" swaps in the
  // scheduling form (own action, own gate).
  const [sendMode, setSendMode] = useState<"now" | "schedule">("now");
  const [isSending, startSend] = useTransition();
  // Synchronous guard: two clicks in the same tick can never start two sends.
  const sendGate = useRef(createSendGate()).current;
  const sender = useMemo(
    () => accounts.find((account) => account.id === senderId) ?? accounts[0],
    [accounts, senderId],
  );

  function handleSendSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // One send per operation: a double click re-enters this handler, the gate
    // rejects the second call outright.
    if (!sendGate.begin()) return;
    const formData = new FormData(event.currentTarget);
    startSend(async () => {
      try {
        await sendApplications(formData);
      } finally {
        // Runs on success AND failure — the UI can never stay stuck.
        sendGate.end();
      }
    });
  }

  const applyTemplate = (templateGoal: ApplicationGoal) => {
    // Defensive: the Praktikum button is hidden while the enum lacks the
    // value, but never set an unsupported goal (the server would reject it).
    if (templateGoal === "praktikum" && !praktikumOn) return;
    setGoal(templateGoal);
    setSubject(applicationTemplates[templateGoal].subject);
    setBody(applicationTemplates[templateGoal].body);
  };

  const handleUpload = async (file: File) => {
    setUploading(true);
    try {
      const formData = new FormData();
      formData.set("file", file);
      const data = (await stageAttachment(formData)) as Omit<
        StagedAttachment,
        "clientKey"
      >;
      setAttachments((items) => [
        ...items,
        { ...data, clientKey: `staged-${Date.now()}-${Math.random()}` },
      ]);
    } catch {
      // The entry simply does not appear; the file is not staged.
    } finally {
      setUploading(false);
    }
  };

  const handleRemoveAttachment = async (attachment: StagedAttachment) => {
    try {
      const formData = new FormData();
      formData.set("storagePath", attachment.storage_path);
      await discardStagedAttachment(formData);
      setAttachments((items) =>
        items.filter((item) => item.clientKey !== attachment.clientKey),
      );
    } catch {
      // Keep the entry visible — the object is still staged, retrying works.
    }
  };

  const validRecipients = recipients.filter(
    (recipient) => recipient.status === "valid",
  );
  const recipientsJson = JSON.stringify(validRecipients);
  // The clientKey is UI-only — the server action receives the storage
  // metadata (which the campaign persists) and nothing else.
  const attachmentsJson = JSON.stringify(
    attachments.map((attachment) => ({
      storage_path: attachment.storage_path,
      filename: attachment.filename,
      mime_type: attachment.mime_type,
      size_bytes: attachment.size_bytes,
    })),
  );

  return (
    <div className="space-y-5">
      {prefillNotice && (
        <div className="rounded-2xl border border-success/25 bg-success-soft px-5 py-4 text-sm font-medium text-success">
          {prefillNotice}
        </div>
      )}
      {prefillError && (
        <div className="rounded-2xl border border-warning/25 bg-warning-soft px-5 py-4 text-sm font-medium text-danger">
          {prefillError}
        </div>
      )}
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="space-y-5">
          {prefillContext && (
            <Card className="flex flex-wrap items-center justify-between gap-3 border-accent/25 bg-surface-2 p-4">
              <div className="min-w-0">
                <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-accent">
                  Vorbefüllt aus Stellenangebot
                </p>
                <p className="mt-1 truncate text-sm font-bold text-ink-soft">
                  {prefillContext.title}
                  {prefillContext.company
                    ? ` · ${prefillContext.company}`
                    : ""}
                </p>
              </div>
              {prefillContext.href && (
                <a
                  href={prefillContext.href}
                  className="shrink-0 text-xs font-bold text-accent hover:underline"
                >
                  Stellenangebot ansehen →
                </a>
              )}
            </Card>
          )}
          <Card className="p-5 sm:p-7">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <p className="text-xs font-bold uppercase tracking-[0.12em] text-accent">
                  New application
                </p>
                <h1 className="display-title mt-2 text-3xl text-ink">
                  Prepare your Bewerbung
                </h1>
                <p className="mt-1.5 text-sm text-muted">
                  {t("apps.sendNote")}
                </p>
              </div>
            </div>
            <div className="mt-6">
              <RecipientManager
                recipients={recipients}
                onChange={setRecipients}
              />
              <RecipientTable recipients={recipients} onChange={setRecipients} />
            </div>
            <div className="mt-5">
              <Input
                label="Subject"
                value={subject}
                onChange={(event) => setSubject(event.target.value)}
                placeholder="Application subject"
              />
            </div>
            <div className="mt-5">
              <div className="mb-2 flex items-center justify-between gap-3">
                <label className="text-sm font-semibold text-ink-soft">
                  Message
                </label>
                <span className="truncate text-xs text-faint">
                  Clean HTML email · variables personalize per recipient
                </span>
              </div>
              <RichEmailEditor value={body} onChange={setBody} />
            </div>
          </Card>
          <Card className="p-5 sm:p-6">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="font-bold text-ink-soft">Attachments</h2>
                <p className="mt-1 text-xs text-muted">
                  PDF, DOC, DOCX, PNG, JPG · up to {uploadLimitMb ?? 10} MB
                  each
                </p>
              </div>
              <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-2xl border border-line bg-surface px-3.5 py-2.5 text-xs font-bold text-accent shadow-[var(--shadow-card)] transition-colors hover:border-accent">
                <Plus size={14} strokeWidth={2.2} />
                {uploading ? "Uploading…" : "Add files"}
                <input
                  className="hidden"
                  type="file"
                  accept=".pdf,.doc,.docx,.png,.jpg,.jpeg"
                  multiple
                  disabled={uploading}
                  onChange={async (event) => {
                    for (const file of Array.from(event.target.files ?? []))
                      await handleUpload(file);
                    event.target.value = "";
                  }}
                />
              </label>
            </div>
            {attachments.length ? (
              <div className="mt-4 space-y-2">
                {attachments.map((attachment) => (
                  <div
                    key={attachment.clientKey}
                    className="flex items-center justify-between rounded-2xl border border-line bg-surface px-3.5 py-3 shadow-[var(--shadow-card)]"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-xs font-semibold text-ink-soft">
                        {attachment.filename}
                      </p>
                      <p className="mt-0.5 text-[10px] text-faint">
                        {formatSize(attachment.size_bytes)} ·{" "}
                        {attachment.mime_type}
                      </p>
                    </div>
                    <button
                      type="button"
                      className="ml-3 text-xs font-semibold text-danger"
                      onClick={() => handleRemoveAttachment(attachment)}
                    >
                      Remove
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <p className="mt-5 rounded-2xl border border-dashed border-line-strong bg-surface px-4 py-5 text-center text-xs text-muted">
                No attachments added yet.
              </p>
            )}
          </Card>
        </div>
        <aside className="space-y-5">
          <Card className="p-5">
            <p className="text-xs font-bold uppercase tracking-[0.12em] text-faint">
              Sending from
            </p>
            <div className="mt-3 flex items-center gap-3">
              <span
                className={`flex h-11 w-11 items-center justify-center rounded-2xl text-sm font-bold shadow-[var(--shadow-card)] ${sender.provider === "gmail" ? "bg-danger-soft text-danger" : "bg-accent-soft text-accent-deep"}`}
              >
                {sender.provider === "gmail" ? "G" : "O"}
              </span>
              <div>
                <p className="text-sm font-bold text-ink-soft">
                  {sender.email}
                </p>
                <p className="mt-1 text-xs text-success">
                  {sender.provider === "gmail" ? "Gmail" : "Outlook"} connected
                </p>
              </div>
            </div>
            <select
              aria-label={t("apps.senderAccount")}
              value={senderId}
              onChange={(event) => setSenderId(event.target.value)}
              className="mt-4 h-11 w-full rounded-2xl border border-line bg-surface px-3.5 text-xs font-medium text-ink shadow-[var(--shadow-card)] outline-none focus:border-accent focus:ring-4 focus:ring-accent/10"
            >
              {accounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.email}
                </option>
              ))}
            </select>
          </Card>
          <Card className="p-5">
            <p className="text-xs font-bold uppercase tracking-[0.12em] text-faint">
              Application type
            </p>
            <div
              className={`mt-3 grid gap-2 ${goalOptions.length === 3 ? "grid-cols-3" : "grid-cols-2"}`}
            >
              {goalOptions.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => setGoal(option.value)}
                  className={`rounded-2xl border p-3 text-left text-xs font-bold transition-colors ${goal === option.value ? "border-accent bg-accent-soft text-accent shadow-[var(--shadow-card)]" : "border-line text-muted hover:border-line-strong hover:text-ink-soft"}`}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </Card>
          <Card className="p-5">
            <p className="text-xs font-bold uppercase tracking-[0.12em] text-faint">
              Send applications
            </p>
            <p className="mt-2 text-xs leading-5 text-muted">
              Review your recipient list before starting this campaign.
            </p>
            <button
              type="button"
              onClick={() => setConfirmOpen(true)}
              disabled={!validRecipients.length || isSending}
              className="btn-neon mt-4 h-12 w-full rounded-2xl text-sm font-bold text-white disabled:cursor-not-allowed disabled:opacity-60"
            >
              Send applications
            </button>
          </Card>
          <Card className="p-5">
            <p className="text-xs font-bold uppercase tracking-[0.12em] text-faint">
              Templates
            </p>
            <p className="mt-2 text-xs leading-5 text-muted">
              Insert a professional German starting point.
            </p>
            <div className="mt-3 space-y-2">
              <button
                type="button"
                onClick={() => applyTemplate("ausbildung")}
                className="w-full rounded-2xl border border-line bg-surface px-3.5 py-3 text-left text-xs font-bold text-ink-soft shadow-[var(--shadow-card)] transition-colors hover:border-accent hover:text-accent"
              >
                Ausbildung Bewerbung
              </button>
              <button
                type="button"
                onClick={() => applyTemplate("arbeit")}
                className="w-full rounded-2xl border border-line bg-surface px-3.5 py-3 text-left text-xs font-bold text-ink-soft shadow-[var(--shadow-card)] transition-colors hover:border-accent hover:text-accent"
              >
                Arbeit Bewerbung
              </button>
              {praktikumOn && (
                <button
                  type="button"
                  onClick={() => applyTemplate("praktikum")}
                  className="w-full rounded-2xl border border-line bg-surface px-3.5 py-3 text-left text-xs font-bold text-ink-soft shadow-[var(--shadow-card)] transition-colors hover:border-accent hover:text-accent"
                >
                  Praktikum Bewerbung
                </button>
              )}
            </div>
          </Card>
        </aside>
        {confirmOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-navy/50 p-5 pb-[calc(6rem_+_env(safe-area-inset-bottom))] backdrop-blur-sm lg:pb-5">
            <div className="max-h-[min(100%,calc(100vh_-_2.5rem))] w-full max-w-md overflow-y-auto overscroll-contain rounded-3xl border border-line bg-surface p-6 shadow-[var(--shadow-float)] supports-[height:100dvh]:max-h-[min(100%,calc(100dvh_-_2.5rem))]">
              <h2 className="display-title text-2xl text-ink">
                Confirm applications
              </h2>
              <p className="mt-3 text-sm leading-6 text-muted">
                You are about to send {validRecipients.length}{" "}
                applications from:
              </p>
              <p className="mt-2 rounded-xl bg-surface-2 px-3 py-2 text-sm font-bold text-ink-soft">
                {sender.email}
              </p>
              <p className="mt-3 truncate text-sm text-muted">
                {t("apps.schedule.subject")}:{" "}
                <span className="font-semibold text-ink-soft">
                  {subject || "—"}
                </span>
              </p>
              <p className="mt-2 text-sm text-muted">
                Only valid recipients will be queued. Sending will continue
                server-side after confirmation.
              </p>
              <div
                className="mt-4 grid grid-cols-2 gap-2"
                role="radiogroup"
                aria-label={t("apps.schedule.mode")}
              >
                {(
                  [
                    ["now", t("apps.schedule.now")],
                    ["schedule", t("apps.schedule.schedule")],
                  ] as const
                ).map(([mode, label]) => (
                  <button
                    key={mode}
                    type="button"
                    role="radio"
                    aria-checked={sendMode === mode}
                    onClick={() => setSendMode(mode)}
                    disabled={isSending}
                    className={`rounded-2xl border p-3 text-left text-xs font-bold transition-colors ${
                      sendMode === mode
                        ? "border-accent bg-accent-soft text-accent shadow-[var(--shadow-card)]"
                        : "border-line text-muted hover:border-line-strong hover:text-ink-soft"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
              {sendMode === "now" ? (
                <>
                  {isSending && (
                    <p
                      role="status"
                      aria-live="polite"
                      className="mt-4 flex items-center gap-2 text-xs font-semibold text-ink-soft"
                    >
                      <span
                        aria-hidden="true"
                        className="inline-block h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-line-strong border-t-accent"
                      />
                      Sending applications… Please keep this page open.
                    </p>
                  )}
                  <div className="mt-6 flex justify-end gap-3">
                    <button
                      type="button"
                      onClick={() => setConfirmOpen(false)}
                      disabled={isSending}
                      className="h-11 rounded-2xl border border-line bg-surface px-4 text-sm font-bold text-muted shadow-[var(--shadow-card)] transition-colors hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      Review again
                    </button>
                    <form
                      action={sendApplications}
                      onSubmit={handleSendSubmit}
                    >
                      <input
                        type="hidden"
                        name="senderAccountId"
                        value={senderId}
                      />
                      <input type="hidden" name="goal" value={goal} />
                      <input type="hidden" name="subject" value={subject} />
                      <input type="hidden" name="bodyHtml" value={body} />
                      <input
                        type="hidden"
                        name="recipients"
                        value={recipientsJson}
                      />
                      <input
                        type="hidden"
                        name="attachments"
                        value={attachmentsJson}
                      />
                      <button
                        type="submit"
                        disabled={isSending}
                        aria-busy={isSending}
                        className="btn-neon flex h-11 items-center gap-2 rounded-2xl px-5 text-sm font-bold text-white disabled:cursor-not-allowed disabled:opacity-70"
                      >
                        {isSending && (
                          <span
                            aria-hidden="true"
                            className="inline-block h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-white/40 border-t-white"
                          />
                        )}
                        {isSending ? "Sending…" : "Continue"}
                      </button>
                    </form>
                  </div>
                </>
              ) : (
                <div className="mt-5">
                  <ScheduleForm
                    action={scheduleApplications}
                    extraHidden={[
                      { name: "senderAccountId", value: senderId },
                      { name: "goal", value: goal },
                      { name: "subject", value: subject },
                      { name: "bodyHtml", value: body },
                      { name: "recipients", value: recipientsJson },
                      { name: "attachments", value: attachmentsJson },
                    ]}
                    submitLabel={t("apps.schedule.submitSchedule")}
                    pendingLabel={t("apps.schedule.scheduling")}
                    cancelLabel="Review again"
                    onCancel={() => setConfirmOpen(false)}
                  />
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function formatSize(bytes: number) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
