/**
 * Community Phase 2 — the friendship/relationship state machine (PURE).
 *
 * One row in `community_friendships` (canonical, one per unordered pair) +
 * two possible `community_blocks` rows fully describe the relationship from
 * the viewer's point of view. This module derives the STATE and the ALLOWED
 * ACTIONS from that triple — the UI renders from it, and the server API
 * consults the same rules (a single source of truth for the state machine).
 *
 * States (viewer perspective):
 *   none              — no friendship, no blocks in either direction
 *   outgoing_pending  — I sent a request, not answered yet
 *   incoming_pending  — they sent me a request
 *   friends           — request accepted
 *   blocked_by_me     — I blocked them (friendship, if any, is suspended)
 *   blocks_me         — they blocked me
 */

export type RelationshipState =
  | "none"
  | "outgoing_pending"
  | "incoming_pending"
  | "friends"
  | "blocked_by_me"
  | "blocks_me";

export type SocialAction =
  | "send_request"
  | "cancel_request"
  | "accept_request"
  | "decline_request"
  | "remove_friend"
  | "block"
  | "unblock"
  | "message";

export interface FriendshipRowLike {
  requester_id: string;
  requestee_id: string;
  status: "pending" | "accepted";
}

/**
 * Derive the viewer's state. `me` is the viewer's user id (from the session,
 * never the client). Blocks outrank everything: a blocked relationship
 * suspends friendship UI-wise and forbids every outgoing social action.
 */
export function deriveRelationship(
  me: string,
  friendship: FriendshipRowLike | null,
  blockedByMe: boolean,
  blocksMe: boolean,
): RelationshipState {
  if (blockedByMe) return "blocked_by_me";
  if (blocksMe) return "blocks_me";
  if (friendship) {
    if (friendship.status === "accepted") return "friends";
    return friendship.requester_id === me
      ? "outgoing_pending"
      : "incoming_pending";
  }
  return "none";
}

/** What the viewer may do in each state (drives the profile-card buttons). */
export function allowedActions(state: RelationshipState): SocialAction[] {
  switch (state) {
    case "none":
      // No "message" here — DMs require an ACCEPTED friendship (server-
      // enforced; the card must not offer it before a request is accepted).
      return ["send_request", "block"];
    case "outgoing_pending":
      return ["cancel_request", "block"];
    case "incoming_pending":
      return ["accept_request", "decline_request", "block"];
    case "friends":
      return ["remove_friend", "block", "message"];
    case "blocked_by_me":
      return ["unblock"];
    case "blocks_me":
      // The other side may unblock; I can only block back or do nothing.
      return ["block"];
  }
}

/**
 * The GATE for direct messages (used by the UI AND re-checked server-side
 * for every DM write): only ACCEPTED friends, with no active block in
 * EITHER direction, may message each other.
 */
export function canDirectMessage(state: RelationshipState): boolean {
  return state === "friends";
}

/** The other member of the canonical pair (for "who is this row about"). */
export function otherUserId(
  me: string,
  friendship: FriendshipRowLike,
): string {
  return friendship.requester_id === me
    ? friendship.requestee_id
    : friendship.requester_id;
}
