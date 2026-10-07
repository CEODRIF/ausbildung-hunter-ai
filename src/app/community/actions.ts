"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { checkRateLimit } from "@/lib/rate-limit";
import {
  COMMUNITY_AVATAR_IDS,
  communityProfileSchema,
  isValidAdminCommunityName,
  isValidCommunityUsername,
} from "@/lib/community";
import { generateCommunityUsername } from "@/lib/community/identity";
import { isPlatformAdminId } from "@/lib/community/platform-admin";
import type { PresenceMode } from "@/lib/community/presence";
import {
  fetchNotifications,
  type NotificationPageCursor,
  type NotificationView,
} from "@/lib/community/social";
import { fetchCommunityBanState } from "@/lib/community/roles";

/**
 * Community v2 server actions — all writes go through the user's own session
 * client, so the RLS "own row only" policies are the second line of defense
 * (the actions never take a user id from the client either).
 *
 * Identity model: the community display name is a UNIQUE generated username
 * (case-insensitive unique index in the DB). Uniqueness is enforced at the
 * database level — a lost race surfaces as a 23505 and the UI regenerates.
 */

export type OnboardingErrorCode =
  | "username_invalid"
  | "username_taken"
  | "avatar_invalid"
  | "rate_limited"
  | "generic";

export type CommunityActionResult =
  | { ok: true }
  | { ok: false; code: OnboardingErrorCode };

/**
 * Phase 10: the BANNED gate for server actions. A platform-banned user makes
 * NO community mutations — presence, preferences, read cursors, mutes,
 * notification receipts or identity changes all abort here. Suspended /
 * muted users are deliberately NOT covered: they keep reading (and therefore
 * cursor/presence chrome) while only their WRITES are gated in the API
 * routes. Never throws — a read failure fails OPEN like the limiter (the
 * RLS community_is_banned() policies are the database backstop).
 */
async function isCommunityBanned(userId: string): Promise<boolean> {
  try {
    const ban = await fetchCommunityBanState(userId);
    return ban.banned;
  } catch (thrown) {
    console.error("[community] ban state check threw:", thrown);
    return false;
  }
}

/**
 * First-time community identity: save the generated (or user-confirmed)
 * username + one of the four predefined avatars. The username must match
 * the community format (letters/digits, 3–24) — it is NEVER a real first
 * name and it must be unique.
 */
export async function completeOnboarding(input: {
  displayName: string;
  avatarId: string;
}): Promise<CommunityActionResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, code: "generic" };
  if (await isCommunityBanned(user.id)) return { ok: false, code: "generic" };

  const parsed = communityProfileSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    if (issue.path[0] === "avatarId") return { ok: false, code: "avatar_invalid" };
    return { ok: false, code: "username_invalid" };
  }

  const limited = await checkRateLimit("community_onboarding", user.id);
  if (!limited.allowed) return { ok: false, code: "rate_limited" };

  let error: { message: string; code?: string } | null = null;
  try {
    const result = await supabase.from("community_profiles").upsert(
      {
        user_id: user.id,
        display_name: parsed.data.displayName,
        avatar_id: parsed.data.avatarId,
      },
      { onConflict: "user_id" },
    );
    error = result.error;
  } catch (thrown) {
    // Never let a transport failure escape as a rejected action: the caller
    // shows a clear inline error instead of the error boundary.
    console.error("[community] onboarding write threw:", thrown);
    return { ok: false, code: "generic" };
  }
  if (error) {
    // 23505 = the username's unique index: two people raced for the same
    // generated name (or typed the same one) — the UI regenerates.
    if (error.code === "23505") return { ok: false, code: "username_taken" };
    console.error("[community] onboarding write failed:", error.message);
    return { ok: false, code: "generic" };
  }

  revalidatePath("/community");
  return { ok: true };
}

/**
 * Generate a UNIQUE username candidate (the onboarding screen calls this on
 * first load and on every "Generate another"). Pure generation happens in
 * `@/lib/community/identity`; the DB check (case-insensitive) is the
 * authoritative uniqueness source.
 */
