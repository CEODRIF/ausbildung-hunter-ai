"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";
import { Plus } from "lucide-react";
import { Card, Input } from "@/components/ui";
import { RecipientManager } from "@/components/recipient-manager";
import { RecipientTable } from "@/components/recipient-table";
import { RichEmailEditor } from "@/components/rich-email-editor";
import {
  discardDraft,
  saveDraft,
  uploadAttachment,
  removeAttachment,
} from "@/app/applications/new/actions";
import { DiscardDraftButton } from "@/components/discard-draft-button";
import { sendApplications } from "@/app/applications/new/send-action";
import { scheduleApplications } from "@/app/applications/new/schedule-action";
import { ScheduleForm } from "@/components/schedule-form";
import { createSendGate } from "@/lib/send-gate";
import type {
  ApplicationDraft,
  ApplicationGoal,
  DraftAttachment,
} from "@/lib/application-drafts";
import type { SafeEmailAccount } from "@/lib/email-oauth";
import { useI18n } from "@/lib/i18n";

const templates = {
  ausbildung: {
    subject: "Bewerbung um einen Ausbildungsplatz",
    body: "<p>Sehr geehrte Damen und Herren,</p><p>hiermit bewerbe ich mich mit großem Interesse um einen Ausbildungsplatz in Ihrem Unternehmen.</p><p>Über die Gelegenheit zu einem persönlichen Gespräch freue ich mich sehr.</p><p>Mit freundlichen Grüßen</p>",
  },
  arbeit: {
    subject: "Bewerbung um eine Position in Ihrem Unternehmen",
    body: "<p>Sehr geehrte Damen und Herren,</p><p>mit großem Interesse bewerbe ich mich um eine Position in Ihrem Unternehmen.</p><p>Über die Gelegenheit zu einem persönlichen Gespräch freue ich mich sehr.</p><p>Mit freundlichen Grüßen</p>",
  },
};

