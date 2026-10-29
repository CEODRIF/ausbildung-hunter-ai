import { NextResponse } from "next/server";
import {
  checkRateLimit,
  rateLimitHeaders,
  tooManyRequests,
} from "@/lib/rate-limit";
import {
  deleteStudioAttachment,
  renameStudioAttachment,
  uploadStudioAttachment,
} from "@/lib/studio";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * AI Bewerbung Studio — Section F: supporting documents.
 *
 *  - POST  multipart {file, applicationId, category} — magic-byte validated,
 *    plan-size-capped, stored PRIVATE in `application-attachments`.
 *  - PATCH {attachmentId, name} — rename (display name only).
 *  - DELETE {attachmentId} — removes the storage object + row (owner only).
 *
 * Files are never publicly addressable: no signed URLs, no public bucket,
 * and the only consumer is the ownership-checked email dispatch path.
 */

async function authedUser() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user;
}

const STATUS_BY_CODE: Record<string, number> = {
  schema_pending: 503,
  not_found: 404,
  not_approved: 403,
  invalid_file_type: 415,
  file_too_large: 413,
  storage_error: 502,
};

function opResponse(op: { ok: boolean; code?: string; message?: string; value?: unknown }, headers?: Record<string, string>) {
  if (op.ok) return NextResponse.json(op.value ?? {}, headers ? { headers } : undefined);
  return NextResponse.json(
    { error: op.message ?? "Operation failed.", code: op.code },
    { status: STATUS_BY_CODE[op.code ?? ""] ?? 400 },
  );
}

export async function POST(request: Request) {
  const user = await authedUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  // Shares the ai_upload burst budget (same cost profile: buffered + sniffed).
  const limited = await checkRateLimit("ai_upload", user.id);
  if (!limited.allowed) return tooManyRequests(limited);

  const formData = await request.formData();
  const file = formData.get("file");
  const applicationId = formData.get("applicationId");
  const rawCategory = formData.get("category");
  const category = typeof rawCategory === "string" ? rawCategory : "other";
  if (!(file instanceof File))
    return NextResponse.json({ error: "File is required." }, { status: 400 });
  if (typeof applicationId !== "string" || !applicationId)
    return NextResponse.json({ error: "applicationId is required." }, { status: 400 });

  const buffer = Buffer.from(await file.arrayBuffer());
  const op = await uploadStudioAttachment(user.id, applicationId, {
    name: file.name,
    buffer,
    category,
  });
  return opResponse(op, op.ok ? rateLimitHeaders(limited) : undefined);
}

export async function PATCH(request: Request) {
  const user = await authedUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  if (typeof body.attachmentId !== "string" || typeof body.name !== "string")
    return NextResponse.json({ error: "attachmentId and name are required." }, { status: 400 });
  return opResponse(await renameStudioAttachment(user.id, body.attachmentId, body.name));
}

export async function DELETE(request: Request) {
  const user = await authedUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  if (typeof body.attachmentId !== "string" || !body.attachmentId)
    return NextResponse.json({ error: "attachmentId is required." }, { status: 400 });
  return opResponse(await deleteStudioAttachment(user.id, body.attachmentId));
}
