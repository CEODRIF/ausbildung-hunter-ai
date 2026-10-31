import { NextResponse } from "next/server";
import {
  checkRateLimit,
  rateLimitHeaders,
  tooManyRequests,
} from "@/lib/rate-limit";
import {
  deleteAutoBewerbSignature,
  getAutoBewerbSignatureImage,
  uploadAutoBewerbSignature,
} from "@/lib/auto-bewerb/engine";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * AUTO BEWERB — Step 5: the candidate's GENUINE handwritten signature.
 *
 *  - POST multipart {file}  → magic-byte validation (PNG or JPEG, ≤ 5 MB),
 *    stored PRIVATE at a fixed owner-scoped path in `application-attachments`
 *    (one signature per user; the opposite-format object is removed). The
 *    image is the user's own upload — it is NEVER generated or invented.
 *  - DELETE                → removes the owner's signature object(s).
 *  - GET                   → streams the current signature (or 404 when none).
 *
 * The path is built from the session-verified user id — never from client
 * input. The private bucket is never exposed (no signed URLs, no public read
 * — the client only sees these same-origin, auth-cookie-protected responses).
 *
 * The signature is OPTIONAL and is used ONLY as an image inside the
 * cover-letter PDF (a separate attachment); it is never a standalone
 * e-mail attachment and never changes the e-mail body.
 */

async function authedUser() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user;
}

const STATUS_BY_CODE: Record<string, number> = {
  not_found: 404,
  invalid_file_type: 415,
  file_too_large: 413,
  storage_error: 502,
};

export async function GET() {
  const user = await authedUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const img = await getAutoBewerbSignatureImage(user.id);
  if (!img) {
    return NextResponse.json(
      { error: "Keine Signatur vorhanden.", code: "no_signature" },
      { status: 404 },
    );
  }
  return new NextResponse(new Uint8Array(img.bytes), {
    status: 200,
    headers: {
      "Content-Type": img.mime,
      "Cache-Control": "no-store",
      "Content-Length": String(img.bytes.length),
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
    return NextResponse.json({ error: "Bitte ein Bild der Signatur hochladen." }, { status: 400 });
  }
  const buffer = Buffer.from(await file.arrayBuffer());
  const op = await uploadAutoBewerbSignature(user.id, buffer);
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
  const op = await deleteAutoBewerbSignature(user.id);
  if (op.ok) return NextResponse.json({ ok: true });
  return NextResponse.json(
    { error: op.message, code: op.code },
    { status: STATUS_BY_CODE[op.code] ?? 400 },
  );
}