type Recipient = {
  email: string;
  companyName?: string;
  status: "valid" | "invalid" | "duplicate";
};
export function ApplicationComposer({
  draft: initialDraft,
  accounts,
  prefillNotice,
  prefillError,
}: {
  draft: ApplicationDraft;
  accounts: SafeEmailAccount[];
  /** One-time notice for the most recent prefill action (in-memory only). */
   prefillNotice?: string | null;
   prefillError?: string | null;
 }) {
  const { t } = useI18n();
  const [draft] = useState(initialDraft);
  const [goal, setGoal] = useState<ApplicationGoal>(initialDraft.goal);
  const [senderId, setSenderId] = useState(
    initialDraft.sender_email_account_id,
  );
  const [subject, setSubject] = useState(initialDraft.subject);
  const [body, setBody] = useState(initialDraft.body_html);
  const [recipients, setRecipients] = useState<Recipient[]>(
    initialDraft.recipients.map((item) => ({
      email: item.email,
      companyName: item.company_name ?? undefined,
      status: item.validation_status,
    })),
  );
  const [attachments, setAttachments] = useState<DraftAttachment[]>(
    initialDraft.attachments,
  );
  const [saveState, setSaveState] = useState<"saved" | "saving" | "error">(
    "saved",
  );
  const [uploading, setUploading] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  // Confirm dialog: "Send now" is the default and keeps the EXACT existing
  // flow; "Schedule" swaps in the scheduling form (own action, own gate).
  const [sendMode, setSendMode] = useState<"now" | "schedule">("now");
  const [isPending, startTransition] = useTransition();
  // Dedicated to the send flow — the save/upload transition is untouched.
  const [isSending, startSend] = useTransition();
  // Synchronous guard: two clicks in the same tick can never start two sends.
  const sendGate = useRef(createSendGate()).current;
  const sender = useMemo(
    () => accounts.find((account) => account.id === senderId) ?? accounts[0],
    [accounts, senderId],
  );
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setSaveState("saving");
      startTransition(async () => {
        try {
          await saveDraft({
            draftId: draft.id,
            goal,
            senderAccountId: senderId,
            subject,
            bodyHtml: body,
            recipients,
          });
          setSaveState("saved");
        } catch {
          setSaveState("error");
        }
      });
    }, 900);
    return () => window.clearTimeout(timer);
  }, [body, draft.id, goal, recipients, senderId, subject]);
  /**
   * Continue (Confirm applications) → send.
   *
   * The loading state is bound to the REAL server action promise: the
   * transition sets `isSending` before the request leaves the browser, and
   * clears it when the action settles (success, redirect or failure). The
   * action is deliberately NOT wrapped in catch — it redirects on success and
   * its errors must keep reaching the existing error handling unchanged.
   */
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
    setGoal(templateGoal);
    setSubject(templates[templateGoal].subject);
    setBody(templates[templateGoal].body);
  };
  const handleUpload = async (file: File) => {
    setUploading(true);
    try {
      const formData = new FormData();
      formData.set("draftId", draft.id);
      formData.set("file", file);
      const data = (await uploadAttachment(formData)) as DraftAttachment;
      setAttachments((items) => [...items, data]);
      setSaveState("saved");
    } catch {
      setSaveState("error");
    } finally {
      setUploading(false);
    }
  };
  const prefilledFrom =
    initialDraft.opportunity_title !== null &&
    initialDraft.opportunity_title !== undefined
      ? initialDraft
      : null;

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
          {prefilledFrom && (
            <Card className="flex flex-wrap items-center justify-between gap-3 border-accent/25 bg-surface-2 p-4">
              <div className="min-w-0">
                <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-accent">
                  Vorbefüllt aus Stellenangebot
                </p>
                <p className="mt-1 truncate text-sm font-bold text-ink-soft">
                  {prefilledFrom.opportunity_title}
                  {prefilledFrom.opportunity_company
                    ? ` · ${prefilledFrom.opportunity_company}`
                    : ""}
                </p>
              </div>
              {prefilledFrom.opportunity_key && (
                <a
                  href={`/opportunities/${encodeURIComponent(prefilledFrom.opportunity_key)}`}
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
                    {t("apps.draftNote")}
                  </p>
                </div>
              <span
                className={`text-xs font-semibold ${saveState === "error" ? "text-danger" : saveState === "saving" || isPending ? "text-warning" : "text-success"}`}
              >
                {saveState === "error"
                  ? t("apps.saveFailed")
                  : saveState === "saving" || isPending
                    ? t("apps.saving")
                    : t("apps.saved")}
              </span>
            </div>
            <div className="mt-6">
              <RecipientManager
                recipients={recipients}
                onChange={setRecipients}
              />
              <RecipientTable
                recipients={recipients}
                onChange={setRecipients}
              />
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
              <div className="mb-2 flex items-center justify-between">
                <label className="text-sm font-semibold text-ink-soft">
                  Message
                </label>
                <span className="text-xs text-faint">Clean HTML email</span>
              </div>
              <RichEmailEditor value={body} onChange={setBody} />
            </div>
          </Card>
          <Card className="p-5 sm:p-6">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="font-bold text-ink-soft">Attachments</h2>
                <p className="mt-1 text-xs text-muted">
                  PDF, DOC, DOCX, PNG, JPG · up to 10 MB each
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
                    key={attachment.id}
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
                      onClick={() =>
                        startTransition(async () => {
                          await removeAttachment({
                            draftId: draft.id,
                            attachmentId: attachment.id,
                          });
                          setAttachments((items) =>
                            items.filter((item) => item.id !== attachment.id),
                          );
                        })
                      }
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
          {/* Phase 16 — item-level erasure for the draft's personal data */}
          <Card className="border-danger/25 p-5 sm:p-6">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h2 className="font-bold text-danger">
                  Delete personal data
                </h2>
                <p className="mt-1 text-xs text-muted">
                  Discard this draft, including recipients and uploaded
                  attachments. This cannot be undone.
                </p>
              </div>
              <form action={discardDraft} id="discard-draft-form">
                <input type="hidden" name="draftId" value={draft.id} />
                <DiscardDraftButton />
              </form>
            </div>
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
            <div className="mt-3 grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setGoal("ausbildung")}
                className={`rounded-2xl border p-3 text-left text-xs font-bold transition-colors ${goal === "ausbildung" ? "border-accent bg-accent-soft text-accent shadow-[var(--shadow-card)]" : "border-line text-muted hover:border-line-strong hover:text-ink-soft"}`}
              >
                Ausbildung
              </button>
              <button
                type="button"
                onClick={() => setGoal("arbeit")}
                className={`rounded-2xl border p-3 text-left text-xs font-bold transition-colors ${goal === "arbeit" ? "border-accent bg-accent-soft text-accent shadow-[var(--shadow-card)]" : "border-line text-muted hover:border-line-strong hover:text-ink-soft"}`}
              >
                Arbeit
              </button>
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
              disabled={
                !recipients.some((recipient) => recipient.status === "valid") ||
                isPending ||
                isSending ||
                saveState !== "saved"
              }
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
            </div>
          </Card>
        </aside>
        {confirmOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-navy/50 p-5 backdrop-blur-sm">
            <div className="w-full max-w-md rounded-3xl border border-line bg-surface p-6 shadow-[var(--shadow-float)]">
              <h2 className="display-title text-2xl text-ink">
                Confirm applications
              </h2>
              <p className="mt-3 text-sm leading-6 text-muted">
                You are about to send{" "}
                {
                  recipients.filter((recipient) => recipient.status === "valid")
                    .length
                }{" "}
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
              {/* Send mode: "now" is the default and keeps the existing flow
                  byte-for-byte; "schedule" swaps in the scheduling form. */}
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
                      <input type="hidden" name="draftId" value={draft.id} />
                      <input
                        type="hidden"
                        name="senderAccountId"
                        value={senderId}
                      />
                      <input type="hidden" name="goal" value={goal} />
                      <input
                        type="hidden"
                        name="recipients"
                        value={JSON.stringify(
                          recipients.filter(
                            (recipient) => recipient.status === "valid",
                          ),
                        )}
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
                      { name: "draftId", value: draft.id },
                      { name: "senderAccountId", value: senderId },
                      { name: "goal", value: goal },
                      {
                        name: "recipients",
                        value: JSON.stringify(
                          recipients.filter(
                            (recipient) => recipient.status === "valid",
                          ),
                        ),
                      },
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
