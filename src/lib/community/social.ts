import "server-only";

import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  deriveRelationship,
  otherUserId,
  type FriendshipRowLike,
  type RelationshipState,
} from "@/lib/community/relationship";
import {
  type CommunityAuthor,
  type CommunityReplyPreview,
  type LocalMessage,
} from "@/lib/community";
import { aggregateReactions, resolveMentionedUserIds } from "@/lib/community/rooms";
import {
  mapVisiblePresence,
  PRESENCE_WINDOW_MS,
  type PresenceMode,
  type PresenceState,
} from "@/lib/community/presence";

/**
 * Community Phase 2 — the social data layer (SERVER ONLY).
 *
 * Every fetcher degrades to an explicit `unavailable` flag instead of
 * throwing: the social UI is chrome around the chat, a transient DB issue
 * must never take the page down (same contract as rooms.ts).
 *
 * Presence (Phase 3): the DERIVED state (online / away / dnd / offline) is
 * computed here, on the server, from the stored declared mode + heartbeat
 * freshness — and privacy-mapped per viewer (show_presence = false renders
 * as offline-without-last-seen for everyone but the owner). The ONE shared
 * derivation lives in lib/community/presence.ts; no component re-derives.
 */

/** Re-exported for compatibility (the constant now lives in presence.ts). */
export { PRESENCE_WINDOW_MS };

export interface SocialProfile {
  userId: string;
  displayName: string;
  avatarId: string;
  bio: string | null;
  /** Community join date (ISO). */
  joinedAt: string;
  /** Phase 2 compatibility flag (fresh heartbeat = not offline). */
  online: boolean;
  /** Phase 3: server-computed, privacy-mapped presence state. */
  presence: PresenceState;
  /** Privacy-mapped last seen (null = never seen or hidden). */
  lastSeenAt: string | null;
}

export interface RelationshipView {
  state: RelationshipState;
  /** The friendship row id (present for pending/friends states). */
  friendshipId: string | null;
  other: SocialProfile;
}

export interface DmSummaryRow {
  conversationId: string;
  other: SocialProfile;
  unread: number;
  lastMessageAt: string | null;
  lastMessage: string | null;
  lastMessageIsImage: boolean;
  /** The last message was written by the viewer ("You: …" prefix). */
  lastMessageMine: boolean;
}

interface ProfileRow {
  user_id: string;
  display_name: string;
  avatar_id: string;
  bio: string | null;
  created_at: string;
  last_seen_at: string | null;
  presence_mode: PresenceMode | null;
  show_presence: boolean | null;
}

/**
 * The single SocialProfile mapper — the privacy mapping (show_presence =
 * false → offline without last_seen for everyone but the owner) happens
 * HERE, so no surface can render unmasked presence.
 */
function toSocialProfile(row: ProfileRow, viewerId: string | null = null): SocialProfile {
  const isSelf = viewerId !== null && row.user_id === viewerId;
  const mapped = mapVisiblePresence(row, isSelf);
  return {
    userId: row.user_id,
    displayName: row.display_name,
    avatarId: row.avatar_id,
    bio: row.bio,
    joinedAt: row.created_at,
    online: mapped.state !== "offline",
    presence: mapped.state,
    lastSeenAt: mapped.lastSeenAt,
  };
}

const PROFILE_SELECT =
  "user_id,display_name,avatar_id,bio,created_at,last_seen_at,presence_mode,show_presence";

/**
 * One member's social profile (identity fields + presence; never email or
 * account metadata). Null when the profile is gone — the caller renders a
 * neutral placeholder, and a DB hiccup degrades to the same placeholder.
 */
export async function fetchSocialProfile(
  supabase: SupabaseClient,
  userId: string,
  viewerId: string | null = null,
): Promise<SocialProfile | null> {
  try {
    const { data, error } = await supabase
      .from("community_profiles")
      .select(PROFILE_SELECT)
      .eq("user_id", userId)
      .maybeSingle();
    if (error || !data) {
      if (error) console.error("[community] social profile fetch failed:", error.message);
      return null;
    }
    return toSocialProfile(data as ProfileRow, viewerId);
  } catch (error) {
    console.error("[community] social profile fetch threw:", error);
    return null;
  }
}

/**
 * Load the community profiles for a set of user ids in ONE query (no N+1).
 * Identity fields + bio + presence only — never email or account metadata.
 * The rows stay raw — toSocialProfile(row, viewerId) applies the privacy
 * mapping at the exact point a SocialProfile is produced.
 */
