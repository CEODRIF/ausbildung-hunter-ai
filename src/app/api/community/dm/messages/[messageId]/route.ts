import { NextResponse } from "next/server";
import { getCurrentUserAndProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import {
  checkRateLimit,
  rateLimitHeaders,
  tooManyRequests,
} from "@/lib/rate-limit";
import { COMMUNITY_MAX_MESSAGE_LENGTH } from "@/lib/community";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface DmRow {
  id: string;
  conversation_id: string;
  user_id: string;
  message: string | null;
  image_path: string | null;
  reply_to_message_id: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * PATCH /api/community/dm/messages/:id — edit OWN text.
 *
 * Scope chain: the row must exist (RLS already limits the read to
 * conversations the viewer belongs to), the UPDATE is double-scoped
 * (id + user_id = session), and an image-only message can never gain or
 * lose its image through this path (image_path is immutable after send).
 * The client re-broadcasts the edit on the conversation channel (postgres
 * UPDATE events only reach the actor — same rationale as room edits).
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ messageId: string }> },
) {
  const { user, profile } = await getCurrentUserAndProfile();
  if (!user || !profile || profile.account_status !== "active") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const limited = await checkRateLimit("community_dm_edit", user.id);
  if (!limited.allowed) return tooManyRequests(limited);

  const id = (await params).messageId;
  if (!UUID.test(id)) {
    return NextResponse.json({ error: "message_not_found" }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
  const rawMessage = (body as { message?: unknown })?.message;
  if (typeof rawMessage !== "string") {
    return NextResponse.json({ error: "empty_message" }, { status: 400 });
  }
  const text = rawMessage.trim();
  if (text.length === 0) {
    return NextResponse.json({ error: "empty_message" }, { status: 400 });
  }
  if (text.length > COMMUNITY_MAX_MESSAGE_LENGTH) {
    return NextResponse.json({ error: "text_too_long" }, { status: 400 });
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("community_direct_messages")
    .update({ message: text })
    .eq("id", id)
    .eq("user_id", user.id) // session-scoped: only my rows
    .select("id,conversation_id,user_id,message,image_path,reply_to_message_id,created_at,updated_at")
    .maybeSingle();
  if (error) {
    console.error("[community] dm edit failed:", error.message);
    return NextResponse.json({ error: "Could not edit message." }, { status: 500 });
  }
  if (!data) {
    // Not found OR not mine — deliberately the same error (no enumeration).
    return NextResponse.json({ error: "message_not_found" }, { status: 404 });
  }
  return NextResponse.json(
    { message: data as DmRow },
    { status: 200, headers: rateLimitHeaders(limited) },
  );
}

/**
 * DELETE /api/community/dm/messages/:id — delete OWN message.
 *
 * Only the author (session-scoped eq + RLS). The uploaded image is cleaned
 * up best-effort (storage delete is scoped to the author's own dm folder).
 * The client re-broadcasts the deletion on the conversation channel.
 */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ messageId: string }> },
) {
  const { user, profile } = await getCurrentUserAndProfile();
  if (!user || !profile || profile.account_status !== "active") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const limited = await checkRateLimit("community_dm_delete", user.id);
  if (!limited.allowed) return tooManyRequests(limited);

  const id = (await params).messageId;
  if (!UUID.test(id)) {
    return NextResponse.json({ error: "message_not_found" }, { status: 400 });
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("community_direct_messages")
    .delete()
    .eq("id", id)
    .eq("user_id", user.id)
    .select("id,conversation_id,user_id,message,image_path,reply_to_message_id,created_at,updated_at");
  if (error) {
    console.error("[community] dm delete failed:", error.message);
    return NextResponse.json({ error: "Could not delete message." }, { status: 500 });
  }
  if (!data || data.length === 0) {
    return NextResponse.json({ error: "message_not_found" }, { status: 404 });
  }

  // Best-effort image cleanup — a storage hiccup must not fail the delete.
  const imagePath = (data[0] as DmRow).image_path;
  if (imagePath) {
    try {
      await supabase.storage.from("community-images").remove([imagePath]);
    } catch (cleanupError) {
      console.error("[community] dm image cleanup failed:", cleanupError);
    }
  }

  return NextResponse.json(
    { deleted: true },
    { status: 200, headers: rateLimitHeaders(limited) },
  );
}
