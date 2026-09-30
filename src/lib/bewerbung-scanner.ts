import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { getEntitlements } from "@/lib/billing/entitlements";
import { createAIProvider } from "@/lib/ai-provider";
import { getCurrentUserAndProfile } from "@/lib/auth";
import { buildFileContext } from "@/lib/ai-file-context";
import {
  candidateProfileSchema,
  type CandidateProfile,
} from "@/lib/bewerbung-schema";
import {
  emptyPrimarySections,
  isSuspiciouslySparse,
  normalizeAiProfileResponse,
  pickMoreComplete,
} from "@/lib/bewerbung-profile-normalize";
import {
  buildScannerPrompt,
  buildSparseRetryPrompt,
} from "@/lib/bewerbung-scanner-prompt";
import { PDF_PARSE_FAILED } from "@/lib/pdf-extract";

/** Raw AI text → normalized object, with server-side diagnostics. Throws
 *  the user-safe schema error when no JSON object can be recovered. */
function extractAndNormalize(raw: string, goal: ScanGoal): unknown {
  try {
    return normalizeAiProfileResponse(raw, goal);
  } catch (jsonError) {
    console.error(
      "[bewerbung-scanner] AI returned no parseable JSON object:",
      jsonError instanceof Error ? jsonError.message : jsonError,
      "raw (truncated):",
      String(raw).slice(0, 2000),
    );
    throw new Error(
      "The AI response did not match the required profile schema.",
    );
  }
}

/** Stable, user-safe code for unexpected scan failures (UI localizes it). */
export const SCAN_UNEXPECTED_FAILED = "SCAN_UNEXPECTED_FAILED";
/** Stable code: document was substantial but the AI returned a nearly empty
 *  profile even after the controlled retry pass (UI localizes it). */
export const SCAN_PROFILE_INCOMPLETE = "SCAN_PROFILE_INCOMPLETE";
/** Long structured CV extraction gets a bigger per-request budget than the
 *  60s chat default (the function timeout in Vercel stays the backstop). */
const SCANNER_AI_TIMEOUT_MS = 180_000;
/** Messages that are already user-safe (stored verbatim, no code mapping). */
const SAFE_SCAN_MESSAGES = new Set([
  "Not authorized.",
  "Scan not found.",
  "Upload between 1 and 10 supported files.",
  "Unable to create scan.",
  "Unable to save scan files.",
  "No scan files found.",
  "Scan file ownership could not be verified.",
  "AI daily request limit reached. Please try again tomorrow.",
  "AI usage is unavailable.",
  "The AI response did not match the required profile schema.",
  "Unable to save candidate profile.",
  PDF_PARSE_FAILED,
  SCAN_PROFILE_INCOMPLETE,
]);

export type ScanGoal = "ausbildung" | "arbeit";
export type ScanFile = {
  id: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  storage_path: string;
};

