import { NextResponse } from "next/server";
import { getCurrentUserAndProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import {
  checkRateLimit,
  rateLimitHeaders,
  tooManyRequests,
} from "@/lib/rate-limit";
import {
  COMMUNITY_REACTION_EMOJIS,
  type CommunityMessageReactionAgg,
} from "@/lib/community";
import { aggregateReactions } from "@/lib/community/rooms";
import { createSocialNotification, socialSendKey } from "@/lib/community/social";

/**
 * POST /api/community/messages/:id/reactions {emoji} — TOGGLE one reaction
 * (add if the viewer has none, remove if they do).
 *
 * RLS: select all members (reactions are visible on visible messages),
 * insert/delete only the caller's OWN reaction row — a user can never
 * react or un-react on someone else's behalf.
 *
 * Returns the message's full aggregated reaction list, so the client stays
 * authoritative without a second fetch.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { user } = await getCurrentUserAndProfile();
  if (!user)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const limited = await checkRateLimit("community_react", user.id);
  if (!limited.allowed) return tooManyRequests(limited);

  const { id } = await context.params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  let body: { emoji?: unknown };
  try {
    body = (await request.json()) as { emoji?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  const emoji =
    typeof body.emoji === "string" &&
    (COMMUNITY_REACTION_EMOJIS as readonly string[]).includes(body.emoji)
      ? body.emoji
      : null;
  if (!emoji) {
    return NextResponse.json({ error: "reaction_invalid" }, { status: 400 });
  }

  const supabase = await createClient();

  // The message must exist and be readable by this member (RLS select all).
  const { data: message, error: messageError } = await supabase
    .from("community_messages")
    .select("id,user_id,room_id")
    .eq("id", id)
    .maybeSingle();
  if (messageError)
    return NextResponse.json({ error: "Could not load message." }, { status: 500 });
  if (!message)
    return NextResponse.json({ error: "message_not_found" }, { status: 404 });
  const msg = message as { id: string; user_id: string; room_id: string };

  // Toggle: read MY row for this (message, emoji), then insert or delete it.
  const { data: mine } = await supabase
    .from("community_message_reactions")
    .select("emoji")
    .eq("message_id", id)
    .eq("user_id", user.id)
    .eq("emoji", emoji)
    .maybeSingle();

  if (mine) {
    const { error: removeError } = await supabase
      .from("community_message_reactions")
      .delete()
      .eq("message_id", id)
      .eq("user_id", user.id)
      .eq("emoji", emoji);
    if (removeError)
      return NextResponse.json({ error: "Could not update reaction." }, { status: 500 });
  } else {
    const { error: addError } = await supabase
      .from("community_message_reactions")
      .insert({ message_id: id, user_id: user.id, emoji });
    if (addError)
      return NextResponse.json({ error: "Could not update reaction." }, { status: 500 });
    // Phase 3: ADDING a reaction notifies the message's author (never the
    // actor; removing/retoggling does not re-notify — one notification per
    // (actor, emoji, message) lifetime via the idempotency key).
    if (msg.user_id !== user.id) {
      void createSocialNotification({
        targetUserId: msg.user_id,
        actorUserId: user.id,
        title: "reaction",
        content: "",
        roomId: msg.room_id,
        roomMessageId: id,
        reactionEmoji: emoji,
        sendKey: socialSendKey(`reaction:${user.id}:${emoji}`, id),
      });
    }
  }

  const { data: rows, error: listError } = await supabase
    .from("community_message_reactions")
    .select("message_id,emoji,user_id")
    .eq("message_id", id);
  if (listError)
    return NextResponse.json({ error: "Could not load reactions." }, { status: 500 });

  const reactions: CommunityMessageReactionAgg[] =
    aggregateReactions(
      (rows ?? []) as Array<{ message_id: string; emoji: string; user_id: string }>,
      user.id,
    )[id] ?? [];

  return NextResponse.json(
    { reactions },
    { headers: rateLimitHeaders(limited) },
  );
}