export async function generateCommunityUsernameAction(): Promise<{
  ok: boolean;
  username?: string;
}> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false };

  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = generateCommunityUsername();
    try {
      const { data } = await supabase
        .from("community_profiles")
        .select("user_id")
        .ilike("display_name", candidate)
        .limit(1);
      if (!data || data.length === 0) return { ok: true, username: candidate };
    } catch {
      // Read hiccup: try the next candidate; the onboarding upsert
      // re-validates uniqueness at claim time anyway.
    }
  }
  return { ok: false };
}

/**
 * Edit the identity LATER (profile menu): rename and/or change the avatar.
 * At least one field must be present; both are re-validated server-side
 * (format + avatar allowlist + uniqueness).
 */
export async function updateCommunityIdentity(input: {
  displayName?: string;
  avatarId?: string;
}): Promise<CommunityActionResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, code: "generic" };
  if (await isCommunityBanned(user.id)) return { ok: false, code: "generic" };

  const updates: Record<string, string> = {};
  if (input.displayName !== undefined) {
    const name = input.displayName.trim();
    // Phase 10: the DESIGNATED platform admin (stable session user id → the
    // admins table; the client can never assert this) may use a custom
    // display name (1–40 chars, no control characters). Every other user
    // keeps the exact username rules — this check only relaxes ONE branch.
    const isAdmin = isPlatformAdminId(user.id);
    if (!isAdmin ? !isValidCommunityUsername(name) : !isValidAdminCommunityName(name)) {
      return { ok: false, code: "username_invalid" };
    }
    updates.display_name = name;
  }
  if (input.avatarId !== undefined) {
    if (!(COMMUNITY_AVATAR_IDS as readonly string[]).includes(input.avatarId)) {
      return { ok: false, code: "avatar_invalid" };
    }
    updates.avatar_id = input.avatarId;
  }
  if (Object.keys(updates).length === 0)
    return { ok: false, code: "username_invalid" };

  const limited = await checkRateLimit("community_onboarding", user.id);
  if (!limited.allowed) return { ok: false, code: "rate_limited" };

  let error: { message: string; code?: string } | null = null;
  try {
    const result = await supabase
      .from("community_profiles")
      .update(updates)
      .eq("user_id", user.id);
    error = result.error;
  } catch (thrown) {
    console.error("[community] identity update threw:", thrown);
    return { ok: false, code: "generic" };
  }
  if (error) {
    if (error.code === "23505") return { ok: false, code: "username_taken" };
    console.error("[community] identity update failed:", error.message);
    return { ok: false, code: "generic" };
  }

  revalidatePath("/community");
  return { ok: true };
}

const uuidValue = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Advance this user's read cursor for ONE room (per-room unread dots).
 * Called from the room view while it is open; the server stamps "now" —
 * the cursor only ever moves forward in wall-clock time.
 */
export async function markRoomRead(roomId: string): Promise<void> {
  if (!uuidValue.test(roomId)) return;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return;
  if (await isCommunityBanned(user.id)) return; // Phase 10
  try {
    const { error } = await supabase.from("community_room_read_state").upsert(
      {
        user_id: user.id,
        room_id: roomId,
        last_read_at: new Date().toISOString(),
      },
      { onConflict: "user_id,room_id", ignoreDuplicates: false },
    );
    if (error) console.error("[community] room read cursor failed:", error.message);
  } catch (thrown) {
    // The badge is chrome: a failed cursor write must never surface anywhere.
    console.error("[community] room read cursor threw:", thrown);
  }
}

/**
 * Phase 3 presence heartbeat — touch the viewer's last_seen_at and report
 * the declared mode (online/away, never a DND override).
 *
 * Fire-and-forget from the community shell (one throttled write per 30 s
 * while the tab is visible — the ONLY sanctioned periodic community
 * traffic). "Online" is a SERVER-SIDE derivation (≤ 2 minutes), so the
 * client never asserts its own presence — it only reports a heartbeat.
 *
 * DND guard: a heartbeat can never clear a MANUAL Do Not Disturb. Only
 * setPresenceMode("online"|"away") below can leave DND.
 * Failures are swallowed: presence is chrome.
 */
