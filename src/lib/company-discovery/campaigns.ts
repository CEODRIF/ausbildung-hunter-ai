import "server-only";

import { emailDedupeKey, normalizeOpportunityEmail } from "@/lib/opportunities/email-export";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  classifyDiscoveryDbError,
  isUnknownColumnError,
  type DiscoveryErrorCode,
} from "./errors";
import { getDiscoveryRunStrict } from "./runs";

/**
 * The Company Discovery → Email Campaign bridge.
 *
 * Design decision: a campaign is NOT duplicated. Company Discovery creates the
 * SAME persisted draft the composer uses (`application_drafts` +
 * `application_draft_recipients`), linked to the run via `discovery_run_id`.
 * That draft therefore survives a refresh, leaving the page or a re-login,
 * appears in the history immediately as a `draft` row (before any campaign
 * exists), can be finished in the normal composer, and is turned into a
 * campaign by the EXISTING send flow — which copies the run link onto the
 * campaign row. No parallel campaign model, no invented recipients, nothing
 * sent by this module.
 *
 * Schema drift is handled explicitly: `discovery_run_id` arrives with
 * `supabase/migrations/20261018000000_company_discovery_emails_link.sql`. On a
 * database that has not received it yet, PostgREST rejects the statement
 * (`PGRST204`, unknown column) — so the write is retried WITHOUT the link and
 * the loss is logged loudly, because losing the user's draft would be far
 * worse than losing its provenance. Every degraded path is also reported to
 * the caller (`linked:false`, or rows with `discoveryRunId: null`).
 */

/** The migration that adds the run links to drafts and campaigns. */
const LINK_MIGRATION =
  "supabase/migrations/20261018000000_company_discovery_emails_link.sql";

/** One campaign — or one discovery-linked draft that is not sent yet. */
export interface DiscoveryCampaignRow {
  /** Empty while the draft has not been turned into a campaign yet. */
  campaignId: string;
  draftId: string;
  /** Draft subject, else the opportunity title, else empty. */
  title: string;
  status: string;
  totalRecipients: number;
  sentCount: number;
  failedCount: number;
  createdAt: string;
  /** completed_at ?? started_at ?? created_at (campaigns), updated_at (drafts). */
  updatedAt: string;
  /** null on a database without the link migration. */
  discoveryRunId: string | null;
}

export type CreateDiscoveryDraftResult =
  | { ok: true; draftId: string; /** false when the run link could not be stored. */ linked: boolean }
  | { ok: false; code: DiscoveryErrorCode | "no_email_account" };

interface CampaignRow {
  id: string;
  draft_id: string;
  status: string;
  total_recipients: number | null;
  sent_count: number | null;
  failed_count: number | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  discovery_run_id?: string | null;
}

interface DraftRow {
  id: string;
  subject: string | null;
  opportunity_title: string | null;
  created_at: string;
  updated_at: string;
  discovery_run_id?: string | null;
}

const CAMPAIGN_COLUMNS =
  "id, draft_id, status, total_recipients, sent_count, failed_count, created_at, started_at, completed_at";
const DRAFT_COLUMNS = "id, subject, opportunity_title, created_at, updated_at";

function draftTitle(draft: DraftRow | undefined): string {
  if (!draft) return "";
  return (
    (draft.subject ?? "").trim() || (draft.opportunity_title ?? "").trim() || ""
  );
}

/**
 * The most recent campaigns of the user PLUS the discovery drafts that have no
 * campaign yet — the "Previous Campaigns" panel. Persisted rows only: the list
 * is identical after a refresh or a re-login, and a draft that was already
 * turned into a campaign is listed once (as that campaign).
 */
