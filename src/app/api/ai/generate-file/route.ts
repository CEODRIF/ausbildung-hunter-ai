import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createAIProvider } from "@/lib/ai-provider";
import { getCurrentUserAndProfile } from "@/lib/auth";
import { checkRateLimit, tooManyRequests } from "@/lib/rate-limit";
import { generateFileRequestSchema } from "@/lib/bewerbung-schema";
import {
  completeFeatureOp,
  releaseFeatureOp,
  reserveFeatureOp,
} from "@/lib/billing/entitlement-service";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const { user, profile } = await getCurrentUserAndProfile();
  if (!user || !profile || profile.account_status !== "active")
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  // One request = a paid AI completion + a storage write — it counts as one
  // ai_assistant operation on the user's plan (same daily meter as chat).
  // Reserved BEFORE the provider call so a failed generation is refunded.
  const limited = await checkRateLimit("ai_generate_file", user.id);
  if (!limited.allowed) return tooManyRequests(limited);
  const runId = crypto.randomUUID();
  const reserved = await reserveFeatureOp(user.id, "ai_assistant", runId);
  if (reserved.outcome === "quota_exhausted") {
    return NextResponse.json(
      {
        error: "Daily AI limit reached. It resets at 00:00 UTC.",
        code: "quota_exhausted",
      },
      { status: 429 },
    );
  }
  if (reserved.outcome === "feature_disabled") {
    return NextResponse.json(
      {
        error: "AI file generation is not available on your current plan.",
        code: "feature_disabled",
      },
      { status: 403 },
    );
  }
  if (reserved.outcome === "error") {
    return NextResponse.json(
      {
        error: reserved.message ?? "AI usage is temporarily unavailable.",
        code: "quota_unavailable",
      },
      { status: 503 },
    );
  }
  const parsed = generateFileRequestSchema.safeParse(
    await request.json().catch(() => ({})),
  );
  if (!parsed.success) {
    await releaseFeatureOp(user.id, "ai_assistant");
    return NextResponse.json(
      { error: "Missing file request fields." },
      { status: 400 },
    );
  }
  const { conversationId, filename, mimeType, prompt } = parsed.data;
  const admin = createAdminClient();
  // Ownership is derived from the session, never from the body.
  const { data: conversation } = await admin
    .from("ai_conversations")
    .select("id")
    .eq("id", conversationId)
    .eq("user_id", user.id)
    .single();
  if (!conversation) {
    await releaseFeatureOp(user.id, "ai_assistant");
    return NextResponse.json(
      { error: "Conversation not found." },
      { status: 404 },
    );
  }
  try {
    const content = await createAIProvider().generateFile({
      filename,
      mimeType,
      prompt,
    });
    const path = `${user.id}/generated/${crypto.randomUUID()}-${filename.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
    const { error: uploadError } = await admin.storage
      .from("ai-files")
      .upload(path, content, { contentType: mimeType, upsert: false });
    if (uploadError) throw new Error("Unable to store generated file.");
    const { data, error } = await admin
      .from("ai_generated_files")
      .insert({
        user_id: user.id,
        conversation_id: conversationId,
        filename,
        mime_type: mimeType,
        storage_path: path,
        size_bytes: content.length,
      })
      .select("id, filename, mime_type, size_bytes")
      .single();
    if (error) throw new Error("Unable to save generated file metadata.");
    // Reservation is final for ai_assistant (the meter is the daily
    // counter); the call documents the operation completed.
    await completeFeatureOp(user.id, "ai_assistant", runId);
    return NextResponse.json(data);
  } catch (error) {
    // Refund: a failed generation must not consume the user's quota.
    await releaseFeatureOp(user.id, "ai_assistant");
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "File generation failed.",
      },
      { status: 400 },
    );
  }
}