async function activeUser() {
  const current = await getCurrentUserAndProfile();
  if (
    !current.user ||
    !current.profile ||
    current.profile.account_status !== "active"
  )
    throw new Error("Not authorized.");
  return current.user;
}
export async function createScan(goal: ScanGoal, files: ScanFile[]) {
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

export async function runScan(scanId: string) {
  const user = await activeUser();
  const admin = createAdminClient();
  const { data: scan, error } = await admin
    .from("bewerbung_scans")
    .select("id, goal, status")
    .eq("id", scanId)
    .eq("user_id", user.id)
    .single<{ id: string; goal: ScanGoal; status: string }>();
  if (error || !scan) throw new Error("Scan not found.");
  await admin
    .from("bewerbung_scans")
    .update({ status: "analyzing", error_message: null })
    .eq("id", scanId)
    .eq("user_id", user.id);
  // Plan-aware AI limit, resolved server-side (free users: unchanged).
  const entitlements = await getEntitlements(user.id);
  const { error: usageError } = await admin.rpc("reserve_ai_request", {
    target_user_id: user.id,
    max_requests: entitlements.aiPerDay,
  });
  if (usageError)
    throw new Error(
      usageError.message.includes("ai_daily_limit_reached")
        ? "AI daily request limit reached. Please try again tomorrow."
        : "AI usage is unavailable.",
    );
  try {
    const { data: files } = await admin
      .from("bewerbung_scan_files")
      .select("filename, mime_type, storage_file_id")
      .eq("scan_id", scanId)
      .eq("user_id", user.id);
    if (!files?.length) throw new Error("No scan files found.");
    const { data: uploads } = await admin
      .from("ai_file_uploads")
      .select("id, filename, mime_type, storage_path, size_bytes")
      .in(
        "id",
        files.map((file) => file.storage_file_id),
      )
      .eq("user_id", user.id);
    if (!uploads || uploads.length !== files.length)
      throw new Error("Scan file ownership could not be verified.");
    // The scanner allows up to 10 files — pass ALL of them (buildFileContext
    // defaults to 5 for chat). Every file's text is handed to the model
    // verbatim (per-file cap 50k chars in ai-file-context, far above a CV).
    const context = await buildFileContext(uploads, 10);
    // Size telemetry: a CV that silently stops short of the model would show
    // up here. contextChars ≈ characters of extracted text + file headers.
    console.info(
      "[bewerbung-scanner] scan started: goal=" +
        scan.goal +
        " files=" +
        uploads.length +
        " contextChars=" +
        context.length,
    );
    const provider = createAIProvider();
    // Full analyzer prompt (read the whole document, every section, German
    // terminology, evidence-based derived fields) — see
    // bewerbung-scanner-prompt.ts. The strict schema below remains the
    // final validation boundary; diagnostics go to server logs only.
    const response = await provider.generateText(
      [{ role: "user", content: buildScannerPrompt(scan.goal, context) }],
      SCANNER_AI_TIMEOUT_MS,
    );
    const parsed = candidateProfileSchema.safeParse(
      extractAndNormalize(response, scan.goal),
    );
    if (!parsed.success) {
      console.error(
        "[bewerbung-scanner] AI profile schema issues:",
        parsed.error.issues
          .slice(0, 12)
          .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.code}`),
      );
      throw new Error(
        "The AI response did not match the required profile schema.",
      );
    }
    let finalProfile: CandidateProfile = { ...parsed.data, goal: scan.goal };
    // Deterministic completeness gate: a substantial document must not
    // silently produce a nearly empty profile. On sparse output, run exactly
    // ONE controlled retry pass and keep the more complete of the two
    // genuine model outputs — never fabricated data.
    if (isSuspiciouslySparse(finalProfile, context.length)) {
      const emptySections = emptyPrimarySections(finalProfile);
      console.warn(
        "[bewerbung-scanner] sparse profile despite substantial document " +
          "(contextChars=" +
          context.length +
          ", empty sections: " +
          emptySections.join(", ") +
          ") — running controlled retry pass",
      );
      try {
        const retryResponse = await provider.generateText(
          [
            {
              role: "user",
              content: buildSparseRetryPrompt(scan.goal, context, emptySections),
            },
          ],
          SCANNER_AI_TIMEOUT_MS,
        );
        const retryParsed = candidateProfileSchema.safeParse(
          extractAndNormalize(retryResponse, scan.goal),
        );
        if (retryParsed.success) {
          finalProfile = pickMoreComplete(finalProfile, retryParsed.data) as CandidateProfile;
          finalProfile = { ...finalProfile, goal: scan.goal };
        } else {
          console.error(
            "[bewerbung-scanner] retry pass schema issues:",
            retryParsed.error.issues
              .slice(0, 12)
              .map(
                (issue) => `${issue.path.join(".") || "<root>"}: ${issue.code}`,
              ),
          );
        }
      } catch (retryError) {
        // Provider/network failure on the retry: keep the first (sparse)
        // result only if we can — otherwise surface the stable code.
        console.error(
          "[bewerbung-scanner] retry pass failed:",
          retryError instanceof Error ? retryError.message : retryError,
        );
      }
      if (isSuspiciouslySparse(finalProfile, context.length)) {
        throw new Error(SCAN_PROFILE_INCOMPLETE);
      }
    }
    const { error: profileError } = await admin
      .from("candidate_profiles")
      .upsert(
        { user_id: user.id, scan_id: scanId, profile_json: finalProfile },
        { onConflict: "scan_id" },
      );
    if (profileError) throw new Error("Unable to save candidate profile.");
    await admin
      .from("bewerbung_scans")
      .update({
        status: "completed",
        completed_at: new Date().toISOString(),
        error_message: null,
      })
      .eq("id", scanId)
      .eq("user_id", user.id);
    await admin.from("activity_logs").insert({
      user_id: user.id,
      activity_type: "bewerbung_scan_completed",
      title: "Bewerbung scan completed",
      description:
        "A structured candidate profile was created from your documents.",
      metadata: { scan_id: scanId },
    });
    return finalProfile;
  } catch (error) {
    const raw = error instanceof Error ? error.message : "Scan failed.";
    // Only user-safe messages and stable codes reach the DB (surfaced in the
    // UI) and the client response. Unexpected technical failures (library
    // internals like "DOMMatrix is not defined", provider stack messages)
    // are logged server-side and replaced with SCAN_UNEXPECTED_FAILED.
    const message = SAFE_SCAN_MESSAGES.has(raw)
      ? raw
      : SCAN_UNEXPECTED_FAILED;
    if (message !== raw)
      console.error("[bewerbung-scanner] scan failed:", error);
    await admin
      .from("bewerbung_scans")
      .update({ status: "failed", error_message: message.slice(0, 500) })
      .eq("id", scanId)
      .eq("user_id", user.id);
    throw new Error(message);
  }
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
