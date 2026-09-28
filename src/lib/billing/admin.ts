import "server-only";

import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Profile } from "@/lib/auth";
import { isAssignablePlan } from "./plans";

/**
 * Phase 10 — admin foundation.
 *
 * Authorization model:
 *   * The ADMIN ACTOR always comes from the authenticated session — never
 *     from request bodies or parameters.
 *   * Admin membership lives in `public.admins` (RLS enabled, NO user
 *     policies) — users cannot read or write it, so self-elevation is
 *     impossible from the browser.
 *   * Every mutation targets an explicit user id (the target), is written
 *     with the service role scoped to that exact id, and appends an
 *     immutable row to `admin_audit_log`.
 */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

/** Session user + admin check (server-side only). */
export async function requireAdmin(): Promise<Profile | null> {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  const user = data.user;
  if (!user) return null;
  if (!isUuid(user.id)) return null;
  const admin = createAdminClient();
  const { data: membership } = await admin
    .from("admins")
    .select("user_id")
    .eq("user_id", user.id)
    .maybeSingle();
  if (!membership) return null;
  const { data: profile } = await admin
    .from("profiles")
    .select(
      "id, email, full_name, avatar_url, selected_goal, daily_email_limit, account_status, created_at, updated_at",
    )
    .eq("id", user.id)
    .maybeSingle();
  if (!profile) return null;
  return profile as Profile;
}

export type AdminAction =
  | "set_plan"
  | "cancel_subscription"
  | "reactivate_subscription"
  | "grant_admin"
  | "revoke_admin";

const ADMIN_ACTIONS: readonly AdminAction[] = [
  "set_plan",
  "cancel_subscription",
  "reactivate_subscription",
  "grant_admin",
  "revoke_admin",
];

export function isAdminAction(value: unknown): value is AdminAction {
  return (
    typeof value === "string" &&
    (ADMIN_ACTIONS as readonly string[]).includes(value)
  );
}

export type AdminActionResult =
  { ok: true; message: string } | { ok: false; reason: string };

async function appendAudit(
  actorId: string,
  targetUserId: string,
  action: AdminAction,
  details: Record<string, unknown>,
): Promise<void> {
  const admin = createAdminClient();
  await admin.from("admin_audit_log").insert({
    actor_id: actorId,
    target_user_id: targetUserId,
    action,
    details,
  });
}

async function targetExists(targetUserId: string): Promise<boolean> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("profiles")
    .select("id")
    .eq("id", targetUserId)
    .maybeSingle();
  return data !== null;
}

const PERIOD_DAYS = [1, 30, 365] as const;
export function isPeriodDays(
  value: unknown,
): value is (typeof PERIOD_DAYS)[number] {
  return (
    typeof value === "number" &&
    (PERIOD_DAYS as readonly number[]).includes(value)
  );
}

/**
 * Executes one audited admin action. `actorId` must be a verified
 * administrator (call `requireAdmin` first); the target must be a real
 * user. All writes are service-role and scoped to the exact target id.
 */
export async function executeAdminAction(
  actorId: string,
  targetUserId: string,
  action: AdminAction,
  params: { plan?: unknown; periodDays?: unknown } = {},
): Promise<AdminActionResult> {
  if (!isUuid(actorId) || !isUuid(targetUserId)) {
    return { ok: false, reason: "invalid_id" };
  }
  if (!(await targetExists(targetUserId))) {
    return { ok: false, reason: "user_not_found" };
  }
  const admin = createAdminClient();
  const now = new Date().toISOString();

  if (action === "set_plan" || action === "reactivate_subscription") {
    if (!isAssignablePlan(params.plan)) {
      return { ok: false, reason: "invalid_plan" };
    }
    if (!isPeriodDays(params.periodDays)) {
      return { ok: false, reason: "invalid_period" };
    }
    const periodEnd = new Date(
      Date.now() + params.periodDays * 86_400_000,
    ).toISOString();
    const existing = await admin
      .from("subscriptions")
      .select("id")
      .eq("user_id", targetUserId)
      .maybeSingle();
    if (action === "set_plan" && existing?.data) {
      const { error } = await admin
        .from("subscriptions")
        .update({
          plan: params.plan,
          status: "active",
          canceled_at: null,
          current_period_start: now,
          current_period_end: periodEnd,
          updated_at: now,
        })
        .eq("id", existing.data.id as string);
      if (error) return { ok: false, reason: "db_error" };
    } else {
      const { error } = await admin.from("subscriptions").upsert(
        {
          user_id: targetUserId,
          plan: params.plan,
          status: "active",
          provider: "manual",
          current_period_start: now,
          current_period_end: periodEnd,
          canceled_at: null,
          created_by: actorId,
          updated_at: now,
        },
        { onConflict: "user_id" },
      );
      if (error) return { ok: false, reason: "db_error" };
    }
    await appendAudit(actorId, targetUserId, action, {
      plan: params.plan,
      period_days: params.periodDays,
    });
    return {
      ok: true,
      message: `Plan ${params.plan} activated for ${params.periodDays} day(s).`,
    };
  }

  if (action === "cancel_subscription") {
    const { data: sub } = await admin
      .from("subscriptions")
      .select("id, status")
      .eq("user_id", targetUserId)
      .maybeSingle();
    if (!sub) return { ok: false, reason: "no_subscription" };
    const { error } = await admin
      .from("subscriptions")
      .update({
        status: "canceled",
        canceled_at: now,
        updated_at: now,
      })
      .eq("id", sub.id as string);
    if (error) return { ok: false, reason: "db_error" };
    await appendAudit(actorId, targetUserId, "cancel_subscription", {});
    return {
      ok: true,
      message: "Subscription canceled (entitlements revert to Free).",
    };
  }

  if (action === "grant_admin") {
    const { error } = await admin
      .from("admins")
      .upsert(
        { user_id: targetUserId, created_by: actorId },
        { onConflict: "user_id" },
      );
    if (error) return { ok: false, reason: "db_error" };
    await appendAudit(actorId, targetUserId, "grant_admin", {});
    return { ok: true, message: "Admin rights granted." };
  }

  if (action === "revoke_admin") {
    if (actorId === targetUserId) {
      // Lockout guard: an admin cannot revoke their own last membership.
      return { ok: false, reason: "self_revoke_blocked" };
    }
    const { error } = await admin
      .from("admins")
      .delete()
      .eq("user_id", targetUserId);
    if (error) return { ok: false, reason: "db_error" };
    await appendAudit(actorId, targetUserId, "revoke_admin", {});
    return { ok: true, message: "Admin rights revoked." };
  }

  return { ok: false, reason: "unknown_action" };
}
