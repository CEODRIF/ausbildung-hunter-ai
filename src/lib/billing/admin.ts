import "server-only";

import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Profile } from "@/lib/auth";
import { isAssignablePlan, type AssignablePlan } from "./plans";

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

/**
 * Per-step gate diagnostics (secret-free by construction: step outcomes +
 * SQLSTATE codes only — never email, JWT, cookies or tokens).
 */
export type GateStepState = "found" | "not_found" | "error" | "skipped";

export interface GateDiagnostics {
  /** `public.admins` membership read: found / not_found / error:<SQLSTATE>. */
  admins: GateStepState | `error:${string}`;
  /** `profiles` row read: found / not_found / error:<SQLSTATE> / skipped. */
  profile: GateStepState | `error:${string}`;
}

export type AdminAccess =
  | { status: "ok"; profile: Profile }
  | { status: "unauthenticated" }
  | {
      status: "forbidden";
      reason: "no_membership" | "no_profile";
      userId: string;
      diag: GateDiagnostics;
    };

/** Session user + admin check with a diagnostic reason (server-side only). */
export async function diagnoseAdminAccess(): Promise<AdminAccess> {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  const user = data.user;
  if (!user || !isUuid(user.id)) return { status: "unauthenticated" };

  const admin = createAdminClient();

  // Step 1 — admin membership (service role; PK read, no filters).
  const { data: membership, error: membershipError } = await admin
    .from("admins")
    .select("user_id")
    .eq("user_id", user.id)
    .maybeSingle();
  const adminsState: GateDiagnostics["admins"] = membershipError
    ? `error:${membershipError.code ?? "unknown"}`
    : membership
      ? "found"
      : "not_found";
  if (!membership)
    return {
      status: "forbidden",
      reason: "no_membership",
      userId: user.id,
      diag: { admins: adminsState, profile: "skipped" },
    };

  // Step 2 — profile row (service role).
  //
  // CRITICAL (production incident 2026-10-08, second report): this select
  // MUST stay `*`. The previous explicit column list named the avatar
  // display column added by the FEATURE migration
  // 20261013000000_profile_settings — not by the base auth schema. In the
  // production project that column was absent, so the explicit select
  // failed (SQLSTATE 42703) with `data: null` even though the admin row,
  // the stable UUID and the profile row all existed — and the gate denied
  // a fully provisioned platform admin (403; before the 403 page it was
  // the same null → the silent /dashboard bounce). `select *` can never
  // fail on a missing column, and the gate decision only needs the row to
  // exist; every consumer of requireAdmin() reads `.id` only.
  const { data: profile, error: profileError } = await admin
    .from("profiles")
    .select("*")
    .eq("id", user.id)
    .maybeSingle();
  const profileState: GateDiagnostics["profile"] = profileError
    ? `error:${profileError.code ?? "unknown"}`
    : profile
      ? "found"
      : "not_found";
  if (!profile)
    return {
      status: "forbidden",
      reason: "no_profile",
      userId: user.id,
      diag: { admins: "found", profile: profileState },
    };

  return { status: "ok", profile: profile as Profile };
}

/** Session user + admin check (server-side only). */
export async function requireAdmin(): Promise<Profile | null> {
  const access = await diagnoseAdminAccess();
  return access.status === "ok" ? access.profile : null;
}

export type AdminAction =
  | "set_plan"
  | "cancel_subscription"
  | "reactivate_subscription"
  | "grant_admin"
  | "revoke_admin";

export type AdminActionResult =
  { ok: true; message: string } | { ok: false; reason: string };

/**
 * Sanitized server-side diagnostics for admin-action failures.
 *
 * The UI only ever receives the coarse `reason` (see AdminActionResult) —
 * these logs carry the actual PostgREST error CODE + a redacted MESSAGE so
 * the real failure (e.g. "function does not exist" = a missing migration)
 * is diagnosable from the server logs without leaking data to the browser.
 * Redaction: every UUID and e-mail literal in the message is replaced; the
 * message is truncated. Function names, argument TYPES and SQLSTATE/PGRST
 * codes are intentionally kept — they are the diagnostic signal and carry
 * no personal data.
 */
