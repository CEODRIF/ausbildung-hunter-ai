import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export type Profile = {
  id: string;
  full_name: string;
  /** Editable name parts (20261013000000_profile_settings). null for accounts
   *  created before they existed, undefined when the migration is not applied
   *  yet — full_name stays the display name either way. */
  first_name?: string | null;
  last_name?: string | null;
  /** Public URL of the avatar stored in the `avatars` bucket, or null. */
  avatar_url?: string | null;
  email: string;
  account_status: "pending" | "active" | "suspended";
  selected_goal: "ausbildung" | "arbeit" | null;
  daily_email_limit: number;
  created_at: string;
  updated_at: string;
};

/**
 * Where the user lands after clicking the Supabase email confirmation link.
 * Supabase appends `?code=...` to this URL; /auth/callback exchanges the code
 * for a session and then forwards to the `next` target (default /onboarding).
 */
export const AUTH_CALLBACK_PATH = "/auth/callback?next=/onboarding";

/**
 * Absolute confirmation redirect (emailRedirectTo). Requires APP_URL; when
 * unset, Supabase falls back to the Site URL configured in the dashboard.
 */
export function getAuthCallbackUrl(): string | undefined {
  const appUrl = process.env.APP_URL?.trim().replace(/\/+$/, "");
  return appUrl ? `${appUrl}${AUTH_CALLBACK_PATH}` : undefined;
}

function scrub(message: string): string {
  return message
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+/gi, "Bearer [redacted]")
    .replace(
      /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
      "[redacted-jwt]",
    );
}

export async function getCurrentUserAndProfile() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { user: null, profile: null };

  const { data: profile, error } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", user.id)
    .maybeSingle<Profile>();
  if (error)
    // A valid session plus a failed/empty profile lookup is exactly how a
    // broken profiles access contract (missing RLS policy/grant) presents
    // itself in production — keep it diagnosable without leaking secrets.
    console.error(
      `[auth] profile lookup failed user="${user.id}" error="${scrub(error.message)}"`,
    );
  if (profile) return { user, profile };

  // RLS fallback: the RLS-gated query saw no row. That is either a
  // genuinely missing profile (trigger not run yet) or a broken access
  // contract on the profiles table. Re-check the SAME row with the service
  // role (RLS bypass), strictly scoped to the session user's own id — no
  // user can influence whose profile is read — so a confirmed user is
  // never locked out while the schema is being repaired. Using this path
  // is itself a production defect signal: log it loudly.
  const admin = createAdminClient();
  const { data: adminProfile } = await admin
    .from("profiles")
    .select("*")
    .eq("id", user.id)
    .maybeSingle<Profile>();
  if (adminProfile)
    console.error(
      `[auth] profile visible only to service_role for user="${user.id}" — the profiles RLS policy/grant contract is incomplete in this database; apply migration 20261008000000_restore_profiles_access`,
    );
  return { user, profile: adminProfile ?? null };
}

export async function requireActiveUser() {
  const { user, profile } = await getCurrentUserAndProfile();
  if (!user || !profile || profile.account_status !== "active") return null;
  return { user, profile };
}

/**
 * Validate an invitation code (service role — invitation_codes is revoked
 * from anon/authenticated).
 *
 * Consumption is NOT done here: the on_auth_user_email_confirmed database
 * trigger (migration 20261005000000_email_confirmation_activation.sql) calls
 * consume_invitation_code() exactly once when the user's email is verified
 * via the Supabase Auth confirmation link.
 */
export async function validateInvitationCode(
  code: string,
  type: "registration" | "quota_upgrade",
) {
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("validate_invitation_code", {
    invitation_code: code,
    invitation_type: type,
  });
  if (error) throw new Error(error.message);
  return Boolean(data);
}
