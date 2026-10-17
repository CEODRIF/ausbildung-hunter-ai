import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { checkRateLimit, tooManyRequests } from "@/lib/rate-limit";
import { uploadBewDocument } from "@/lib/bewerbung-engine";

/**
 * POST /api/bew/documents — upload ONE personal document to the user's
 * library (Bewerbung Automation, step 2).
 *
 * WHY A ROUTE HANDLER (and not a server action): server actions cap the
 * request body at 1 MB by default (`serverActions.bodySizeLimit`), while
 * documents may be up to 10 MB. The original `bewUploadDocument` action
 * therefore rejected multi-MB files with a framework 413 BEFORE the engine
 * ran — a small CV passed, a certificate scan failed with a generic error.
 * Route handlers have no such framework limit (same pattern as
 * /api/ai/files and /api/bewerbung-scanner/files).
 *
 * Body: multipart form-data { file: File, kind: "cv" | "certificate" | "supporting" }
 * Auth: session (never trusted from the body). Rate-limited with the shared
 * `ai_upload` budget (same user, same 10 MB buffered-in-memory cost).
 * Errors: JSON { error: <stable code> } — the client maps stable codes to
 * localized messages; nothing server-internal is ever echoed.
 */

export const runtime = "nodejs";

/** Engine-thrown codes that mean "the user sent something we cannot take". */
const CLIENT_ERROR_CODES = new Set([
  "INVALID_KIND",
  "NO_FILE",
  "DOCUMENT_EMPTY",
  "DOCUMENT_TOO_LARGE",
  "DOCUMENT_UNSUPPORTED",
  "PDF_REQUIRED",
]);

export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Shares the ai_upload budget with /api/ai/files + the scanner (same cost).
  const limited = await checkRateLimit("ai_upload", user.id);
  if (!limited.allowed) return tooManyRequests(limited);

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json({ error: "INVALID_PAYLOAD" }, { status: 400 });
  }
  const file = formData.get("file");
  const kind = formData.get("kind");
  if (!(file instanceof File) || typeof kind !== "string")
    return NextResponse.json({ error: "NO_FILE" }, { status: 400 });

  try {
    const doc = await uploadBewDocument(user.id, file, kind as never);
    return NextResponse.json({ id: doc.id, filename: doc.filename, kind: doc.kind });
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    if (CLIENT_ERROR_CODES.has(code))
      return NextResponse.json({ error: code }, { status: 400 });
    // DOC_UPLOAD_FAILED / DOC_SAVE_FAILED / DOC_ATTACH_FAILED / anything
    // unexpected — a safe category, never the raw server text.
    if (
      code === "DOC_UPLOAD_FAILED" ||
      code === "DOC_SAVE_FAILED" ||
      code === "DOC_ATTACH_FAILED"
    )
      return NextResponse.json({ error: code }, { status: 500 });
    console.error("[api/bew/documents] unexpected upload error", error);
    return NextResponse.json({ error: "INTERNAL" }, { status: 500 });
  }
}
