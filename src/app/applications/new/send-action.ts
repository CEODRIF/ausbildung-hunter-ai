"use server";

import { redirect } from "next/navigation";
import { createCampaign } from "@/lib/email-campaigns";
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
  redirect(`/applications/campaign/${result.campaignId}`);
}
