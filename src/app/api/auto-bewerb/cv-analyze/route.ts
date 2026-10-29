import { createHash, randomUUID } from "node:crypto";
import mammoth from "mammoth";
import { NextResponse } from "next/server";
import { createAIProvider } from "@/lib/ai-provider";
import { extractPdfText } from "@/lib/pdf-extract";
import { PDF_PARSE_FAILED } from "@/lib/pdf-error";
import {
  completeFeatureOp,
  effectiveUploadLimitBytes,
  releaseFeatureOp,
  reserveFeatureOp,
} from "@/lib/billing/entitlement-service";
import { getEntitlements } from "@/lib/billing/entitlements";
import { detectFileType, DETECTED_MIME } from "@/lib/ai-service";
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
import { buildScannerPrompt, buildSparseRetryPrompt } from "@/lib/bewerbung-scanner-prompt";
import {
  SCAN_PROFILE_INCOMPLETE,
  SCAN_UNEXPECTED_FAILED,
  type ScanGoal,
} from "@/lib/bewerbung-scanner";
import { checkRateLimit, rateLimitHeaders, tooManyRequests } from "@/lib/rate-limit";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { getAutoBewerbProfile, saveAutoBewerbProfile } from "@/lib/auto-bewerb/engine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * AUTO BEWERB — Step 1: CV upload + background analysis.
 *
 * The pipeline reuses the production Bewerbung Scanner (buildScannerPrompt /
 * normalizeAiProfileResponse + the sparse-output retry gate), fed with
 * buffer-based extraction (PDF → pdf-parse, DOCX → mammoth, images →
 * vision model, DOC → file analyzer). The result is the platform's
 * CandidateProfile — the single source of truth for every generated
 * document (never fabricated: the model only extracts, the schema
 * validates, the user reviews and corrects).
 *
 * Reuse: re-uploading IDENTICAL bytes (same sha256) returns the stored
 * extraction — zero AI calls, zero quota. A replacement runs the full
 * pipeline; the old file is removed only after the new profile is stored.
 *
 * Metered on the existing `scanner` quota (same cost class) + the shared
 * AI daily meter. Failed runs release both (a failed op costs nothing).
 */

const GOAL: ScanGoal = "ausbildung";
const SCANNER_AI_TIMEOUT_MS = 180_000;
const CV_HARD_CAP_BYTES = 10 * 1024 * 1024;
const CV_TYPES = new Set(["pdf", "doc", "docx", "png", "jpeg"]);
const CV_BUCKET = "application-attachments";

/** Raw AI text → normalized object (server-side diagnostics only). */
function extractAndNormalize(raw: string): unknown {
  try {
    return normalizeAiProfileResponse(raw, GOAL);
  } catch (jsonError) {
    console.error(
      "[auto-bewerb-cv] AI returned no parseable JSON object:",
      jsonError instanceof Error ? jsonError.message : jsonError,
    );
    throw new Error("The AI response did not match the required profile schema.");
  }
}

/** Buffer → text context for the scanner prompt (per-format extraction). */
async function extractCvContext(type: string, mime: string, name: string, buffer: Buffer): Promise<string> {
  const ai = createAIProvider();
  if (type === "pdf") {
    const text = await extractPdfText(buffer);
    return `FILE ${name}\n${text.slice(0, 50_000)}`;
  }
  if (type === "docx") {
    const parsed = await mammoth.extractRawText({ buffer });
    return `FILE ${name}\n${parsed.value.slice(0, 50_000)}`;
  }
  if (type === "png" || type === "jpeg") {
    return `IMAGE ANALYSIS ${name}\n${await ai.analyzeImage({ filename: name, mimeType: mime, content: buffer })}`;
  }
  // doc / txt
  return `FILE ${name}\n${await ai.analyzeFile({ filename: name, mimeType: mime, content: buffer })}`;
}

