import { NextResponse } from "next/server";
import {
  checkRateLimit,
  rateLimitHeaders,
  tooManyRequests,
} from "@/lib/rate-limit";
import {
  deleteAutoBewerbProfilePhoto,
  resolveAutoBewerbPhotoDataUrl,
  uploadAutoBewerbProfilePhoto,
} from "@/lib/auto-bewerb/engine";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * AUTO BEWERB — Step 1: the professional profile photo (Bewerbungsfoto).
 *
 *  - POST multipart {file}  → validate (magic bytes, ≤ 5 MB, dimensions),
 *    optimize (aspect preserved), store PRIVATE in `application-attachments`
 *    under the owner's folder and upsert the single owner row. Uploads are
 *    idempotent per content hash (same photo → same object, no duplicate).
 *  - DELETE                → removes the "current photo" row (the storage
 *    object is kept: saved CVs freeze the hash reference).
 *  - GET                   → streams the current photo (or a FROZEN
 *    reference via ?ref=abphoto:v1:<hash>:<ext> — used by the Step 4 edit
 *    preview) to the owner. Ownership is re-checked server-side from the
 *    session: the path is built from the verified user id, never from the
 *    client. The private bucket is never exposed (no signed URLs, no
 *    public read — the client only ever sees these same-origin,
 *    auth-cookie-protected responses).
 *
 * The photo is OPTIONAL: every failure degrades to "no photo" and the
 * workflow continues (generation without a photograph always works).
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

/** data URL → { bytes, mime } (the GET route streams raw bytes). */
function dataUrlToBytes(dataUrl: string): { bytes: Buffer; mime: string } | null {
  const m = dataUrl.match(/^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/i);
  if (!m) return null;
  return { bytes: Buffer.from(m[2], "base64"), mime: m[1] };
}

export async function GET(request: Request) {
  const user = await authedUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(request.url);
  const ref = url.searchParams.get("ref");
  if (ref !== null && ref.trim() === "") {
    return NextResponse.json({ error: "ref is invalid." }, { status: 400 });
  }

  const dataUrl = await resolveAutoBewerbPhotoDataUrl(user.id, ref).catch(() => null);
  const bytes = dataUrl ? dataUrlToBytes(dataUrl) : null;
  if (!bytes) {
    return NextResponse.json(
      { error: "Kein Bewerbungsfoto vorhanden.", code: "no_photo" },
      { status: 404 },
    );
  }
  return new NextResponse(new Uint8Array(bytes.bytes), {
    status: 200,
    headers: {
      "Content-Type": bytes.mime,
      "Cache-Control": "no-store",
      "Content-Length": String(bytes.bytes.length),
    },
  });
}

export async function POST(request: Request) {
  const user = await authedUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const limited = await checkRateLimit("ai_upload", user.id);
  if (!limited.allowed) return tooManyRequests(limited);

  const formData = await request.formData();
  const file = formData.get("file");
  if (!(file instanceof File) || file.size < 1) {
    return NextResponse.json({ error: "Bitte ein Foto hochladen." }, { status: 400 });
  }
  const buffer = Buffer.from(await file.arrayBuffer());
  const op = await uploadAutoBewerbProfilePhoto(user.id, buffer);
  if (op.ok) {
    return NextResponse.json(op.value, { headers: rateLimitHeaders(limited) });
  }
  return NextResponse.json(
    { error: op.message, code: op.code },
    { status: STATUS_BY_CODE[op.code] ?? 400 },
  );
}

export async function DELETE() {
  const user = await authedUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const op = await deleteAutoBewerbProfilePhoto(user.id);
  if (op.ok) return NextResponse.json({ ok: true });
  return NextResponse.json(
    { error: op.message, code: op.code },
    { status: STATUS_BY_CODE[op.code] ?? 400 },
  );
}
