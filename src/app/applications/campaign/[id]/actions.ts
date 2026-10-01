"use server";

import { redirect } from "next/navigation";
import {
  cancelCampaign,
  getSenderSlotWaitMs,
  processCampaignBatch,
} from "@/lib/email-campaigns";
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
/**
 * Bounded drain callable by the campaign monitor (client) on every tick.
 *
 * Same engine as the manual button and the internal worker — one batch of at
 * most 5 messages, idempotent through the claim/finalize RPCs, so parallel
 * calls can never send the same message twice. Returns the fresh counters so
 * the UI can render real numbers instead of invented progress.
 */
export async function drainCampaign(campaignId: string) {
  const { user } = await getCurrentUserAndProfile();
  if (!user)
    return { ok: false as const, processed: 0, status: null, slotWaitMs: 0 };
  try {
    const result = await processCampaignBatch(user.id, campaignId, 5);
    // Real Smart-Sending state for the UI: how long this campaign's sender
    // slot is busy RIGHT NOW (0 = free). Never faked — read from Postgres.
    const active = ![
      "completed",
      "partially_failed",
      "failed",
      "cancelled",
    ].includes(result.status);
    const slotWaitMs = active
      ? await getSenderSlotWaitMs(user.id, campaignId)
      : 0;
    return { ok: true as const, processed: result.processed, status: result.status, slotWaitMs };
  } catch {
    return { ok: false as const, processed: 0, status: null, slotWaitMs: 0 };
  }
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
