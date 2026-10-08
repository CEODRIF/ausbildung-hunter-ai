import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { getEntitlements } from "@/lib/billing/entitlements";
import { createAIProvider } from "@/lib/ai-provider";
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
import { PDF_PARSE_FAILED } from "@/lib/pdf-error";
import {
  activeUser,
  SCAN_PROFILE_INCOMPLETE,
  SCAN_UNEXPECTED_FAILED,
  type ScanGoal,
} from "@/lib/bewerbung-scanner";

/**
 * Heavy half of the Bewerbung Scanner: the document → AI-profile run.
 *
 * Split out of `bewerbung-scanner.ts` so the module keeps no link to
 * `@/lib/ai-file-context` (and therefore to the PDF parsing stack). Routes
 * that only read/delete/update scans must import from
 * `bewerbung-scanner.ts`; only this module may be imported where files are
 * actually parsed.
 */

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
