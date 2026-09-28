"use server";

import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  assertDraftOwnership,
  assertSenderOwnership,
  createStoragePath,
  sanitizeEmailHtml,
  htmlToText,
  validateRecipientList,
  ALLOWED_ATTACHMENT_TYPES,
  MAX_ATTACHMENT_SIZE,
  type ApplicationGoal,
  type RecipientStatus,
} from "@/lib/application-drafts";
import { getCurrentUserAndProfile } from "@/lib/auth";

export async function saveDraft(input: {
  draftId: string;
  goal: ApplicationGoal;
  senderAccountId: string;
  subject: string;
  bodyHtml: string;
  recipients: Array<{
    email: string;
    companyName?: string | null;
    status: RecipientStatus;
  }>;
}) {
  const current = await getCurrentUserAndProfile();
  if (
    !current.user ||
    !current.profile ||
    current.profile.account_status !== "active"
  )
    throw new Error("Not authorized.");
  await assertDraftOwnership(current.user.id, input.draftId);
  await assertSenderOwnership(current.user.id, input.senderAccountId);
  const admin = createAdminClient();
  const bodyHtml = sanitizeEmailHtml(input.bodyHtml);
  const { error } = await admin
    .from("application_drafts")
    .update({
      goal: input.goal,
      sender_email_account_id: input.senderAccountId,
      subject: input.subject.slice(0, 500),
      body_html: bodyHtml,
      body_text: htmlToText(bodyHtml),
    })
    .eq("id", input.draftId)
    .eq("user_id", current.user.id);
  if (error) throw new Error("Unable to save draft.");
  await admin
    .from("application_draft_recipients")
    .delete()
    .eq("draft_id", input.draftId);
  const recipients = validateRecipientList(input.recipients).map(
    (recipient) => ({ draft_id: input.draftId, ...recipient }),
  );
  if (recipients.length) {
    const { error: recipientError } = await admin
      .from("application_draft_recipients")
      .insert(recipients);
    if (recipientError) throw new Error("Unable to save recipients.");
  }
  revalidatePath("/applications/new");
}

export async function uploadAttachment(formData: FormData) {
  const current = await getCurrentUserAndProfile();
  if (
    !current.user ||
    !current.profile ||
    current.profile.account_status !== "active"
  )
    throw new Error("Not authorized.");
  const draftId = String(formData.get("draftId") ?? "");
  const file = formData.get("file");
  if (!(file instanceof File)) throw new Error("No attachment selected.");
  if (file.size <= 0 || file.size > MAX_ATTACHMENT_SIZE)
    throw new Error("Attachments must be 10 MB or smaller.");
  if (!ALLOWED_ATTACHMENT_TYPES.has(file.type))
    throw new Error("This file type is not supported.");
  await assertDraftOwnership(current.user.id, draftId);
  const storagePath = createStoragePath(current.user.id, draftId, file.name);
  const admin = createAdminClient();
  const { error: uploadError } = await admin.storage
    .from("application-attachments")
    .upload(storagePath, file, { contentType: file.type, upsert: false });
  if (uploadError) throw new Error("Unable to upload attachment.");
  const { data, error } = await admin
    .from("application_draft_attachments")
    .insert({
      draft_id: draftId,
      storage_path: storagePath,
      filename: file.name.slice(0, 255),
      mime_type: file.type,
      size_bytes: file.size,
    })
    .select("id, filename, mime_type, size_bytes, storage_path")
    .single();
  if (error) {
    await admin.storage.from("application-attachments").remove([storagePath]);
    throw new Error("Unable to save attachment metadata.");
  }
  return data;
}

export async function removeAttachment(input: {
  draftId: string;
  attachmentId: string;
}) {
  const current = await getCurrentUserAndProfile();
  if (!current.user) throw new Error("Not authorized.");
  await assertDraftOwnership(current.user.id, input.draftId);
  const admin = createAdminClient();
  const { data } = await admin
    .from("application_draft_attachments")
    .select("storage_path")
    .eq("id", input.attachmentId)
    .eq("draft_id", input.draftId)
    .single<{ storage_path: string }>();
  if (!data) throw new Error("Attachment not found.");
  await admin.storage
    .from("application-attachments")
    .remove([data.storage_path]);
  const { error } = await admin
    .from("application_draft_attachments")
    .delete()
    .eq("id", input.attachmentId)
    .eq("draft_id", input.draftId);
  if (error) throw new Error("Unable to remove attachment.");
}
