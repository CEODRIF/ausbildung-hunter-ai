import "server-only";

/**
 * Platform administrator identity — the canonical server-side identity for
 * the privileged platform account.
 *
 * AUTHORIZATION MODEL:
 *
 *   1. STABLE ID — the platform admin is a fixed Supabase auth.id, never an
 *      email, display name, or any client-supplied field. The id survives
 *      profile renames, avatar changes and UI tweaks; nothing a user can
 *      edit can grant or remove this status.
 *   2. DATABASE — the membership row in public.admins (RLS enabled, NO user
 *      policies — self-elevation is impossible from the browser; only the
 *      migration/service role can write it) is the enforceable source of the
 *      id↔account binding (see migration 20261104000000 — the seed is a
 *      no-op if the uid is ever re-bound).
 *
 * The designated account (verified against auth.users.email in migration
 * 20261104000000):
 *   contact@ausbildungsweg.net — 6fa45036-1b86-427a-a7d0-54a3a3904767
 *
 * NOTE: this module only provides the stable identity and the pure id
 * predicate used for the DISPLAY-ONLY admin flag in `src/lib/auth.ts`
 * (the red admin badge on author payloads). There is no async
 * platform-admin authorization gate in this codebase — privileged
 * endpoints are guarded by the billing admin gate
 * (`src/lib/billing/admin.ts`, `requireAdmin`).
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
