import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

/**
 * Platform administrator identity — the canonical server-side authorization
 * for privileged platform operations (announcements, community-wide
 * moderation, bans).
 *
 * AUTHORIZATION MODEL (three independent lines, all server-side):
 *
 *   1. STABLE ID — the platform admin is a fixed Supabase auth.id, never an
 *      email, display name, or any client-supplied field. The id survives
 *      profile renames, avatar changes and UI tweaks; nothing a user can
 *      edit can grant or remove this status.
 *   2. SESSION — the actor is always the JWT-verified session user
 *      (supabase.auth.getUser), resolved per request. A forged user id in a
 *      request body is never read.
 *   3. DATABASE — membership must also exist in public.admins (RLS enabled,
 *      NO user policies — self-elevation is impossible from the browser;
 *      only the migration/service role can write it).
 *
 * Failure mode is FAIL-CLOSED: any read error, missing session, missing
 * membership, or id mismatch → not admin. (The community ROLE layer
 * degrades fail-open for least-privilege reads; a privileged gate must
 * never fail the other way.)
 *
 * The designated account (verified against auth.users.email in migration
 * 20261104000000 — the seed is a no-op if the uid is ever re-bound):
 *   contact@ausbildungsweg.net — 6fa45036-1b86-427a-a7d0-54a3a3904767
 */

/** The stable platform-admin auth.id (see module docs for the binding). */
export const PLATFORM_ADMIN_USER_ID = "6fa45036-1b86-427a-a7d0-54a3a3904767";

/**
 * DOCUMENTATION ONLY — the email is never used for authorization. It is
 * pinned here so the id↔account binding is auditable in code; the
 * migration is the enforceable source of the binding.
 */
export const PLATFORM_ADMIN_EMAIL = "contact@ausbildungsweg.net";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Pure id comparison for SERVER-SIDE enrichment (the red admin badge flag
 * on author payloads). The input is always a database-derived user id —
 * never client input — so the flag cannot be spoofed from the browser.
 */
export function isPlatformAdminId(value: unknown): boolean {
  return (
    typeof value === "string" &&
    UUID_RE.test(value) &&
    value.toLowerCase() === PLATFORM_ADMIN_USER_ID.toLowerCase()
  );
}

export type PlatformAdminResult =
  | { ok: true; userId: string }
  | {
      ok: false;
      /** unauthenticated: no session; not_admin: session user is someone else; not_bound: stable id matches but the DB membership row is missing. */
      code: "unauthenticated" | "not_admin" | "not_bound";
    };

/**
 * The canonical check: is the CURRENT SESSION USER the platform admin?
 * Re-resolves the session on every call (a revoked membership loses access
 * on the very next request). Never throws — errors fail closed.
 */
export async function isPlatformAdmin(): Promise<PlatformAdminResult> {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return { ok: false, code: "unauthenticated" };
    if (!isPlatformAdminId(user.id)) return { ok: false, code: "not_admin" };

    // Line 3: the platform membership table (service role only). A missing
    // row fails CLOSED even though the id matched — the DB is the second
    // source of truth, not a formality.
    const admin = createAdminClient();
    const { data: membership, error } = await admin
      .from("admins")
      .select("user_id")
      .eq("user_id", user.id)
      .maybeSingle();
    if (error || !membership) {
      if (error) console.error("[community] platform admin membership check failed:", error.message);
      return { ok: false, code: "not_bound" };
    }
    return { ok: true, userId: user.id };
  } catch (error) {
    console.error("[community] platform admin check threw:", error);
    return { ok: false, code: "not_bound" };
  }
}

/**
 * The route/action gate. null = the caller must NOT perform the privileged
 * operation (map: unauthenticated → 401, not_admin/not_bound → 403).
 * Callers that need the code (for logging) use isPlatformAdmin() directly.
 */
export async function requirePlatformAdmin(): Promise<{ userId: string } | null> {
  const check = await isPlatformAdmin();
  if (!check.ok) return null;
  return { userId: check.userId };
}
