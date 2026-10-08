import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentUserAndProfile } from "@/lib/auth";
import {
  candidateProfileSchema,
  type CandidateProfile,
} from "@/lib/bewerbung-schema";

/**
 * Light half of the Bewerbung Scanner: scan CRUD + ownership + profile
 * read/update.
 *
 * This module must NOT link `@/lib/ai-file-context` or `@/lib/pdf-extract`:
 * every route that imports from it (list/detail/delete/update) would
 * otherwise force Vercel's file tracer to ship the ~60 MB PDF parsing stack
 * into its function. The document → AI-profile run lives in
 * `bewerbung-scan.ts`, which is imported only by the scan route.
 */

/** Stable, user-safe code for unexpected scan failures (UI localizes it). */
export const SCAN_UNEXPECTED_FAILED = "SCAN_UNEXPECTED_FAILED";
/** Stable code: document was substantial but the AI returned a nearly empty
 *  profile even after the controlled retry pass (UI localizes it). */
export const SCAN_PROFILE_INCOMPLETE = "SCAN_PROFILE_INCOMPLETE";

export type ScanGoal = "ausbildung" | "arbeit";
export type ScanFile = {
  id: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  storage_path: string;
};

export async function activeUser() {
  const current = await getCurrentUserAndProfile();
  if (
    !current.user ||
    !current.profile ||
    current.profile.account_status !== "active"
  )
    throw new Error("Not authorized.");
  return current.user;
}
/**
 * The subset of an upload a scan actually needs. `storage_path` and
 * `size_bytes` are deliberately NOT part of the input: the request is
 * untrusted, and runScan() re-reads the uploads from `ai_file_uploads`
 * scoped to the session user (`.eq("user_id", user.id)`), so a foreign or
 * invented file id can never be scanned.
 */
export type ScanFileInput = Pick<ScanFile, "id" | "filename" | "mime_type">;

export async function createScan(goal: ScanGoal, files: ScanFileInput[]) {
  const user = await activeUser();
  if (!files.length || files.length > 10)
    throw new Error("Upload between 1 and 10 supported files.");
  const admin = createAdminClient();
  const { data: scan, error } = await admin
    .from("bewerbung_scans")
    .insert({ user_id: user.id, goal, status: "uploading" })
    .select("id")
    .single<{ id: string }>();
  if (error || !scan) throw new Error("Unable to create scan.");
  const { error: fileError } = await admin.from("bewerbung_scan_files").insert(
    files.map((file) => ({
      scan_id: scan.id,
      user_id: user.id,
      storage_file_id: file.id,
      filename: file.filename,
      mime_type: file.mime_type,
    })),
  );
  if (fileError) {
    await admin.from("bewerbung_scans").delete().eq("id", scan.id);
    throw new Error("Unable to save scan files.");
  }
  return scan.id;
}

/** Phase 19 — server-side cap for bulk scan deletion (bounded work per
 *  request: every scan runs the full Phase 16 verification + erasure).
 *  Lives here (not in the "use server" action file) because non-function
 *  exports are not allowed in server-action modules. */
export const BULK_DELETE_MAX_SCANS = 25;

/** Phase 19 — user-scoped ownership check for a scan (used to validate a
 *  whole bulk selection BEFORE any destructive operation). Throws the same
 *  fixed message for missing and foreign scans (no ownership oracle). */
export async function assertScanOwnership(userId: string, scanId: string) {
  const admin = createAdminClient();
  const { data: scan, error } = await admin
    .from("bewerbung_scans")
    .select("id")
    .eq("id", scanId)
    .eq("user_id", userId)
    .single();
  if (error || !scan) throw new Error("Scan not found.");
  return scan;
}

export async function getScan(scanId: string) {
  const user = await activeUser();
  const admin = createAdminClient();
  const { data: scan, error } = await admin
    .from("bewerbung_scans")
    .select("id, goal, status, created_at, completed_at, error_message")
    .eq("id", scanId)
    .eq("user_id", user.id)
    .single();
  if (error || !scan) throw new Error("Scan not found.");
  const { data: profile } = await admin
    .from("candidate_profiles")
    .select("id, profile_json, created_at, updated_at")
    .eq("scan_id", scanId)
    .eq("user_id", user.id)
    .maybeSingle();
  const { data: history } = await admin
    .from("bewerbung_scans")
    .select("id, goal, status, created_at, completed_at")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(20);
  return {
    scan,
    profile: profile
      ? {
          ...profile,
          profile_json: candidateProfileSchema.parse(profile.profile_json),
        }
      : null,
    history: history ?? [],
  };
}

export async function updateCandidateProfile(
  scanId: string,
  profile: CandidateProfile,
) {
  const user = await activeUser();
  const validated = candidateProfileSchema.parse(profile);
  const admin = createAdminClient();
  const { error } = await admin
    .from("candidate_profiles")
    .update({ profile_json: validated })
    .eq("scan_id", scanId)
    .eq("user_id", user.id);
  if (error) throw new Error("Unable to update candidate profile.");
  return validated;
}

/**
 * Phase 16 — delete a scan (item-level erasure of the most sensitive
 * data: uploaded CVs + extracted candidate profile).
 *
 * Sequence: verify ownership → collect this scan's uploads → delete the
 * scan row (Postgres cascades `candidate_profiles` +
 * `bewerbung_scan_files`) → for each referenced upload that NO longer
 * has any scan reference, delete its row + storage object. Uploads still
 * referenced by another scan are kept (shared uploads are legal — the
 * same file can back two scans).
 *
 * Returns how many uploaded files were removed with the scan.
 */
export async function deleteScan(scanId: string): Promise<{
  filesRemoved: number;
}> {
  const user = await activeUser();
  const admin = createAdminClient();
  const { data: scan, error } = await admin
    .from("bewerbung_scans")
    .select("id")
    .eq("id", scanId)
    .eq("user_id", user.id)
    .single();
  if (error || !scan) throw new Error("Scan not found.");
  const { data: scanFiles } = await admin
    .from("bewerbung_scan_files")
    .select("storage_file_id")
    .eq("scan_id", scanId)
    .eq("user_id", user.id);
  const uploadIds = [
    ...new Set((scanFiles ?? []).map((f) => f.storage_file_id)),
  ];
  const { error: deleteError } = await admin
    .from("bewerbung_scans")
    .delete()
    .eq("id", scanId)
    .eq("user_id", user.id);
  if (deleteError) throw new Error("Unable to delete scan.");
  let filesRemoved = 0;
  for (const uploadId of uploadIds) {
    const { count: stillReferenced } = await admin
      .from("bewerbung_scan_files")
      .select("id", { count: "exact", head: true })
      .eq("storage_file_id", uploadId)
      .eq("user_id", user.id);
    if ((stillReferenced ?? 0) > 0) continue;
    const { data: upload, error: uploadError } = await admin
      .from("ai_file_uploads")
      .select("storage_path")
      .eq("id", uploadId)
      .eq("user_id", user.id)
      .single<{ storage_path: string }>();
    if (uploadError || !upload) continue;
    const { error: uploadDeleteError } = await admin
      .from("ai_file_uploads")
      .delete()
      .eq("id", uploadId)
      .eq("user_id", user.id);
    if (uploadDeleteError) continue;
    await admin.storage
      .from("ai-files")
      .remove([upload.storage_path])
      .catch(() => undefined);
    filesRemoved += 1;
  }
  return { filesRemoved };
}
