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
  COMMUNITY_DEFAULT_ROOM_SLUG,
  COMMUNITY_MAX_MESSAGE_LENGTH,
  extractMentionUsernames,
  validateCommunityImage,
} from "@/lib/community";
import {
  fetchRoomBySlug,
  fetchRoomMessagePage,
  persistMentions,
} from "@/lib/community/rooms";
import { createSocialNotification, notifyMentions, socialSendKey } from "@/lib/community/social";
import { fetchCommunityWriteGate } from "@/lib/community/roles";
import { checkCommunityImageQuota } from "@/lib/community/image-quota";

/**
 * Community v2 — room-scoped message API.
 *
 * GET  — one room's newest page (optionally older than `before_at`), enriched
 *        with authors, reactions and reply-to previews (fixed batch queries,
 *        no N+1). `?room=<slug>` selects the room (default: public-chat).
 * POST — create a message in a room (multipart/form-data: `message` text
 *        and/or `image` file, optional `room` slug, optional `reply_to`
 *        message id, optional client `id` for idempotent retries).
 *
 * The sender's identity ALWAYS comes from the authenticated session; RLS
 * makes impersonation fail at the database level as well.
 *
 * Images: only image/jpeg|png|webp, ≤ 2 MB, re-validated server-side from
 * the actual bytes (MIME allowlist + magic bytes). Storage paths are
 * generated server-side as {user_id}/{message_id}/image.{ext}.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(request: Request) {
  const { user } = await getCurrentUserAndProfile();
  if (!user)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const limited = await checkRateLimit("community_history", user.id);
  if (!limited.allowed) return tooManyRequests(limited);

  const url = new URL(request.url);
  const roomSlug = url.searchParams.get("room") ?? COMMUNITY_DEFAULT_ROOM_SLUG;
  const beforeAt = url.searchParams.get("before_at");
  if (beforeAt && Number.isNaN(Date.parse(beforeAt))) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const supabase = await createClient();
  const { room, unavailable } = await fetchRoomBySlug(supabase, roomSlug);
  if (unavailable)
    return NextResponse.json({ error: "Could not load room." }, { status: 500 });
  if (!room)
    return NextResponse.json({ error: "room_not_found" }, { status: 404 });

  const page = await fetchRoomMessagePage(supabase, room.id, user.id, {
    beforeAt,
  });
  if (page.unavailable)
    return NextResponse.json({ error: "Could not load messages." }, { status: 500 });

  return NextResponse.json(
    { room, items: page.messages },
    { headers: rateLimitHeaders(limited) },
  );
}

export async function POST(request: Request) {
  const { user } = await getCurrentUserAndProfile();
  if (!user)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const limited = await checkRateLimit("community_message", user.id);
  if (!limited.allowed) return tooManyRequests(limited);

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const rawText = form.get("message");
  const text = typeof rawText === "string" ? rawText.trim() : "";
  if (text.length > COMMUNITY_MAX_MESSAGE_LENGTH) {
    return NextResponse.json({ error: "text_too_long" }, { status: 400 });
  }

  const file = form.get("image");
  // A message needs at least one of: text or image.
  if (!text && !(file instanceof File)) {
    return NextResponse.json({ error: "empty_message" }, { status: 400 });
  }

  const supabase = await createClient();

  // Senders must have completed the community onboarding (profile exists).
  const { data: profile } = await supabase
    .from("community_profiles")
    .select("id,display_name")
    .eq("user_id", user.id)
    .maybeSingle();
  if (!profile) {
    return NextResponse.json({ error: "profile_required" }, { status: 409 });
  }

  // Phase 5 moderation gate: suspended / timed-out users cannot post
  // (server-stamped flags; the client can never set them).
  const gate = await fetchCommunityWriteGate(user.id);
  if (!gate.writable) {
    return NextResponse.json({ error: gate.code }, { status: 403 });
  }

  // Target room (slug from the client — resolved server-side; unknown or
  // disabled rooms are rejected, so a room id can never be smuggled in).
  const rawRoom = form.get("room");
  const roomSlug =
    typeof rawRoom === "string" && rawRoom.trim().length > 0
      ? rawRoom.trim().toLowerCase()
      : COMMUNITY_DEFAULT_ROOM_SLUG;
  const { room, unavailable: roomUnavailable } = await fetchRoomBySlug(
    supabase,
    roomSlug,
  );
  if (roomUnavailable)
    return NextResponse.json({ error: "Could not load room." }, { status: 500 });
  if (!room)
    return NextResponse.json({ error: "room_not_found" }, { status: 404 });

  // Optional reply target: must exist and live in the SAME room.
  const rawReply = form.get("reply_to");
  const replyToMessageId =
    typeof rawReply === "string" && UUID.test(rawReply) ? rawReply : null;
  let replyParentUserId: string | null = null;
  if (replyToMessageId) {
    const { data: parent } = await supabase
      .from("community_messages")
      .select("id,room_id,user_id")
      .eq("id", replyToMessageId)
      .maybeSingle();
    if (!parent || (parent as { room_id: string }).room_id !== room.id) {
      return NextResponse.json({ error: "Invalid request." }, { status: 400 });
    }
    replyParentUserId = (parent as { user_id: string }).user_id;
  }

  // Idempotency: the client MAY supply its own UUID so that a retry after a
  // lost response reuses the SAME row instead of creating a duplicate. The
  // id is validated as a UUID and only ever becomes THIS session user's own
  // row (the RLS insert policy enforces user_id = auth.uid()).
  const rawId = form.get("id");
  const clientMessageId =
    typeof rawId === "string" && UUID.test(rawId) ? rawId : null;

  if (clientMessageId) {
    const { data: existing } = await supabase
      .from("community_messages")
      .select(
        "id,user_id,room_id,message,image_path,reply_to_message_id,created_at,updated_at",
      )
      .eq("id", clientMessageId)
      .maybeSingle();
    if (existing) {
      // Someone else's row: never claimable — reject without echoing it.
      if (existing.user_id !== user.id) {
        return NextResponse.json({ error: "Invalid request." }, { status: 400 });
      }
      // This exact message was already persisted (first attempt succeeded,
      // response lost). Return it — the client flips its optimistic row to
      // "sent" and nothing is duplicated.
      return NextResponse.json(
        { message: existing, duplicate: true },
        { status: 200, headers: rateLimitHeaders(limited) },
      );
    }
  }

  const messageId = clientMessageId ?? crypto.randomUUID();
  let imagePath: string | null = null;

  if (file instanceof File) {
    // Never trust the client-declared type/size/filename: re-validate the
    // actual bytes (size, MIME allowlist, magic bytes).
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
    const path = buildCommunityImagePath(user.id, messageId, verdict.ext);
    if (!path)
      return NextResponse.json({ error: "Invalid request." }, { status: 400 });
    const { error: uploadError } = await supabase.storage
      .from("community-images")
      .upload(path, new Blob([bytes], { type: file.type }), {
        contentType: file.type,
        upsert: false,
        cacheControl: "31536000",
      });
    if (uploadError) {
      // Storage re-enforces the 2 MB bucket limit and the MIME allowlist.
      const tooBig = /limit/i.test(uploadError.message ?? "");
      return NextResponse.json(
        { error: tooBig ? "image_too_large" : "invalid_image" },
        { status: tooBig ? 413 : 415 },
      );
    }
    imagePath = path;
  }

  const { data: row, error } = await supabase
    .from("community_messages")
    .insert({
      id: messageId,
      // Always the session user — a user_id sent in the form body is ignored.
      user_id: user.id,
      room_id: room.id,
      message: text || null,
      image_path: imagePath,
      reply_to_message_id: replyToMessageId,
    })
    .select(
      "id,user_id,room_id,message,image_path,reply_to_message_id,created_at,updated_at",
    )
    .single();
  if (error) {
    // 23505 = primary-key violation: a concurrent retry (two tabs, or the
    // pre-check raced another request) already created this exact row.
    // Idempotent success — return it instead of failing the retry.
    if ((error as { code?: string }).code === "23505") {
      const { data: existing } = await supabase
        .from("community_messages")
        .select(
          "id,user_id,room_id,message,image_path,reply_to_message_id,created_at,updated_at",
        )
        .eq("id", messageId)
        .maybeSingle();
      if (existing) {
        return NextResponse.json(
          { message: existing, duplicate: true },
          { status: 200, headers: rateLimitHeaders(limited) },
        );
      }
    }
    return NextResponse.json({ error: "Could not send message." }, { status: 500 });
  }

  // Mentions: resolve @-tokens to members and persist the mention rows
  // (service role — members have no insert policy). Never blocks the send.
  void persistMentions(messageId, extractMentionUsernames(text));

  // Phase 3: mentioned members get a typed (idempotent, recipient-only)
  // notification. Non-fatal by design.
  void notifyMentions(messageId, extractMentionUsernames(text), {
    actorId: user.id,
    actorName: profile.display_name,
    roomName: room.name,
    roomId: room.id,
  });

  // Phase 3: the reply's PARENT author gets a "replied to you" notification
  // (never yourself; re-checked server-side in createSocialNotification).
  if (replyParentUserId && replyParentUserId !== user.id) {
    void createSocialNotification({
      targetUserId: replyParentUserId,
      actorUserId: user.id,
      title: "reply",
      content: "",
      roomId: room.id,
      roomMessageId: messageId,
      sendKey: socialSendKey(`reply:${replyParentUserId}`, messageId),
    });
  }

  return NextResponse.json(
    { message: row },
    { status: 201, headers: rateLimitHeaders(limited) },
  );
}