export async function touchCommunityPresence(
  mode: PresenceMode = "online",
): Promise<void> {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
  if (!user) return;
  if (await isCommunityBanned(user.id)) return; // Phase 10
  const limited = await checkRateLimit("community_presence", user.id);
  if (!limited.allowed) return;
  const values = { user_id: user.id, last_seen_at: new Date().toISOString() };
    // NOTE: deliberately NO ignoreDuplicates — every real member already has
    // a profile row (created at onboarding), and an upsert with
    // ignoreDuplicates is a SILENT NO-OP on existing rows: the heartbeat
    // would never stamp last_seen_at and presence would go stale for
    // everyone. A plain onConflict upsert UPDATES the existing row (insert
    // only happens when the row is genuinely missing).
    let query = supabase
      .from("community_profiles")
      .upsert({ ...values, presence_mode: mode }, { onConflict: "user_id" });
    if (mode !== "dnd") {
      // The heartbeat must not flip a manual DND back to online/away. The
      // filter applies to the on-conflict UPDATE branch (a missing row is
      // still inserted).
      query = query.not("presence_mode", "eq", "dnd");
    }
    const { error } = await query;
    if (error)
      console.error(
        `[community] presence heartbeat failed code=${error.code ?? "unknown"} message=${error.message.slice(0, 200)}`,
      );
  } catch (thrown) {
    console.error("[community] presence heartbeat threw:", thrown);
  }
}

/**
 * Phase 3 manual presence control — DND / Away / Online. An EXPLICIT user
 * choice: it bypasses the heartbeat's DND guard (this is how DND is left)
 * and stamps last_seen when (re)appearing, so "online" shows immediately.
 */
export async function setPresenceMode(mode: "online" | "away" | "dnd"): Promise<void> {
  if (!["online", "away", "dnd"].includes(mode)) return;
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
  if (!user) return;
  if (await isCommunityBanned(user.id)) return; // Phase 10
  const limited = await checkRateLimit("community_presence", user.id);
  if (!limited.allowed) return;
  const values: Record<string, unknown> = { user_id: user.id, presence_mode: mode };
    if (mode !== "dnd") values.last_seen_at = new Date().toISOString();
    // Plain onConflict upsert: for every real member the row already exists,
    // so the conflict branch must UPDATE it — ignoreDuplicates would make
    // the manual choice a silent no-op and the setting would never persist.
    const { error } = await supabase
      .from("community_profiles")
      .upsert(values, { onConflict: "user_id" });
    if (error)
      console.error(
        `[community] set presence mode failed code=${error.code ?? "unknown"} message=${error.message.slice(0, 200)}`,
      );
  } catch (thrown) {
    console.error("[community] set presence mode threw:", thrown);
  }
}

/** Phase 3 privacy toggle — "show my online status". */
export async function setShowPresence(show: boolean): Promise<void> {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
  if (!user) return;
  if (await isCommunityBanned(user.id)) return; // Phase 10
  const limited = await checkRateLimit("community_prefs", user.id);
  if (!limited.allowed) return;
  const { error } = await supabase
    .from("community_profiles")
    .update({ show_presence: show })
      .eq("user_id", user.id);
    if (error) console.error("[community] set show presence failed:", error.message);
  } catch (thrown) {
    console.error("[community] set show presence threw:", thrown);
  }
}

export interface CommunityPreferenceInput {
  friendRequests?: boolean;
  mentions?: boolean;
  replies?: boolean;
  reactions?: boolean;
  directMessages?: boolean;
  sound?: boolean;
}

/** Phase 3 notification preferences — whitelisted booleans, own row only. */
/** Returns true when the preference was written (the settings sheet reverts
 *  its optimistic state on false). */
