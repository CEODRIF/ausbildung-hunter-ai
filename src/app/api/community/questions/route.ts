import { NextResponse } from "next/server";
import { getCurrentUserAndProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import {
  checkRateLimit,
  rateLimitHeaders,
  tooManyRequests,
} from "@/lib/rate-limit";
import {
  buildCommunityImagePath,
  COMMUNITY_MAX_IMAGE_BYTES,
  validateCommunityImage,
} from "@/lib/community";
import { fetchRoomBySlug } from "@/lib/community/rooms";
import { fetchCommunityWriteGate } from "@/lib/community/roles";
import {
  createQuestion,
  parseQuestionTags,
} from "@/lib/community/qa";
import { checkCommunityImageQuota } from "@/lib/community/image-quota";

/**
 * POST /api/community/questions — create a question (Phase 5 Q&A).
 *
 * multipart/form-data: `room` (slug), `title`, `body`, `tags` (comma-
 * separated), optional `image` (≤2 MB, jpeg/png/webp — re-validated from
 * the bytes). The question id is server-generated; the optional image is
 * uploaded FIRST (storage policy: the {user_id}/… owner folder, so a failed
 * insert leaves only a GC-able orphan, never an exposed file).
 *
 * Authorization chain (all server-side):
 *   session user → write gate (suspended/muted) → room exists + enabled +
 *   qna_enabled → RLS insert policy (authorship + qna re-check in the DB).
 * Rate limit: community_question (10/min).
 */

const MAX_TITLE = 120;
const MAX_BODY = 4000;

export async function POST(request: Request) {
  const { user } = await getCurrentUserAndProfile();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const limited = await checkRateLimit("community_question", user.id);
  if (!limited.allowed) return tooManyRequests(limited);

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const gate = await fetchCommunityWriteGate(user.id);
  if (!gate.writable) {
    return NextResponse.json({ error: gate.code }, { status: 403 });
  }

  const title = typeof form.get("title") === "string" ? (form.get("title") as string).trim() : "";
  const body = typeof form.get("body") === "string" ? (form.get("body") as string).trim() : "";
  if (title.length > MAX_TITLE || body.length > MAX_BODY) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }

  const supabase = await createClient();
  const roomSlug =
    typeof form.get("room") === "string" && (form.get("room") as string).trim().length > 0
      ? (form.get("room") as string).trim().toLowerCase()
      : null;
  if (!roomSlug) {
    return NextResponse.json({ error: "room_required" }, { status: 400 });
  }
  const { room, unavailable } = await fetchRoomBySlug(supabase, roomSlug);
  if (unavailable) {
    return NextResponse.json({ error: "Could not load room." }, { status: 500 });
  }
  if (!room) {
    return NextResponse.json({ error: "room_not_found" }, { status: 404 });
  }
  if (!room.qna_enabled) {
    return NextResponse.json({ error: "qna_disabled" }, { status: 409 });
  }

  const rawTags = typeof form.get("tags") === "string" ? (form.get("tags") as string) : "";
  const tags = parseQuestionTags(rawTags);
  if (tags === null) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }

  // Optional image (byte-validated), stored under the owner folder.
  let imagePath: string | null = null;
  const file = form.get("image");
  if (file instanceof File) {
    if (file.size > COMMUNITY_MAX_IMAGE_BYTES) {
      return NextResponse.json({ error: "image_too_large" }, { status: 413 });
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const verdict = validateCommunityImage(file.type, bytes);
    if (!verdict.ok) {
      return NextResponse.json(
        { error: verdict.code },
        { status: verdict.code === "image_too_large" ? 413 : 415 },
      );
    }
    // Phase 6A: per-user storage quota — server-side, BEFORE the upload
    // (a rejected upload must never create a storage object).
    const quota = await checkCommunityImageQuota(user.id, file.size);
    if (!quota.ok) {
      return NextResponse.json(
        { error: quota.code },
        { status: quota.code === "storage_quota" ? 413 : 500 },
      );
    }
    const questionId = crypto.randomUUID();
    const path = buildCommunityImagePath(user.id, questionId, verdict.ext);
    if (!path) {
      return NextResponse.json({ error: "Invalid request." }, { status: 400 });
    }
    const { error: uploadError } = await supabase.storage
      .from("community-images")
      .upload(path, new Blob([bytes], { type: file.type }), {
        contentType: file.type,
        upsert: false,
        cacheControl: "31536000",
      });
    if (uploadError) {
      const tooBig = /limit/i.test(uploadError.message ?? "");
      return NextResponse.json(
        { error: tooBig ? "image_too_large" : "invalid_image" },
        { status: tooBig ? 413 : 415 },
      );
    }
    imagePath = path;
  }

  const result = await createQuestion(supabase, { id: user.id }, {
    roomId: room.id,
    room,
    title,
    body,
    tags,
    imagePath,
  });
  if (!result.ok) {
    switch (result.error) {
      case "room_not_found":
        return NextResponse.json({ error: "room_not_found" }, { status: 404 });
      case "qna_disabled":
        return NextResponse.json({ error: "qna_disabled" }, { status: 409 });
      case "invalid":
        return NextResponse.json({ error: "invalid" }, { status: 400 });
      default:
        return NextResponse.json({ error: "question_failed" }, { status: 500 });
    }
  }
  return NextResponse.json(
    { question: result.question },
    { status: 201, headers: rateLimitHeaders(limited) },
  );
}
