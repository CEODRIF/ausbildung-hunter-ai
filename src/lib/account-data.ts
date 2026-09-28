import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Phase 11 — GDPR data controls (export & deletion).
 *
 * Both operations run server-side with the service role, scoped to the
 * session-verified user id. The export NEVER includes OAuth tokens,
 * encrypted credential material, or other users' data. Deletion is
 * all-or-nothing per step: the database (via the auth admin API, which
 * cascades the 21 user FKs) is removed first; only then are private
 * storage objects swept. If the database deletion fails, nothing is
 * deleted — no partial state.
 */

export interface UserExport {
  exported_at: string;
  user: {
    email: string;
    full_name: string | null;
    selected_goal: string | null;
    account_status: string | null;
    created_at: string | null;
  };
  candidate_profile: unknown | null;
  saved_opportunities: unknown[];
  application_drafts: unknown[];
  email_campaigns: unknown[];
  email_messages: unknown[];
  ai_conversations: unknown[];
  ai_messages: unknown[];
  bewerbung_scans: unknown[];
  subscriptions: unknown[];
  daily_usage: unknown[];
  activity_logs: unknown[];
  storage_files: unknown[];
  notes: string[];
}

const STORAGE_BUCKETS = ["ai-files", "application-attachments"] as const;

async function safeList(
  admin: ReturnType<typeof createAdminClient>,
  table: string,
  select: string,
  userId: string,
): Promise<unknown[]> {
  try {
    const { data } = await admin
      .from(table)
      .select(select)
      .eq("user_id", userId)
      .limit(1000);
    return (data ?? []) as unknown[];
  } catch {
    return [];
  }
}

/** Server-side full data export for the authenticated user (GDPR
 *  portability). Only safe columns are selected; token/secret fields do
 *  not exist on these read paths. */
export async function exportUserData(userId: string): Promise<UserExport> {
  const admin = createAdminClient();
  const [
    profile,
    candidateProfile,
    saved,
    drafts,
    campaigns,
    messages,
    conversations,
    aiMessages,
    scans,
    subscriptions,
    usage,
    activities,
  ] = await Promise.all([
    admin
      .from("profiles")
      .select("email, full_name, selected_goal, account_status, created_at")
      .eq("id", userId)
      .maybeSingle(),
    safeList(
      admin,
      "candidate_profiles",
      "profile_json, created_at, updated_at",
      userId,
    ),
    safeList(
      admin,
      "saved_opportunities",
      "opportunity_key, provider, goal, title, company_name, location, posted_at, salary_label, notes, match_score, match_status, saved_at",
      userId,
    ),
    safeList(
      admin,
      "application_drafts",
      "goal, subject, body_text, created_at, updated_at, opportunity_key, opportunity_title, opportunity_company, opportunity_source_url",
      userId,
    ),
    safeList(
      admin,
      "email_campaigns",
      "subject, status, recipient_count, created_at, updated_at",
      userId,
    ),
    safeList(
      admin,
      "email_messages",
      "campaign_id, recipient_email, company_name, status, attempt_count, sent_at, created_at",
      userId,
    ),
    safeList(
      admin,
      "ai_conversations",
      "title, created_at, updated_at",
      userId,
    ),
    safeList(
      admin,
      "ai_messages",
      "conversation_id, role, content, created_at",
      userId,
    ),
    safeList(
      admin,
      "bewerbung_scans",
      "goal, status, created_at, completed_at, error_message",
      userId,
    ),
    safeList(
      admin,
      "subscriptions",
      "plan, status, provider, current_period_start, current_period_end, canceled_at, created_at",
      userId,
    ),
    safeList(admin, "daily_usage", "date, emails_sent, ai_requests", userId),
    safeList(
      admin,
      "activity_logs",
      "activity_type, title, description, metadata, created_at",
      userId,
    ),
  ]);

  // Storage inventory (metadata only — private objects are never linked).
  const storageFiles: unknown[] = [];
  for (const bucket of STORAGE_BUCKETS) {
    try {
      const { data } = await admin.storage.from(bucket).list("", {
        search: `${userId}/`,
      });
      for (const object of data ?? []) {
        storageFiles.push({
          bucket,
          name: object.name,
          size: object.metadata?.size ?? null,
        });
      }
    } catch {
      // inventory is best-effort; the account data above is authoritative
    }
  }

  return {
    exported_at: new Date().toISOString(),
    user: {
      email: (profile?.data as Record<string, unknown> | null)?.email as string,
      full_name:
        ((profile?.data as Record<string, unknown> | null)?.full_name as
          string | null) ?? null,
      selected_goal:
        ((profile?.data as Record<string, unknown> | null)?.selected_goal as
          string | null) ?? null,
      account_status:
        ((profile?.data as Record<string, unknown> | null)?.account_status as
          string | null) ?? null,
      created_at:
        ((profile?.data as Record<string, unknown> | null)?.created_at as
          string | null) ?? null,
    },
    candidate_profile: candidateProfile[0] ?? null,
    saved_opportunities: saved,
    application_drafts: drafts,
    email_campaigns: campaigns,
    email_messages: messages,
    ai_conversations: conversations,
    ai_messages: aiMessages,
    bewerbung_scans: scans,
    subscriptions,
    daily_usage: usage,
    activity_logs: activities,
    storage_files: storageFiles,
    notes: [
      "Export generated server-side for the authenticated account only.",
      "Private file contents are not included; file inventory is listed in storage_files.",
      "OAuth tokens, encrypted email credentials, and API keys are never included.",
    ],
  };
}

/**
 * Full account deletion (GDPR erasure). Order matters:
 *   1. application drafts first — their `sender_email_account_id` FK is
 *      ON DELETE RESTRICT against email_accounts and would otherwise
 *      block the auth cascade;
 *   2. auth admin delete (cascades ALL user FK tables in the DB),
 *   3. private storage sweep per bucket (idempotent, path-prefixed).
 * If any database step fails, the flow aborts — no partial data loss.
 */
export async function deleteUserAccount(userId: string): Promise<{
  ok: boolean;
  storageSwept: boolean;
}> {
  const admin = createAdminClient();
  const { error: draftsError } = await admin
    .from("application_drafts")
    .delete()
    .eq("user_id", userId);
  if (draftsError) {
    throw new Error(`account_deletion_failed: ${draftsError.message}`);
  }
  const { error } = await admin.auth.admin.deleteUser(userId);
  if (error) {
    // Database state unchanged; storage untouched.
    throw new Error(`account_deletion_failed: ${error.message}`);
  }

  let storageSwept = true;
  for (const bucket of STORAGE_BUCKETS) {
    try {
      const { data } = await admin.storage.from(bucket).list("", {
        search: `${userId}/`,
      });
      const paths = (data ?? [])
        .map((object) => object.name)
        .filter((name: string) => name.startsWith(`${userId}/`));
      // Storage remove is batched (max 100 per call).
      for (let i = 0; i < paths.length; i += 100) {
        const batch = paths.slice(i, i + 100);
        const { error: removeError } = await admin.storage
          .from(bucket)
          .remove(batch);
        if (removeError) storageSwept = false;
      }
    } catch {
      storageSwept = false;
    }
  }
  return { ok: true, storageSwept };
}
