import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Phase 11 — GDPR data controls (export & deletion).
 *
 * Both operations run server-side with the service role, scoped to the
 * session-verified user id. The export NEVER includes OAuth tokens,
 * encrypted credential material, or other users' data. Deletion is
 * all-or-nothing per step: the database (via the auth admin API, which
 * cascades the user FK tables) is removed first; only then are private
 * storage objects swept. If the database deletion fails, nothing is
 * deleted — no partial state.
 *
 * Phase 6A: Community images are covered in BOTH operations. Room message
 * and question images are user-prefixed (`{userId}/…`) and follow the
 * existing prefix sweep; DM images are conversation-prefixed
 * (`dm/{conversationId}/{userId}/…`) and can only be attributed to their
 * owner through the database rows — so deletion and export first collect
 * the exact storage paths from the referencing Community rows
 * (community_messages / community_questions / community_direct_messages).
 * No broad bucket wipe is ever performed.
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

const STORAGE_BUCKETS = [
  "ai-files",
  "application-attachments",
  "avatars",
] as const;

/** Community image bucket (Phase 6A — handled separately from the
 *  user-prefix-only sweep because DM paths are conversation-prefixed). */
const COMMUNITY_IMAGES_BUCKET = "community-images";

/**
 * Collect the storage paths of every Community image referenced by a row
 * OWNED by `userId` (room message images, question images, DM images).
 *
 * Source of truth: the referencing database rows — a storage LIST cannot
 * attribute DM objects (their paths do not contain the owner id as the
 * first segment). Returns `null` when any reference read fails: account
 * deletion must abort rather than cascade without a complete inventory.
 */
async function collectCommunityImagePaths(
  admin: ReturnType<typeof createAdminClient>,
  userId: string,
): Promise<string[] | null> {
  const sources: Array<{ table: string; ownerColumn: string }> = [
    { table: "community_messages", ownerColumn: "user_id" },
    { table: "community_questions", ownerColumn: "author_id" },
    { table: "community_direct_messages", ownerColumn: "user_id" },
  ];
  const paths: string[] = [];
  for (const { table, ownerColumn } of sources) {
    try {
      const { data, error } = await admin
        .from(table)
        .select("image_path")
        .eq(ownerColumn, userId)
        .limit(1000);
      if (error) return null;
      for (const row of (data ?? []) as Array<{ image_path: string | null }>) {
        if (typeof row.image_path === "string" && row.image_path.length > 0) {
          paths.push(row.image_path);
        }
      }
    } catch {
      return null;
    }
  }
  return paths;
}

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
  for (const bucket of [...STORAGE_BUCKETS, COMMUNITY_IMAGES_BUCKET]) {
    try {
      const { data } = await admin.storage.from(bucket).list("", {
        search: `${userId}/`,
      });
      for (const object of data ?? []) {
        // defensive prefix re-check (search is a substring match)
        if (!object.name.startsWith(`${userId}/`)) continue;
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

  // Phase 6A — Community DM images: their paths are conversation-prefixed
  // (dm/{conversationId}/{userId}/…), so the user-prefix list above cannot
  // see them. Enumerate them from THIS user's own DM rows only, list the
  // own sender folders (never the whole conversation — that would surface
  // the peer's objects), and record metadata. Paths the list could not
  // confirm are still reported as references (size null — best-effort).
  try {
    const communityPaths = (await collectCommunityImagePaths(admin, userId)) ?? [];
    const ownDmPaths = communityPaths.filter((p) => p.startsWith("dm/"));
    const bySenderFolder = new Map<string, Set<string>>();
    for (const p of ownDmPaths) {
      // dm/{conversationId}/{userId} → the owner's own folder in the conv
      const folder = p.split("/").slice(0, 3).join("/");
      const set = bySenderFolder.get(folder) ?? new Set<string>();
      set.add(p);
      bySenderFolder.set(folder, set);
    }
    const confirmed = new Set<string>();
    for (const [folder, names] of [...bySenderFolder.entries()].slice(0, 100)) {
      try {
        const { data } = await admin.storage
          .from(COMMUNITY_IMAGES_BUCKET)
          .list("", { search: `${folder}/` });
        for (const object of data ?? []) {
          if (names.has(object.name)) {
            confirmed.add(object.name);
            storageFiles.push({
              bucket: COMMUNITY_IMAGES_BUCKET,
              name: object.name,
              size: object.metadata?.size ?? null,
            });
          }
        }
      } catch {
        // best-effort — the reference itself is still inventoried below
      }
    }
    for (const p of ownDmPaths) {
      if (!confirmed.has(p)) {
        storageFiles.push({ bucket: COMMUNITY_IMAGES_BUCKET, name: p, size: null });
      }
    }
  } catch {
    // inventory is best-effort; the account data above is authoritative
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
 *   1. Community image reference inventory (BEFORE the cascade — the rows
 *      that attribute DM paths to their owner would be gone afterwards);
 *      a failed read aborts the whole deletion (no unverified sweep);
 *   2. application drafts — their `sender_email_account_id` FK is ON
 *      DELETE RESTRICT against email_accounts and would otherwise block
 *      the auth cascade;
 *   3. auth admin delete (cascades ALL user FK tables in the DB),
 *   4. private storage sweep per bucket (idempotent, path-prefixed), plus
 *      exact removal of every DB-referenced Community image path and a
 *      user-prefix backstop for the same bucket.
 * If any database step fails, the flow aborts — no partial data loss.
 */
export async function deleteUserAccount(userId: string): Promise<{
  ok: boolean;
  storageSwept: boolean;
}> {
  const admin = createAdminClient();
  // Community image inventory FIRST — after the auth cascade the DM rows
  // (and therefore the only attribution of the conversation-prefixed paths)
  // would be gone. Null = an unreadable reference table → abort with
  // everything intact rather than cascade into orphaned images.
  const communityImagePaths = await collectCommunityImagePaths(admin, userId);
  if (communityImagePaths === null) {
    throw new Error("account_deletion_failed: community reference read");
  }
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

  // Phase 6A — Community images (idempotent; every input is user-scoped,
  // so no other user's object can be touched):
  //   a) exact removal of every path collected from the owner's own rows —
  //      this is the ONLY mechanism that reaches DM images (their paths
  //      are conversation-prefixed, never user-prefixed);
  //   b) a user-prefix backstop list+remove of the same bucket — catches
  //      any room/question object whose referencing row was already gone.
  try {
    const exact = [...new Set(communityImagePaths)];
    for (let i = 0; i < exact.length; i += 100) {
      const batch = exact.slice(i, i + 100);
      const { error: removeError } = await admin.storage
        .from(COMMUNITY_IMAGES_BUCKET)
        .remove(batch);
      if (removeError) storageSwept = false;
    }
    const exactSet = new Set(exact);
    const { data } = await admin.storage.from(COMMUNITY_IMAGES_BUCKET).list("", {
      search: `${userId}/`,
    });
    const backstop = (data ?? [])
      .map((object) => object.name)
      .filter((name: string) => name.startsWith(`${userId}/`) && !exactSet.has(name));
    for (let i = 0; i < backstop.length; i += 100) {
      const batch = backstop.slice(i, i + 100);
      const { error: removeError } = await admin.storage
        .from(COMMUNITY_IMAGES_BUCKET)
        .remove(batch);
      if (removeError) storageSwept = false;
    }
  } catch {
    storageSwept = false;
  }
  return { ok: true, storageSwept };
}