export async function fetchProfiles(
  supabase: SupabaseClient,
  userIds: string[],
): Promise<Map<string, ProfileRow>> {
  const map = new Map<string, ProfileRow>();
  if (userIds.length === 0) return map;
  try {
    const { data, error } = await supabase
      .from("community_profiles")
      .select(PROFILE_SELECT)
      .in("user_id", userIds);
    if (error) throw new Error(error.message);
    for (const row of (data ?? []) as ProfileRow[]) map.set(row.user_id, row);
  } catch (error) {
    console.error("[community] social profile lookup failed:", error);
  }
  return map;
}

interface FriendshipRow {
  id: string;
  requester_id: string;
  requestee_id: string;
  status: "pending" | "accepted";
  status_changed_at: string;
}

/**
 * All of the viewer's friendship + block rows in TWO queries:
 *   community_friendships where I am a participant (any state)
 *   community_blocks where I am blocker OR blocked
 */
async function fetchMySocialRows(
  supabase: SupabaseClient,
  me: string,
): Promise<{
  friendships: Map<string, FriendshipRow>; // key: OTHER user id
  blockedByMe: Set<string>;
  blocksMe: Set<string>;
  unavailable: boolean;
}> {
  const friendships = new Map<string, FriendshipRow>();
  const blockedByMe = new Set<string>();
  const blocksMe = new Set<string>();
  try {
    const [friendRes, blockRes] = await Promise.all([
      supabase
        .from("community_friendships")
        .select("id,requester_id,requestee_id,status,status_changed_at")
        .or(`requester_id.eq.${me},requestee_id.eq.${me}`),
      supabase
        .from("community_blocks")
        .select("blocker_id,blocked_id")
        .or(`blocker_id.eq.${me},blocked_id.eq.${me}`),
    ]);
    if (friendRes.error || blockRes.error) throw friendRes.error ?? blockRes.error;
    for (const row of (friendRes.data ?? []) as FriendshipRow[]) {
      friendships.set(otherUserId(me, row), row);
    }
    for (const row of (blockRes.data ?? []) as Array<{
      blocker_id: string;
      blocked_id: string;
    }>) {
      if (row.blocker_id === me) blockedByMe.add(row.blocked_id);
      if (row.blocked_id === me) blocksMe.add(row.blocker_id);
    }
    return { friendships, blockedByMe, blocksMe, unavailable: false };
  } catch (error) {
    console.error("[community] social state lookup failed:", error);
    return { friendships, blockedByMe, blocksMe, unavailable: true };
  }
}

export interface FriendsListResult {
  friends: RelationshipView[];
  incoming: RelationshipView[];
  outgoing: RelationshipView[];
  /** Blocked users (I blocked them) — the "Unblock" management list. */
  blocked: SocialProfile[];
  unavailable: boolean;
}

/** The Friends page: friends (grouped client-side by presence) + requests. */
export async function fetchFriendsList(
  supabase: SupabaseClient,
  me: string,
): Promise<FriendsListResult> {
  const empty: FriendsListResult = {
    friends: [],
    incoming: [],
    outgoing: [],
    blocked: [],
    unavailable: true,
  };
  const rows = await fetchMySocialRows(supabase, me);
  if (rows.unavailable) return empty;

  const otherIds = [...rows.friendships.keys(), ...rows.blockedByMe];
  const profiles = await fetchProfiles(supabase, otherIds);

  const view = (userId: string, row: FriendshipRow | null): RelationshipView => ({
    state: deriveRelationship(me, row ?? null, false, false),
    friendshipId: row?.id ?? null,
    other: toSocialProfile(profiles.get(userId)!, me),
  });

  const friends: RelationshipView[] = [];
  const incoming: RelationshipView[] = [];
  const outgoing: RelationshipView[] = [];
  for (const [userId, row] of rows.friendships) {
    if (!profiles.has(userId)) continue;
    const v = view(userId, row);
    if (row.status === "accepted") friends.push(v);
    else if (row.requestee_id === me) incoming.push(v);
    else outgoing.push(v);
  }
  // Presence is the primary axis (online first), then newest state change.
  const rowFor = (userId: string) => rows.friendships.get(userId);
  const byPresenceThenNewest = (a: RelationshipView, b: RelationshipView) =>
    Number(b.other.online) - Number(a.other.online) ||
    String(rowFor(b.other.userId)?.status_changed_at ?? "").localeCompare(
      String(rowFor(a.other.userId)?.status_changed_at ?? ""),
    );
  friends.sort(byPresenceThenNewest);
  incoming.sort(byPresenceThenNewest);
  outgoing.sort(byPresenceThenNewest);

  const blocked: SocialProfile[] = [...rows.blockedByMe]
    .map((userId) => profiles.get(userId))
    .filter((p): p is ProfileRow => Boolean(p))
    .map((p) => toSocialProfile(p, me));

  return { friends, incoming, outgoing, blocked, unavailable: false };
}

