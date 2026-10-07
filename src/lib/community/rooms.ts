import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import {
  COMMUNITY_DEFAULT_ROOM_SLUG,
  COMMUNITY_PAGE_SIZE,
  type CommunityAuthor,
  type CommunityMessage,
  type CommunityMessageClient,
  type CommunityMessageReactionAgg,
  type CommunityMessageView,
  type CommunityReplyPreview,
  type CommunityRoom,
  type CommunityRoomGroup,
} from "@/lib/community";

/** The request-scoped client (RLS-enforced) used for member-readable data. */
type SessionClient = Awaited<ReturnType<typeof createClient>>;

/**
 * Phase 4: the room's active voice conversation — AGGREGATE METADATA ONLY.
 * The table carries no participant identities by design (outsiders see a
 * count, nothing else). Never throws: voice chrome degrades to "none".
 */
export async function fetchRoomVoice(
  supabase: SessionClient,
  roomId: string,
): Promise<{ active: boolean; participantCount: number }> {
  try {
    const { data, error } = await supabase
      .from("community_voice_conversations")
      .select("id,status,participant_count,updated_at")
      .eq("room_id", roomId)
      .eq("status", "active")
      .maybeSingle();
    if (error) {
      console.error("[community] voice lookup failed:", error.message);
      return { active: false, participantCount: 0 };
    }
    if (!data) return { active: false, participantCount: 0 };
    return {
      active: true,
      participantCount:
        typeof data.participant_count === "number" ? data.participant_count : 0,
    };
  } catch (error) {
    console.error("[community] voice lookup threw:", error);
    return { active: false, participantCount: 0 };
  }
}

// ---------------------------------------------------------------------------
// Room directory
// ---------------------------------------------------------------------------

export interface RoomDirectory {
  /** Categories with their enabled rooms, in display order. */
  groups: CommunityRoomGroup[];
  /** True when the directory could not be read (degraded, never fatal). */
  unavailable: boolean;
}

/**
 * Load the room directory (categories + enabled rooms) in two indexed
 * queries and group them in TS. Runs on the caller's SESSION client — rooms
 * are member-readable by RLS, no privileged key involved.
 * Never throws: any failure degrades to `{groups: [], unavailable: true}`.
 */
export async function fetchCommunityRoomGroups(
  supabase: SessionClient,
): Promise<RoomDirectory> {
  try {
    const [categoriesRes, roomsRes] = await Promise.all([
      supabase
        .from("community_room_categories")
        .select("id,slug,name,position")
        .order("position", { ascending: true }),
      supabase
        .from("community_rooms")
        .select("id,slug,name,category_id,description,icon,position,enabled,qna_enabled")
        .eq("enabled", true)
        .order("position", { ascending: true }),
    ]);
    if (categoriesRes.error || roomsRes.error) {
      const error = categoriesRes.error ?? roomsRes.error ?? { message: "unknown" };
      console.error("[community] room directory failed:", error.message);
      return { groups: [], unavailable: true };
    }

    const categories = (categoriesRes.data ?? []) as CommunityRoomGroup[];
    const rooms = (roomsRes.data ?? []) as CommunityRoom[];
    const byCategory = new Map<string, CommunityRoom[]>();
    for (const room of rooms) {
      const list = byCategory.get(room.category_id) ?? [];
      list.push(room);
      byCategory.set(room.category_id, list);
    }
    const groups = categories.map((c) => ({
      ...c,
      rooms: (byCategory.get(c.id) ?? []).slice().sort((a, b) => a.position - b.position),
    }));
    return { groups, unavailable: false };
  } catch (error) {
    console.error("[community] room directory threw:", error);
    return { groups: [], unavailable: true };
  }
}

export interface RoomLookup {
  room: CommunityRoom | null;
  /** True on a read failure (vs. "room does not exist"). */
  unavailable: boolean;
}

/** Resolve one room by slug (enabled rooms only — RLS hides the rest). */
export async function fetchRoomBySlug(
  supabase: SessionClient,
  slug: string,
): Promise<RoomLookup> {
  try {
    const { data, error } = await supabase
      .from("community_rooms")
      .select("id,slug,name,category_id,description,icon,position,enabled,qna_enabled")
      .eq("slug", slug)
      .eq("enabled", true)
      .maybeSingle();
    if (error) {
      console.error("[community] room lookup failed:", error.message);
      return { room: null, unavailable: true };
    }
    return { room: (data as CommunityRoom | null) ?? null, unavailable: false };
  } catch (error) {
    console.error("[community] room lookup threw:", error);
    return { room: null, unavailable: true };
  }
}

