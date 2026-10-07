import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import type { CommunityAuthor, CommunityMessage } from "@/lib/community";
import type { CommunityRole } from "@/lib/community/roles";
import { isModerator } from "@/lib/community/roles";

/**
 * Community Phase 5 — pinned messages.
 *
 *   * READS: session client (RLS: pins of enabled rooms only) + one batch
 *     query for the pinned messages + their authors (no N+1).
 *   * WRITES: ADMIN client, moderator+ only (re-resolved server-side),
 *     audited in community_moderation_actions. The DB has NO user write
 *     policies on community_pins and a UNIQUE constraint keeps a message
 *     pinned at most once.
 */

type SessionClient = Awaited<ReturnType<typeof createClient>>;

export interface PinnedMessage {
  pinId: string;
  pinnedAt: string;
  pinnedBy: CommunityAuthor | null;
  message: CommunityMessage;
}

/** The room's pins, newest pin first (bounded to 20). Never throws. */
export async function fetchRoomPins(
  supabase: SessionClient,
  roomId: string,
  me: { id: string; displayName: string; avatarId: string },
): Promise<PinnedMessage[]> {
  try {
    const { data: pinRows, error } = await supabase
      .from("community_pins")
      .select("id,message_id,pinned_by,created_at")
      .eq("room_id", roomId)
      .order("created_at", { ascending: false })
      .limit(20);
    if (error || !pinRows || pinRows.length === 0) return [];
    const pins = pinRows as Array<{
      id: string;
      message_id: string;
      pinned_by: string;
      created_at: string;
    }>;
    const messageIds = pins.map((p) => p.message_id);
    const pinners = [...new Set(pins.map((p) => p.pinned_by))];
    const [messagesRes, pinnersRes] = await Promise.all([
      supabase
        .from("community_messages")
        .select("id,user_id,room_id,message,image_path,reply_to_message_id,created_at,updated_at")
        .in("id", messageIds),
      supabase
        .from("community_profiles")
        .select("user_id,display_name,avatar_id")
        .in("user_id", pinners),
    ]);
    const messageMap = new Map(
      ((messagesRes.data ?? []) as CommunityMessage[]).map((m) => [m.id, m]),
    );
    const authorMap: Record<string, CommunityAuthor> = {};
    for (const a of (pinnersRes.data ?? []) as CommunityAuthor[]) authorMap[a.user_id] = a;
    if (pinners.includes(me.id)) {
      authorMap[me.id] = {
        user_id: me.id,
        display_name: me.displayName,
        avatar_id: me.avatarId,
      };
    }
    const out: PinnedMessage[] = [];
    for (const pin of pins) {
      const message = messageMap.get(pin.message_id);
      if (!message) continue;
      out.push({
        pinId: pin.id,
        pinnedAt: pin.created_at,
        pinnedBy: authorMap[pin.pinned_by] ?? null,
        message,
      });
    }
    return out;
  } catch (error) {
    console.error("[community] fetch pins threw:", error);
    return [];
  }
}

export type PinError = "forbidden" | "not_found" | "already_pinned" | "failed";

/** Pin a message (moderator+, audited). The message must live in the room. */
export async function pinMessage(input: {
  actorUserId: string;
  actorRole: CommunityRole;
  roomId: string;
  messageId: string;
}): Promise<{ ok: true } | { ok: false; error: PinError }> {
  const { actorUserId, actorRole, roomId, messageId } = input;
  if (!isModerator(actorRole)) return { ok: false, error: "forbidden" };
  try {
    const admin = createAdminClient();
    const { data: msg, error: msgErr } = await admin
      .from("community_messages")
      .select("id,room_id,user_id,message,image_path,reply_to_message_id,created_at,updated_at")
      .eq("id", messageId)
      .maybeSingle();
    if (msgErr || !msg || (msg as { room_id: string }).room_id !== roomId) {
      return { ok: false, error: "not_found" };
    }
    const { data: existing, error: dupErr } = await admin
      .from("community_pins")
      .select("id")
      .eq("message_id", messageId)
      .maybeSingle();
    if (dupErr) return { ok: false, error: "failed" };
    if (existing) return { ok: false, error: "already_pinned" };

    const { error } = await admin.from("community_pins").insert({
      room_id: roomId,
      message_id: messageId,
      pinned_by: actorUserId,
    });
    if (error) {
      // 23505 = the unique constraint raced us — treat as already pinned.
      if ((error as { code?: string }).code === "23505") {
        return { ok: false, error: "already_pinned" };
      }
      return { ok: false, error: "failed" };
    }
    try {
      await admin.from("community_moderation_actions").insert({
        moderator_id: actorUserId,
        action: "pin",
        target_type: "message",
        target_id: messageId,
      });
    } catch {
      /* audit is best-effort */
    }
    return { ok: true };
  } catch (error) {
    console.error("[community] pin threw:", error);
    return { ok: false, error: "failed" };
  }
}

/** Unpin a message (moderator+, audited). Idempotent: missing pin = ok. */
export async function unpinMessage(input: {
  actorUserId: string;
  actorRole: CommunityRole;
  roomId: string;
  messageId: string;
}): Promise<{ ok: true } | { ok: false; error: PinError }> {
  const { actorUserId, actorRole, roomId, messageId } = input;
  if (!isModerator(actorRole)) return { ok: false, error: "forbidden" };
  try {
    const admin = createAdminClient();
    const { error } = await admin
      .from("community_pins")
      .delete()
      .eq("room_id", roomId)
      .eq("message_id", messageId);
    if (error) return { ok: false, error: "failed" };
    try {
      await admin.from("community_moderation_actions").insert({
        moderator_id: actorUserId,
        action: "unpin",
        target_type: "message",
        target_id: messageId,
      });
    } catch {
      /* audit is best-effort */
    }
    return { ok: true };
  } catch (error) {
    console.error("[community] unpin threw:", error);
    return { ok: false, error: "failed" };
  }
}
