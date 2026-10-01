import "server-only";

import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { AI_DAILY_REQUEST_LIMIT } from "@/lib/ai-service";
import type { Profile } from "@/lib/auth";
import type { SafeEmailAccount } from "@/lib/email-oauth";
import { getUsageSnapshot, type UsageSnapshot } from "@/lib/email-campaigns";
import {
  buildRecommendationQuery,
  evaluateProfileCompleteness,
  resolveNextAction,
  type NextAction,
  type ProfileCompleteness,
} from "@/lib/dashboard-intelligence";
import {
  MATCHER_VERSION,
  type MatchResult,
} from "@/lib/opportunities/matching";
import { searchOpportunities } from "@/lib/opportunities/search";
import type { Opportunity } from "@/lib/opportunities/types";
import {
  evaluateSnapshotStaleness,
  formatSnapshotDate,
  listSavedOpportunities,
} from "@/lib/opportunities/saved";
import {
  candidateProfileSchema,
  type CandidateProfile,
} from "@/lib/bewerbung-schema";

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

/** A recent application = the user's own application draft joined with its
 *  persisted campaign + message state. No synthetic records: every field
 *  comes from rows that actually exist. */
export interface RecentApplication {
  id: string;
  subject: string;
  company: string | null;
  goal: string;
  opportunity_key: string | null;
  opportunity_title: string | null;
  created_at: string;
  updated_at: string;
  has_content: boolean;
  campaign_id: string | null;
  campaign_status: string | null;
  sent_at: string | null;
  /** Live counters maintained by the sending engine (email_campaigns). */
  total_recipients: number | null;
  queued_count: number | null;
  sending_count: number | null;
  sent_count: number | null;
  failed_count: number | null;
  cancelled_count: number | null;
  /** Account the campaign sends from (never a secret — the address only). */
  sender_email: string | null;
  campaign_updated_at: string | null;
}

export interface SavedPreviewItem {
  id: string;
  opportunity_key: string;
  title: string | null;
  company_name: string | null;
  location: string | null;
  match_score: number | null;
  match_status: string | null;
  saved_at: string;
  savedAtLabel: string | null;
  stale: boolean;
  staleReasons: string[];
}

export interface RecommendationItem {
  opportunity: Opportunity;
  match: MatchResult | null;
  saved: boolean;
}

/** The recommendation layer resolves everything server-side from the
 *  authoritative source (shared cache first, provider on miss) and ranks
 *  with the EXISTING matcher v2 (`sort=match`). It never invents items:
 *  `available=false` + a factual reason triggers an explicit empty state. */
export interface DashboardRecommendations {
  available: boolean;
  blockedReason: "no_profile" | "no_keyword" | "search_failed" | null;
  items: RecommendationItem[];
}

export type DashboardData = {
  profile: Profile;
  usage: DailyUsage;
  usageSnapshot: UsageSnapshot;
  aiLimit: number;
  /** Count of prepared application drafts (the real data source). */
  applicationsCount: number;
  activities: ActivityLog[];
  emailAccount: SafeEmailAccount | null;
  hasCompletedScan: boolean;
  matching: MatchingSummary;
  /** The user's latest validated candidate profile (null = none). */
  candidateProfile: CandidateProfile | null;
  completeness: ProfileCompleteness | null;
  nextAction: NextAction;
  savedPreview: SavedPreviewItem[];
  recentApplications: RecentApplication[];
  recommendations: DashboardRecommendations;
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

function scrub(message: string): string {
  return message
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+/gi, "Bearer [redacted]")
    .replace(
      /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
      "[redacted-jwt]",
    );
}