export async function updateNotificationPreferences(
  input: CommunityPreferenceInput,
): Promise<boolean> {
  const values: Record<string, boolean> = {};
  if (typeof input.friendRequests === "boolean") values.notify_friend_requests = input.friendRequests;
  if (typeof input.mentions === "boolean") values.notify_mentions = input.mentions;
  if (typeof input.replies === "boolean") values.notify_replies = input.replies;
  if (typeof input.reactions === "boolean") values.notify_reactions = input.reactions;
  if (typeof input.directMessages === "boolean") values.notify_direct_messages = input.directMessages;
  if (typeof input.sound === "boolean") values.notify_sound = input.sound;
  if (Object.keys(values).length === 0) return true;
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return false;
    if (await isCommunityBanned(user.id)) return false; // Phase 10
    const limited = await checkRateLimit("community_prefs", user.id);
    if (!limited.allowed) return false;
    const { error } = await supabase
      .from("community_profiles")
      .update(values)
      .eq("user_id", user.id);
    if (error) {
      console.error("[community] update preferences failed:", error.message);
      return false;
    }
    return true;
  } catch (thrown) {
    console.error("[community] update preferences threw:", thrown);
    return false;
  }
}

/** Phase 3 room mute — add/remove the room in own muted_room_ids. */
export async function toggleRoomMute(roomId: string): Promise<void> {
  if (!uuidValue.test(roomId)) return;
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
  if (!user) return;
  if (await isCommunityBanned(user.id)) return; // Phase 10
  const limited = await checkRateLimit("community_prefs", user.id);
  if (!limited.allowed) return;
  const { data: row, error: selectError } = await supabase
      .from("community_profiles")
      .select("muted_room_ids")
      .eq("user_id", user.id)
      .maybeSingle();
    if (selectError || !row) return;
    const muted = ((row as { muted_room_ids?: string[] }).muted_room_ids ?? []) as string[];
    const next = muted.includes(roomId)
      ? muted.filter((id) => id !== roomId)
      : [...muted, roomId];
    const { error } = await supabase
      .from("community_profiles")
      .update({ muted_room_ids: next })
      .eq("user_id", user.id);
    if (error) console.error("[community] toggle room mute failed:", error.message);
  } catch (thrown) {
    console.error("[community] toggle room mute threw:", thrown);
  }
}

/**
 * Phase 2 DM read cursor — advance "last read" for ONE conversation.
 * Same contract as markRoomRead: server-stamped time, forward-only,
 * fire-and-forget (the unread badge is chrome and must never error out).
 */
export async function markDmRead(conversationId: string): Promise<void> {
  if (!uuidValue.test(conversationId)) return;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return;
  if (await isCommunityBanned(user.id)) return; // Phase 10
  try {
    const { error } = await supabase.from("community_dm_read_state").upsert(
      {
        user_id: user.id,
        conversation_id: conversationId,
        last_read_at: new Date().toISOString(),
      },
      { onConflict: "user_id,conversation_id", ignoreDuplicates: false },
    );
    if (error) console.error("[community] dm read cursor failed:", error.message);

    // Phase 3 read-state convergence: if the peer is viewing this
    // conversation, its direct_message notifications are seen too — mark
    // the latest 25 of them read (bounded, RLS-scoped to my rows). This is
    // what keeps "actively inside the DM" from inflating the badge.
    const { data: dmNotes, error: notesError } = await supabase
      .from("notifications")
      .select("id")
      .eq("type", "direct_message")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: false })
      .limit(25);
    if (!notesError && (dmNotes?.length ?? 0) > 0) {
      const { error: readsError } = await supabase
        .from("notification_reads")
        .upsert(
          (dmNotes as Array<{ id: string }>).map((n) => ({
            notification_id: n.id,
            user_id: user.id,
          })),
          { onConflict: "notification_id,user_id", ignoreDuplicates: true },
        );
      if (readsError)
        console.error("[community] dm notification read failed:", readsError.message);
    }
  } catch (thrown) {
    console.error("[community] dm read cursor threw:", thrown);
  }
}

/**
 * Phase 2 notification read receipt (one notification). RLS limits this to
 * the viewer's own row and to notifications they can read (own + global).
 */
export async function markNotificationRead(notificationId: string): Promise<void> {
  if (!uuidValue.test(notificationId)) return;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return;
  if (await isCommunityBanned(user.id)) return; // Phase 10
  try {
    const { error } = await supabase.from("notification_reads").upsert(
      { notification_id: notificationId, user_id: user.id },
      { onConflict: "notification_id,user_id", ignoreDuplicates: true },
    );
    if (error) {
      console.error("[community] notification read failed:", error.message);
      throw new Error(error.message);
    }
  } catch (thrown) {
    // Reject (do NOT swallow): the caller rolls back the optimistic read.
    console.error("[community] notification read threw:", thrown);
    throw thrown;
  }
}

