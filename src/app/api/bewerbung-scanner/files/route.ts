import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { checkRateLimit, tooManyRequests } from "@/lib/rate-limit";
import { uploadAIFile } from "@/lib/ai-service";

export const runtime = "nodejs";
export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  // Shares the ai_upload budget with /api/ai/files (same user, same cost).
  const limited = await checkRateLimit("ai_upload", user.id);
  if (!limited.allowed) return tooManyRequests(limited);
  const formData = await request.formData();
  const file = formData.get("file");
  if (!(file instanceof File))
    return NextResponse.json({ error: "File is required." }, { status: 400 });
  try {
    const result = await uploadAIFile(file);
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Upload failed." },
      { status: 400 },
    );
  }
}
