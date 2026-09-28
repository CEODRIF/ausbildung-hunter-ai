"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
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
import type {
  ApplicationDraft,
  ApplicationGoal,
  DraftAttachment,
} from "@/lib/application-drafts";
import type { SafeEmailAccount } from "@/lib/email-oauth";

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
  const [isPending, startTransition] = useTransition();
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
        <div className="rounded-2xl border border-[#bfe3d4] bg-[#eefaf3] px-5 py-4 text-sm font-medium text-[#177a55]">
          {prefillNotice}
        </div>
      )}
      {prefillError && (
        <div className="rounded-2xl border border-[#f3d3c3] bg-[#fdf3ee] px-5 py-4 text-sm font-medium text-[#b4543c]">
          {prefillError}
        </div>
      )}
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="space-y-5">
          {prefilledFrom && (
            <Card className="flex flex-wrap items-center justify-between gap-3 border-[#dce9ff] bg-[#f7faff] p-4">
              <div className="min-w-0">
                <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-[#2f6fed]">
                  Vorbefüllt aus Stellenangebot
                </p>
                <p className="mt-1 truncate text-sm font-bold text-[#1d3458]">
                  {prefilledFrom.opportunity_title}
                  {prefilledFrom.opportunity_company
                    ? ` · ${prefilledFrom.opportunity_company}`
                    : ""}
                </p>
              </div>
              {prefilledFrom.opportunity_key && (
                <a
                  href={`/opportunities/${encodeURIComponent(prefilledFrom.opportunity_key)}`}
                  className="shrink-0 text-xs font-bold text-[#2f6fed] hover:underline"
                >
                  Stellenangebot ansehen →
                </a>
              )}
            </Card>
          )}
          <Card className="p-5 sm:p-6">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <p className="text-xs font-bold uppercase tracking-[0.12em] text-[#2f6fed]">
                  New application
                </p>
                <h1 className="mt-2 text-2xl font-bold tracking-[-0.04em] text-[#10203b]">
                  Prepare your Bewerbung
                </h1>
                <p className="mt-1 text-sm text-[#8290a4]">
                  Draft only — sending will be added later.
                </p>
              </div>
              <span
                className={`text-xs font-semibold ${saveState === "error" ? "text-[#b3444e]" : saveState === "saving" || isPending ? "text-[#a56a1e]" : "text-[#1b9b70]"}`}
              >
                {saveState === "error"
                  ? "Save failed"
                  : saveState === "saving" || isPending
                    ? "Saving…"
                    : "Saved"}
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
                <label className="text-sm font-semibold text-[#1d3458]">
                  Message
                </label>
                <span className="text-xs text-[#9aa7b8]">Clean HTML email</span>
              </div>
              <RichEmailEditor value={body} onChange={setBody} />
            </div>
          </Card>
          <Card className="p-5 sm:p-6">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="font-bold text-[#1d3458]">Attachments</h2>
                <p className="mt-1 text-xs text-[#8290a4]">
                  PDF, DOC, DOCX, PNG, JPG · up to 10 MB each
                </p>
              </div>
              <label className="cursor-pointer rounded-lg border border-[#dbe3ef] px-3 py-2 text-xs font-bold text-[#2f6fed] hover:bg-[#f5f8ff]">
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
                    className="flex items-center justify-between rounded-xl border border-[#edf0f4] bg-[#fbfcfe] px-3 py-2.5"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-xs font-semibold text-[#1d3458]">
                        {attachment.filename}
                      </p>
                      <p className="mt-0.5 text-[10px] text-[#8b9ab0]">
                        {formatSize(attachment.size_bytes)} ·{" "}
                        {attachment.mime_type}
                      </p>
                    </div>
                    <button
                      type="button"
                      className="ml-3 text-xs font-semibold text-[#b3444e]"
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
              <p className="mt-5 rounded-xl bg-[#f7f9fc] px-4 py-4 text-center text-xs text-[#8290a4]">
                No attachments added yet.
              </p>
            )}
          </Card>
          {/* Phase 16 — item-level erasure for the draft's personal data */}
          <Card className="border-[#f0d9da] p-5 sm:p-6">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h2 className="font-bold text-[#c24c55]">
                  Delete personal data
                </h2>
                <p className="mt-1 text-xs text-[#8290a4]">
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
            <p className="text-xs font-bold uppercase tracking-[0.12em] text-[#8b9ab0]">
              Sending from
            </p>
            <div className="mt-3 flex items-center gap-3">
              <span
                className={`flex h-10 w-10 items-center justify-center rounded-xl text-sm font-bold ${sender.provider === "gmail" ? "bg-[#fff0ee] text-[#df5548]" : "bg-[#eaf2ff] text-[#2878d7]"}`}
              >
                {sender.provider === "gmail" ? "G" : "O"}
              </span>
              <div>
                <p className="text-sm font-bold text-[#1d3458]">
                  {sender.email}
                </p>
                <p className="mt-1 text-xs text-[#1b9b70]">
                  {sender.provider === "gmail" ? "Gmail" : "Outlook"} connected
                </p>
              </div>
            </div>
            <select
              aria-label="Sender account"
              value={senderId}
              onChange={(event) => setSenderId(event.target.value)}
              className="mt-4 h-10 w-full rounded-xl border border-[#dfe6f0] bg-white px-3 text-xs text-[#1d3458]"
            >
              {accounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.email}
                </option>
              ))}
            </select>
          </Card>
          <Card className="p-5">
            <p className="text-xs font-bold uppercase tracking-[0.12em] text-[#8b9ab0]">
              Application type
            </p>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setGoal("ausbildung")}
                className={`rounded-xl border p-3 text-left text-xs font-bold ${goal === "ausbildung" ? "border-[#2f6fed] bg-[#f3f7ff] text-[#2f6fed]" : "border-[#e3e9f1] text-[#71819a]"}`}
              >
                Ausbildung
              </button>
              <button
                type="button"
                onClick={() => setGoal("arbeit")}
                className={`rounded-xl border p-3 text-left text-xs font-bold ${goal === "arbeit" ? "border-[#2f6fed] bg-[#f3f7ff] text-[#2f6fed]" : "border-[#e3e9f1] text-[#71819a]"}`}
              >
                Arbeit
              </button>
            </div>
          </Card>
          <Card className="p-5">
            <p className="text-xs font-bold uppercase tracking-[0.12em] text-[#8b9ab0]">
              Send applications
            </p>
            <p className="mt-2 text-xs leading-5 text-[#8290a4]">
              Review your recipient list before starting this campaign.
            </p>
            <button
              type="button"
              onClick={() => setConfirmOpen(true)}
              disabled={
                !recipients.some((recipient) => recipient.status === "valid") ||
                isPending ||
                saveState !== "saved"
              }
              className="mt-4 h-11 w-full rounded-xl bg-[#2f6fed] text-sm font-semibold text-white hover:bg-[#255dcc] disabled:cursor-not-allowed disabled:opacity-50"
            >
              Send applications
            </button>
          </Card>
          <Card className="p-5">
            <p className="text-xs font-bold uppercase tracking-[0.12em] text-[#8b9ab0]">
              Templates
            </p>
            <p className="mt-2 text-xs leading-5 text-[#8290a4]">
              Insert a professional German starting point.
            </p>
            <div className="mt-3 space-y-2">
              <button
                type="button"
                onClick={() => applyTemplate("ausbildung")}
                className="w-full rounded-xl border border-[#e3e9f1] px-3 py-2.5 text-left text-xs font-semibold text-[#546783] hover:bg-[#f5f8ff]"
              >
                Ausbildung Bewerbung
              </button>
              <button
                type="button"
                onClick={() => applyTemplate("arbeit")}
                className="w-full rounded-xl border border-[#e3e9f1] px-3 py-2.5 text-left text-xs font-semibold text-[#546783] hover:bg-[#f5f8ff]"
              >
                Arbeit Bewerbung
              </button>
            </div>
          </Card>
        </aside>
        {confirmOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#10203b]/40 p-5">
            <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl">
              <h2 className="text-lg font-bold text-[#10203b]">
                Confirm applications
              </h2>
              <p className="mt-3 text-sm leading-6 text-[#71819a]">
                You are about to send{" "}
                {
                  recipients.filter((recipient) => recipient.status === "valid")
                    .length
                }{" "}
                applications from:
              </p>
              <p className="mt-2 rounded-xl bg-[#f4f7fc] px-3 py-2 text-sm font-bold text-[#1d3458]">
                {sender.email}
              </p>
              <p className="mt-4 text-sm text-[#71819a]">
                Only valid recipients will be queued. Sending will continue
                server-side after confirmation.
              </p>
              <div className="mt-6 flex justify-end gap-3">
                <button
                  type="button"
                  onClick={() => setConfirmOpen(false)}
                  className="h-10 rounded-xl border border-[#dbe3ef] px-4 text-sm font-semibold text-[#546783]"
                >
                  Review again
                </button>
                <form action={sendApplications}>
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
                    className="h-10 rounded-xl bg-[#2f6fed] px-4 text-sm font-semibold text-white"
                  >
                    Continue
                  </button>
                </form>
              </div>
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