export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const limited = await checkRateLimit("scanner_scan", user.id);
  if (!limited.allowed) return tooManyRequests(limited);

  const formData = await request.formData();
  const file = formData.get("file");
  if (!(file instanceof File) || file.size < 1) {
    return NextResponse.json({ error: "Bitte eine Lebenslauf-Datei hochladen." }, { status: 400 });
  }
  const buffer = Buffer.from(await file.arrayBuffer());

  // Content is the source of truth (magic bytes) — never the browser hint.
  const detected = detectFileType(buffer);
  if (!detected || !CV_TYPES.has(detected)) {
    return NextResponse.json(
      { error: "Nicht unterstützter Dateityp. Erlaubt: PDF, DOC, DOCX, PNG, JPEG." },
      { status: 415 },
    );
  }
  const mime = DETECTED_MIME[detected];
  const cap = Math.min(await effectiveUploadLimitBytes(user.id), CV_HARD_CAP_BYTES);
  if (buffer.length > cap) {
    return NextResponse.json(
      { error: `Datei ist zu groß (max. ${Math.floor(cap / 1024 / 1024)} MB).` },
      { status: 413 },
    );
  }

  const admin = createAdminClient();
  const cvHash = createHash("sha256").update(buffer).digest("hex");

  // REUSE: identical bytes → the stored extraction wins (no AI, no quota).
  const existingProfile = await getAutoBewerbProfile(user.id);
  if (existingProfile && existingProfile.cv_hash === cvHash && existingProfile.extracted) {
    return NextResponse.json(
      { reused: true, extracted: existingProfile.extracted },
      { headers: rateLimitHeaders(limited) },
    );
  }

  // Quota (reserved BEFORE any model call; released on every failure).
  const runId = randomUUID();
  const reserved = await reserveFeatureOp(user.id, "scanner", runId);
  if (reserved.outcome === "quota_exhausted") {
    return NextResponse.json(
      { error: "Scanner limit reached for your current plan.", code: "quota_exhausted" },
      { status: 429 },
    );
  }
  if (reserved.outcome === "feature_disabled") {
    return NextResponse.json(
      { error: "Scanner is not available on your current plan.", code: "feature_disabled" },
      { status: 403 },
    );
  }
  if (reserved.outcome === "error") {
    return NextResponse.json(
      { error: reserved.message ?? "Scanner quota could not be verified.", code: "quota_unavailable" },
      { status: 503 },
    );
  }

  const entitlements = await getEntitlements(user.id);
  const { error: usageError } = await admin.rpc("reserve_ai_request", {
    target_user_id: user.id,
    max_requests: entitlements.aiPerDay,
  });
  if (usageError) {
    await releaseFeatureOp(user.id, "scanner", runId).catch(() => undefined);
    return NextResponse.json(
      {
        error: usageError.message.includes("ai_daily_limit_reached")
          ? "AI daily request limit reached. Please try again tomorrow."
          : "AI usage is unavailable.",
      },
      { status: 429 },
    );
  }

  // Upload the ORIGINAL file first (private bucket, user-scoped path) so the
  // stored CV is the source of truth for re-analysis + replacement checks.
  const fileName = file.name.replace(/[^a-zA-Z0-9.äöüßÄÖÜ-]/g, "_").slice(0, 255) || "lebenslauf";
  const storagePath = `${user.id}/auto-bewerb/cv/${randomUUID()}-${fileName}`;
  const { error: uploadError } = await admin
    .storage.from(CV_BUCKET)
    .upload(storagePath, buffer, { contentType: mime, upsert: false });
  if (uploadError) {
    await releaseFeatureOp(user.id, "scanner", runId).catch(() => undefined);
    await Promise.resolve(admin.rpc("release_ai_request", { target_user_id: user.id })).catch(() => undefined);
    return NextResponse.json({ error: "Upload fehlgeschlagen. Bitte erneut versuchen." }, { status: 502 });
  }

  const cleanup = async () => {
    await releaseFeatureOp(user.id, "scanner", runId).catch(() => undefined);
    await Promise.resolve(admin.rpc("release_ai_request", { target_user_id: user.id })).catch(() => undefined);
    // A FAILED replacement must not orphan the new file (the old profile is
    // still the source of truth).
    await admin.storage.from(CV_BUCKET).remove([storagePath]).catch(() => undefined);
  };

  try {
    const context = await extractCvContext(detected, mime, fileName, buffer);
    if (context.trim().length < 20) {
      await cleanup();
      return NextResponse.json(
        { error: "Aus der Datei konnte kein Text extrahiert werden. Bitte eine lesbare PDF oder ein Bild mit Text verwenden.", code: "no_text" },
        { status: 422 },
      );
    }
    console.info(
      `[auto-bewerb-cv] analysis started: user=${user.id} type=${detected} contextChars=${context.length}`,
    );
    const provider = createAIProvider();
    const response = await provider.generateText(
      [{ role: "user", content: buildScannerPrompt(GOAL, context) }],
      SCANNER_AI_TIMEOUT_MS,
    );
    const parsed = candidateProfileSchema.safeParse(extractAndNormalize(response));
    if (!parsed.success) {
      console.error(
        "[auto-bewerb-cv] AI profile schema issues:",
        parsed.error.issues.slice(0, 12).map((i) => `${i.path.join(".") || "<root>"}: ${i.code}`),
      );
      throw new Error("The AI response did not match the required profile schema.");
    }
    let finalProfile: CandidateProfile = { ...parsed.data, goal: GOAL };

    // Deterministic completeness gate (identical to the scanner): a
    // substantial document must not silently produce a nearly empty profile.
    // One controlled retry; keep the more complete of the two genuine model
    // outputs — never fabricated data.
    if (isSuspiciouslySparse(finalProfile, context.length)) {
      const emptySections = emptyPrimarySections(finalProfile);
      console.warn(
        `[auto-bewerb-cv] sparse profile (contextChars=${context.length}, empty: ${emptySections.join(", ")}) — controlled retry pass`,
      );
      try {
        const retryResponse = await provider.generateText(
          [{ role: "user", content: buildSparseRetryPrompt(GOAL, context, emptySections) }],
          SCANNER_AI_TIMEOUT_MS,
        );
        const retryParsed = candidateProfileSchema.safeParse(extractAndNormalize(retryResponse));
        if (retryParsed.success) {
          finalProfile = pickMoreComplete(finalProfile, retryParsed.data) as CandidateProfile;
          finalProfile = { ...finalProfile, goal: GOAL };
        } else {
          console.error(
            "[auto-bewerb-cv] retry pass schema issues:",
            retryParsed.error.issues.slice(0, 12).map((i) => `${i.path.join(".") || "<root>"}: ${i.code}`),
          );
        }
      } catch (retryError) {
        console.error(
          "[auto-bewerb-cv] retry pass failed:",
          retryError instanceof Error ? retryError.message : retryError,
        );
      }
      if (isSuspiciouslySparse(finalProfile, context.length)) {
        throw new Error(SCAN_PROFILE_INCOMPLETE);
      }
    }

    const saved = await saveAutoBewerbProfile(user.id, {
      cvFileName: fileName,
      cvMime: mime,
      cvSizeBytes: buffer.length,
      cvStoragePath: storagePath,
      cvHash,
      extracted: finalProfile,
    });
    if (!saved.ok) {
      await cleanup();
      return NextResponse.json({ error: saved.message ?? "Profil konnte nicht gespeichert werden." }, { status: 502 });
    }

    await completeFeatureOp(user.id, "scanner", runId);
    return NextResponse.json(
      { reused: false, extracted: finalProfile, fileName },
      { headers: rateLimitHeaders(limited) },
    );
  } catch (error) {
    await cleanup();
    const raw = error instanceof Error ? error.message : "Analysis failed.";
    const isPdfParse = raw === PDF_PARSE_FAILED;
    const safe =
      raw === "The AI response did not match the required profile schema." ||
      raw === SCAN_PROFILE_INCOMPLETE ||
      isPdfParse
        ? raw
        : SCAN_UNEXPECTED_FAILED;
    if (safe !== raw) console.error("[auto-bewerb-cv] analysis failed:", error);
    return NextResponse.json(
      {
        error: isPdfParse
          ? "Die PDF konnte nicht gelesen werden. Bitte eine unbeschädigte Datei oder ein Bild verwenden."
          : safe === SCAN_PROFILE_INCOMPLETE
            ? "Die Analyse hat zu wenig Informationen ergeben. Bitte eine vollständigere Lebenslauf-Datei verwenden."
            : "Die Analyse ist fehlgeschlagen. Bitte erneut versuchen.",
        code: isPdfParse ? PDF_PARSE_FAILED : safe === SCAN_PROFILE_INCOMPLETE ? SCAN_PROFILE_INCOMPLETE : "analysis_failed",
      },
      { status: 502 },
    );
  }
}
