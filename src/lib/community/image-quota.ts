import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Community Phase 6A — per-user community image storage quota.
 *
 * Total volume of `community-images` storage owned by a user (room message
 * images, question images and DM images — counted from the storage catalog
 * via the service-role-only `community_image_storage_usage` RPC, which
 * attributes every path shape to its owner).
 *
 * Enforcement contract (used by ALL three community image endpoints):
 * - checked SERVER-side, BEFORE any storage upload — a rejected upload must
 *   never create a storage object;
 * - 100 MB per user total (the Phase 6A discovery value), in ADDITION to
 *   the existing 2 MB per-image limit (unchanged);
 * - FAILS CLOSED: if the usage query itself fails, the upload is rejected
 *   (500 `quota_check_failed`). A database that cannot report usage cannot
 *   verify the quota, and the insert that follows an upload would fail as
 *   well — uploading first would only create orphaned objects.
 */

/** 100 MB per user (Phase 6A discovery value). */
export const COMMUNITY_USER_IMAGE_QUOTA_BYTES = 100 * 1024 * 1024;

export type CommunityImageQuotaResult =
  | { ok: true; usedBytes: number }
  | { ok: false; code: "storage_quota"; usedBytes: number; limitBytes: number }
  | { ok: false; code: "quota_check_failed"; limitBytes: number };

export async function checkCommunityImageQuota(
  userId: string,
  additionalBytes: number,
): Promise<CommunityImageQuotaResult> {
  const limitBytes = COMMUNITY_USER_IMAGE_QUOTA_BYTES;
  let usedBytes: number;
  try {
    const admin = createAdminClient();
    const { data, error } = await admin.rpc(
      "community_image_storage_usage",
      { p_user: userId },
    );
    if (error) throw new Error(error.message);
    // A missing/legacy RPC returns null → treat as 0 bytes used (the
    // per-image limit and rate limits still apply).
    usedBytes =
      typeof data === "number" && Number.isFinite(data) && data >= 0
        ? Math.trunc(data)
        : 0;
  } catch (err) {
    console.error(
      "[community] image quota check failed:",
      err instanceof Error ? err.message : String(err),
    );
    return { ok: false, code: "quota_check_failed", limitBytes };
  }
  if (usedBytes + additionalBytes > limitBytes) {
    return { ok: false, code: "storage_quota", usedBytes, limitBytes };
  }
  return { ok: true, usedBytes };
}
