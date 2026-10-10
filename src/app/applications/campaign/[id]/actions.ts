"use server";

import { redirect } from "next/navigation";
import {
  cancelCampaign,
  getSenderSlotWaitMs,
  processCampaignBatch,
  rescheduleCampaign,
} from "@/lib/email-campaigns";
import { getCurrentUserAndProfile } from "@/lib/auth";
import {
  isSupportedTimezone,
  wallClockToUtc,
  type DstResolution,
} from "@/lib/schedule-time";

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

/**
 * Reschedule a not-yet-started campaign. Server-authoritative: the wall
 * clock from the form is re-converted here (same pure function + future
 * check as scheduleApplications), and the atomic `reschedule_campaign` RPC
 * refuses once any message has been claimed — a reschedule that races a
 * starting send simply fails with a clear message, never a partial move.
 */
export async function rescheduleCampaignAction(formData: FormData) {
  const campaignId = String(formData.get("campaignId") ?? "");
  const { user } = await getCurrentUserAndProfile();
  if (!user) redirect("/login");
  const year = Number(formData.get("scheduleYear"));
  const month = Number(formData.get("scheduleMonth"));
  const day = Number(formData.get("scheduleDay"));
  const hour = Number(formData.get("scheduleHour"));
  const minute = Number(formData.get("scheduleMinute"));
  const timeZone = String(formData.get("scheduleTimezone") ?? "");
  const rawResolution = String(formData.get("dstResolution") ?? "");
  const resolution: DstResolution | null =
    rawResolution === "start" || rawResolution === "end"
      ? rawResolution
      : null;
  if (!isSupportedTimezone(timeZone))
    throw new Error("Unknown timezone — please choose one from the list.");
  const result = wallClockToUtc(
    { year, month, day, hour, minute },
    timeZone,
    resolution,
  );
  if (!result.ok) {
    if (result.reason === "nonexistent")
      throw new Error(
        "That time does not exist in the selected timezone (daylight-saving gap). Please choose another time.",
      );
    if (result.reason === "ambiguous")
      throw new Error(
        "That time occurs twice in the selected timezone (daylight-saving fallback). Please pick which occurrence you want.",
      );
    throw new Error("Invalid schedule — please check the date and time.");
  }
  if (result.utcMs - Date.now() < 60_000)
    throw new Error(
      "The selected time is not in the future. Choose a later time.",
    );
  await rescheduleCampaign(user.id, campaignId, {
    utcIso: result.utcIso,
    timeZone,
    usageDate: result.utcIso.slice(0, 10),
  });
  redirect(`/applications/campaign/${campaignId}?rescheduled=1`);
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
