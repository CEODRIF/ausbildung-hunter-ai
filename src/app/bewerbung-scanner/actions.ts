"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  assertScanOwnership,
  BULK_DELETE_MAX_SCANS,
  deleteScan,
} from "@/lib/bewerbung-scanner";
import { createClient } from "@/lib/supabase/server";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Phase 19 — bulk deletion of the user's own scans. Reuses the Phase 16
 * `deleteScan` logic (and therefore all of its erasure guarantees: FK
 * cascades, shared-upload retention, row-before-storage ordering) for every
 * selected scan.
 *
 * Safety model (all server-side; the browser only sends ids):
 * - `currentScanId` (the page the form lives on) and every `scanId` must be
 *   valid UUIDs BEFORE authentication or any database access.
 * - Empty selections and selections over `BULK_DELETE_MAX_SCANS` are
 *   rejected with zero destructive operations (the raw entry count is
 *   checked, so id spam cannot amortize the limit).
 * - Phase 1: every selected scan is ownership-verified
 *   (`assertScanOwnership`, user-scoped) BEFORE anything is deleted. A
 *   single foreign/missing id rejects the whole selection — a mixed
 *   owned + foreign selection can never be partially executed.
 * - Phase 2: each verified scan goes through the existing `deleteScan`
 *   (which re-verifies ownership internally — defense in depth). A database
 *   failure stops the loop; already-deleted scans stay deleted, the rest
 *   are left untouched, and a fixed generic error is shown (no DB/FK
 *   details). Storage failures remain best-effort per Phase 16.
 * - The current page's own scan is never part of a valid selection (the UI
 *   hides it; a tampered form including it is rejected with zero ops).
 */
export async function bulkDeleteScans(formData: FormData): Promise<void> {
  const currentScanId = String(formData.get("currentScanId") ?? "");
  const rawIds = formData.getAll("scanId").map(String);

  const fallback = () => redirect("/bewerbung-scanner");
  const fail = () =>
    redirect(`/bewerbung-scanner/${currentScanId}?error=bulk_failed`);

  // ---- Validation gates (no auth, no DB access before these) ----
  if (!UUID_RE.test(currentScanId)) return fallback();
  if (rawIds.length === 0) redirect(`/bewerbung-scanner/${currentScanId}`); // no-op
  if (rawIds.length > BULK_DELETE_MAX_SCANS) return fail();
  if (rawIds.some((id) => !UUID_RE.test(id))) return fail();
  if (rawIds.includes(currentScanId)) return fail();

  const uniqueIds = [...new Set(rawIds)];
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  // ---- Phase 1: verify ownership of the ENTIRE selection first ----
  try {
    for (const scanId of uniqueIds) await assertScanOwnership(user.id, scanId);
  } catch {
    return fail();
  }

  // ---- Phase 2: delete via the existing Phase 16 logic ----
  let deleted = 0;
  try {
    for (const scanId of uniqueIds) {
      await deleteScan(scanId);
      deleted += 1;
    }
  } catch {
    revalidatePath(`/bewerbung-scanner/${currentScanId}`);
    revalidatePath("/bewerbung-scanner");
    return fail();
  }
  revalidatePath(`/bewerbung-scanner/${currentScanId}`);
  revalidatePath("/bewerbung-scanner");
  redirect(`/bewerbung-scanner/${currentScanId}?bulk_deleted=${deleted}`);
}