// ---------------------------------------------------------------------------
// Per-room unread (sidebar dots + nav badge)
// ---------------------------------------------------------------------------

/**
 * Per-room unread counts for ONE user, from a single SQL summary call
 * (`community_room_unread_summary`) — O(rooms), not O(messages).
 *
 * Runs on the ADMIN client with the SESSION user's id (never client input) —
 * same trust pattern as the original unread counter. Non-critical chrome:
 * any failure degrades to {} and never breaks the page.
 */
export async function fetchRoomUnreadMap(userId: string): Promise<Record<string, number>> {
  try {
    const admin = createAdminClient();
    const { data, error } = (await admin.rpc("community_room_unread_summary", {
      p_user: userId,
    })) as {
      data: Array<{ room_id: string; unread: number }> | null;
      error: { message: string } | null;
    };
    if (error || !data) {
      console.error(
        "[community] unread summary unavailable:",
        error?.message ?? "empty result",
      );
      return {};
    }
    const map: Record<string, number> = {};
    for (const row of data) {
      const count = Number(row.unread) || 0;
      if (count > 0) map[row.room_id] = count;
    }
    return map;
  } catch (error) {
    console.error("[community] unread summary threw:", error);
    return {};
  }
}

// ---------------------------------------------------------------------------
// Room message pages (initial fetch + "load older" — same shape the API
// returns, so the client never has two decoders)
// ---------------------------------------------------------------------------

export interface RoomMessagePage {
  /** Chronological ascending. */
  messages: CommunityMessageClient[];
  /** True when the page could not be read (degraded — client resyncs). */
  unavailable: boolean;
}

interface ReactionRow {
  message_id: string;
  emoji: string;
  user_id: string;
}

/** Batch-aggregate flat reaction rows into per-message counts (+ mine). */
export function aggregateReactions(
  rows: ReactionRow[],
  viewerUserId: string | null,
): Record<string, CommunityMessageReactionAgg[]> {
  const perMessage = new Map<string, Map<string, { count: number; mine: boolean }>>();
  for (const row of rows) {
    let byEmoji = perMessage.get(row.message_id);
    if (!byEmoji) {
      byEmoji = new Map();
      perMessage.set(row.message_id, byEmoji);
    }
    const agg = byEmoji.get(row.emoji) ?? { count: 0, mine: false };
    agg.count += 1;
    if (viewerUserId && row.user_id === viewerUserId) agg.mine = true;
    byEmoji.set(row.emoji, agg);
  }
  const out: Record<string, CommunityMessageReactionAgg[]> = {};
  for (const [messageId, byEmoji] of perMessage) {
    out[messageId] = [...byEmoji.entries()]
      .map(([emoji, v]) => ({ emoji, count: v.count, mine: v.mine }))
      .sort((a, b) => b.count - a.count);
  }
  return out;
}

/**
 * One room message page with EVERYTHING the client needs to render it:
 * authors, reactions and reply-to previews are fetched in fixed batch
 * queries (no N+1), then joined in memory.
 *
 * Runs on the caller's SESSION client (RLS-backed member reads). Never
 * throws: failures degrade to `{messages: [], unavailable: true}`.
 */
