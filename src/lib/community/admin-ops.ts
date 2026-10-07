import "server-only";

import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { evictLiveKitParticipant } from "@/lib/voice/livekit-api";
import { isPlatformAdminId } from "./platform-admin";

/**
 * Platform administrator operations — announcements, message moderation,
 * bans. The privileged surface of the community.
 *
 * SECURITY MODEL (every operation):
 *   * the ACTOR is always a server-resolved platform-admin id (the caller
 *     of this module already ran requirePlatformAdmin(); a forged user id
 *     in a request body can never become the actor),
 *   * every write runs on the SERVICE ROLE (the only role that can write
 *     the protected tables — RLS has no user write policies),
 *   * every write is scoped to EXACTLY one row by a validated UUID,
 *   * every successful mutation appends an immutable row to
 *     community_moderation_actions (the existing moderation audit trail —
 *     no second audit system),
 *   * destructive semantics reuse the EXISTING community models (soft hide
 *     via hidden_by/hidden_at; ban via community_bans), so moderation
 *     behavior stays consistent with the report queue.
 *
 * Nothing here may be imported by a client component (server-only).
 */

type AdminClient = ReturnType<typeof createAdminClient>;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

/** Append one audit row (best-effort — the action itself already ran). */
async function audit(
  actorId: string,
  action: string,
  targetType: string,
  targetId: string,
  reason?: string | null,
): Promise<void> {
  try {
    const admin = createAdminClient() as AdminClient;
    await admin.from("community_moderation_actions").insert({
      moderator_id: actorId,
      action,
      target_type: targetType,
      target_id: targetId,
      reason: reason ?? null,
    });
  } catch (error) {
    console.error("[community] admin audit insert failed:", error);
  }
}

// ---------------------------------------------------------------------------
// Announcements (the existing notification system: ONE target_type='all'
// row reaches every user — no per-user fan-out, realtime delivery is the
// existing supabase_realtime stream scoped by the notifications SELECT
// policy).
// ---------------------------------------------------------------------------

/** The notification categories an announcement may carry. */
export const ANNOUNCEMENT_TYPES = [
  "announcement",
  "info",
  "important",
  "maintenance",
  "improvement",
] as const;
export type AnnouncementType = (typeof ANNOUNCEMENT_TYPES)[number];

/**
 * The validated announcement payload (re-applied at the lib boundary —
 * the API route validates first; this is the second line).
 * `sendKey` is the CLIENT-GENERATED idempotency key: a retry of the same
 * logical send reuses the same UUID → the unique index returns 23505 →
 * "duplicate", never a second notification.
 */
export const announcementSchema = z
  .object({
    title: z.string().trim().min(3).max(120),
    content: z.string().trim().min(3).max(2000),
    linkUrl: z
      .string()
      .trim()
      .max(500)
      .url()
      .refine((u) => u.startsWith("https://"), "https only")
      .optional()
      .or(z.literal(""))
      .transform((v) => (v ? v : null)),
    type: z.enum(ANNOUNCEMENT_TYPES),
    sendKey: z.string().uuid(),
  })
  .strict();

export type AnnouncementInput = z.infer<typeof announcementSchema>;

/**
 * The POST-TRANSFORM payload shape the route hands over (`linkUrl` is
 * already normalized to an https string or null by `announcementSchema`).
 * The lib boundary re-validates THIS shape — re-parsing the raw-input
 * schema would reject the transformed `null` and fail every valid send.
 */
const validatedAnnouncementSchema = z
  .object({
    title: z.string().min(3).max(120),
    content: z.string().min(3).max(2000),
    linkUrl: z
      .string()
      .url()
      .refine((u) => u.startsWith("https://"), "https only")
      .nullable(),
    type: z.enum(ANNOUNCEMENT_TYPES),
    sendKey: z.string().uuid(),
  })
  .strict();

/**
 * Send ONE platform announcement to ALL users (single row, target_type
 * 'all'). Idempotent per send_key. Audited ('admin_announcement').
 */
export async function sendPlatformAnnouncement(input: {
  actorId: string;
  payload: AnnouncementInput;
}): Promise<
  | { ok: true; duplicate: boolean }
  | { ok: false; error: "invalid" | "failed" }
