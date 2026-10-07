/**
 * Community settings — the persistence contract (shared types + classifier).
 *
 * LIVES HERE (not in `src/app/community/actions.ts`) because Next.js
 * requires every EXPORTED function in a `"use server"` file to be async;
 * the classifier is a pure sync helper used by the server actions and by
 * the regression tests.
 */

export type CommunitySettingsCode =
  | "success"
  | "unauthenticated"
  | "banned"
  | "rate_limited"
  | "not_found"
  | "rls_blocked"
  | "unique_conflict"
  | "check_constraint"
  | "foreign_key"
  | "postgrest"
  | "database"
  | "generic";

export interface CommunitySettingsResult {
  ok: boolean;
  code: CommunitySettingsCode;
  /** SQLSTATE when present (diagnostics only — safe to surface to the UI). */
  sqlstate?: string;
}

/** Classify a Supabase/PostgREST error into a stable, displayable code. */
export function classifySettingsError(
  error: { message: string; code?: string } | null | undefined,
): { code: CommunitySettingsCode; sqlstate?: string } {
  const sqlstate = error?.code;
  if (sqlstate === "42501") return { code: "rls_blocked", sqlstate };
  if (sqlstate === "23505") return { code: "unique_conflict", sqlstate };
  if (sqlstate === "23514") return { code: "check_constraint", sqlstate };
  if (sqlstate === "23503") return { code: "foreign_key", sqlstate };
  if (sqlstate?.startsWith("PGRST")) return { code: "postgrest", sqlstate };
  if (error && /row-level security/i.test(error.message)) return { code: "rls_blocked" };
  if (!error) return { code: "database" };
  return { code: "database", sqlstate };
}