/**
 * The profile card payload for ONE other member: identity + bio + presence +
 * the relationship from the viewer's session. Nothing account-level is
 * selected (email / real name / plan are structurally out of reach).
 */
export async function fetchMemberProfile(
  supabase: SupabaseClient,
  viewerId: string,
  targetUserId: string,
): Promise<{ profile: SocialProfile | null; relationship: RelationshipView | null; unavailable: boolean }> {
  const fail = { profile: null, relationship: null, unavailable: true } as const;
  if (targetUserId === viewerId) return { ...fail, unavailable: false };
  const rows = await fetchMySocialRows(supabase, viewerId);
  if (rows.unavailable) return fail;
  const profiles = await fetchProfiles(supabase, [targetUserId]);
  const profileRow = profiles.get(targetUserId);
  if (!profileRow) return { profile: null, relationship: null, unavailable: false };
  const profile = toSocialProfile(profileRow, viewerId);
  const friendship = rows.friendships.get(targetUserId) ?? null;
  const relationship: RelationshipView = {
    state: deriveRelationship(
      viewerId,
      friendship,
      rows.blockedByMe.has(targetUserId),
      rows.blocksMe.has(targetUserId),
    ),
    friendshipId: friendship?.id ?? null,
    other: profile,
  };
  return { profile, relationship, unavailable: false };
}

export interface DmConversation {
  id: string;
  member_a: string;
  member_b: string;
  created_at: string;
  updated_at: string;
}

/**
 * The DM inbox: every conversation the viewer belongs to, with the OTHER
 * member's identity, the unread count and the last message's shape — all in
 * ONE SQL summary call + ONE profile batch (no message downloads).
 */
export async function fetchDmSummary(
  supabase: SupabaseClient,
  me: string,
): Promise<{ conversations: DmSummaryRow[]; unavailable: boolean }> {
  try {
    const { data, error } = await supabase.rpc("community_dm_summary", {
      p_user: me,
    });
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as Array<{
      conversation_id: string;
      other_user_id: string;
      unread: number | string;
      last_message_at: string | null;
      last_message: string | null;
      last_message_is_image: boolean;
      last_message_mine: boolean;
    }>;
    if (rows.length === 0) return { conversations: [], unavailable: false };
    const profiles = await fetchProfiles(
      supabase,
      rows.map((r) => r.other_user_id),
    );
    const conversations: DmSummaryRow[] = rows.flatMap((r) => {
      const p = profiles.get(r.other_user_id);
      if (!p) return [];
      return [
        {
          conversationId: r.conversation_id,
          other: toSocialProfile(p, me),
          unread: Number(r.unread) || 0,
          lastMessageAt: r.last_message_at,
          lastMessage: r.last_message,
          lastMessageIsImage: Boolean(r.last_message_is_image),
          lastMessageMine: Boolean(r.last_message_mine),
        },
      ];
    });
    return { conversations, unavailable: false };
  } catch (error) {
    console.error("[community] dm summary failed:", error);
    return { conversations: [], unavailable: true };
  }
}

/**
 * Nav-badge counts for the community shell — three tiny, index-backed
 * queries (DM unread via the SQL summary, pending INCOMING requests via a
 * head count, notifications via the unread count function). Null = the
 * shell renders without badges (chrome must never block the page).
 */
export async function fetchSocialBadges(
  supabase: SupabaseClient,
  me: string,
): Promise<{ dms: number; friendRequests: number; notifications: number } | null> {
  try {
    const [summaryRes, requestRes, notificationRes] = await Promise.all([
      supabase.rpc("community_dm_summary", { p_user: me }),
      supabase
        .from("community_friendships")
        .select("id", { count: "exact", head: true })
        .eq("requestee_id", me)
        .eq("status", "pending"),
      supabase.rpc("community_notifications_unread", { p_user: me }),
    ]);
    if (summaryRes.error || requestRes.error || notificationRes.error) {
      throw summaryRes.error ?? requestRes.error ?? notificationRes.error;
    }
    const rows = (summaryRes.data ?? []) as Array<{ unread: number | string }>;
    return {
      dms: rows.reduce((sum, r) => sum + (Number(r.unread) || 0), 0),
      friendRequests: requestRes.count ?? 0,
      notifications: Number(notificationRes.data) || 0,
    };
  } catch (error) {
    console.error("[community] social badges failed:", error);
    return null;
  }
}

