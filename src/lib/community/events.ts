/**
 * Community v2 — room broadcast events (edits + deletions).
 *
 * WHY broadcasts: Supabase Realtime applies RLS to the postgres stream — an
 * UPDATE/DELETE event is only streamed to users who have that policy on the
 * row. The owner-only edit/delete policies therefore stream the event ONLY
 * to the actor. The actor additionally broadcasts the change on the room
 * channel so every other member sees the edit/removal in real time.
 *
 * Pure/isomorphic: payload parsing is unit-testable (untrusted wire data —
 * every field is validated, malformed payloads are dropped, never applied).
 */

import type { CommunityMessage } from "../community";

export const MESSAGE_UPDATE_BROADCAST_EVENT = "community_message_update";
export const MESSAGE_DELETE_BROADCAST_EVENT = "community_message_delete";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Wire payload: the actor's own edited row (the actor can read it). */
export interface MessageUpdateBroadcast {
  roomId: string;
  message: CommunityMessage;
}

export function parseMessageUpdateBroadcast(
  raw: unknown,
): MessageUpdateBroadcast | null {
  if (!isRecord(raw)) return null;
  const roomId = typeof raw.roomId === "string" ? raw.roomId.trim() : "";
  const m = isRecord(raw.message) ? raw.message : null;
  if (!roomId || !UUID.test(roomId) || !m) return null;
  const id = typeof m.id === "string" ? m.id : "";
  const userId = typeof m.user_id === "string" ? m.user_id : "";
  const message = typeof m.message === "string" ? m.message : null;
  const createdAt = typeof m.created_at === "string" ? m.created_at : "";
  const updatedAt = typeof m.updated_at === "string" ? m.updated_at : "";
  if (!UUID.test(id) || !UUID.test(userId) || !createdAt || !updatedAt) {
    return null;
  }
  const replyTo =
    typeof m.reply_to_message_id === "string" && UUID.test(m.reply_to_message_id)
      ? m.reply_to_message_id
      : null;
  return {
    roomId,
    message: {
      id,
      user_id: userId,
      room_id: roomId,
      message,
      image_path: typeof m.image_path === "string" ? m.image_path : null,
      reply_to_message_id: replyTo,
      created_at: createdAt,
      updated_at: updatedAt,
    },
  };
}

export interface MessageDeleteBroadcast {
  roomId: string;
  id: string;
}

export function parseMessageDeleteBroadcast(raw: unknown): MessageDeleteBroadcast | null {
  if (!isRecord(raw)) return null;
  const roomId = typeof raw.roomId === "string" ? raw.roomId.trim() : "";
  const id = typeof raw.id === "string" ? raw.id : "";
  if (!UUID.test(roomId) || !UUID.test(id)) return null;
  return { roomId, id };
}

// ---------------------------------------------------------------------------
// Phase 2 — DM broadcast events (edits + deletions), same RLS rationale as
// the room events: the postgres stream only reaches the actor, so the actor
// re-broadcasts on the CONVERSATION channel for the peer.
// ---------------------------------------------------------------------------

export const DM_MESSAGE_UPDATE_BROADCAST_EVENT = "community_dm_message_update";
export const DM_MESSAGE_DELETE_BROADCAST_EVENT = "community_dm_message_delete";

export interface DmMessageUpdateBroadcast {
  conversationId: string;
  message: {
    id: string;
    user_id: string;
    message: string | null;
    image_path: string | null;
    reply_to_message_id: string | null;
    created_at: string;
    updated_at: string;
  };
}

export function parseDmMessageUpdateBroadcast(
  raw: unknown,
): DmMessageUpdateBroadcast | null {
  if (!isRecord(raw)) return null;
  const conversationId =
    typeof raw.conversationId === "string" ? raw.conversationId.trim() : "";
  const m = isRecord(raw.message) ? raw.message : null;
  if (!conversationId || !UUID.test(conversationId) || !m) return null;
  const id = typeof m.id === "string" ? m.id : "";
  const userId = typeof m.user_id === "string" ? m.user_id : "";
  const createdAt = typeof m.created_at === "string" ? m.created_at : "";
  const updatedAt = typeof m.updated_at === "string" ? m.updated_at : "";
  if (!UUID.test(id) || !UUID.test(userId) || !createdAt || !updatedAt) {
    return null;
  }
  return {
    conversationId,
    message: {
      id,
      user_id: userId,
      message: typeof m.message === "string" ? m.message : null,
      image_path: typeof m.image_path === "string" ? m.image_path : null,
      reply_to_message_id:
        typeof m.reply_to_message_id === "string" && UUID.test(m.reply_to_message_id)
          ? m.reply_to_message_id
          : null,
      created_at: createdAt,
      updated_at: updatedAt,
    },
  };
}

export interface DmMessageDeleteBroadcast {
  conversationId: string;
  id: string;
}

export function parseDmMessageDeleteBroadcast(raw: unknown): DmMessageDeleteBroadcast | null {
  if (!isRecord(raw)) return null;
  const conversationId =
    typeof raw.conversationId === "string" ? raw.conversationId.trim() : "";
  const id = typeof raw.id === "string" ? raw.id : "";
  if (!UUID.test(conversationId) || !UUID.test(id)) return null;
  return { conversationId, id };
}

// ---------------------------------------------------------------------------
// Phase 5 — pin broadcasts (same RLS rationale: the pin rows are written
// with the ADMIN client, so NO postgres stream reaches the members; the
// moderator's client re-broadcasts on the ROOM channel after the action).
// The payload is METADATA ONLY (ids) — no content crosses the wire.
// ---------------------------------------------------------------------------

export const PIN_BROADCAST_EVENT = "community_pin";
export const PIN_REMOVE_BROADCAST_EVENT = "community_pin_removed";

export interface PinBroadcast {
  roomId: string;
  messageId: string;
}

export function parsePinBroadcast(raw: unknown): PinBroadcast | null {
  if (!isRecord(raw)) return null;
  const roomId = typeof raw.roomId === "string" ? raw.roomId.trim() : "";
  const messageId = typeof raw.messageId === "string" ? raw.messageId.trim() : "";
  if (!UUID.test(roomId) || !UUID.test(messageId)) return null;
  return { roomId, messageId };
}

export interface PinRemoveBroadcast {
  roomId: string;
  messageId: string;
}

export function parsePinRemoveBroadcast(raw: unknown): PinRemoveBroadcast | null {
  if (!isRecord(raw)) return null;
  const roomId = typeof raw.roomId === "string" ? raw.roomId.trim() : "";
  const messageId = typeof raw.messageId === "string" ? raw.messageId.trim() : "";
  if (!UUID.test(roomId) || !UUID.test(messageId)) return null;
  return { roomId, messageId };
}
