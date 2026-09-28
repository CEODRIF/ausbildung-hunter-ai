"use server";

import { redirect } from "next/navigation";
import { cancelCampaign, processCampaignBatch } from "@/lib/email-campaigns";
import { getCurrentUserAndProfile } from "@/lib/auth";

export async function processCampaign(formData: FormData) {
  const campaignId = String(formData.get("campaignId") ?? "");
  const { user } = await getCurrentUserAndProfile();
  if (!user) redirect("/login");
  try {
    await processCampaignBatch(user.id, campaignId, 5);
  } catch {
    /* monitor can retry safely */
  }
  redirect(`/applications/campaign/${campaignId}`);
}
export async function cancelCampaignAction(formData: FormData) {
  const campaignId = String(formData.get("campaignId") ?? "");
  const { user } = await getCurrentUserAndProfile();
  if (!user) redirect("/login");
  try {
    await cancelCampaign(user.id, campaignId);
  } catch {
    /* page presents current state */
  }
  redirect(`/applications/campaign/${campaignId}`);
}
