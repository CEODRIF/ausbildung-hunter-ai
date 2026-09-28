import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createAIProvider } from "@/lib/ai-provider";
import { getCurrentUserAndProfile } from "@/lib/auth";

export const runtime = "nodejs";
export async function POST(request: Request) {
  const { user, profile } = await getCurrentUserAndProfile();
  if (!user || !profile || profile.account_status !== "active")
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = (await request.json().catch(() => ({}))) as {
    conversationId?: string;
    filename?: string;
    mimeType?: string;
    prompt?: string;
  };
  if (!body.conversationId || !body.filename || !body.mimeType || !body.prompt)
    return NextResponse.json(
      { error: "Missing file request fields." },
      { status: 400 },
    );
  const admin = createAdminClient();
  const { data: conversation } = await admin
    .from("ai_conversations")
    .select("id")
    .eq("id", body.conversationId)
    .eq("user_id", user.id)
    .single();
  if (!conversation)
    return NextResponse.json(
      { error: "Conversation not found." },
      { status: 404 },
    );
  try {
    const content = await createAIProvider().generateFile({
      filename: body.filename,
      mimeType: body.mimeType,
      prompt: body.prompt,
    });
    const path = `${user.id}/generated/${crypto.randomUUID()}-${body.filename.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
    const { error: uploadError } = await admin.storage
      .from("ai-files")
      .upload(path, content, { contentType: body.mimeType, upsert: false });
    if (uploadError) throw new Error("Unable to store generated file.");
    const { data, error } = await admin
      .from("ai_generated_files")
      .insert({
        user_id: user.id,
        conversation_id: body.conversationId,
        filename: body.filename.slice(0, 255),
        mime_type: body.mimeType,
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