/**
 * Phase 3 notification center — cursor "load more" (page 2+). The session is
 * re-derived server-side (no user id from the client); the cursor is the
 * (created_at, id) of the current page's oldest row, validated before it is
 * trusted. Returns the next page + the new cursor (null = exhausted).
 */
export async function loadMoreNotifications(
  cursor: NotificationPageCursor,
): Promise<{
  items: NotificationView[];
  cursor: NotificationPageCursor | null;
  unavailable: boolean;
}> {
  const empty = {
    items: [] as NotificationView[],
    cursor: null as NotificationPageCursor | null,
    unavailable: false,
  };
  if (
    !cursor ||
    typeof cursor.createdAt !== "string" ||
    !Number.isFinite(Date.parse(cursor.createdAt)) ||
    typeof cursor.id !== "string" ||
    !uuidValue.test(cursor.id)
  ) {
    return empty;
  }
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return empty;
    const result = await fetchNotifications(supabase, user.id, 30, cursor);
    return { items: result.items, cursor: result.cursor, unavailable: result.unavailable };
  } catch (thrown) {
    console.error("[community] load more notifications threw:", thrown);
    return { ...empty, unavailable: true };
  }
}

/**
 * Phase 3 notification center — first-page retry (the server could not
 * prefetch the page, or a load-more failed). ONE bounded RPC; the session is
 * derived server-side.
 */
export async function loadFirstNotifications(): Promise<{
  items: NotificationView[];
  cursor: NotificationPageCursor | null;
  unavailable: boolean;
}> {
  const empty = {
    items: [] as NotificationView[],
    cursor: null as NotificationPageCursor | null,
    unavailable: false,
  };
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return empty;
    const result = await fetchNotifications(supabase, user.id, 30, null);
    return { items: result.items, cursor: result.cursor, unavailable: result.unavailable };
  } catch (thrown) {
    console.error("[community] first notifications page threw:", thrown);
    return { ...empty, unavailable: true };
  }
}

/**
 * Phase 2 "mark all read" — one upsert of every currently-unread
 * (own + global) notification. Bounded to the latest 200: a user who has
 * not opened the app for years still gets a clean, fast mark-all.
 */
export async function markAllNotificationsRead(): Promise<void> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return;
  if (await isCommunityBanned(user.id)) return; // Phase 10
  try {
    const [ownRes, readsRes] = await Promise.all([
      supabase
        .from("notifications")
        .select("id")
        .or(`target_user_id.eq.${user.id},target_type.eq.all`)
        .order("created_at", { ascending: false })
        .limit(200),
      supabase.from("notification_reads").select("notification_id").eq("user_id", user.id),
    ]);
    if (ownRes.error || readsRes.error) {
      console.error(
        "[community] mark-all-read lookup failed:",
        ownRes.error?.message ?? readsRes.error?.message,
      );
      throw new Error(ownRes.error?.message ?? readsRes.error?.message ?? "lookup failed");
    }
    const alreadyRead = new Set(
      ((readsRes.data ?? []) as Array<{ notification_id: string }>).map(
        (r) => r.notification_id,
      ),
    );
    const toRead = ((ownRes.data ?? []) as Array<{ id: string }>)
      .map((n) => n.id)
      .filter((id) => !alreadyRead.has(id));
    if (toRead.length === 0) return;
    const { error } = await supabase
      .from("notification_reads")
      .upsert(
        toRead.map((notification_id) => ({ notification_id, user_id: user.id })),
        { onConflict: "notification_id,user_id", ignoreDuplicates: true },
      );
    if (error) {
      console.error("[community] mark-all-read failed:", error.message);
      throw new Error(error.message);
    }
  } catch (thrown) {
    // Reject (do NOT swallow): the caller restores the previous read state.
    console.error("[community] mark-all-read threw:", thrown);
    throw thrown;
  }
}