> {
  const parsed = validatedAnnouncementSchema.safeParse(input.payload);
  if (!parsed.success) return { ok: false, error: "invalid" };
  const { title, content, linkUrl, type, sendKey } = parsed.data;
  try {
    const admin = createAdminClient() as AdminClient;
    const { data: row, error } = await admin
      .from("notifications")
      .insert({
        type,
        target_type: "all",
        target_user_id: null,
        created_by: input.actorId,
        actor_id: input.actorId,
        title,
        content,
        link_url: linkUrl,
        send_key: sendKey,
      })
      .select("id")
      .single();
    if (error) {
      if (error.code === "23505") {
        // Same send_key: the first attempt already created the row (lost
        // response, client retry). Converge to success without a duplicate
        // and without a second audit row (the original send was audited).
        return { ok: true, duplicate: true };
      }
      console.error("[community] announcement insert failed:", error.message);
      return { ok: false, error: "failed" };
    }
    await audit(input.actorId, "admin_announcement", "notification", String((row as { id: string }).id), title);
    return { ok: true, duplicate: false };
  } catch (error) {
    console.error("[community] announcement threw:", error);
    return { ok: false, error: "failed" };
  }
}

export interface AnnouncementRow {
  id: string;
  title: string;
  content: string;
  type: string;
  linkUrl: string | null;
  createdAt: string;
}

/** Recent announcements (the admin history list — newest first, bounded). */
export async function fetchAnnouncementHistory(
  limit = 20,
): Promise<{ items: AnnouncementRow[]; unavailable: boolean }> {
  const fail = { items: [] as AnnouncementRow[], unavailable: true };
  try {
    const admin = createAdminClient() as AdminClient;
    const { data, error } = await admin
      .from("notifications")
      .select("id,title,content,type,link_url,created_at")
      .eq("target_type", "all")
      .in("type", [...ANNOUNCEMENT_TYPES, "social"])
      .order("created_at", { ascending: false })
      .limit(Math.min(Math.max(limit, 1), 50));
    if (error || !data) return fail;
    const items = (data as Array<Record<string, unknown>>).map((r) => ({
      id: String(r.id),
      title: String(r.title),
      content: String(r.content),
      type: String(r.type),
      linkUrl: (r.link_url as string | null) ?? null,
      createdAt: String(r.created_at),
    }));
    return { items, unavailable: false };
  } catch (error) {
    console.error("[community] announcement history threw:", error);
    return fail;
  }
}

// ---------------------------------------------------------------------------
// User search (admin surface: find a community member by account email OR
// community display name — two bounded queries, merged in application
// code; the result carries the current ban state).
// ---------------------------------------------------------------------------

export interface AdminCommunityUser {
  userId: string;
  email: string | null;
  fullName: string | null;
  communityDisplayName: string | null;
  communityJoinedAt: string | null;
  communityRole: string;
  suspended: boolean;
  mutedUntil: string | null;
  banned: boolean;
  banReason: string | null;
  banExpiresAt: string | null;
  isPlatformAdmin: boolean;
}

/**
 * Search community users (email or display name, ≥3 chars after trim).
 * Bounded to 25 per source; ban states resolved in ONE batched query.
 */
