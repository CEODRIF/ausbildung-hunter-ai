import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { AIFileInUseError, deleteAIFile, uploadAIFile } from "@/lib/ai-service";

const deleteFileBody = z.object({ fileId: z.string().uuid() }).strict();

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
  const parsed = deleteFileBody.safeParse(
    await request.json().catch(() => ({})),
  );
  if (!parsed.success)
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  // Phase 16 — the lib performs the safe sequence: reference pre-check
  // (409 while a scan uses the file), row delete, best-effort storage
  // sweep. Ownership is enforced inside (session user, user-scoped).
  try {
    await deleteAIFile(parsed.data.fileId);
    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof AIFileInUseError)
      return NextResponse.json({ error: error.message }, { status: 409 });
    if (error instanceof Error && error.message === "File not found.")
      return NextResponse.json({ error: error.message }, { status: 404 });
    return NextResponse.json(
      { error: "Unable to delete file." },
      { status: 500 },
    );
  }
}
