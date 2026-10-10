"use server";

import { redirect } from "next/navigation";
import { createCampaign } from "@/lib/email-campaigns";
import { getCurrentUserAndProfile } from "@/lib/auth";
import {
  isSupportedTimezone,
  wallClockToUtc,
  type DstResolution,
} from "@/lib/schedule-time";

/** A schedule must be at least this far in the future — anything closer is
 *  treated as "now" and rejected: the user should pick Send now instead.
 *  Measured against the SERVER clock (the browser clock is never trusted). */
const MIN_FUTURE_MS = 60_000;

/**
 * Schedule a campaign: same validation pipeline as sendApplications, plus a
 * server-authoritative wall-clock → UTC conversion. The browser preview uses
 * the same pure function, but ONLY this server result is persisted.
 */
export async function scheduleApplications(formData: FormData) {
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

  // The wall-clock fields arrive as form strings; numbers that are not
  // exact (e.g. 2.5, 1e3, empty) are rejected before any conversion.
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
  // Server clock is authoritative for "future": the browser's idea of
  // now (and its preview) is never part of the decision.
  if (result.utcMs - Date.now() < MIN_FUTURE_MS)
    throw new Error(
      "The selected time is not in the future. Choose a later time, or send now.",
    );

  // The quota belongs to the scheduled UTC date; finalize/cancel release it
  // from the same date (existing engine behaviour).
  const result2 = await createCampaign({
    draftId,
    senderAccountId,
    goal,
    recipientEmails: recipients,
    scheduling: {
      utcIso: result.utcIso,
      timeZone,
      usageDate: result.utcIso.slice(0, 10),
    },
  });

  // Deliberately NO processCampaignBatch here: the instant is in the
  // future, so the durable scheduler (Vercel Cron → claim loop) picks the
  // campaign up at `scheduled_at`. The browser is not needed for sending.
  redirect(`/applications/campaign/${result2.campaignId}?scheduled=1`);
}
