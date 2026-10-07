import { NextResponse } from "next/server";
import { getCurrentUserAndProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import {
  checkRateLimit,
  rateLimitHeaders,
  tooManyRequests,
} from "@/lib/rate-limit";
import { COMMUNITY_REACTION_EMOJIS } from "@/lib/community";
import { aggregateReactions } from "@/lib/community/rooms";
import { createSocialNotification, socialSendKey } from "@/lib/community/social";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * POST /api/community/dm/messages/:id/reactions — toggle a reaction.
 *
 * Same toggle semantics as room reactions (insert if absent, delete if
 * mine, then return the fresh aggregated list). Authorization: the message
 * must exist AND the viewer must be a member of its conversation (RLS on
 * community_dm_reactions enforces the same — inserts by non-members fail).
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ messageId: string }> },
) {
  const { user, profile } = await getCurrentUserAndProfile();
  if (!user || !profile || profile.account_status !== "active") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const limited = await checkRateLimit("community_dm_react", user.id);
  if (!limited.allowed) return tooManyRequests(limited);

  const id = (await params).messageId;
  if (!UUID.test(id)) {
    return NextResponse.json({ error: "message_not_found" }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "reaction_invalid" }, { status: 400 });
  }
  const emoji = (body as { emoji?: unknown })?.emoji;
  if (typeof emoji !== "string" || !(COMMUNITY_REACTION_EMOJIS as readonly string[]).includes(emoji)) {
    return NextResponse.json({ error: "reaction_invalid" }, { status: 400 });
  }

  const supabase = await createClient();

  // The message must exist AND belong to a conversation I am in (RLS on the
  // select already limits me to my conversations; a null row = not mine).
  const msgRes = await supabase
    .from("community_direct_messages")
    .select("id,conversation_id,user_id")
    .eq("id", id)
    .maybeSingle();
  if (msgRes.error) {
    return NextResponse.json({ error: "Could not update reaction." }, { status: 500 });
  }
  if (!msgRes.data) {
    return NextResponse.json({ error: "message_not_found" }, { status: 404 });
  }
  const msg = msgRes.data as { id: string; conversation_id: string; user_id: string };

  // Toggle is PER EMOJI (parity with room reactions): read MY row for this
  // (message, emoji) pair, then insert or delete exactly that emoji.
  const mineRes = await supabase
    .from("community_dm_reactions")
    .select("emoji")
    .eq("message_id", id)
    .eq("user_id", user.id)
    .eq("emoji", emoji)
    .maybeSingle();
  if (mineRes.error) {
    return NextResponse.json({ error: "Could not update reaction." }, { status: 500 });
  }
  const mine = mineRes.data as { emoji: string } | null;

  if (mine) {
    const { error: removeError } = await supabase
      .from("community_dm_reactions")
      .delete()
      .eq("message_id", id)
      .eq("user_id", user.id)
      .eq("emoji", mine.emoji);
    if (removeError) {
      console.error("[community] dm unreact failed:", removeError.message);
      return NextResponse.json({ error: "Could not update reaction." }, { status: 500 });
    }
  } else {
    const { error: insertError } = await supabase
      .from("community_dm_reactions")
      .insert({ message_id: id, user_id: user.id, emoji });
    if (insertError) {
      console.error("[community] dm react failed:", insertError.message);
      return NextResponse.json({ error: "Could not update reaction." }, { status: 500 });
    }
    // Phase 3: ADDING a reaction notifies the message's author (never the
    // actor; one notification per (actor, emoji, message) lifetime).
    if (msg.user_id !== user.id) {
      void createSocialNotification({
        targetUserId: msg.user_id,
        actorUserId: user.id,
        title: "reaction",
        content: "",
        conversationId: msg.conversation_id,
        dmMessageId: id,
        reactionEmoji: emoji,
        sendKey: socialSendKey(`dm-reaction:${user.id}:${emoji}`, id),
      });
    }
  }

  const listRes = await supabase
    .from("community_dm_reactions")
    .select("message_id,emoji,user_id")
    .eq("message_id", id);
  if (listRes.error) {
    return NextResponse.json({ error: "Could not update reaction." }, { status: 500 });
  }
  const rows = (listRes.data ?? []) as Array<{
    message_id: string;
    emoji: string;
    user_id: string;
  }>;

  return NextResponse.json(
    { reactions: aggregateReactions(rows, user.id)[id] ?? [] },
    { status: 200, headers: rateLimitHeaders(limited) },
  );
}
