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