export async function fetchRoomMessagePage(
  supabase: SessionClient,
  roomId: string,
  viewerUserId: string | null,
  opts: { beforeAt?: string | null } = {},
): Promise<RoomMessagePage> {
  try {
    let query = supabase
      .from("community_messages")
      .select(
        "id,user_id,room_id,message,image_path,reply_to_message_id,created_at,updated_at",
      )
      .eq("room_id", roomId)
      .order("created_at", { ascending: false })
      .limit(COMMUNITY_PAGE_SIZE);
    if (opts.beforeAt) query = query.lt("created_at", opts.beforeAt);
    const { data: rows, error } = await query;
    if (error) {
      console.error("[community] room history failed:", error.message);
      return { messages: [], unavailable: true };
    }
    if (!rows || rows.length === 0) return { messages: [], unavailable: false };

    const items = rows as CommunityMessage[];
    const ids = items.map((m) => m.id);
    const authorIds = [...new Set(items.map((m) => m.user_id))];
    const replyIds = [...new Set(items.map((m) => m.reply_to_message_id).filter(Boolean))] as string[];

    // One query per batch — independent, so run them together.
    const [profilesRes, reactionsRes, repliesRes] = await Promise.all([
      supabase
        .from("community_profiles")
        .select("user_id,display_name,avatar_id")
        .in("user_id", authorIds),
      supabase
        .from("community_message_reactions")
        .select("message_id,emoji,user_id")
        .in("message_id", ids),
      replyIds.length > 0
        ? supabase
            .from("community_messages")
            .select("id,user_id,message,image_path,created_at")
            .in("id", replyIds)
        : Promise.resolve({ data: null, error: null }),
    ]);
    if (reactionsRes.error)
      console.error("[community] reactions lookup failed:", reactionsRes.error.message);
    if (repliesRes.error)
      console.error("[community] reply lookup failed:", (repliesRes as { error: { message: string } }).error.message);

    const authors: Record<string, CommunityAuthor> = {};
    for (const p of (profilesRes.data ?? []) as CommunityAuthor[]) authors[p.user_id] = p;

    const reactionsByMessage = aggregateReactions(
      (reactionsRes.data ?? []) as ReactionRow[],
      viewerUserId,
    );

    // Reply parents may be by authors not in this page — fetch their labels
    // only when needed (one extra batch query, same table).
    const replyAuthorIds = [
      ...new Set(((repliesRes.data ?? []) as CommunityMessage[]).map((r) => r.user_id)),
    ].filter((id) => !(id in authors));
    const replyAuthors: Record<string, CommunityAuthor> = {};
    if (replyAuthorIds.length > 0) {
      const { data: extra } = await supabase
        .from("community_profiles")
        .select("user_id,display_name,avatar_id")
        .in("user_id", replyAuthorIds);
      for (const p of (extra ?? []) as CommunityAuthor[]) replyAuthors[p.user_id] = p;
    }

    const repliesById: Record<string, CommunityReplyPreview> = {};
    for (const r of (repliesRes.data ?? []) as CommunityMessage[]) {
      repliesById[r.id] = {
        id: r.id,
        user_id: r.user_id,
        message: r.message,
        image_path: r.image_path,
        created_at: r.created_at,
        author: authors[r.user_id] ?? replyAuthors[r.user_id] ?? null,
      };
    }

    const messages: CommunityMessageClient[] = items
      .map((m) => {
        const view: CommunityMessageView = { ...m, author: authors[m.user_id] ?? null };
        return {
          ...view,
          reactions: reactionsByMessage[m.id] ?? [],
          replyTo: m.reply_to_message_id ? repliesById[m.reply_to_message_id] ?? null : null,
        };
      })
      .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));

    return { messages, unavailable: false };
  } catch (error) {
    console.error("[community] room history threw:", error);
    return { messages: [], unavailable: true };
  }
}

// ---------------------------------------------------------------------------
// Community home
// ---------------------------------------------------------------------------

export interface HomeRecentItem {
  message: CommunityMessageView;
  roomName: string;
  roomSlug: string;
}

/**
 * The latest few messages ACROSS all rooms (the home page's "recent
 * activity"). Three fixed batch queries total; never throws.
 */