export function sanitizeDbDiagnostic(message: string): string {
  return message
    .replace(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
      "[uuid]",
    )
    .replace(/\S+@\S+\.\S+/g, "[email]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

function logAdminDbError(
  action: AdminAction,
  code: string | undefined,
  message: string | undefined,
): void {
  console.error(
    `[admin] database error for action "${action}" — code=${code ?? "unknown"} message=${sanitizeDbDiagnostic(message ?? "(no message)")}`,
  );
}

/**
 * True when the error says the RPC (or another function) does not exist —
 * i.e. the database schema is behind the deployed application code
 * (missing migration), not when the operation itself was rejected.
 * PostgREST reports this as PGRST202; raw SQLSTATE is 42883.
 */
export function isMissingFunctionError(error: {
  code?: string | null;
  message?: string | null;
}): boolean {
  if (error.code === "PGRST202" || error.code === "42883") return true;
  return /function\s+[\w.]+\s*\([^)]*\)\s+does not exist/i.test(
    error.message ?? "",
  );
}

/**
 * Appends an audit row. Returns false (and logs a sanitized diagnostic)
 * when the insert fails — callers MUST treat that as a failure, never as
 * success: an admin action without its audit record is not complete.
 */
async function appendAudit(
  actorId: string,
  targetUserId: string,
  action: AdminAction,
  details: Record<string, unknown>,
): Promise<boolean> {
  const admin = createAdminClient();
  const { error } = await admin.from("admin_audit_log").insert({
    actor_id: actorId,
    target_user_id: targetUserId,
    action,
    details,
  });
  if (error) {
    console.error(
      `[admin] AUDIT WRITE FAILED for action "${action}" (the underlying change, if any, IS committed) — code=${error.code ?? "unknown"} message=${sanitizeDbDiagnostic(error.message ?? "(no message)")}`,
    );
    return false;
  }
  return true;
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

/**
 * Per-plan assignment durations — the app-layer source of truth.
 *
 *   * Plus = EXACTLY 10 days, aligned with the canonical `premium_10d`
 *     tier (fixed_days 10 — commercial-plans.ts, seeded by 20261120).
 *   * Pro  = EXACTLY 30 days (Pro's intended duration, unchanged).
 *
 * The flat 1|30|365 allowlist from the 20261126 era is retired: 1-day and
 * 365-day grants were never UI-exposed, and any plan/duration pairing that
 * is not plus→10 or pro→30 is rejected at EVERY layer — this check, the
 * route's zod schema, and (authoritatively) the `manage_subscription` RPC
 * as redefined by migration 20261128000000.
 */
export const PLAN_PERIOD_DAYS: Record<AssignablePlan, number> = {
  plus: 10,
  pro: 30,
};

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

  // Subscription actions run through the atomic `manage_subscription` RPC
  // (migration 20261126): row lock → validated write → admin_audit_log with
  // before/after + reason → subscription_events, all in ONE transaction.
  // The actor id is the SESSION-derived administrator (requireAdmin ran
  // first); the browser never supplies it.
  if (
    action === "set_plan" ||
    action === "reactivate_subscription" ||
    action === "cancel_subscription"
  ) {
    if (action !== "cancel_subscription") {
      if (!isAssignablePlan(params.plan)) {
        return { ok: false, reason: "invalid_plan" };
      }
      // Strict plan↔duration pairing (server-side; the RPC re-checks it —
      // migration 20261128): plus is granted for exactly 10 days, pro for
      // exactly 30. Any other combination is rejected before any DB call.
      if (params.periodDays !== PLAN_PERIOD_DAYS[params.plan]) {
        return { ok: false, reason: "invalid_period" };
      }
    }
    let data: unknown;
    let error: { code?: string; message?: string } | null = null;
    try {
      const res = await admin.rpc("manage_subscription", {
        p_actor_id: actorId,
        p_target_id: targetUserId,
        p_action: action,
        p_plan: action === "cancel_subscription" ? null : params.plan,
        p_period_days:
          action === "cancel_subscription" ? null : params.periodDays,
        p_reason: "admin_ui",
      });
      data = res.data;
      error = res.error;
    } catch (e) {
      // A thrown client failure still gets a sanitized server-side
      // diagnostic (the UI keeps only the coarse reason).
      logAdminDbError(
        action,
        e instanceof Error && /PGRST\d{4}/.test(e.message)
          ? e.message.match(/PGRST\d{4}/)?.[0]
          : "client_exception",
        e instanceof Error ? e.message : String(e),
      );
      return { ok: false, reason: "db_error" };
    }
    if (error) {
      logAdminDbError(action, error.code, error.message);
      // Missing function = the database is behind the code (a required
      // migration was never applied) — surface that specifically instead
      // of an opaque "db_error" so the operator knows exactly what to do.
      if (isMissingFunctionError(error)) {
        return { ok: false, reason: "rpc_unavailable" };
      }
      return { ok: false, reason: "db_error" };
    }
    const result = (Array.isArray(data) ? data[0] : data) as Record<
      string,
      unknown
    > | null;
    const status =
      typeof result?.["status"] === "string"
        ? (result["status"] as string)
        : "db_error";
    if (status === "no_subscription") {
      return { ok: false, reason: "no_subscription" };
    }
    if (status !== "ok") return { ok: false, reason: "db_error" };
    if (action === "cancel_subscription") {
      return {
        ok: true,
        message:
          "Subscription canceled — the account has no active plan; protected features are locked (account and data preserved).",
      };
    }
    return {
      ok: true,
      message: `Plan ${String(params.plan)} activated for ${String(
        params.periodDays,
      )} day(s) — administrator grant (not a customer payment).`,
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
    // The grant IS committed at this point; a failed audit write must NOT
    // be reported as a plain success — the operator has to verify it.
    if (!(await appendAudit(actorId, targetUserId, "grant_admin", {}))) {
      return { ok: false, reason: "audit_failed" };
    }
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
    // Same audit-integrity rule as grant_admin.
    if (!(await appendAudit(actorId, targetUserId, "revoke_admin", {}))) {
      return { ok: false, reason: "audit_failed" };
    }
    return { ok: true, message: "Admin rights revoked." };
  }

  return { ok: false, reason: "unknown_action" };
}
