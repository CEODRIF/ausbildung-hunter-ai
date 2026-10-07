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
import {
  buildViewerSettings,
  fetchNotifications,
  VIEWER_SETTINGS_SELECT,
  type NotificationPageCursor,
  type NotificationView,
  type ViewerCommunitySettings,
} from "@/lib/community/social";
import { fetchCommunityBanState } from "@/lib/community/roles";
import {
  classifySettingsError,
  type CommunitySettingsResult,
} from "@/lib/community/settings";

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

// ---------------------------------------------------------------------------
// Community settings — the persistence contract (production incident fix).
//
// Every EXPLICIT setting write must:
//   1. derive the actor from the authenticated session (never the client),
//   2. write ONLY its own whitelisted column(s) on the own row,
//   3. VERIFY the write by an RLS-scoped read-back (a zero-row UPDATE is a
//      FAILURE, not a silent success — PostgREST returns no error for it),
//   4. classify the failure (SQLSTATE → stable code) and log a safe
//      structured diagnostic (no user content, no SQL, no stack),
//   5. report the outcome so the UI can revert the optimistic state and
//      tell the user the truth.
//
// `ignoreDuplicates: true` is deliberately NEVER used here: it turns the
// upsert into ON CONFLICT DO NOTHING — a silent no-op on the row every
// real member already has (the original production bug).
// ---------------------------------------------------------------------------

/**
 * Safe structured diagnostic (requirement J): setting + outcome + code only
 * — no message text, no row data, no SQL, no stack.
 */
function logSettingsUpdate(
  userId: string,
  setting: string,
  result: "success" | "failure",
  code: string,
): void {
  const line = `[community] settings_update user=${userId} setting=${setting} result=${result} code=${code}`;
  if (result === "success") console.info(line);
  else console.error(`${line} (settings_update_failed)`);
}

/**
 * Phase 3 presence HEARTBEAT — stamps the viewer's last_seen_at ONLY.
 *
 * Fire-and-forget from the community shell (one throttled write per 30 s
 * while the tab is visible — the ONLY sanctioned periodic community
 * traffic). "Online" is a SERVER-SIDE derivation (≤ 2 minutes of
 * last_seen_at freshness), so the client never asserts its own presence.
 *
 * THE heartbeat NEVER writes presence_mode: a manually selected DND or AWAY
 * is explicit user state and must survive every heartbeat. Only the
 * explicit setPresenceMode below changes the stored mode.
 *
 * Deliberately NO ignoreDuplicates: a plain onConflict upsert UPDATES the
 * existing row (every real member has one) and INSERTS only when the row is
 * genuinely missing (column defaults apply, incl. presence_mode='online').
 * Failures are swallowed: presence is chrome.
 */
export async function touchCommunityPresence(): Promise<void> {
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
    const { error } = await supabase
      .from("community_profiles")
      .upsert(values, { onConflict: "user_id" });
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
 * choice: this is the ONLY path that writes presence_mode (besides the
 * row-creating onboarding insert). Stamps last_seen when (re)appearing so
 * "online" shows immediately; DND never touches last_seen (a hidden user
 * must not look freshly present).
 */
export async function setPresenceMode(
  mode: "online" | "away" | "dnd",
): Promise<CommunitySettingsResult> {
  if (!["online", "away", "dnd"].includes(mode)) return { ok: false, code: "generic" };
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
  if (!user) return { ok: false, code: "unauthenticated" };
  if (await isCommunityBanned(user.id)) return { ok: false, code: "banned" }; // Phase 10
  const limited = await checkRateLimit("community_presence", user.id);
  if (!limited.allowed) {
    logSettingsUpdate(user.id, "presence_mode", "failure", "rate_limited");
    return { ok: false, code: "rate_limited" };
  }
  const values: Record<string, unknown> = { user_id: user.id, presence_mode: mode };
    if (mode !== "dnd") values.last_seen_at = new Date().toISOString();
    // Plain onConflict upsert: the row exists for every real member, so the
    // conflict branch must UPDATE it; a missing row is INSERTed. Never
    // ignoreDuplicates (silent no-op on existing rows — the incident).
    const { error } = await supabase
      .from("community_profiles")
      .upsert(values, { onConflict: "user_id" });
    if (error) {
      const c = classifySettingsError(error);
      logSettingsUpdate(user.id, "presence_mode", "failure", c.sqlstate ?? c.code);
      console.error(
        `[community] set presence mode failed code=${error.code ?? "unknown"} message=${error.message.slice(0, 200)}`,
      );
      return { ok: false, code: c.code, sqlstate: c.sqlstate };
    }
    // Read-back verification (RLS-scoped: the session can only ever see its
    // OWN row — a missing/wrong value means the write did not land).
    const { data: row, error: readError } = await supabase
      .from("community_profiles")
      .select("presence_mode")
      .eq("user_id", user.id)
      .maybeSingle();
    if (readError) {
      const c = classifySettingsError(readError);
      logSettingsUpdate(user.id, "presence_mode", "failure", c.sqlstate ?? c.code);
      return { ok: false, code: c.code, sqlstate: c.sqlstate };
    }
    if (!row || (row as { presence_mode: string }).presence_mode !== mode) {
      logSettingsUpdate(user.id, "presence_mode", "failure", "row_not_affected");
      return { ok: false, code: "not_found" };
    }
    logSettingsUpdate(user.id, "presence_mode", "success", "200");
    return { ok: true, code: "success" };
  } catch (thrown) {
    console.error("[community] set presence mode threw:", thrown);
    return { ok: false, code: "generic" };
  }
}