export async function listRecentDiscoveryCampaigns(
  userId: string,
  limit = 5,
): Promise<DiscoveryCampaignRow[]> {
  const admin = createAdminClient();

  // ---- campaigns (with a fallback for a database without the link column) --
  let linkedKnown = true;
  let campaigns: CampaignRow[] = [];
  const primary = await admin
    .from("email_campaigns")
    .select(`${CAMPAIGN_COLUMNS}, discovery_run_id`)
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (primary.error && isUnknownColumnError(primary.error)) {
    // The history must still work on a database without the link migration.
    linkedKnown = false;
    console.error(
      `[company-discovery] email_campaigns.discovery_run_id is missing in the database — listing campaigns without their discovery run. Apply ${LINK_MIGRATION}.`,
    );
    const fallback = await admin
      .from("email_campaigns")
      .select(CAMPAIGN_COLUMNS)
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(limit);
    if (fallback.error) throw fallback.error;
    campaigns = (fallback.data ?? []) as unknown as CampaignRow[];
  } else if (primary.error) {
    throw primary.error;
  } else {
    campaigns = (primary.data ?? []) as unknown as CampaignRow[];
  }

  // ---- discovery-linked drafts that are not sent yet ----------------------
  let drafts: DraftRow[] = [];
  if (linkedKnown) {
    const draftQuery = await admin
      .from("application_drafts")
      .select(`${DRAFT_COLUMNS}, discovery_run_id`)
      .eq("user_id", userId)
      .not("discovery_run_id", "is", null)
      .order("updated_at", { ascending: false })
      .limit(limit);
    if (draftQuery.error) {
      if (isUnknownColumnError(draftQuery.error)) {
        linkedKnown = false;
        console.error(
          `[company-discovery] application_drafts.discovery_run_id is missing in the database — discovery drafts cannot be listed. Apply ${LINK_MIGRATION}.`,
        );
      } else {
        throw draftQuery.error;
      }
    } else {
      drafts = (draftQuery.data ?? []) as unknown as DraftRow[];
    }
  }

  const draftIds = [
    ...new Set([
      ...campaigns.map((row) => row.draft_id),
      ...drafts.map((row) => row.id),
    ]),
  ];

  // ---- the titles of every draft involved (campaigns + drafts) ------------
  const titleById = new Map<string, string>();
  if (draftIds.length > 0) {
    const { data: titles, error: titleError } = await admin
      .from("application_drafts")
      .select(DRAFT_COLUMNS)
      .in("id", draftIds);
    if (titleError) throw titleError;
    for (const draft of (titles ?? []) as unknown as DraftRow[]) {
      titleById.set(draft.id, draftTitle(draft));
    }
  }

  // ---- recipient counts for the drafts that are not sent yet -------------
  const draftRecipientCount = new Map<string, number>();
  const unlinkedDrafts = drafts.filter(
    (draft) => !campaigns.some((campaign) => campaign.draft_id === draft.id),
  );
  if (unlinkedDrafts.length > 0) {
    const { data: recipients, error: recipientError } = await admin
      .from("application_draft_recipients")
      .select("draft_id")
      .in(
        "draft_id",
        unlinkedDrafts.map((draft) => draft.id),
      );
    if (recipientError) throw recipientError;
    for (const row of recipients ?? []) {
      const draftId = (row as { draft_id: string }).draft_id;
      draftRecipientCount.set(draftId, (draftRecipientCount.get(draftId) ?? 0) + 1);
    }
  }

  const rows: DiscoveryCampaignRow[] = [
    ...campaigns.map((row) => ({
      campaignId: row.id,
      draftId: row.draft_id,
      title: titleById.get(row.draft_id) ?? "",
      status: row.status,
      totalRecipients: Number(row.total_recipients ?? 0),
      sentCount: Number(row.sent_count ?? 0),
      failedCount: Number(row.failed_count ?? 0),
      createdAt: row.created_at,
      updatedAt: (row.completed_at ?? row.started_at ?? row.created_at) as string,
      discoveryRunId: linkedKnown ? (row.discovery_run_id ?? null) : null,
    })),
    // A discovery draft that has no campaign yet IS the campaign the user just
    // created — it must be visible immediately, marked as a draft.
    ...unlinkedDrafts.map((draft) => ({
      campaignId: "",
      draftId: draft.id,
      title: draftTitle(draft),
      status: "draft",
      totalRecipients: draftRecipientCount.get(draft.id) ?? 0,
      sentCount: 0,
      failedCount: 0,
      createdAt: draft.created_at,
      updatedAt: draft.updated_at,
      discoveryRunId: linkedKnown ? (draft.discovery_run_id ?? null) : null,
    })),
  ];

  return rows
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))
    .slice(0, limit);
}

/**
 * Turn a Company Discovery selection into a persisted composer draft.
 *
 * Only addresses the run actually stored are accepted (`normalizeOpportunityEmail`
 * re-validates them, duplicates collapse), the run must belong to the user, and
 * a real sender account must exist — otherwise the caller gets a machine code
 * and the UI says exactly what is missing. Nothing is invented and no message
 * is sent here.
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

    const base = {
      user_id: input.userId,
      goal: run.params.goal === "arbeit" ? "arbeit" : "ausbildung",
      sender_email_account_id: account.id as string,
      subject: "",
      body_html: "",
      body_text: "",
    };

    let linked = true;
    let inserted = await admin
      .from("application_drafts")
      .insert({ ...base, discovery_run_id: input.runId })
      .select("id")
      .single<{ id: string }>();

    if (inserted.error && isUnknownColumnError(inserted.error)) {
      // The link column is not deployed yet: keep the user's draft, lose only
      // the provenance, and make the drift impossible to miss in the log.
      console.error(
        `[company-discovery] application_drafts.discovery_run_id is missing in the database — saving the draft WITHOUT the run link. Apply ${LINK_MIGRATION}.`,
      );
      linked = false;
      inserted = await admin
        .from("application_drafts")
        .insert(base)
        .select("id")
        .single<{ id: string }>();
    }
    if (inserted.error || !inserted.data) {
      throw inserted.error ?? new Error("draft insert returned no row");
    }

    const { error: recipientError } = await admin
      .from("application_draft_recipients")
      .insert(
        recipients.map((recipient) => ({
          draft_id: inserted.data.id,
          email: recipient.email,
          company_name: recipient.companyName,
          validation_status: "valid" as const,
        })),
      );
    if (recipientError) throw recipientError;

    return { ok: true, draftId: inserted.data.id, linked };
  } catch (error) {
    return { ok: false, code: classifyDiscoveryDbError(error) };
  }
}
