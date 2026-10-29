import { NextResponse } from "next/server";
import {
  checkRateLimit,
  rateLimitHeaders,
  tooManyRequests,
} from "@/lib/rate-limit";
import {
  deleteAutoBewerbAttachment,
  renameAutoBewerbAttachment,
  uploadAutoBewerbAttachment,
} from "@/lib/auto-bewerb/engine";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * AUTO BEWERB — Step 3: supporting-document library (user-level, reusable).
 *
 *  - POST multipart {file, category} — magic-byte validated, plan-size-capped,
 *    stored PRIVATE in `application-attachments` (the same secure bucket as
 *    every other user document). Identical bytes (sha256) reuse the stored
 *    row — no duplicate objects, no duplicate library entries.
 *  - PATCH {attachmentId, name} — rename (display name only).
 *  - DELETE {attachmentId} — removes the storage object + row (owner only).
 *
 * Files are never publicly addressable: no signed URLs, no public bucket,
 * and the only consumer is the ownership-checked email dispatch path.
 * The step is OPTIONAL — the workflow continues without documents.
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
  const rawCategory = formData.get("category");
  const category = typeof rawCategory === "string" ? rawCategory : "other";
  if (!(file instanceof File) || file.size < 1) {
    return NextResponse.json({ error: "Bitte eine Datei hochladen." }, { status: 400 });
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const op = await uploadAutoBewerbAttachment(user.id, {
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
  return opResponse(await renameAutoBewerbAttachment(user.id, body.attachmentId, body.name));
}

export async function DELETE(request: Request) {
  const user = await authedUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  if (typeof body.attachmentId !== "string" || !body.attachmentId)
    return NextResponse.json({ error: "attachmentId is required." }, { status: 400 });
  return opResponse(await deleteAutoBewerbAttachment(user.id, body.attachmentId));
}
