import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createAIProvider } from "@/lib/ai-provider";
import { getCurrentUserAndProfile } from "@/lib/auth";
import { checkRateLimit, tooManyRequests } from "@/lib/rate-limit";
import { generateFileRequestSchema } from "@/lib/bewerbung-schema";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const { user, profile } = await getCurrentUserAndProfile();
  if (!user || !profile || profile.account_status !== "active")
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  // One request = a paid AI completion + a storage write.
  const limited = await checkRateLimit("ai_generate_file", user.id);
  if (!limited.allowed) return tooManyRequests(limited);
  const parsed = generateFileRequestSchema.safeParse(
    await request.json().catch(() => ({})),
  );
  if (!parsed.success)
    return NextResponse.json(
      { error: "Missing file request fields." },
      { status: 400 },
    );
  const { conversationId, filename, mimeType, prompt } = parsed.data;
  const admin = createAdminClient();
  // Ownership is derived from the session, never from the body.
  const { data: conversation } = await admin
    .from("ai_conversations")
    .select("id")
    .eq("id", conversationId)
    .eq("user_id", user.id)
    .single();
  if (!conversation)
    return NextResponse.json(
      { error: "Conversation not found." },
      { status: 404 },
    );
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
    return NextResponse.json(data);
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "File generation failed.",
      },
      { status: 400 },
    );
  }
}
