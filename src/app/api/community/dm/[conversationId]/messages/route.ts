import { NextResponse } from "next/server";
import { getCurrentUserAndProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import {
  checkRateLimit,
  rateLimitHeaders,
  tooManyRequests,
} from "@/lib/rate-limit";
import {
  buildDmImagePath,
  COMMUNITY_MAX_IMAGE_BYTES,
  COMMUNITY_MAX_MESSAGE_LENGTH,
  validateCommunityImage,
} from "@/lib/community";
import {
  createSocialNotification,
  loadDmConversation,
  socialSendKey,
} from "@/lib/community/social";
import { fetchCommunityWriteGate } from "@/lib/community/roles";
import { checkCommunityImageQuota } from "@/lib/community/image-quota";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Production diagnostics for DM send failures — the write-side analog of the
 * friend route's `friend_request_failed` line. Structured and SECRET-FREE:
 * step + SQLSTATE + conversationId + the authenticated userId ONLY. The
 * error text is deliberately never logged: on a constraint violation it can
 * embed the failing row's values (the message content). The SQLSTATE is the
 * discriminator: 42501 = the RLS insert policy ("Friends can send direct
 * messages to each other") is not effective, 23514 = check constraint,
 * 23503 = FK, 23505 = duplicate (normally converged, never a failure).
 */
function logDmSendFailure(
  step: string,
  userId: string,
  conversationId: string,
  code: string | null | undefined,
): void {
  console.error(
    `[community] dm_send_failed step=${step} conversation=${conversationId}` +
      ` userId=${userId} code=${code ?? "unknown"}`,
  );
}

/**
 * POST /api/community/dm/:conversationId/messages
 *
 * Send a DM (text and/or image ≤ 2 MB, optional reply).
 *
 * The authorization chain — EVERY step server-side, none of them client
 * hints:
 *   1. active session (author = session user, always),
 *   2. membership of the conversation (RLS also enforces),
 *   3. CURRENTLY accepted friendship (RLS enforces too — the insert policy
 *      re-derives it from the DB),
 *   4. no block in either direction,
 *   5. reply parent exists IN THIS conversation,
 *   6. idempotency: a client UUID is honored (retries reuse it, 23505
 *      converges to the existing row),
 *   7. images: MIME allowlist + magic bytes + 2 MB, path is
 *      dm/{conversation}/{author}/{message}/image.{ext} (storage RLS scopes
 *      it to conversation members).
 *
 * New messages stream in realtime via the postgres INSERT publication
 * (per-conversation channel in the client) — no broadcast needed.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ conversationId: string }> },
) {
  const { user, profile } = await getCurrentUserAndProfile();
  if (!user || !profile || profile.account_status !== "active") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const limited = await checkRateLimit("community_dm_send", user.id);
  if (!limited.allowed) return tooManyRequests(limited);

  const { conversationId } = await params;
  if (!UUID.test(conversationId)) {
    return NextResponse.json({ error: "conversation_not_found" }, { status: 400 });
  }

  // Phase 5 moderation gate: suspended / timed-out users cannot DM.
  const gate = await fetchCommunityWriteGate(user.id);
  if (!gate.writable) {
    return NextResponse.json({ error: gate.code }, { status: 403 });
  }

  const form = await _request.formData().catch(() => null);
  if (!form) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
  const rawText = form.get("message");
  const text = typeof rawText === "string" ? rawText.trim() : "";
  const imageFile = form.get("image");
  const replyTo = form.get("reply_to");
  const clientId = form.get("id");

  if (!text && !(imageFile instanceof File)) {
    return NextResponse.json({ error: "empty_message" }, { status: 400 });
  }
  if (text.length > COMMUNITY_MAX_MESSAGE_LENGTH) {
    return NextResponse.json({ error: "text_too_long" }, { status: 400 });
  }

  // Image gate (client MIME is NEVER trusted — magic bytes decide).
  let imageExt: string | null = null;
  if (imageFile instanceof File) {
    if (imageFile.size > COMMUNITY_MAX_IMAGE_BYTES) {
      return NextResponse.json({ error: "image_too_large" }, { status: 413 });
    }
    const bytes = new Uint8Array(await imageFile.arrayBuffer());
    const check = validateCommunityImage(imageFile.type, bytes);
    if (!check.ok) {
      return NextResponse.json(
        { error: check.code === "image_too_large" ? "image_too_large" : "invalid_image" },
        { status: check.code === "image_too_large" ? 413 : 415 },
      );
    }
    imageExt = check.ext;
  }

  // Phase 6A: per-user storage quota — server-side, BEFORE the upload
  // (a rejected upload must never create a storage object). Placed before
  // the membership checks so an over-quota user fails fast with the exact
  // code instead of a misleading 404/403.
  if (imageFile instanceof File) {
    const quota = await checkCommunityImageQuota(user.id, imageFile.size);
    if (!quota.ok) {
      return NextResponse.json(
        { error: quota.code },
        { status: quota.code === "storage_quota" ? 413 : 500 },
      );
    }
  }

  const supabase = await createClient();

  // (1)+(2) membership.
  const loaded = await loadDmConversation(supabase, user.id, conversationId);
  if (!loaded) {
    return NextResponse.json({ error: "conversation_not_found" }, { status: 404 });
  }
  const { otherId } = loaded;

  // (3) accepted friendship — the RLS insert policy re-derives this, but the
  // API answers with a precise code.
  const friendshipRes = await supabase
    .from("community_friendships")
    .select("id")
    .eq("status", "accepted")
    .or(
      // PostgREST or= syntax: comma = alternatives, AND = composite group.
      `and(requester_id.eq.${user.id},requestee_id.eq.${otherId}),and(requester_id.eq.${otherId},requestee_id.eq.${user.id})`,
    )
    .limit(1);
  if (friendshipRes.error) {
    return NextResponse.json({ error: "Could not send message." }, { status: 500 });
  }
  if ((friendshipRes.data ?? []).length === 0) {
    return NextResponse.json({ error: "not_friends" }, { status: 403 });
  }

  // (4) no block in either direction.
  const blockRes = await supabase
    .from("community_blocks")
    .select("id")
    .or(
      `and(blocker_id.eq.${user.id},blocked_id.eq.${otherId}),and(blocker_id.eq.${otherId},blocked_id.eq.${user.id})`,
    )
    .limit(1);
  if (blockRes.error) {
    return NextResponse.json({ error: "Could not send message." }, { status: 500 });
  }
  if ((blockRes.data ?? []).length > 0) {
    return NextResponse.json({ error: "blocked" }, { status: 403 });
  }

  // (5) reply parent must exist IN THIS conversation.
  let replyToMessageId: string | null = null;
  if (typeof replyTo === "string" && replyTo.length > 0) {
    if (!UUID.test(replyTo)) {
      return NextResponse.json({ error: "invalid_reply" }, { status: 400 });
    }
    const parentRes = await supabase
      .from("community_direct_messages")
      .select("id,conversation_id")
      .eq("id", replyTo)
      .maybeSingle();
    if (parentRes.error) {
      return NextResponse.json({ error: "Could not send message." }, { status: 500 });
    }
    const parent = parentRes.data as
      | { id: string; conversation_id: string }
      | null;
    if (!parent || parent.conversation_id !== conversationId) {
      return NextResponse.json({ error: "invalid_reply" }, { status: 400 });
    }
    replyToMessageId = replyTo;
  }

  // (6) idempotency: honor a client UUID, pre-check for duplicates.
  const messageId =
    typeof clientId === "string" && UUID.test(clientId)
      ? clientId
      : crypto.randomUUID();

  const existingRes = await supabase
    .from("community_direct_messages")
    .select("id,user_id,message,image_path,reply_to_message_id,created_at,updated_at")
    .eq("id", messageId)
    .maybeSingle();
  if (existingRes.error) {
    return NextResponse.json({ error: "Could not send message." }, { status: 500 });
  }
  const existing = existingRes.data as
    | { id: string; user_id: string; message: string | null; image_path: string | null; reply_to_message_id: string | null; created_at: string; updated_at: string }
    | null;
  if (existing) {
    if (existing.user_id !== user.id) {
      // A foreign row with this id: never claim it, never echo it.
      return NextResponse.json({ error: "id_conflict" }, { status: 400 });
    }
    return NextResponse.json(
      { message: existing, duplicate: true },
      { status: 200, headers: rateLimitHeaders(limited) },
    );
  }

  // (7) image upload to the DM owner folder.
  let imagePath: string | null = null;
  if (imageFile instanceof File && imageExt) {
    const path = buildDmImagePath(conversationId, user.id, messageId, imageExt);
    if (!path) {
      return NextResponse.json({ error: "invalid_image" }, { status: 415 });
    }
    const { error: uploadError } = await supabase.storage
      .from("community-images")
      .upload(path, imageFile, {
        contentType: imageFile.type,
        upsert: false,
      });
    if (uploadError) {
      const status = /size/i.test(uploadError.message) ? 413 : 415;
      console.error("[community] dm image upload failed:", uploadError.message);
      return NextResponse.json(
        { error: status === 413 ? "image_too_large" : "invalid_image" },
        { status },
      );
    }
    imagePath = path;
  }

  const { data: inserted, error: insertError } = await supabase
    .from("community_direct_messages")
    .insert({
      id: messageId,
      conversation_id: conversationId,
      user_id: user.id,
      message: text || null,
      image_path: imagePath,
      reply_to_message_id: replyToMessageId,
    })
    .select("id,user_id,message,image_path,reply_to_message_id,created_at,updated_at")
    .single();
  if (insertError) {
    if (insertError.code === "23505") {
      const retry = await supabase
        .from("community_direct_messages")
        .select("id,user_id,message,image_path,reply_to_message_id,created_at,updated_at")
        .eq("id", messageId)
        .maybeSingle();
      if (!retry.error && retry.data && (retry.data as { user_id: string }).user_id === user.id) {
        return NextResponse.json(
          { message: retry.data, duplicate: true },
          { status: 200, headers: rateLimitHeaders(limited) },
        );
      }
      // The collision was real but the existing row is not readable/claimable
      // — log it (normally impossible: the row's author is the session user).
      logDmSendFailure("duplicate_recover", user.id, conversationId, retry.error?.code);
    }
    // THE production discriminator for DM sends: 42501 = the RLS insert
    // policy is not effective on this database, 23514 = check constraint,
    // 23503 = FK. No message text is logged (see logDmSendFailure).
    logDmSendFailure("insert", user.id, conversationId, insertError.code);
    return NextResponse.json({ error: "Could not send message." }, { status: 500 });
  }
  const row = inserted as {
    id: string;
    user_id: string;
    message: string | null;
    image_path: string | null;
    reply_to_message_id: string | null;
    created_at: string;
    updated_at: string;
  };

  // Phase 3: the peer gets a typed direct_message notification (idempotent
  // by message id). In a 1:1 conversation every message is a "reply" in the
  // conversational sense, so this single kind covers Step 18 with zero
  // duplication. The text is rendered client-side per viewer language from
  // type + actor (no stored translation). If the peer is actively viewing
  // the conversation, their client marks these read in the same flow as the
  // realtime message — no badge inflation, no toast.
  void createSocialNotification({
    targetUserId: otherId,
    actorUserId: user.id,
    title: "direct_message",
    content: "",
    conversationId,
    dmMessageId: row.id,
    sendKey: socialSendKey("dm", row.id),
  });

  return NextResponse.json(
    { message: row },
    { status: 201, headers: rateLimitHeaders(limited) },
  );
}
