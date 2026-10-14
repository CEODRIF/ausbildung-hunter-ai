"use server";

import { redirect } from "next/navigation";
import { createCampaign, processCampaignBatch } from "@/lib/email-campaigns";
import { getCurrentUserAndProfile } from "@/lib/auth";
import { hasCampaignOwnedContent } from "@/lib/contact-name-support";
import type { CampaignAttachmentInput } from "@/lib/email-campaigns";

export async function sendApplications(formData: FormData) {
  const { user } = await getCurrentUserAndProfile();
  if (!user) redirect("/login");
  const senderAccountId = String(formData.get("senderAccountId") ?? "");
  const goal = String(formData.get("goal") ?? "");
  const rawRecipients = String(formData.get("recipients") ?? "[]");
  let recipients: Array<{
    email: string;
    companyName?: string | null;
    contactName?: string | null;
  }> = [];
  try {
    recipients = JSON.parse(rawRecipients) as Array<{
      email: string;
      companyName?: string | null;
      contactName?: string | null;
    }>;
  } catch {
    throw new Error("Invalid recipient list.");
  }
  if (goal !== "ausbildung" && goal !== "arbeit" && goal !== "praktikum")
    throw new Error("Invalid application goal.");
  // Drafts feature removal: post-migration the FULL application travels in
  // the form (subject, body, staged attachments) and the campaign owns it —
  // no application_draft row is created, read or updated anywhere on this
  // path. Pre-migration (code deployed before the manual migration) the
  // legacy draft-based payload is sent instead — same engine, same guards.
  const owned = await hasCampaignOwnedContent();
  const result = owned
    ? await createCampaign({
        senderAccountId,
        goal,
        subject: String(formData.get("subject") ?? ""),
        bodyHtml: String(formData.get("bodyHtml") ?? ""),
        recipients,
        attachments: (() => {
          const raw = String(formData.get("attachments") ?? "[]");
          try {
            return JSON.parse(raw) as CampaignAttachmentInput[];
          } catch {
            throw new Error("Invalid attachment list.");
          }
        })(),
      })
    : await createCampaign({
        draftId: String(formData.get("draftId") ?? ""),
        senderAccountId,
        goal,
        recipientEmails: recipients,
      });

  // Consume the queue right away: the campaign is created with queued
  // messages, and the bounded, idempotent batch runner is what actually
  // hands them to Gmail. Without this the messages would sit in `queued`
  // until someone triggered a worker — which is exactly why nothing was
  // being sent. A failure here is never fatal: the campaign exists and the
  // campaign page keeps draining it (bounded batches + stale recovery).
  try {
    await processCampaignBatch(user.id, result.campaignId, 5);
  } catch {
    // Intentional: never block the redirect on a send attempt.
  }

  redirect(`/applications/campaign/${result.campaignId}`);
}