/** Phase 3 privacy toggle — "show my online status" (verified write). */
export async function setShowPresence(show: boolean): Promise<CommunitySettingsResult> {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
  if (!user) return { ok: false, code: "unauthenticated" };
  if (await isCommunityBanned(user.id)) return { ok: false, code: "banned" }; // Phase 10
  const limited = await checkRateLimit("community_prefs", user.id);
  if (!limited.allowed) {
    logSettingsUpdate(user.id, "show_online_status", "failure", "rate_limited");
    return { ok: false, code: "rate_limited" };
  }
  // .select() makes the write self-verifying: a zero-row UPDATE (missing or
  // RLS-hidden row) yields no row → failure instead of a silent success.
  const { data: row, error } = await supabase
    .from("community_profiles")
    .update({ show_presence: show })
      .eq("user_id", user.id)
      .select("show_presence")
      .maybeSingle();
    if (error) {
      const c = classifySettingsError(error);
      logSettingsUpdate(user.id, "show_online_status", "failure", c.sqlstate ?? c.code);
      console.error(
        `[community] set show presence failed code=${error.code ?? "unknown"} message=${error.message.slice(0, 200)}`,
      );
      return { ok: false, code: c.code, sqlstate: c.sqlstate };
    }
    if (!row || (row as { show_presence: boolean }).show_presence !== show) {
      logSettingsUpdate(user.id, "show_online_status", "failure", "row_not_affected");
      return { ok: false, code: "not_found" };
    }
    logSettingsUpdate(user.id, "show_online_status", "success", "200");
    return { ok: true, code: "success" };
  } catch (thrown) {
    console.error("[community] set show presence threw:", thrown);
    return { ok: false, code: "generic" };
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

/** One whitelisted toggle → its one DB column (never a batch of columns). */
const PREFERENCE_COLUMNS = {
  friendRequests: "notify_friend_requests",
  mentions: "notify_mentions",
  replies: "notify_replies",
  reactions: "notify_reactions",
  directMessages: "notify_direct_messages",
  sound: "notify_sound",
} as const;

/**
 * Phase 3 notification preferences — whitelisted booleans, own row only.
 * Each call updates ONLY the column(s) present in `input`, so one toggle
 * can never clobber its siblings. Verified by read-back: a zero-row UPDATE
 * is a failure (the settings sheet reverts its optimistic state on !ok).
 */
export async function updateNotificationPreferences(
  input: CommunityPreferenceInput,
): Promise<CommunitySettingsResult> {
  const values: Record<string, boolean> = {};
  for (const key of Object.keys(PREFERENCE_COLUMNS) as Array<keyof typeof PREFERENCE_COLUMNS>) {
    const value = input[key];
    if (typeof value === "boolean") values[PREFERENCE_COLUMNS[key]] = value;
  }
  if (Object.keys(values).length === 0) return { ok: true, code: "success" };
  const setting = Object.keys(values).join("+");
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return { ok: false, code: "unauthenticated" };
    if (await isCommunityBanned(user.id)) return { ok: false, code: "banned" }; // Phase 10
    const limited = await checkRateLimit("community_prefs", user.id);
    if (!limited.allowed) {
      logSettingsUpdate(user.id, setting, "failure", "rate_limited");
      return { ok: false, code: "rate_limited" };
    }
    const { data: row, error } = await supabase
      .from("community_profiles")
      .update(values)
      .eq("user_id", user.id)
      .select(Object.keys(values).join(","))
      .maybeSingle();
    if (error) {
      const c = classifySettingsError(error);
      logSettingsUpdate(user.id, setting, "failure", c.sqlstate ?? c.code);
      console.error(
        `[community] update preferences failed code=${error.code ?? "unknown"} message=${error.message.slice(0, 200)}`,
      );
      return { ok: false, code: c.code, sqlstate: c.sqlstate };
    }
    if (!row) {
      logSettingsUpdate(user.id, setting, "failure", "row_not_affected");
      return { ok: false, code: "not_found" };
    }
    // `values` holds only whitelisted notify_* columns; the dynamic select
    // string defeats row-type inference, so read the row generically.
    const rowData = row as unknown as Record<string, unknown>;
    for (const [column, expected] of Object.entries(values)) {
      if (rowData[column] !== expected) {
        logSettingsUpdate(user.id, setting, "failure", "value_not_persisted");
        return { ok: false, code: "database" };
      }
    }
    logSettingsUpdate(user.id, setting, "success", "200");
    return { ok: true, code: "success" };
  } catch (thrown) {
    console.error("[community] update preferences threw:", thrown);
    return { ok: false, code: "generic" };
  }
}

/**
 * Settings reload (requirement I): the CURRENT database state of the
 * viewer's own row, read through the session client (RLS: own row only —
 * no client-supplied id). The settings sheet calls this when it opens, so
 * it always shows the persisted truth, never stale page props. Null on any
 * failure (the sheet then keeps its current state — never a blank slate).
 */
export async function refreshCommunitySettings(): Promise<ViewerCommunitySettings | null> {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
  if (!user) return null;
  const { data: row, error } = await supabase
    .from("community_profiles")
    .select(VIEWER_SETTINGS_SELECT)
    .eq("user_id", user.id)
    .maybeSingle();
    if (error) {
      console.error("[community] refresh settings failed:", error.message);
      return null;
    }
    if (!row) return null;
    return buildViewerSettings(row as Parameters<typeof buildViewerSettings>[0]);
  } catch (thrown) {
    console.error("[community] refresh settings threw:", thrown);
    return null;
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
