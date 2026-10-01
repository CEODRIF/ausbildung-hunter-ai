"use server";

import { revalidatePath } from "next/cache";
import { getCurrentUserAndProfile } from "@/lib/auth";
import {
  CampaignDeleteBlockedError,
  deleteCampaign,
} from "@/lib/email-campaigns";

/**
 * Delete ONE application campaign (server-side, ownership-scoped).
 *
 * The campaign id comes from the client, but the operation is always filtered
 * by the authenticated user id, so a forged id can only ever fail. The engine
 * decides what is safe: an actively sending campaign is refused (its messages
 * are locked by the running batch runner).
 */
export async function deleteCampaignAction(campaignId: string) {
  const { user, profile } = await getCurrentUserAndProfile();
  if (!user || !profile || profile.account_status !== "active")
    return { ok: false as const, message: "Not authorized." };

  const id = typeof campaignId === "string" ? campaignId.trim() : "";
  if (!id) return { ok: false as const, message: "Missing campaign id." };

  try {
    await deleteCampaign(user.id, id);
    // The list is a server component: refresh it after the deletion.
    revalidatePath("/applications");
    return { ok: true as const, message: "Campaign deleted." };
  } catch (error) {
    if (error instanceof CampaignDeleteBlockedError)
      return { ok: false as const, message: error.message, blocked: true };
    return { ok: false as const, message: "Unable to delete campaign." };
  }
}