export async function getDashboardData(userId: string): Promise<DashboardData> {
  const supabase = await createClient();
  const admin = createAdminClient();
  const [
    profileResult,
    usageResult,
    applicationsResult,
    activityResult,
    emailAccountResult,
    scanResult,
    candidateProfileResult,
    savedResult,
    usageSnapshotResult,
  ] = await Promise.all([
    supabase.from("profiles").select("*").eq("id", userId).single<Profile>(),
    supabase.rpc("get_or_create_daily_usage").single<DailyUsage>(),
    // "Applications prepared" counts real composer drafts (the legacy
    // `applications` table is never written by the product).
    supabase
      .from("application_drafts")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId),
    supabase
      .from("activity_logs")
      .select("id, activity_type, title, description, metadata, created_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(8),
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
      .select("profile_json, updated_at")
      .eq("user_id", userId)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    // Best-effort: the dashboard must not fail if the saved list errors.
    listSavedOpportunities(userId).catch(() => []),
    // Server-side quota (single source of truth — no duplicated logic).
    getUsageSnapshot(userId).catch(() => null),
  ]);

  // Every strict query failure is logged with the exact PostgREST reason
  // (target + error) before throwing — a broken production access contract
  // (missing RLS policy/grant, missing RPC, missing table) must be
  // diagnosable from the Vercel logs, not only from a generic UI error.
  if (profileResult.error) {
    console.error(
      `[dashboard] query failed target="profiles" error="${scrub(profileResult.error.message)}"`,
    );
    throw new Error("Unable to load your profile.");
  }
  if (usageResult.error) {
    console.error(
      `[dashboard] query failed target="get_or_create_daily_usage" error="${scrub(usageResult.error.message)}"`,
    );
    throw new Error("Unable to load daily usage.");
  }
  if (applicationsResult.error) {
    console.error(
      `[dashboard] query failed target="application_drafts" error="${scrub(applicationsResult.error.message)}"`,
    );
    throw new Error("Unable to load applications.");
  }
  if (activityResult.error) {
    console.error(
      `[dashboard] query failed target="activity_logs" error="${scrub(activityResult.error.message)}"`,
    );
    throw new Error("Unable to load recent activity.");
  }
  if (emailAccountResult.error) {
    console.error(
      `[dashboard] query failed target="email_accounts" error="${scrub(emailAccountResult.error.message)}"`,
    );
    throw new Error("Unable to load email account status.");
  }
  if (scanResult.error) {
    console.error(
      `[dashboard] query failed target="bewerbung_scans" error="${scrub(scanResult.error.message)}"`,
    );
    throw new Error("Unable to load scan status.");
  }
  if (candidateProfileResult.error) {
    console.error(
      `[dashboard] query failed target="candidate_profiles" error="${scrub(candidateProfileResult.error.message)}"`,
    );
    throw new Error("Unable to load candidate profile status.");
  }

  // Validate the latest profile server-side; an invalid row means "none".
  let candidateProfile: CandidateProfile | null = null;
  let profileRevision: string | null = null;
  if (candidateProfileResult.data?.profile_json) {
    const parsed = candidateProfileSchema.safeParse(
      candidateProfileResult.data.profile_json,
    );
    if (parsed.success) candidateProfile = parsed.data;
  }
  if (typeof candidateProfileResult.data?.updated_at === "string") {
    profileRevision = candidateProfileResult.data.updated_at;
  }
  const completeness = candidateProfile
    ? evaluateProfileCompleteness(candidateProfile)
    : null;
  const saved = savedResult;
  const savedKeys = new Set(saved.map((row) => row.opportunity_key));
  const matching = buildMatchingSummary(Boolean(candidateProfile), saved);

  const usageSnapshot = usageSnapshotResult ?? {
    date: usageResult.data.date,
    emails_sent: usageResult.data.emails_sent,
    emails_reserved: 0,
    daily_limit: 0,
    remaining: 0,
  };

  // Recent applications: drafts + their persisted campaign/message state.
  const recentApplications = await loadRecentApplications(admin, userId);
  const hasApplicationDraft = recentApplications.some(
    (draft) => draft.has_content,
  );
  const campaign = recentApplications
    .filter((draft) => draft.campaign_id && draft.campaign_status)
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0];

  // Saved preview with Phase 7 staleness semantics (never silently current).
  const savedPreview: SavedPreviewItem[] = saved.slice(0, 5).map((row) => {
    const staleness = evaluateSnapshotStaleness(row, {
      profileUpdatedAt: profileRevision,
      matcherVersion: MATCHER_VERSION,
    });
    return {
      id: row.id,
      opportunity_key: row.opportunity_key,
      title: row.title,
      company_name: row.company_name,
      location: row.location,
      match_score: row.match_score,
      match_status: row.match_status,
      saved_at: row.saved_at,
      savedAtLabel: formatSnapshotDate(row.saved_at),
      stale: staleness.stale,
      staleReasons: staleness.reasons,
    };
  });

  // Recommendations: existing search + matcher v2, server-side only.
  const recommendations = await loadRecommendations(
    candidateProfile,
    userId,
    savedKeys,
  );

  const nextAction = resolveNextAction({
    hasProfile: Boolean(candidateProfile),
    completeness,
    savedTotal: saved.length,
    completeMatchCount: matching.completeCount,
    hasApplicationDraft,
    hasEmailAccount: Boolean(emailAccountResult.data),
    campaign:
      campaign?.campaign_id && campaign?.campaign_status
        ? {
            id: campaign.campaign_id,
            status: campaign.campaign_status,
          }
        : null,
  });

  return {
    profile: profileResult.data,
    usage: usageResult.data,
    usageSnapshot,
    aiLimit: AI_DAILY_REQUEST_LIMIT,
    applicationsCount: applicationsResult.count ?? 0,
    activities: (activityResult.data ?? []) as ActivityLog[],
    emailAccount: emailAccountResult.data as SafeEmailAccount | null,
    hasCompletedScan: (scanResult.count ?? 0) > 0,
    matching,
    candidateProfile,
    completeness,
    nextAction,
    savedPreview,
    recentApplications,
    recommendations,
  };
}

