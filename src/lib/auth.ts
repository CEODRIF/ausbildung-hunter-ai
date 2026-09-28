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

export async function consumeInvitationCode(
  code: string,
  type: "registration" | "quota_upgrade",
) {
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("consume_invitation_code", {
    invitation_code: code,
    invitation_type: type,
  });
  if (error) throw new Error(error.message);
  return Boolean(data);
}

export async function createVerificationCode(userId: string) {
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("create_verification_code", {
    target_user_id: userId,
  });
  if (error) throw new Error(error.message);
  return data as string;
}

export async function verifyCode(userId: string, code: string) {
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("verify_account_code", {
    target_user_id: userId,
    submitted_code: code,
  });
  if (error) throw new Error(error.message);
  return Boolean(data);
}