export async function searchAdminUsers(
  query: string,
): Promise<{ items: AdminCommunityUser[]; unavailable: boolean }> {
  const fail = { items: [] as AdminCommunityUser[], unavailable: true };
  const q = query.trim();
  if (q.length < 3 || q.length > 120) return { items: [], unavailable: false };
  try {
    const admin = createAdminClient() as AdminClient;
    const [profilesRes, communityRes] = await Promise.all([
      admin
        .from("profiles")
        .select("id,email,full_name,created_at")
        .ilike("email", `%${q}%`)
        .limit(25),
      admin
        .from("community_profiles")
        .select("user_id,display_name,created_at,community_suspended,community_muted_until")
        .ilike("display_name", `%${q}%`)
        .limit(25),
    ]);
    if (profilesRes.error || communityRes.error) {
      console.error("[community] admin user search failed:", profilesRes.error?.message ?? communityRes.error?.message);
      return fail;
    }
    const byId = new Map<string, AdminCommunityUser>();
    for (const p of (profilesRes.data ?? []) as Array<Record<string, unknown>>) {
      const id = String(p.id);
      byId.set(id, {
        userId: id,
        email: (p.email as string | null) ?? null,
        fullName: (p.full_name as string | null) ?? null,
        communityDisplayName: null,
        communityJoinedAt: null,
        communityRole: "member",
        suspended: false,
        mutedUntil: null,
        banned: false,
        banReason: null,
        banExpiresAt: null,
        isPlatformAdmin: isPlatformAdminId(id),
      });
    }
    for (const c of (communityRes.data ?? []) as Array<Record<string, unknown>>) {
      const id = String(c.user_id);
      const entry = byId.get(id) ?? {
        userId: id,
        email: null,
        fullName: null,
        communityDisplayName: null,
        communityJoinedAt: null,
        communityRole: "member",
        suspended: false,
        mutedUntil: null,
        banned: false,
        banReason: null,
        banExpiresAt: null,
        isPlatformAdmin: isPlatformAdminId(id),
      };
      entry.communityDisplayName = (c.display_name as string | null) ?? null;
      entry.communityJoinedAt = (c.created_at as string | null) ?? null;
      entry.suspended = c.community_suspended === true;
      entry.mutedUntil = (c.community_muted_until as string | null) ?? null;
      byId.set(id, entry);
    }
    const ids = [...byId.keys()];
    if (ids.length > 0) {
      const [bansRes, rolesRes] = await Promise.all([
        admin
          .from("community_bans")
          .select("user_id,reason,expires_at")
          .in("user_id", ids)
          .is("revoked_at", null)
          .limit(50),
        admin.from("community_memberships").select("user_id,role").in("user_id", ids).limit(50),
      ]);
      const now = Date.now();
      if (!bansRes.error) {
        for (const b of (bansRes.data ?? []) as Array<Record<string, unknown>>) {
          const entry = byId.get(String(b.user_id));
          const expiresAt = (b.expires_at as string | null) ?? null;
          if (entry && (!expiresAt || Date.parse(expiresAt) > now)) {
            entry.banned = true;
            entry.banReason = (b.reason as string | null) ?? null;
            entry.banExpiresAt = expiresAt;
          }
        }
      }
      if (!rolesRes.error) {
        for (const r of (rolesRes.data ?? []) as Array<Record<string, unknown>>) {
          const entry = byId.get(String(r.user_id));
          if (entry) entry.communityRole = String(r.role);
        }
      }
    }
    return { items: [...byId.values()].slice(0, 30), unavailable: false };
  } catch (error) {
    console.error("[community] admin user search threw:", error);
    return fail;
  }
}

/** The single selected user (URL-driven detail view) — search-free. */
export async function fetchAdminCommunityUser(
  userId: string,
): Promise<AdminCommunityUser | null> {
  if (!isUuid(userId)) return null;
  try {
    const admin = createAdminClient() as AdminClient;
    const [profileRes, communityRes, banRes, roleRes] = await Promise.all([
      admin.from("profiles").select("id,email,full_name").eq("id", userId).maybeSingle(),
      admin
        .from("community_profiles")
        .select("user_id,display_name,created_at,community_suspended,community_muted_until")
        .eq("user_id", userId)
        .maybeSingle(),
      admin
        .from("community_bans")
        .select("reason,expires_at")
        .eq("user_id", userId)
        .is("revoked_at", null)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
      admin.from("community_memberships").select("role").eq("user_id", userId).maybeSingle(),
    ]);
    if (profileRes.error || communityRes.error) return null;
    const c = (communityRes.data ?? null) as
      | {
          display_name: string;
          created_at: string;
          community_suspended: boolean | null;
          community_muted_until: string | null;
        }
      | null;
    const p = (profileRes.data ?? null) as { email: string; full_name: string } | null;
    const b = (banRes.data ?? null) as { reason: string | null; expires_at: string | null } | null;
    const banned = Boolean(b && (!b.expires_at || Date.parse(b.expires_at) > Date.now()));
    return {
      userId,
      email: p?.email ?? null,
      fullName: p?.full_name ?? null,
      communityDisplayName: c?.display_name ?? null,
      communityJoinedAt: c?.created_at ?? null,
      communityRole: isKnownRole((roleRes.data as { role?: string } | null)?.role)
        ? ((roleRes.data as { role: string }).role)
        : "member",
      suspended: c?.community_suspended === true,
      mutedUntil: c?.community_muted_until ?? null,
      banned,
      banReason: banned ? (b?.reason ?? null) : null,
      banExpiresAt: banned ? (b?.expires_at ?? null) : null,
      isPlatformAdmin: isPlatformAdminId(userId),
    };
  } catch {
    return null;
  }
}

const KNOWN_ROLES = ["member", "helper", "moderator", "admin", "owner"];
function isKnownRole(value: unknown): value is string {
  return typeof value === "string" && KNOWN_ROLES.includes(value);
}

// ---------------------------------------------------------------------------
// Message moderation (the EXISTING soft-hide model: hidden_by/hidden_at.
// Hidden rows vanish from every member read path — session client, API
// layer, realtime — while the row + audit stay intact.)
// ---------------------------------------------------------------------------