/** Last 5 application drafts (newest first) joined with their recipients,
 *  campaigns, and sent-message timestamps. All reads are user-scoped. */
export async function loadRecentApplications(
  admin: ReturnType<typeof createAdminClient>,
  userId: string,
  limit = 5,
): Promise<RecentApplication[]> {
  const { data: drafts, error } = await admin
    .from("application_drafts")
    .select(
      "id, goal, subject, body_text, created_at, updated_at, opportunity_key, opportunity_title, opportunity_company",
    )
    .eq("user_id", userId)
    .order("updated_at", { ascending: false })
    .limit(limit);
  if (error || !drafts || drafts.length === 0) return [];

  const draftIds = drafts.map((draft) => draft.id as string);
  const [recipientsResult, campaignsResult] = await Promise.all([
    admin
      .from("application_draft_recipients")
      .select("draft_id, email, company_name")
      .in("draft_id", draftIds),
    admin
      .from("email_campaigns")
      // Single literal: Supabase's typed client needs a literal select.
      .select(
        "id, draft_id, status, created_at, updated_at, email_account_id, total_recipients, queued_count, sending_count, sent_count, failed_count, cancelled_count",
      )
      .in("draft_id", draftIds)
      .order("updated_at", { ascending: false }),
  ]);

  const campaignRows = (campaignsResult.data ?? []) as Array<{
    id: string;
    draft_id: string;
    status: string;
    created_at: string;
    updated_at: string;
    email_account_id: string | null;
    total_recipients: number | null;
    queued_count: number | null;
    sending_count: number | null;
    sent_count: number | null;
    failed_count: number | null;
    cancelled_count: number | null;
  }>;

  // Sender addresses for those accounts (address only — safe to display).
  const senderByAccount = new Map<string, string>();
  const accountIds = [
    ...new Set(
      campaignRows
        .map((row) => row.email_account_id)
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  if (accountIds.length > 0) {
    const { data: accounts } = await admin
      .from("email_accounts")
      .select("id, email_address")
      .in("id", accountIds);
    for (const account of (accounts ?? []) as Array<{
      id: string;
      email_address: string;
    }>)
      senderByAccount.set(account.id, account.email_address);
  }
  const sentAtByCampaign = new Map<string, string | null>();
  if (campaignRows.length > 0) {
    const { data: messages } = await admin
      .from("email_messages")
      .select("campaign_id, sent_at")
      .in(
        "campaign_id",
        campaignRows.map((row) => row.id),
      )
      .not("sent_at", "is", null);
    for (const message of (messages ?? []) as Array<{
      campaign_id: string;
      sent_at: string;
    }>) {
      const current = sentAtByCampaign.get(message.campaign_id) ?? null;
      if (!current || message.sent_at > current) {
        sentAtByCampaign.set(message.campaign_id, message.sent_at);
      }
    }
  }

  const recipientsByDraft = new Map<
    string,
    Array<{ email: string; company_name: string | null }>
  >();
  for (const recipient of (recipientsResult.data ?? []) as Array<{
    draft_id: string;
    email: string;
    company_name: string | null;
  }>) {
    const list = recipientsByDraft.get(recipient.draft_id) ?? [];
    list.push({ email: recipient.email, company_name: recipient.company_name });
    recipientsByDraft.set(recipient.draft_id, list);
  }

  const campaignByDraft = new Map<string, (typeof campaignRows)[number]>();
  for (const row of campaignRows) {
    if (!campaignByDraft.has(row.draft_id))
      campaignByDraft.set(row.draft_id, row);
  }

  return (drafts as Array<Record<string, unknown>>).map((draft) => {
    const recipients = recipientsByDraft.get(draft.id as string) ?? [];
    const campaignRow = campaignByDraft.get(draft.id as string);
    return {
      id: draft.id as string,
      subject: String(draft.subject ?? ""),
      company:
        (draft.opportunity_company as string | null) ??
        recipients[0]?.company_name ??
        null,
      goal: String(draft.goal ?? ""),
      opportunity_key: (draft.opportunity_key as string | null) ?? null,
      opportunity_title: (draft.opportunity_title as string | null) ?? null,
      created_at: draft.created_at as string,
      updated_at: draft.updated_at as string,
      has_content:
        String(draft.subject ?? "").trim().length > 0 ||
        String(draft.body_text ?? "").trim().length > 0,
      campaign_id: campaignRow?.id ?? null,
      campaign_status: campaignRow?.status ?? null,
      sent_at: campaignRow
        ? (sentAtByCampaign.get(campaignRow.id) ?? null)
        : null,
      total_recipients: campaignRow?.total_recipients ?? null,
      queued_count: campaignRow?.queued_count ?? null,
      sending_count: campaignRow?.sending_count ?? null,
      sent_count: campaignRow?.sent_count ?? null,
      failed_count: campaignRow?.failed_count ?? null,
      cancelled_count: campaignRow?.cancelled_count ?? null,
      sender_email: campaignRow?.email_account_id
        ? (senderByAccount.get(campaignRow.email_account_id) ?? null)
        : null,
      campaign_updated_at: campaignRow?.updated_at ?? null,
    };
  });
}

async function loadRecommendations(
  candidateProfile: CandidateProfile | null,
  userId: string,
  savedKeys: Set<string>,
): Promise<DashboardRecommendations> {
  if (!candidateProfile) {
    return { available: false, blockedReason: "no_profile", items: [] };
  }
  const query = buildRecommendationQuery(candidateProfile);
  if (!query) {
    return { available: false, blockedReason: "no_keyword", items: [] };
  }
  try {
    const response = await searchOpportunities(query, { userId });
    const items: RecommendationItem[] = response.results
      .map((opportunity) => ({
        opportunity,
        match: opportunity.match ?? null,
        saved: savedKeys.has(opportunity.id),
      }))
      .slice(0, 6);
    return { available: true, blockedReason: null, items };
  } catch {
    // The source may be unavailable — show an explicit empty state instead
    // of inventing items.
    return { available: false, blockedReason: "search_failed", items: [] };
  }
}

export function getProfileCompletion(profile: Profile) {
  const fields = [profile.full_name, profile.email, profile.selected_goal];
  return Math.round((fields.filter(Boolean).length / fields.length) * 100);
}
