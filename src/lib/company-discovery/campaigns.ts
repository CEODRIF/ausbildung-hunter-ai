import "server-only";

import { emailDedupeKey, normalizeOpportunityEmail } from "@/lib/opportunities/email-export";
import { createAdminClient } from "@/lib/supabase/admin";
import { classifyDiscoveryDbError, type DiscoveryErrorCode } from "./errors";
import { getDiscoveryRunStrict } from "./runs";

/**
 * The Company Discovery → Email Campaign bridge.
 *
 * Design decision: a campaign is NOT duplicated. Company Discovery creates the
 * SAME persisted draft the composer uses (`application_drafts` +
 * `application_draft_recipients`), linked to the run via `discovery_run_id`.
 * The draft therefore survives a refresh or a re-login, appears in the
 * applications history immediately as a draft, can be finished in the normal
 * composer, and is turned into a campaign by the EXISTING send flow — which
 * copies the run link onto the campaign row. No parallel campaign model, no
 * invented recipients, no email sent by this module.
 */

/** One campaign of the user, with the run it was built from. */
export interface DiscoveryCampaignRow {
  campaignId: string;
  draftId: string;
  /** Draft subject, else the opportunity title, else empty. */
  title: string;
  status: string;
  totalRecipients: number;
  sentCount: number;
  failedCount: number;
  createdAt: string;
  /** completed_at ?? started_at ?? created_at — the honest last touch. */
  updatedAt: string;
  discoveryRunId: string | null;
}

export type CreateDiscoveryDraftResult =
  | { ok: true; draftId: string }
  | { ok: false; code: DiscoveryErrorCode | "no_email_account" };

/**
 * The most recent campaigns of the user (the "Previous Campaigns" panel).
 * Persisted rows only — this list is identical after a refresh or a re-login.
 */
export async function listRecentDiscoveryCampaigns(
  userId: string,
  limit = 5,
): Promise<DiscoveryCampaignRow[]> {
  const admin = createAdminClient();
  const { data: campaigns, error } = await admin
    .from("email_campaigns")
    .select(
      "id, draft_id, status, total_recipients, sent_count, failed_count, created_at, started_at, completed_at, discovery_run_id",
    )
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  const rows = campaigns ?? [];
  if (rows.length === 0) return [];

  const draftIds = [...new Set(rows.map((row) => row.draft_id as string))];
  const { data: drafts, error: draftError } = await admin
    .from("application_drafts")
    .select("id, subject, opportunity_title")
    .in("id", draftIds);
  if (draftError) throw draftError;
  const titleById = new Map(
    (drafts ?? []).map((draft) => [
      draft.id as string,
      (draft.subject as string).trim() ||
        ((draft.opportunity_title as string | null) ?? ""),
    ]),
  );

  return rows.map((row) => ({
    campaignId: row.id as string,
    draftId: row.draft_id as string,
    title: titleById.get(row.draft_id as string) ?? "",
    status: row.status as string,
    totalRecipients: Number(row.total_recipients ?? 0),
    sentCount: Number(row.sent_count ?? 0),
    failedCount: Number(row.failed_count ?? 0),
    createdAt: row.created_at as string,
    updatedAt: (row.completed_at ?? row.started_at ?? row.created_at) as string,
    discoveryRunId: (row.discovery_run_id as string | null) ?? null,
  }));
}

/**
 * Turn a Company Discovery selection into a persisted composer draft.
 *
 * Only addresses the run actually stored are accepted (`normalizeOpportunityEmail`
 * re-validates them and duplicates are collapsed), the run must belong to the
 * user, and a real sender account must exist — otherwise the caller gets a
 * machine code and the UI says exactly what is missing. Nothing is invented
 * and no message is sent here.
 */
export async function createDiscoveryDraft(input: {
  userId: string;
  runId: string;
  recipients: Array<{ email: string; companyName?: string | null }>;
}): Promise<CreateDiscoveryDraftResult> {
  try {
    const run = await getDiscoveryRunStrict(input.runId, input.userId);
    if (!run) return { ok: false, code: "not_found" };

    const seen = new Set<string>();
    const recipients: Array<{ email: string; companyName: string | null }> = [];
    for (const entry of input.recipients) {
      const email = normalizeOpportunityEmail(entry.email);
      if (!email) continue;
      const key = emailDedupeKey(email);
      if (seen.has(key)) continue;
      seen.add(key);
      recipients.push({ email, companyName: entry.companyName ?? null });
    }
    if (recipients.length === 0) return { ok: false, code: "invalid_params" };

    const admin = createAdminClient();
    const { data: account, error: accountError } = await admin
      .from("email_accounts")
      .select("id")
      .eq("user_id", input.userId)
      .eq("is_active", true)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (accountError) throw accountError;
    if (!account) return { ok: false, code: "no_email_account" };

    const { data: draft, error: draftError } = await admin
      .from("application_drafts")
      .insert({
        user_id: input.userId,
        goal: run.params.goal === "arbeit" ? "arbeit" : "ausbildung",
        sender_email_account_id: account.id as string,
        subject: "",
        body_html: "",
        body_text: "",
        discovery_run_id: input.runId,
      })
      .select("id")
      .single<{ id: string }>();
    if (draftError || !draft) throw draftError ?? new Error("draft insert failed");

    const { error: recipientError } = await admin
      .from("application_draft_recipients")
      .insert(
        recipients.map((recipient) => ({
          draft_id: draft.id,
          email: recipient.email,
          company_name: recipient.companyName,
          validation_status: "valid" as const,
        })),
      );
    if (recipientError) throw recipientError;

    return { ok: true, draftId: draft.id };
  } catch (error) {
    return { ok: false, code: classifyDiscoveryDbError(error) };
  }
}
