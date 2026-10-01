"use server";

import { redirect } from "next/navigation";
import { createCampaign, processCampaignBatch } from "@/lib/email-campaigns";
import { getCurrentUserAndProfile } from "@/lib/auth";

export async function sendApplications(formData: FormData) {
  const { user } = await getCurrentUserAndProfile();
  if (!user) redirect("/login");
  const draftId = String(formData.get("draftId") ?? "");
  const senderAccountId = String(formData.get("senderAccountId") ?? "");
  const goal = String(formData.get("goal") ?? "");
  const rawRecipients = String(formData.get("recipients") ?? "[]");
  let recipients: Array<{ email: string; companyName?: string | null }> = [];
  try {
    recipients = JSON.parse(rawRecipients) as Array<{
      email: string;
      companyName?: string | null;
    }>;
  } catch {
    throw new Error("Invalid recipient list.");
  }
  if (goal !== "ausbildung" && goal !== "arbeit")
    throw new Error("Invalid application goal.");
  const result = await createCampaign({
    draftId,
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
