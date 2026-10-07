import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

/**
 * Community Phase 5 — roles & permissions (SERVER-AUTHORIZED ONLY).
 *
 * The community role (community_memberships) is INDEPENDENT of the Supabase
 * auth role. Every permission check in the app goes through this module:
 *
 *   * the viewer's role is read from their OWN session (RLS) or the admin
 *     client — NEVER from a client-supplied field,
 *   * every privileged action re-resolves the role server-side at request
 *     time (a demoted user loses access on the very next call),
 *   * role changes are rank-limited (nobody may grant a role ≥ their own,
 *     nobody may change their own role),
 *   * degraded-safe: any read failure degrades to 'member' (least privilege).
 *
 * The database side (v6 migration) keeps the second line of defense:
 * community_is_moderator() / community_is_admin() in the RLS policies, and
 * NO user write policies on community_memberships.
 */

export type CommunityRole = "member" | "helper" | "moderator" | "admin" | "owner";

export const COMMUNITY_ROLES: readonly CommunityRole[] = [
  "member",
  "helper",
  "moderator",
  "admin",
  "owner",
];

export const ROLE_RANK: Record<CommunityRole, number> = {
  member: 0,
  helper: 1,
  moderator: 2,
  admin: 3,
  owner: 4,
};

export function isKnownRole(value: unknown): value is CommunityRole {
  return typeof value === "string" && (COMMUNITY_ROLES as readonly string[]).includes(value);
}

export function isModerator(role: CommunityRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK.moderator;
}

export function isAdmin(role: CommunityRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK.admin;
}

/** The request-scoped (RLS-enforced) session client. */
type SessionClient = Awaited<ReturnType<typeof createClient>>;

/**
 * The viewer's community role. Session client (RLS read-all); degrades to
 * 'member' on ANY failure — least privilege, never an error.
 */
export async function fetchViewerRole(
  supabase: SessionClient,
  userId: string,
): Promise<CommunityRole> {
  try {
    const { data, error } = await supabase
      .from("community_memberships")
      .select("role")
      .eq("user_id", userId)
      .maybeSingle();
    if (error || !data) return "member";
    return isKnownRole((data as { role: string }).role) ? (data as { role: CommunityRole }).role : "member";
  } catch {
    return "member";
  }
}

/**
 * The write gate for moderation: is this user SUSPENDED (no community
 * writes at all) or TIMED OUT (muted until a server-stamped moment)?
 * Checked by every community write path (messages, DMs, Q&A, voice join).
 * Never throws: a read failure degrades to "writable" (the rate limits +
 * RLS stay the backstop; a gate outage must not lock out the whole
 * community — same fail-open class as the limiter).
 */
export async function fetchCommunityWriteGate(
  userId: string,
): Promise<{ writable: true } | { writable: false; code: "suspended" | "muted" }> {
  try {
    const admin = createAdminClient();
    const { data, error } = await admin
      .from("community_profiles")
      .select("community_suspended,community_muted_until")
      .eq("user_id", userId)
      .maybeSingle();
    if (error || !data) return { writable: true };
    const row = data as { community_suspended: boolean | null; community_muted_until: string | null };
    if (row.community_suspended === true) return { writable: false, code: "suspended" };
    if (
      typeof row.community_muted_until === "string" &&
      Date.parse(row.community_muted_until) > Date.now()
    ) {
      return { writable: false, code: "muted" };
    }
    return { writable: true };
  } catch {
    return { writable: true };
  }
}

export interface ModerationMemberRow {
  userId: string;
  displayName: string;
  avatarId: string;
  role: CommunityRole;
  joinedAt: string;
  suspended: boolean;
  mutedUntil: string | null;
}

/**
 * The member directory for the moderation "Members" tab (admin+ page):
 * profiles + roles + moderation flags in two bounded queries (no N+1).
 * Runs on the ADMIN client — the page itself is role-guarded.
 */