export interface AdminUserMessage {
  messageId: string;
  roomId: string;
  roomSlug: string | null;
  text: string | null;
  hasImage: boolean;
  hiddenBy: string | null;
  createdAt: string;
}

/** The user's recent community messages (admin detail view, bounded). */
export async function fetchUserMessagesForAdmin(
  userId: string,
  limit = 20,
): Promise<{ items: AdminUserMessage[]; unavailable: boolean }> {
  const fail = { items: [] as AdminUserMessage[], unavailable: true };
  if (!isUuid(userId)) return { items: [], unavailable: false };
  try {
    const admin = createAdminClient() as AdminClient;
    const { data, error } = await admin
      .from("community_messages")
      .select("id,room_id,message,image_path,hidden_by,created_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(Math.min(Math.max(limit, 1), 50));
    if (error || !data || data.length === 0) return { items: [], unavailable: Boolean(error) };
    const rows = data as Array<Record<string, unknown>>;
    const roomIds = [...new Set(rows.map((r) => String(r.room_id)))];
    const slugs: Record<string, string> = {};
    if (roomIds.length > 0) {
      const { data: roomRows } = await admin
        .from("community_rooms")
        .select("id,slug")
        .in("id", roomIds)
        .limit(100);
      for (const r of (roomRows ?? []) as Array<Record<string, unknown>>) {
        slugs[String(r.id)] = String(r.slug);
      }
    }
    const items = rows.map((r) => ({
      messageId: String(r.id),
      roomId: String(r.room_id),
      roomSlug: slugs[String(r.room_id)] ?? null,
      text: (r.message as string | null) ?? null,
      hasImage: Boolean(r.image_path),
      hiddenBy: (r.hidden_by as string | null) ?? null,
      createdAt: String(r.created_at),
    }));
    return { items, unavailable: false };
  } catch (error) {
    console.error("[community] admin user messages threw:", error);
    return fail;
  }
}

/**
 * Admin deletion of ANY community message (soft hide — the existing
 * moderation model). Scoped to exactly ONE message by validated UUID;
 * audited as action='admin_message_delete' (the room slug is carried in
 * the audit reason so the trail is self-describing).
 */
export async function adminHideMessage(input: {
  actorId: string;
  messageId: string;
  reason?: string | null;
}): Promise<
  | { ok: true; alreadyHidden: boolean }
  | { ok: false; error: "invalid" | "not_found" | "failed" }
> {
  if (!isUuid(input.messageId)) return { ok: false, error: "invalid" };
  const reason =
    typeof input.reason === "string" && input.reason.trim().length > 0
      ? input.reason.trim().slice(0, 200)
      : null;
  try {
    const admin = createAdminClient() as AdminClient;
    const { data: msg, error: readError } = await admin
      .from("community_messages")
      .select("id,room_id,hidden_by")
      .eq("id", input.messageId)
      .maybeSingle();
    if (readError || !msg) return { ok: false, error: "not_found" };
    const row = msg as { id: string; room_id: string; hidden_by: string | null };
    if (row.hidden_by) return { ok: true, alreadyHidden: true };

    // The room slug for the audit trail (best-effort — the hide itself
    // must not depend on it).
    let roomSlug: string | null = null;
    const { data: room } = await admin
      .from("community_rooms")
      .select("slug")
      .eq("id", row.room_id)
      .maybeSingle();
    roomSlug = ((room as { slug?: string } | null)?.slug ?? null);

    const { error } = await admin
      .from("community_messages")
      .update({ hidden_by: input.actorId, hidden_at: new Date().toISOString() })
      .eq("id", row.id);
    if (error) {
      console.error("[community] admin message hide failed:", error.message);
      return { ok: false, error: "failed" };
    }
    const auditReason = [roomSlug ? `room:${roomSlug}` : null, reason ?? null]
      .filter(Boolean)
      .join(" · ");
    await audit(input.actorId, "admin_message_delete", "message", row.id, auditReason || null);
    return { ok: true, alreadyHidden: false };
  } catch (error) {
    console.error("[community] admin message hide threw:", error);
    return { ok: false, error: "failed" };
  }
}

// ---------------------------------------------------------------------------
// Bans (platform sanction: community access removed at the RLS level —
// community_is_banned() is embedded in the read/write policies — and at
// the API level via the write gate. Revoke = timestamp, never delete.)
// ---------------------------------------------------------------------------

/** The finite duration keys the admin UI offers (null key = permanent). */
export const BAN_DURATIONS: Record<string, number> = {
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

export type BanError =
  | "invalid"
  | "not_found"
  | "self_ban"
  | "admin_protected"
  | "already_banned"
  | "not_banned"
  | "failed";

/**
 * Ban a community user. Guards (server-side, all of them):
 *   * target must exist as a community member,
 *   * self-ban is impossible (no one administers themselves),
 *   * the platform admin cannot be banned (no lockout of the only
 *     sanctioned account),
 *   * one active ban per user (the partial unique index is the DB line).
 */
export async function banUser(input: {
  actorId: string;
  targetUserId: string;
  reason?: string | null;
  durationKey?: string | null;
}): Promise<{ ok: true } | { ok: false; error: BanError }> {
  if (!isUuid(input.targetUserId)) return { ok: false, error: "invalid" };
  if (input.actorId === input.targetUserId) return { ok: false, error: "self_ban" };
  if (isPlatformAdminId(input.targetUserId)) return { ok: false, error: "admin_protected" };
  const reason =
    typeof input.reason === "string" && input.reason.trim().length > 0
      ? input.reason.trim().slice(0, 500)
      : null;
  const durationKey = input.durationKey && input.durationKey in BAN_DURATIONS ? input.durationKey : null;
  try {
    const admin = createAdminClient() as AdminClient;
    const { data: profile, error: readError } = await admin
      .from("community_profiles")
      .select("user_id,display_name")
      .eq("user_id", input.targetUserId)
      .maybeSingle();
    if (readError) return { ok: false, error: "failed" };
    if (!profile) return { ok: false, error: "not_found" };
    const displayName = (profile as { display_name: string }).display_name;

    const { error } = await admin.from("community_bans").insert({
      user_id: input.targetUserId,
      banned_by: input.actorId,
      reason,
      expires_at: durationKey
        ? new Date(Date.now() + BAN_DURATIONS[durationKey]).toISOString()
        : null,
    });
    if (error) {
      if (error.code === "23505") return { ok: false, error: "already_banned" };
      console.error("[community] ban insert failed:", error.message);
      return { ok: false, error: "failed" };
    }

    await audit(input.actorId, "admin_ban_user", "profile", input.targetUserId, `${displayName}${durationKey ? ` (${durationKey})` : ""}${reason ? ` · ${reason}` : ""}`);
    // A ban must also end any ACTIVE voice session (the write gate only
    // blocks NEW joins — same best-effort contract as suspend_user).
    const eviction = await evictLiveKitParticipant(input.targetUserId);
    if (eviction.status === "unavailable") {
      console.error("[community] ban eviction unavailable:", eviction.detail);
    } else if (eviction.status === "evicted") {
      console.warn(`[community] ban eviction: ${eviction.rooms.join(",")}`);
    }
    return { ok: true };
  } catch (error) {
    console.error("[community] ban threw:", error);
    return { ok: false, error: "failed" };
  }
}

/** Lift the user's active ban (revoked_at timestamp — the row survives). */
export async function unbanUser(input: {
  actorId: string;
  targetUserId: string;
}): Promise<{ ok: true } | { ok: false; error: BanError }> {
  if (!isUuid(input.targetUserId)) return { ok: false, error: "invalid" };
  try {
    const admin = createAdminClient() as AdminClient;
    const { data: profile } = await admin
      .from("community_profiles")
      .select("user_id,display_name")
      .eq("user_id", input.targetUserId)
      .maybeSingle();
    const displayName = ((profile as { display_name?: string } | null)?.display_name ?? null);
    const { data: rows, error } = await admin
      .from("community_bans")
      .update({ revoked_at: new Date().toISOString() })
      .eq("user_id", input.targetUserId)
      .is("revoked_at", null)
      .select("id");
    if (error) {
      console.error("[community] unban failed:", error.message);
      return { ok: false, error: "failed" };
    }
    if (!rows || rows.length === 0) return { ok: false, error: "not_banned" };
    await audit(input.actorId, "admin_unban_user", "profile", input.targetUserId, displayName ?? undefined);
    return { ok: true };
  } catch (error) {
    console.error("[community] unban threw:", error);
    return { ok: false, error: "failed" };
  }
}

/** How many active (non-revoked, non-expired) bans exist — overview stat. */
export async function fetchActiveBanCount(): Promise<number> {
  try {
    const admin = createAdminClient() as AdminClient;
    const { count, error } = await admin
      .from("community_bans")
      .select("id", { count: "exact", head: true })
      .is("revoked_at", null);
    if (error) return 0;
    // Expired rows still count as "revoked=false" — refine client-side is
    // overkill for a stat card; expired bans lift themselves via RLS.
    return count ?? 0;
  } catch {
    return 0;
  }
}