/**
 * Load one conversation's authorization context. Returns null when the
 * viewer is not a member (or the row is gone) — the API maps that to 404
 * (not "not found" vs "not yours" — the error is deliberately indistinct).
 */
export async function loadDmConversation(
  supabase: SupabaseClient,
  me: string,
  conversationId: string,
): Promise<{ conversation: DmConversation; otherId: string } | null> {
  const { data, error } = await supabase
    .from("community_conversations")
    .select("id,member_a,member_b,created_at,updated_at")
    .eq("id", conversationId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  const conv = data as DmConversation | null;
  if (!conv) return null;
  if (conv.member_a !== me && conv.member_b !== me) return null; // RLS already hides these
  const otherId = conv.member_a === me ? conv.member_b : conv.member_a;
  return { conversation: conv, otherId };
}

interface DmMessageRow {
  id: string;
  user_id: string;
  message: string | null;
  image_path: string | null;
  reply_to_message_id: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * One page of DM messages (newest `before` cursor, ascending result) with
 * authors, reactions and reply previews — the same enrichment pattern as
 * the room message page (fixed batch queries, no N+1).
 *
 * The result rows are the CLIENT's LocalMessage shape: `room_id` is
 * aliased to the conversation id, so the room MessageRow/merge helpers work
 * for DMs unchanged.
 */
export async function fetchDmMessagePage(
  supabase: SupabaseClient,
  conversation: DmConversation,
  viewerId: string,
  beforeAt: string | null,
  limit = 50,
): Promise<{ messages: LocalMessage[]; unavailable: boolean }> {
  try {
    const base = supabase
      .from("community_direct_messages")
      .select("id,user_id,message,image_path,reply_to_message_id,created_at,updated_at")
      .eq("conversation_id", conversation.id)
      .order("created_at", { ascending: false })
      .limit(limit);
    const { data, error } = beforeAt
      ? await base.lt("created_at", beforeAt)
      : await base;
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as DmMessageRow[];
    if (rows.length === 0) return { messages: [], unavailable: false };

    const authors = await fetchProfiles(
      supabase,
      [...new Set(rows.map((r) => r.user_id))],
    );
    const reactionRes = await supabase
      .from("community_dm_reactions")
      .select("message_id,user_id,emoji")
      .in("message_id", rows.map((r) => r.id));
    if (reactionRes.error) throw new Error(reactionRes.error.message);
    const reactionRows = (reactionRes.data ?? []) as Array<{
      message_id: string;
      user_id: string;
      emoji: string;
    }>;
    const replyIds = [...new Set(rows.map((r) => r.reply_to_message_id).filter(Boolean))] as string[];
    let replyRows: DmMessageRow[] = [];
    if (replyIds.length > 0) {
      const replyRes = await supabase
        .from("community_direct_messages")
        .select("id,user_id,message,image_path,reply_to_message_id,created_at,updated_at")
        .in("id", replyIds);
      if (replyRes.error) throw new Error(replyRes.error.message);
      replyRows = (replyRes.data ?? []) as DmMessageRow[];
    }
    const replyAuthors =
      replyRows.length > 0
        ? await fetchProfiles(supabase, [...new Set(replyRows.map((r) => r.user_id))])
        : new Map<string, ProfileRow>();
    const repliesById = new Map(replyRows.map((r) => [r.id, r]));
    // One batch aggregation for the whole page (viewer = "mine" flag).
    const aggs = aggregateReactions(reactionRows, viewerId);

    // newest-first DB order → ascending chat order
    const messages: LocalMessage[] = rows
      .map((row) => {
        const authorRow = authors.get(row.user_id);
        const author = authorRow
          ? ({
              user_id: authorRow.user_id,
              display_name: authorRow.display_name,
              avatar_id: authorRow.avatar_id,
            } as CommunityAuthor)
          : null;
        const replyRow = row.reply_to_message_id ? repliesById.get(row.reply_to_message_id) : undefined;
        const replyAuthor = replyRow
          ? (() => {
              const a = replyAuthors.get(replyRow.user_id);
              return a
                ? ({
                    user_id: a.user_id,
                    display_name: a.display_name,
                    avatar_id: a.avatar_id,
                  } as CommunityAuthor)
                : null;
            })()
          : null;
        return {
          id: row.id,
          user_id: row.user_id,
          room_id: conversation.id, // alias — MessageRow/merge helpers are shape-driven
          message: row.message,
          image_path: row.image_path,
          reply_to_message_id: row.reply_to_message_id,
          created_at: row.created_at,
          updated_at: row.updated_at,
          author,
          reactions: aggs[row.id] ?? [],
          replyTo: replyRow
            ? ({
                id: replyRow.id,
                user_id: replyRow.user_id,
                message: replyRow.message,
                image_path: replyRow.image_path,
                created_at: replyRow.created_at,
                author: replyAuthor,
              } as CommunityReplyPreview)
            : null,
        };
      })
      .reverse();

    return { messages, unavailable: false };
  } catch (error) {
    console.error("[community] dm page failed:", error);
    return { messages: [], unavailable: true };
  }
}

/**
 * Open (or reuse) the DM conversation with an accepted friend.
 *
 * GATES (all server-side, in order):
 *   1. target is a valid community member,
 *   2. the pair has an ACCEPTED friendship (pending is not enough),
 *   3. no active block in EITHER direction.
 * The unique-pair constraint makes concurrent opens idempotent: a 23505
 * re-reads the winner's row instead of failing.
 */
export async function openDmConversation(
  supabase: SupabaseClient,
  me: string,
  otherId: string,
): Promise<{
  conversation: DmConversation | null;
  error: "member_not_found" | "not_friends" | "blocked" | "unavailable" | null;
}> {
  if (otherId === me) return { conversation: null, error: "member_not_found" };
  try {
    const profiles = await fetchProfiles(supabase, [otherId]);
    if (!profiles.has(otherId)) return { conversation: null, error: "member_not_found" };

    const friendshipRes = await supabase
      .from("community_friendships")
      .select("id,requester_id,requestee_id,status")
      .eq("status", "accepted")
      .or(
        `requester_id.eq.${me}.and.requestee_id.eq.${otherId},requester_id.eq.${otherId}.and.requestee_id.eq.${me}`,
      );
    if (friendshipRes.error) throw new Error(friendshipRes.error.message);
    const friendship = (friendshipRes.data ?? [])[0] as FriendshipRowLike | undefined;
    if (!friendship) return { conversation: null, error: "not_friends" };

    const blockRes = await supabase
      .from("community_blocks")
      .select("blocker_id,blocked_id")
      .or(
        `blocker_id.eq.${me}.and.blocked_id.eq.${otherId},blocker_id.eq.${otherId}.and.blocked_id.eq.${me}`,
      );
    if (blockRes.error) throw new Error(blockRes.error.message);
    if ((blockRes.data ?? []).length > 0)
      return { conversation: null, error: "blocked" };

    // Reuse the existing conversation if there is one (either ordering).
    const existingRes = await supabase
      .from("community_conversations")
      .select("id,member_a,member_b,created_at,updated_at")
      .or(
        `member_a.eq.${me}.and.member_b.eq.${otherId},member_a.eq.${otherId}.and.member_b.eq.${me}`,
      );
    if (existingRes.error) throw new Error(existingRes.error.message);
    const existing = (existingRes.data ?? [])[0] as DmConversation | undefined;
    if (existing) return { conversation: existing, error: null };

    // Canonical ordering at insert time: the smaller uuid first.
    const [memberA, memberB] = [me, otherId].sort();
    const { data, error } = await supabase
      .from("community_conversations")
      .insert({ member_a: memberA, member_b: memberB })
      .select("id,member_a,member_b,created_at,updated_at")
      .single();
    if (error) {
      if (error.code === "23505") {
        // Concurrent open won the race — reuse their row.
        const retry = await supabase
          .from("community_conversations")
          .select("id,member_a,member_b,created_at,updated_at")
          .or(
            `member_a.eq.${me}.and.member_b.eq.${otherId},member_a.eq.${otherId}.and.member_b.eq.${me}`,
          );
        if (!retry.error) {
          const row = (retry.data ?? [])[0] as DmConversation | undefined;
          if (row) return { conversation: row, error: null };
        }
      }
      throw error;
    }
    return { conversation: data as DmConversation, error: null };
  } catch (error) {
    console.error("[community] open dm conversation failed:", error);
    return { conversation: null, error: "unavailable" };
  }
}

// ---------------------------------------------------------------------------
// Social notifications (Phase 3) — typed, navigable, idempotent.
//
// CREATION: the API layer calls createSocialNotification() (server-only),
// which inserts directly with the service-role client after the
// non-security recipient-preference checks. Server-side invariants: never
// self-notify (actor === target → no row) and idempotency via the
// deterministic send_key — a 23505 on (target_user_id, send_key) re-reads
// the EXISTING row, so a retried action can never duplicate. No user has
// an INSERT policy on notifications, so client-side injection is
// impossible.
//
// READING: the notification center selects OWN + GLOBAL rows directly
// (RLS is the visibility boundary) with a stable (created_at, id) keyset
// cursor. Live updates stream over the existing RLS-scoped postgres
// publication (no polling).
//
// WRITING: social notifications target ANOTHER user, so they are inserted
// with the service-role client (see createSocialNotification). The row
// carries the structured event data; the `title` column holds the machine
// KIND MARKER (one of: friend_request, friend_accepted, mention, reply,
// reaction, direct_message) — the client renders the viewer-language text
// from marker + structured fields (stored text is a legacy fallback).
// ---------------------------------------------------------------------------

/** Kind markers + row classifier — the isomorphic module (client components
 *  must not import this server module). */
export { SOCIAL_KIND_MARKERS, socialKindOf } from "./notification-kinds";
export type { SocialKindMarker } from "./notification-kinds";

export interface NotificationView {
  id: string;
  title: string;
  content: string;
  type: string;
  /** "all" (platform) or "user" (targeted at me — RLS guarantees). */
  target_type: "all" | "user";
  created_at: string;
  read: boolean;
  // Phase 3: the typed social model (null for platform + legacy rows).
  actorId: string | null;
  roomId: string | null;
  roomMessageId: string | null;
  conversationId: string | null;
  dmMessageId: string | null;
  reactionEmoji: string | null;
  /** Phase 5 Q&A refs (null for every pre-Phase-5 kind). */
  questionId: string | null;
  answerId: string | null;
}

export interface NotificationPageCursor {
  /** (created_at, id) of the page's oldest row — pass back for page 2. */
  createdAt: string;
  id: string;
}

/**
 * The notification center feed: ONE invoker RPC per page (RLS-scoped),
 * newest first, stable (created_at, id) cursor. Typed rows carry the
 * references the client needs to navigate safely; the client renders the
 * text per viewer language from type + actor (actor profiles are batched
 * separately, no N+1).
 */
export async function fetchNotifications(
  supabase: SupabaseClient,
  me: string,
  limit = 30,
  cursor: NotificationPageCursor | null = null,
): Promise<{
  items: NotificationView[];
  cursor: NotificationPageCursor | null;
  unavailable: boolean;
}> {
  try {
    // RLS is the visibility boundary: own + global rows only (the SELECT
    // policy enforces it — no user id travels in the query). The keyset
    // cursor (created_at, id) keeps "load more" an indexed backward walk.
    let query = supabase
      .from("notifications")
      .select(
        "id,title,content,type,target_type,actor_id,room_id,room_message_id,conversation_id,dm_message_id,reaction_emoji,question_id,answer_id,created_at",
      )
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(limit);
    if (cursor) {
      query = query.or(
        `created_at.lt.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},id.lt.${cursor.id})`,
      );
    }
    const { data, error } = await query;
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as Array<{
      id: string;
      title: string;
      content: string;
      type: string;
      target_type: string;
      actor_id: string | null;
      room_id: string | null;
      room_message_id: string | null;
      conversation_id: string | null;
      dm_message_id: string | null;
      reaction_emoji: string | null;
      question_id: string | null;
      answer_id: string | null;
      created_at: string;
    }>;
    if (rows.length === 0) return { items: [], cursor: null, unavailable: false };
    // PERSONAL read receipts: one bounded select over the page's ids.
    const readsRes = await supabase
      .from("notification_reads")
      .select("notification_id")
      .eq("user_id", me)
      .in("notification_id", rows.map((r) => r.id));
    if (readsRes.error) throw new Error(readsRes.error.message);
    const readIds = new Set(
      ((readsRes.data ?? []) as Array<{ notification_id: string }>).map(
        (r) => r.notification_id,
      ),
    );
    const items: NotificationView[] = rows.map((r) => ({
      id: r.id,
      title: r.title,
      content: r.content,
      type: r.type,
      target_type: (r.target_type === "all" ? "all" : "user") as "all" | "user",
      created_at: r.created_at,
      read: readIds.has(r.id),
      actorId: r.actor_id ?? null,
      roomId: r.room_id ?? null,
      roomMessageId: r.room_message_id ?? null,
      conversationId: r.conversation_id ?? null,
      dmMessageId: r.dm_message_id ?? null,
      reactionEmoji: r.reaction_emoji ?? null,
      questionId: r.question_id ?? null,
      answerId: r.answer_id ?? null,
    }));
    const last = rows[rows.length - 1];
    return {
      items,
      cursor: rows.length === limit ? { createdAt: last.created_at, id: last.id } : null,
      unavailable: false,
    };
  } catch (error) {
    console.error("[community] notifications failed:", error);
    return { items: [], cursor: null, unavailable: true };
  }
}

// ---------------------------------------------------------------------------
// Viewer settings (Phase 3) — the presence + notification preferences the
// shell renders server-side (own row only; every page needs it, so it is
// fetched once per page render, never polled).
// ---------------------------------------------------------------------------

/**
 * The shell's settings state (structurally the same shape the client's
 * CommunitySettingsState uses — kept here so the SERVER layer does not
 * import a client component). Defaults are the "sensible on" state, matching
 * the DB column defaults.
 */
export interface ViewerCommunitySettings {
  mode: PresenceMode;
  showPresence: boolean;
  friendRequests: boolean;
  mentions: boolean;
  replies: boolean;
  reactions: boolean;
  directMessages: boolean;
  sound: boolean;
  /** The viewer's muted room ids (bell state in the nav). */
  mutedRooms: string[];
}

/** The exact column list — the pages fold it into their own profile select. */
export const VIEWER_SETTINGS_SELECT =
  "presence_mode,show_presence,notify_friend_requests,notify_mentions,notify_replies,notify_reactions,notify_direct_messages,notify_sound,muted_room_ids";

/** Pure mapper (unit-testable): raw row → shell state. Nulls → defaults. */
export function buildViewerSettings(row: {
  presence_mode: PresenceMode | null;
  show_presence: boolean | null;
  notify_friend_requests: boolean | null;
  notify_mentions: boolean | null;
  notify_replies: boolean | null;
  notify_reactions: boolean | null;
  notify_direct_messages: boolean | null;
  notify_sound: boolean | null;
  muted_room_ids: string[] | null;
}): ViewerCommunitySettings {
  return {
    mode: row.presence_mode ?? "online",
    showPresence: row.show_presence !== false,
    friendRequests: row.notify_friend_requests !== false,
    mentions: row.notify_mentions !== false,
    replies: row.notify_replies !== false,
    reactions: row.notify_reactions !== false,
    directMessages: row.notify_direct_messages !== false,
    sound: row.notify_sound !== false,
    mutedRooms: row.muted_room_ids ?? [],
  };
}

/**
 * Load the viewer's settings from their OWN row (RLS: own only). Null on any
 * failure — the shell falls back to its built-in defaults, so a DB hiccup
 * degrades the chrome, never the page.
 */
export async function fetchViewerSettings(
  supabase: SupabaseClient,
  userId: string,
): Promise<ViewerCommunitySettings | null> {
  try {
    const { data, error } = await supabase
      .from("community_profiles")
      .select(VIEWER_SETTINGS_SELECT)
      .eq("user_id", userId)
      .maybeSingle();
    if (error || !data) {
      if (error) console.error("[community] viewer settings failed:", error.message);
      return null;
    }
    return buildViewerSettings(
      data as Parameters<typeof buildViewerSettings>[0],
    );
  } catch (error) {
    console.error("[community] viewer settings threw:", error);
    return null;
  }
}

/** Deterministic uuid (uuid-formatted sha256 prefix) from a stable key. */
export function socialSendKey(kind: string, rowId: string): string {
  const digest = createHash("sha256").update(`social:${kind}:${rowId}`).digest("hex");
  return (
    digest.slice(0, 8) +
    "-" +
    digest.slice(8, 12) +
    "-" +
    digest.slice(12, 16) +
    "-" +
    digest.slice(16, 20) +
    "-" +
    digest.slice(20, 32)
  );
}

/**
 * Mention notifications: for a freshly posted room message, notify each
 * mentioned member (EXCEPT the sender) that they were mentioned. Reuses the
 * mention resolution (username → member id, service role) and the
 * deterministic send key (one notification per (message, user) — retries
 * cannot duplicate). Non-fatal: the message persists regardless of
 * notification success.
 */
export async function notifyMentions(
  messageId: string,
  names: string[],
  context: { actorId: string; actorName: string; roomName: string; roomId?: string },
): Promise<void> {
  if (names.length === 0) return;
  try {
    const userIds = await resolveMentionedUserIds(names);
    if (userIds.size === 0) return;
    for (const targetUserId of userIds) {
      if (targetUserId === context.actorId) continue; // no self-mention ping
      void createSocialNotification({
        targetUserId,
        actorUserId: context.actorId,
        title: "mention",
        content: "",
        roomId: context.roomId,
        roomMessageId: messageId,
        sendKey: socialSendKey(`mention:${targetUserId}`, messageId),
      });
    }
  } catch (error) {
    console.error("[community] mention notifications failed:", error);
  }
}

export interface SocialNotificationInput {
  targetUserId: string;
  /** The triggering user (stored as actor_id; the client resolves the
   *  display name from the member directory). */
  actorUserId: string;
  /**
   * The machine KIND marker, stored as `title` (one of: "friend_request",
   * "friend_accepted", "mention", "reply", "reaction", "direct_message").
   * The client renders the per-viewer-language text from this marker + the
   * structured fields; stored text is only the fallback for legacy rows.
   */
  title: string;
  content: string;
  /** Deterministic idempotency key (one event per entity, per recipient). */
  sendKey: string;
  roomId?: string;
  roomMessageId?: string;
  conversationId?: string;
  dmMessageId?: string;
  reactionEmoji?: string;
  /** Phase 5 Q&A kinds ('answer' / 'answer_accepted'): the entity refs the
   *  v6 CHECK constraint requires (question + answer + room). */
  questionId?: string;
  answerId?: string;
}

/**
 * Create a social notification for ONE recipient.
 *
 * Written with the SERVICE-ROLE client: a notification row targets ANOTHER
 * user, so the viewer's RLS-scoped client cannot insert on their behalf —
 * the trusted server does. The row carries the structured event data
 * (actor / room / conversation / message + the deterministic send_key);
 * the display text is rendered client-side per viewer language (the stored
 * title is the kind marker, not copy).
 *
 * Invariants enforced here (server-side, never client-trusted):
 *  - never self-notify (actor === target → no row);
 *  - idempotent: a 23505 on (target_user_id, send_key) re-reads the EXISTING
 *    row — a retried action can never create a duplicate.
 *
 * Non-fatal: a failed notification logs and returns null — the social
 * action itself already succeeded and must not roll back because of a badge.
 */
export async function createSocialNotification(
  input: SocialNotificationInput,
): Promise<string | null> {
  try {
    if (input.actorUserId === input.targetUserId) return null; // never self-notify
    const admin = createAdminClient();
    const { data, error } = await admin
      .from("notifications")
      .insert({
        target_user_id: input.targetUserId,
        target_type: "user",
        // The kind rides the enum `type` (the v4 CHECK constraint
        // notifications_social_refs validates the per-kind reference shape)
        // AND `title` (the client render signal — socialKindOf reads the
        // title first, `type` second for legacy rows).
        type: input.title,
        title: input.title,
        // created_by is NOT NULL: the actor is the creator of this row.
        created_by: input.actorUserId,
        // content is a legacy fallback (CHECK: 3..2000 chars); the client
        // renders the viewer-language text from the kind marker + the
        // structured fields, never from the stored content.
        content: input.content.trim().length >= 3 ? input.content.trim() : "Update",
        actor_id: input.actorUserId,
        room_id: input.roomId ?? null,
        room_message_id: input.roomMessageId ?? null,
        conversation_id: input.conversationId ?? null,
        dm_message_id: input.dmMessageId ?? null,
        reaction_emoji: input.reactionEmoji ?? null,
        question_id: input.questionId ?? null,
        answer_id: input.answerId ?? null,
        send_key: input.sendKey,
      })
      .select("id")
      .single();
    if (error) {
      if (error.code === "23505") {
        // Idempotent retry: the row already exists — re-read it by send_key.
        const { data: existing } = await admin
          .from("notifications")
          .select("id")
          .eq("send_key", input.sendKey)
          .maybeSingle();
        return ((existing as { id: string } | null)?.id) ?? null;
      }
      console.error("[community] social notification failed:", error.message);
      return null;
    }
    return (data as { id: string } | null)?.id ?? null;
  } catch (error) {
    console.error("[community] social notification threw:", error);
    return null;
  }
}
