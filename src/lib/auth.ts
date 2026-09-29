import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export type Profile = {
  id: string;
  full_name: string;
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

export async function getCurrentUserAndProfile() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { user: null, profile: null };

  const { data: profile } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", user.id)
    .maybeSingle<Profile>();
  return { user, profile };
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
