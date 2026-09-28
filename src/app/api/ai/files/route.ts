import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { uploadAIFile } from "@/lib/ai-service";

export const runtime = "nodejs";
export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const formData = await request.formData();
  const file = formData.get("file");
  if (!(file instanceof File))
    return NextResponse.json({ error: "File is required." }, { status: 400 });
  try {
    return NextResponse.json(await uploadAIFile(file));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Upload failed." },
      { status: 400 },
    );
  }
}
export async function DELETE(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { fileId } = (await request.json().catch(() => ({}))) as {
    fileId?: string;
  };
  if (!fileId)
    return NextResponse.json({ error: "File not found." }, { status: 404 });
  const { createAdminClient } = await import("@/lib/supabase/admin");
  const admin = createAdminClient();
  const { data: file } = await admin
    .from("ai_file_uploads")
    .select("storage_path")
    .eq("id", fileId)
    .eq("user_id", user.id)
    .single<{ storage_path: string }>();
  if (!file)
    return NextResponse.json({ error: "File not found." }, { status: 404 });
  await admin.storage.from("ai-files").remove([file.storage_path]);
  await admin
    .from("ai_file_uploads")
    .delete()
    .eq("id", fileId)
    .eq("user_id", user.id);
  return NextResponse.json({ success: true });
}
