import { NextResponse } from "next/server";
import { getCurrentUserAndProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import {
  checkRateLimit,
  rateLimitHeaders,
  tooManyRequests,
} from "@/lib/rate-limit";
import {
  COMMUNITY_MAX_MESSAGE_LENGTH,
  extractMentionUsernames,
} from "@/lib/community";
import { replaceMentions } from "@/lib/community/rooms";
import { fetchCommunityWriteGate } from "@/lib/community/roles";

/**
 * Community v2 — edit / delete ONE of the caller's own messages.
 *
 * PATCH {message: string} — edit the text (RLS update policy: own rows only;
 *                           the room, reply target and image are immutable).
 * DELETE                  — remove the message (RLS delete policy: own rows
 *                           only) and clean up the uploaded image file.
 *
 * Both are rate-limited per user; moderation delete (Phase 4) is a
 * service-role path and does not go through here.
 */

const MESSAGE_SELECT =
  "id,user_id,room_id,message,image_path,reply_to_message_id,created_at,updated_at";

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { user } = await getCurrentUserAndProfile();
  if (!user)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const limited = await checkRateLimit("community_edit", user.id);
  if (!limited.allowed) return tooManyRequests(limited);

  // Phase 10: platform ban — banned users make no community mutations.
  const gate = await fetchCommunityWriteGate(user.id);
  if (!gate.writable) return NextResponse.json({ error: gate.code }, { status: 403 });

  const { id } = await context.params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  let body: { message?: unknown };
  try {
    body = (await request.json()) as { message?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  const text = typeof body.message === "string" ? body.message.trim() : "";
  if (text.length === 0 || text.length > COMMUNITY_MAX_MESSAGE_LENGTH) {
    return NextResponse.json(
      { error: text.length === 0 ? "empty_message" : "text_too_long" },
      { status: 400 },
    );
  }

  const supabase = await createClient();

  // RLS (update policy) is the authorization: a non-own row is invisible to
  // this UPDATE and comes back as zero rows.
  const { data: row, error } = await supabase
    .from("community_messages")
    .update({ message: text })
    .eq("id", id)
    .eq("user_id", user.id)
    .select(MESSAGE_SELECT)
    .maybeSingle();
  if (error) {
    return NextResponse.json({ error: "Could not edit message." }, { status: 500 });
  }
  if (!row) {
    return NextResponse.json({ error: "message_not_found" }, { status: 404 });
  }

  // Mention rows follow the NEW text (service role — members have no write
  // policy). Never blocks the edit response.
  void replaceMentions(id, extractMentionUsernames(text));

  return NextResponse.json(
    { message: row },
    { headers: rateLimitHeaders(limited) },
  );
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { user } = await getCurrentUserAndProfile();
  if (!user)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const limited = await checkRateLimit("community_delete", user.id);
  if (!limited.allowed) return tooManyRequests(limited);

  // Phase 10: platform ban — banned users make no community mutations.
  const gate = await fetchCommunityWriteGate(user.id);
  if (!gate.writable) return NextResponse.json({ error: gate.code }, { status: 403 });

  const { id } = await context.params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const supabase = await createClient();

  // First learn what the row holds (image path) — then delete it. RLS
  // (select all + delete own) keeps this to the caller's own messages.
  const { data: existing, error: readError } = await supabase
    .from("community_messages")
    .select(MESSAGE_SELECT)
    .eq("id", id)
    .eq("user_id", user.id)
    .maybeSingle();
  if (readError) {
    return NextResponse.json({ error: "Could not load message." }, { status: 500 });
  }
  if (!existing) {
    return NextResponse.json({ error: "message_not_found" }, { status: 404 });
  }

  const { error: deleteError } = await supabase
    .from("community_messages")
    .delete()
    .eq("id", id)
    .eq("user_id", user.id);
  if (deleteError) {
    return NextResponse.json({ error: "Could not delete message." }, { status: 500 });
  }

  // Clean up the uploaded image (owner-based storage delete policy). Best
  // effort: the message is already gone, a leftover file is only dust.
  if (existing.image_path) {
    try {
      await supabase.storage.from("community-images").remove([existing.image_path]);
    } catch (error) {
      console.error("[community] image cleanup failed:", error);
    }
  }

  return NextResponse.json(
    { ok: true },
    { headers: rateLimitHeaders(limited) },
  );
}
