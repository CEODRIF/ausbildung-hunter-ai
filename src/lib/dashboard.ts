import "server-only";

import { createClient } from "@/lib/supabase/server";
import type { Profile } from "@/lib/auth";
import type { SafeEmailAccount } from "@/lib/email-oauth";

export type DailyUsage = {
  emails_sent: number;
  ai_requests: number;
  date: string;
};

export type ActivityLog = {
  id: string;
  activity_type: string;
  title: string;
  description: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
};

export type DashboardData = {
  profile: Profile;
  usage: DailyUsage;
  applicationsCount: number;
  activities: ActivityLog[];
  emailAccount: SafeEmailAccount | null;
  hasCompletedScan: boolean;
};

export async function getDashboardData(userId: string): Promise<DashboardData> {
  const supabase = await createClient();
  const [
    profileResult,
    usageResult,
    applicationsResult,
    activityResult,
    emailAccountResult,
    scanResult,
  ] = await Promise.all([
    supabase.from("profiles").select("*").eq("id", userId).single<Profile>(),
    supabase.rpc("get_or_create_daily_usage").single<DailyUsage>(),
    supabase
      .from("applications")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId),
    supabase
      .from("activity_logs")
      .select("id, activity_type, title, description, metadata, created_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(5),
    supabase
      .from("email_accounts")
      .select(
        "id, provider, email, is_active, created_at, updated_at, last_used_at",
      )
      .eq("user_id", userId)
      .eq("is_active", true)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle<SafeEmailAccount>(),
    supabase
      .from("bewerbung_scans")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("status", "completed"),
  ]);

  if (profileResult.error) throw new Error("Unable to load your profile.");
  if (usageResult.error) throw new Error("Unable to load daily usage.");
  if (applicationsResult.error) throw new Error("Unable to load applications.");
  if (activityResult.error) throw new Error("Unable to load recent activity.");
  if (emailAccountResult.error)
    throw new Error("Unable to load email account status.");
  if (scanResult.error) throw new Error("Unable to load scan status.");

  return {
    profile: profileResult.data,
    usage: usageResult.data,
    applicationsCount: applicationsResult.count ?? 0,
    activities: (activityResult.data ?? []) as ActivityLog[],
    emailAccount: emailAccountResult.data as SafeEmailAccount | null,
    hasCompletedScan: (scanResult.count ?? 0) > 0,
  };
}

export function getProfileCompletion(profile: Profile) {
  const fields = [profile.full_name, profile.email, profile.selected_goal];
  return Math.round((fields.filter(Boolean).length / fields.length) * 100);
}
