import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const id = (await params).id;
  const admin = createAdminClient();
  const { data: file, error } = await admin
    .from("ai_generated_files")
    .select("storage_path, filename, mime_type")
    .eq("id", id)
    .eq("user_id", user.id)
    .single<{ storage_path: string; filename: string; mime_type: string }>();
  if (error || !file)
    return NextResponse.json({ error: "File not found." }, { status: 404 });
  const { data, error: downloadError } = await admin.storage
    .from("ai-files")
    .download(file.storage_path);
  if (downloadError || !data)
    return NextResponse.json({ error: "File unavailable." }, { status: 404 });
  return new Response(data, {
    headers: {
      "content-type": file.mime_type,
      "content-disposition": `attachment; filename="${file.filename.replace(/"/g, "")}"`,
      "cache-control": "private, no-store",
    },
  });
}

/** Phase 16 — item-level erasure for AI-generated files. Row first,
 *  then a best-effort storage sweep (the storage_path is unique to this
 *  row — no shared references exist). */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const id = (await params).id;
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
  )
    return NextResponse.json({ error: "File not found." }, { status: 404 });
  const admin = createAdminClient();
  const { data: file, error } = await admin
    .from("ai_generated_files")
    .select("storage_path")
    .eq("id", id)
    .eq("user_id", user.id)
    .single<{ storage_path: string }>();
  if (error || !file)
    return NextResponse.json({ error: "File not found." }, { status: 404 });
  const { error: deleteError } = await admin
    .from("ai_generated_files")
    .delete()
    .eq("id", id)
    .eq("user_id", user.id);
  if (deleteError)
    return NextResponse.json(
      { error: "Unable to delete file." },
      { status: 500 },
    );
  await admin.storage
    .from("ai-files")
    .remove([file.storage_path])
    .catch(() => undefined);
  return NextResponse.json({ success: true });
}
