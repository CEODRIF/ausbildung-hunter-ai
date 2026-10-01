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

export interface BulkDeleteResult {
  ok: boolean;
  /** Campaign ids that were deleted — the ONLY ids the UI may remove. */
  deleted: string[];
  /** Campaign ids the engine refused (sending / in-flight message). */
  blocked: string[];
  /** Campaign ids that failed for any other reason — stay visible. */
  failed: string[];
}

/**
 * Bulk-delete campaigns, ONE BY ONE through the existing deleteCampaign
 * engine path — there is deliberately no second delete implementation:
 * ownership (user_id scoping), the `sending` guard, the in-flight message
 * guard, capacity release and cascade behaviour all apply per campaign.
 *
 * A blocked or failed id never aborts the rest of the batch; the result
 * reports each bucket so the UI can only ever remove what was actually
 * deleted, and only ids owned by the authenticated user.
 */
export async function deleteCampaignsAction(
  campaignIds: string[],
): Promise<BulkDeleteResult> {
  const { user, profile } = await getCurrentUserAndProfile();
  if (!user || !profile || profile.account_status !== "active")
    return { ok: false, deleted: [], blocked: [], failed: [] };

  const ids = [
    ...new Set(
      (Array.isArray(campaignIds) ? campaignIds : [])
        .filter((id): id is string => typeof id === "string")
        .map((id) => id.trim())
        .filter(Boolean),
    ),
  ];
  if (ids.length === 0)
    return { ok: true, deleted: [], blocked: [], failed: [] };

  const deleted: string[] = [];
  const blocked: string[] = [];
  const failed: string[] = [];
  // Sequential on purpose: each delete is an independent, engine-checked
  // unit; nothing about one campaign can ever touch another.
  for (const id of ids) {
    try {
      await deleteCampaign(user.id, id);
      deleted.push(id);
    } catch (error) {
      if (error instanceof CampaignDeleteBlockedError) blocked.push(id);
      else failed.push(id);
    }
  }
  // The list is a server component: refresh it so the counters (Total /
  // Drafts / Sending / Sent / Failed) come back from the database.
  revalidatePath("/applications");
  return { ok: failed.length === 0, deleted, blocked, failed };
}