export async function fetchHomeRecent(
  supabase: SessionClient,
  limit = 6,
): Promise<HomeRecentItem[]> {
  try {
    const { data: rows, error } = await supabase
      .from("community_messages")
      .select("id,user_id,room_id,message,image_path,reply_to_message_id,created_at,updated_at")
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error || !rows || rows.length === 0) return [];
    const items = rows as CommunityMessage[];

    const [roomsRes, profilesRes] = await Promise.all([
      supabase
        .from("community_rooms")
        .select("id,slug,name")
        .in("id", [...new Set(items.map((m) => m.room_id))]),
      supabase
        .from("community_profiles")
        .select("user_id,display_name,avatar_id")
        .in("user_id", [...new Set(items.map((m) => m.user_id))]),
    ]);

    const roomById = new Map(
      ((roomsRes.data ?? []) as Array<{ id: string; slug: string; name: string }>).map(
        (r) => [r.id, r],
      ),
    );
    const authors = new Map(
      ((profilesRes.data ?? []) as CommunityAuthor[]).map((a) => [a.user_id, a]),
    );

    return items.map((m) => {
      const room = roomById.get(m.room_id);
      return {
        message: { ...m, author: authors.get(m.user_id) ?? null },
        roomName: room?.name ?? "—",
        roomSlug: room?.slug ?? COMMUNITY_DEFAULT_ROOM_SLUG,
      };
    });
  } catch (error) {
    console.error("[community] home recent activity threw:", error);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Mention resolution (server-side — used by the message API)
// ---------------------------------------------------------------------------

/**
 * Resolve @-username tokens to member ids, CASE-INSENSITIVELY (Postgres
 * `ilike`), in ONE query. Runs on the ADMIN client (read-only; the data is
 * already member-visible via RLS) because the session client cannot express
 * `IN (ilike …)` in PostgREST — and because mention rows themselves are
 * written with the service role (members have no insert policy on
 * community_message_mentions).
 */
export async function resolveMentionedUserIds(
  names: string[],
): Promise<Set<string>> {
  const result = new Set<string>();
  if (names.length === 0) return result;
  try {
    const admin = createAdminClient();
    const or = names
      .map((n) => `display_name.ilike.${n.replace(/[^A-Za-z0-9]/g, "")}`)
      .join(",");
    const { data, error } = await admin
      .from("community_profiles")
      .select("user_id")
      .or(or);
    if (error) {
      console.error("[community] mention resolution failed:", error.message);
      return result;
    }
    for (const row of (data ?? []) as Array<{ user_id: string }>) result.add(row.user_id);
  } catch (error) {
    console.error("[community] mention resolution threw:", error);
  }
  return result;
}

/**
 * Persist the mention rows for one message (service role — members have no
 * insert policy). Idempotent: existing (message,user) pairs are skipped.
 * Failures are logged and swallowed — a mention is a nicety, not the message.
 */
export async function persistMentions(
  messageId: string,
  names: string[],
): Promise<void> {
  const userIds = await resolveMentionedUserIds(names);
  if (userIds.size === 0) return;
  try {
    const admin = createAdminClient();
    const { error } = await admin
      .from("community_message_mentions")
      .upsert(
        [...userIds].map((user_id) => ({ message_id: messageId, user_id })),
        { onConflict: "message_id,user_id" },
      );
    if (error) console.error("[community] persist mentions failed:", error.message);
  } catch (error) {
    console.error("[community] persist mentions threw:", error);
  }
}

// ---------------------------------------------------------------------------
// Phase 5 — community home feeds (all bounded, all degraded-safe)
// ---------------------------------------------------------------------------

export interface HomeActivityRow {
  roomId: string;
  roomSlug: string;
  roomName: string;
  messageCount: number;
  questionCount: number;
}

/**
 * Per-room 7-day activity for the home's "active rooms" — ONE SQL summary
 * call (community_home_activity), never a per-room count from the app.
 */
export async function fetchHomeActivity(): Promise<HomeActivityRow[]> {
  try {
    const admin = createAdminClient();
    const { data, error } = (await admin.rpc("community_home_activity")) as {
      data: Array<{
        room_id: string;
        room_slug: string;
        room_name: string;
        message_count: number;
        question_count: number;
      }> | null;
      error: { message: string } | null;
    };
    if (error || !data) return [];
    return data.map((r) => ({
      roomId: r.room_id,
      roomSlug: r.room_slug,
      roomName: r.room_name,
      messageCount: Number(r.message_count) || 0,
      questionCount: Number(r.question_count) || 0,
    }));
  } catch (error) {
    console.error("[community] home activity threw:", error);
    return [];
  }
}

/**
 * How many members are online RIGHT NOW (last heartbeat ≤ 2 minutes —
 * the same window presence.ts derives from; one bounded count query).
 */
export async function fetchHomeOnlineCount(supabase: SessionClient): Promise<number> {
  try {
    const { count, error } = await supabase
      .from("community_profiles")
      .select("id", { count: "exact", head: true })
      .gte(
        "last_seen_at",
        new Date(Date.now() - 2 * 60 * 1000).toISOString(),
      );
    if (error) return 0;
    return count ?? 0;
  } catch {
    return 0;
  }
}

export interface HomeAnnouncement {
  id: string;
  title: string;
  content: string;
  type: string;
  created_at: string;
}

/**
 * Community announcements: the latest PLATFORM rows (target_type 'all',
 * informational kinds) — the home's "announcements" strip. Three at most.
 */
export async function fetchHomeAnnouncements(
  supabase: SessionClient,
): Promise<HomeAnnouncement[]> {
  try {
    const { data, error } = await supabase
      .from("notifications")
      .select("id,title,content,type,created_at")
      .eq("target_type", "all")
      .in("type", ["info", "important", "improvement", "maintenance", "moderation"])
      .order("created_at", { ascending: false })
      .limit(3);
    if (error || !data) return [];
    return (data as HomeAnnouncement[]).map((n) => ({
      id: n.id,
      title: n.title,
      content: n.content,
      type: n.type,
      created_at: n.created_at,
    }));
  } catch (error) {
    console.error("[community] home announcements threw:", error);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Phase 5 — room settings (moderation page; admin client, role-guarded)
// ---------------------------------------------------------------------------

export interface RoomSettingsRow {
  id: string;
  slug: string;
  name: string;
  categoryId: string;
  description: string | null;
  icon: string;
  position: number;
  enabled: boolean;
  qnaEnabled: boolean;
}

export interface RoomCategoryOption {
  id: string;
  slug: string;
  name: string;
}

/** The full room list (including DISABLED rooms — admin client) + the
 *  category options for the settings forms. Two bounded queries. */
export async function fetchRoomSettingsList(): Promise<{
  rooms: RoomSettingsRow[];
  categories: RoomCategoryOption[];
  unavailable: boolean;
}> {
  const fail = { rooms: [] as RoomSettingsRow[], categories: [] as RoomCategoryOption[], unavailable: true };
  try {
    const admin = createAdminClient();
    const [roomsRes, catsRes] = await Promise.all([
      admin
        .from("community_rooms")
        .select("id,slug,name,category_id,description,icon,position,enabled,qna_enabled")
        .order("position", { ascending: true })
        .limit(200),
      admin
        .from("community_room_categories")
        .select("id,slug,name")
        .order("position", { ascending: true }),
    ]);
    if (roomsRes.error || catsRes.error) {
      console.error(
        "[community] room settings list failed:",
        roomsRes.error?.message ?? catsRes.error?.message,
      );
      return fail;
    }
    return {
      rooms: ((roomsRes.data ?? []) as Array<Record<string, unknown>>).map((r) => ({
        id: String(r.id),
        slug: String(r.slug),
        name: String(r.name),
        categoryId: String(r.category_id),
        description: (r.description as string | null) ?? null,
        icon: String(r.icon ?? "hash"),
        position: Number(r.position) || 0,
        enabled: r.enabled === true,
        qnaEnabled: r.qna_enabled === true,
      })),
      categories: ((catsRes.data ?? []) as Array<RoomCategoryOption>).map((c) => ({
        id: c.id,
        slug: c.slug,
        name: c.name,
      })),
      unavailable: false,
    };
  } catch (error) {
    console.error("[community] room settings list threw:", error);
    return fail;
  }
}

export interface RoomSettingsInput {
  roomId: string;
  description?: string | null;
  categoryId?: string;
  qnaEnabled?: boolean;
  enabled?: boolean;
  position?: number;
}

/**
 * Update one room's admin-controlled fields (whitelisted; name/slug/icon
 * are fixed seeds and stay out of reach). The category must exist.
 */
export async function updateRoomSettings(
  input: RoomSettingsInput,
): Promise<{ ok: true } | { ok: false; error: "not_found" | "bad_category" | "failed" }> {
  const uuidValue = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidValue.test(input.roomId)) return { ok: false, error: "not_found" };
  try {
    const admin = createAdminClient();
    if (input.categoryId !== undefined) {
      const { data: cat } = await admin
        .from("community_room_categories")
        .select("id")
        .eq("id", input.categoryId)
        .maybeSingle();
      if (!cat) return { ok: false, error: "bad_category" };
    }
    const values: Record<string, unknown> = {};
    if (input.description !== undefined) {
      const trimmed = input.description?.trim() ?? "";
      values.description = trimmed.length === 0 ? null : trimmed.slice(0, 300);
    }
    if (input.categoryId !== undefined) values.category_id = input.categoryId;
    if (input.qnaEnabled !== undefined) values.qna_enabled = input.qnaEnabled;
    if (input.enabled !== undefined) values.enabled = input.enabled;
    if (input.position !== undefined && Number.isFinite(input.position)) {
      values.position = Math.max(0, Math.min(999, Math.trunc(input.position)));
    }
    if (Object.keys(values).length === 0) return { ok: true };
    const { data, error } = await admin
      .from("community_rooms")
      .update(values)
      .eq("id", input.roomId)
      .select("id");
    if (error || !data || data.length === 0) {
      return { ok: false, error: data && data.length === 0 ? "not_found" : "failed" };
    }
    return { ok: true };
  } catch (error) {
    console.error("[community] room settings update threw:", error);
    return { ok: false, error: "failed" };
  }
}

/**
 * Replace the mention rows of an edited message (service role). Deleting
 * first keeps the row set exactly matching the NEW text.
 */
export async function replaceMentions(messageId: string, names: string[]): Promise<void> {
  try {
    const admin = createAdminClient();
    const { error } = await admin
      .from("community_message_mentions")
      .delete()
      .eq("message_id", messageId);
    if (error) console.error("[community] clear mentions failed:", error.message);
  } catch (error) {
    console.error("[community] clear mentions threw:", error);
  }
  await persistMentions(messageId, names);
}
