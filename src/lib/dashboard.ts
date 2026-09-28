import "server-only";

import { createClient } from "@/lib/supabase/server";
import type { Profile } from "@/lib/auth";
import type { SafeEmailAccount } from "@/lib/email-oauth";
import { listSavedOpportunities } from "@/lib/opportunities/saved";

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

/** Safe matching summary (all data is the user's own, server-read):
 *  snapshot counts of saved opportunities + the top scored snapshots.
 *  Snapshots are historical — the current match is always recomputed live
 *  on the opportunity detail page. No ranking is fabricated from
 *  insufficient data: only `complete` snapshots with a score are listed. */
export type MatchingSummary = {
  hasCandidateProfile: boolean;
  savedTotal: number;
  completeCount: number;
  incompleteCount: number;
  top: Array<{
    opportunity_key: string;
    title: string | null;
    location: string | null;
    match_score: number;
    saved_at: string;
  }>;
};

export type DashboardData = {
  profile: Profile;
  usage: DailyUsage;
  applicationsCount: number;
  activities: ActivityLog[];
  emailAccount: SafeEmailAccount | null;
  hasCompletedScan: boolean;
  matching: MatchingSummary;
};

export function buildMatchingSummary(
  hasCandidateProfile: boolean,
  saved: Array<{
    opportunity_key: string;
    title: string | null;
    location: string | null;
    match_score: number | null;
    match_status: string | null;
    saved_at: string;
  }>,
): MatchingSummary {
  const complete = saved.filter(
    (row) => row.match_status === "complete" && row.match_score !== null,
  );
  return {
    hasCandidateProfile,
    savedTotal: saved.length,
    completeCount: complete.length,
    incompleteCount: saved.filter((row) => row.match_status === "incomplete")
      .length,
    // Deterministic: score desc, ties by stable opportunity_key.
    top: [...complete]
      .sort(
        (a, b) =>
          (b.match_score ?? 0) - (a.match_score ?? 0) ||
          a.opportunity_key.localeCompare(b.opportunity_key),
      )
      .slice(0, 3)
      .map((row) => ({
        opportunity_key: row.opportunity_key,
        title: row.title,
        location: row.location,
        match_score: row.match_score as number,
        saved_at: row.saved_at,
      })),
  };
}

export async function getDashboardData(userId: string): Promise<DashboardData> {
  const supabase = await createClient();
  const [
    profileResult,
    usageResult,
    applicationsResult,
    activityResult,
    emailAccountResult,
    scanResult,
    candidateProfileResult,
    savedResult,
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
    supabase
      .from("candidate_profiles")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId),
    // Best-effort: the dashboard must not fail if the saved list errors.
    listSavedOpportunities(userId).catch(() => []),
  ]);

  if (profileResult.error) throw new Error("Unable to load your profile.");
  if (usageResult.error) throw new Error("Unable to load daily usage.");
  if (applicationsResult.error) throw new Error("Unable to load applications.");
  if (activityResult.error) throw new Error("Unable to load recent activity.");
  if (emailAccountResult.error)
    throw new Error("Unable to load email account status.");
  if (scanResult.error) throw new Error("Unable to load scan status.");
  if (candidateProfileResult.error)
    throw new Error("Unable to load candidate profile status.");

  return {
    profile: profileResult.data,
    usage: usageResult.data,
    applicationsCount: applicationsResult.count ?? 0,
    activities: (activityResult.data ?? []) as ActivityLog[],
    emailAccount: emailAccountResult.data as SafeEmailAccount | null,
    hasCompletedScan: (scanResult.count ?? 0) > 0,
    matching: buildMatchingSummary(
      (candidateProfileResult.count ?? 0) > 0,
      savedResult,
    ),
  };
}

export function getProfileCompletion(profile: Profile) {
  const fields = [profile.full_name, profile.email, profile.selected_goal];
  return Math.round((fields.filter(Boolean).length / fields.length) * 100);
}
