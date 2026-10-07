import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

/**
 * Community Phase 5 — user reports.
 *
 *   * The INSERT runs on the SESSION client: RLS makes it impossible to
 *     file a report as someone else (reporter_id = auth.uid() with check)
 *     and to read anyone else's report (select own-only).
 *   * The TARGET is validated server-side (admin client): it must exist
 *     and match its type — arbitrary UUIDs are rejected, and the reporter
 *     can never report their OWN content (self-report abuse).
 *   * DMs are NOT a reportable target (the target_type enum simply has no
 *     DM value — they never enter the public moderation feed).
 *   * Anti-duplicate: a partial unique index allows at most ONE pending
 *     (open/reviewing) report per (reporter, target) — the 23505 surfaces
 *     as a friendly "already reported" result.
 *   * Rate limiting (community_report, 5/min) is applied by the route.
 */

type SessionClient = Awaited<ReturnType<typeof createClient>>;

export const REPORT_REASONS = [
  "spam",
  "harassment",
  "hate",
  "scam",
  "misinformation",
  "sexual_content",
  "illegal_content",
  "impersonation",
  "other",
] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];

export const REPORT_TARGET_TYPES = ["message", "question", "answer", "profile"] as const;
export type ReportTargetType = (typeof REPORT_TARGET_TYPES)[number];

export type ReportStatus = "open" | "reviewing" | "resolved" | "dismissed";

export interface CommunityReportRow {
  id: string;
  reporter_id: string;
  target_type: ReportTargetType;
  target_id: string;
  reason: ReportReason;
  details: string | null;
  status: ReportStatus;
  assigned_to: string | null;
  created_at: string;
  resolved_at: string | null;
}

export type ReportCreateError =
  | "invalid"
  | "target_not_found"
  | "self_report"
  | "duplicate"
  | "failed";

function isKnownReason(value: unknown): value is ReportReason {
  return typeof value === "string" && (REPORT_REASONS as readonly string[]).includes(value);
}

function isKnownTarget(value: unknown): value is ReportTargetType {
  return typeof value === "string" && (REPORT_TARGET_TYPES as readonly string[]).includes(value);
}

/**
 * File ONE report. The reporter id ALWAYS comes from the session; the
 * target is verified to exist (and to be foreign) before the insert.
 */
export async function createReport(
  supabase: SessionClient,
  reporterId: string,
  input: {
    targetType: string;
    targetId: string;
    reason: string;
    details?: string;
  },
): Promise<{ ok: true; report: CommunityReportRow } | { ok: false; error: ReportCreateError }> {
  const targetType = isKnownTarget(input.targetType) ? input.targetType : null;
  const reason = isKnownReason(input.reason) ? input.reason : null;
  const details = input.details?.trim() ?? "";
  const uuidValue = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!targetType || !reason || details.length > 500 || !uuidValue.test(input.targetId)) {
    return { ok: false, error: "invalid" };
  }

  // Target existence + self-report check (service role: hidden/deleted
  // targets stay checkable, which the session client would not show).
  try {
    const admin = createAdminClient();
    let targetUserId: string | null = null;
    let exists = false;
    if (targetType === "message") {
      const { data, error } = await admin
        .from("community_messages")
        .select("id,user_id")
        .eq("id", input.targetId)
        .maybeSingle();
      if (error) return { ok: false, error: "failed" };
      exists = Boolean(data);
      targetUserId = (data as { user_id: string } | null)?.user_id ?? null;
    } else if (targetType === "question") {
      const { data, error } = await admin
        .from("community_questions")
        .select("id,author_id")
        .eq("id", input.targetId)
        .maybeSingle();
      if (error) return { ok: false, error: "failed" };
      exists = Boolean(data);
      targetUserId = (data as { author_id: string } | null)?.author_id ?? null;
    } else if (targetType === "answer") {
      const { data, error } = await admin
        .from("community_answers")
        .select("id,author_id")
        .eq("id", input.targetId)
        .maybeSingle();
      if (error) return { ok: false, error: "failed" };
      exists = Boolean(data);
      targetUserId = (data as { author_id: string } | null)?.author_id ?? null;
    } else {
      // profile
      const { data, error } = await admin
        .from("community_profiles")
        .select("id,user_id")
        .eq("user_id", input.targetId)
        .maybeSingle();
      if (error) return { ok: false, error: "failed" };
      exists = Boolean(data);
    }
    if (!exists) return { ok: false, error: "target_not_found" };
    if (targetUserId === reporterId) return { ok: false, error: "self_report" };

    const { data: row, error: insertError } = await supabase
      .from("community_reports")
      .insert({
        reporter_id: reporterId,
        target_type: targetType,
        target_id: input.targetId,
        reason,
        details: details.length > 0 ? details : null,
      })
      .select(
        "id,reporter_id,target_type,target_id,reason,details,status,assigned_to,created_at,resolved_at",
      )
      .single();
    if (insertError) {
      if ((insertError as { code?: string }).code === "23505") {
        return { ok: false, error: "duplicate" };
      }
      console.error("[community] report insert failed:", insertError.message);
      return { ok: false, error: "failed" };
    }
    return { ok: true, report: row as CommunityReportRow };
  } catch (error) {
    console.error("[community] create report threw:", error);
    return { ok: false, error: "failed" };
  }
}

/**
 * The reporter's OWN reports (session client → RLS own-only), newest
 * first, bounded. This is the ONLY user-facing report read path.
 */
export async function fetchMyReports(
  supabase: SessionClient,
  reporterId: string,
  limit = 20,
): Promise<CommunityReportRow[]> {
  try {
    const { data, error } = await supabase
      .from("community_reports")
      .select(
        "id,reporter_id,target_type,target_id,reason,details,status,assigned_to,created_at,resolved_at",
      )
      .eq("reporter_id", reporterId)
      .order("created_at", { ascending: false })
      .limit(Math.min(Math.max(limit, 1), 50));
    if (error || !data) return [];
    // The DB CHECK constraints guarantee every stored value is valid.
    return data as CommunityReportRow[];
  } catch (error) {
    console.error("[community] my reports threw:", error);
    return [];
  }
}