export async function fetchModerationMembers(
  limit = 300,
): Promise<{ items: ModerationMemberRow[]; unavailable: boolean }> {
  const fail = { items: [] as ModerationMemberRow[], unavailable: true };
  try {
    const admin = createAdminClient();
    const [profilesRes, membershipsRes] = await Promise.all([
      admin
        .from("community_profiles")
        .select("user_id,display_name,avatar_id,created_at,community_suspended,community_muted_until")
        .order("created_at", { ascending: true })
        .limit(limit),
      admin
        .from("community_memberships")
        .select("user_id,role")
        .limit(limit * 2),
    ]);
    if (profilesRes.error || membershipsRes.error) {
      console.error(
        "[community] moderation members failed:",
        profilesRes.error?.message ?? membershipsRes.error?.message,
      );
      return fail;
    }
    const roleByUser = new Map<string, string>();
    for (const row of (membershipsRes.data ?? []) as Array<{ user_id: string; role: string }>) {
      roleByUser.set(row.user_id, row.role);
    }
    const items: ModerationMemberRow[] = (
      (profilesRes.data ?? []) as Array<{
        user_id: string;
        display_name: string;
        avatar_id: string;
        created_at: string;
        community_suspended: boolean | null;
        community_muted_until: string | null;
      }>
    ).map((p) => ({
      userId: p.user_id,
      displayName: p.display_name,
      avatarId: p.avatar_id,
      role: isKnownRole(roleByUser.get(p.user_id)) ? (roleByUser.get(p.user_id) as CommunityRole) : "member",
      joinedAt: p.created_at,
      suspended: p.community_suspended === true,
      mutedUntil: p.community_muted_until,
    }));
    return { items, unavailable: false };
  } catch (error) {
    console.error("[community] moderation members threw:", error);
    return fail;
  }
}

export type SetMemberRoleError =
  | "forbidden"
  | "self_role"
  | "rank_exceeded"
  | "invalid_role"
  | "member_missing"
  | "failed";

/**
 * Change ONE member's role (admin+ only, rank-limited).
 *   * the actor's role is re-resolved server-side (never client input),
 *   * self-role changes are impossible (no one administers themselves),
 *   * a role of rank ≥ the actor's rank cannot be granted (an admin cannot
 *     mint an owner; only an owner can grant an admin),
 *   * the target must exist as a community member.
 * Every change is audited (append-only community_moderation_actions).
 */
export async function setMemberRole(input: {
  actorUserId: string;
  targetUserId: string;
  role: string;
}): Promise<{ ok: true } | { ok: false; error: SetMemberRoleError }> {
  const { actorUserId, targetUserId, role } = input;
  if (!isKnownRole(role)) return { ok: false, error: "invalid_role" };
  try {
    const admin = createAdminClient();
    const [actorRes, targetRes, memberRes] = await Promise.all([
      admin.from("community_memberships").select("role").eq("user_id", actorUserId).maybeSingle(),
      admin
        .from("community_memberships")
        .select("user_id,role")
        .eq("user_id", targetUserId)
        .maybeSingle(),
      admin.from("community_profiles").select("user_id").eq("user_id", targetUserId).maybeSingle(),
    ]);
    const actorRole = isKnownRole((actorRes.data as { role?: string } | null)?.role)
      ? ((actorRes.data as { role: CommunityRole }).role)
      : "member";
    if (!isAdmin(actorRole)) return { ok: false, error: "forbidden" };
    if (actorUserId === targetUserId) return { ok: false, error: "self_role" };
    if (ROLE_RANK[role] >= ROLE_RANK[actorRole]) return { ok: false, error: "rank_exceeded" };
    // HIERARCHY GUARD: you may only administer members whose CURRENT rank is
    // strictly below yours (an admin can never demote the owner — that would
    // be a back-door escalation of the admin over the owner).
    const targetRole = isKnownRole((targetRes.data as { role?: string } | null)?.role)
      ? ((targetRes.data as { role: CommunityRole }).role)
      : "member";
    if (ROLE_RANK[targetRole] > ROLE_RANK[actorRole]) {
      return { ok: false, error: "rank_exceeded" };
    }
    if (!memberRes.data) return { ok: false, error: "member_missing" };
    if (!targetRes.data) return { ok: false, error: "member_missing" };

    const { error } = await admin
      .from("community_memberships")
      .update({ role })
      .eq("user_id", targetUserId);
    if (error) return { ok: false, error: "failed" };

    // Audit (best-effort: the role change already succeeded).
    const { data: targetProfile } = await admin
      .from("community_profiles")
      .select("display_name")
      .eq("user_id", targetUserId)
      .maybeSingle();
    try {
      await admin.from("community_moderation_actions").insert({
        moderator_id: actorUserId,
        action: "role_change",
        target_type: "profile",
        target_id: targetUserId,
        reason: `${(targetProfile as { display_name?: string } | null)?.display_name ?? "?"} → ${role}`,
      });
    } catch {
      /* audit is best-effort */
    }
    return { ok: true };
  } catch (error) {
    console.error("[community] set member role threw:", error);
    return { ok: false, error: "failed" };
  }
}
