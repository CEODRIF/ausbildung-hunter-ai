import "server-only";

import { randomUUID } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  assertDraftOwnership,
  assertSenderOwnership,
  sanitizeEmailHtml,
  htmlToText,
  validateRecipientList,
  MAX_ATTACHMENT_SIZE,
  DraftQuotaError,
  type ApplicationGoal,
} from "@/lib/application-drafts";
import {
  completeFeatureOp,
  releaseFeatureOp,
  reserveFeatureOp,
} from "@/lib/billing/entitlement-service";
import {
  createEmailProvider,
  type ProviderFailure,
} from "@/lib/email-providers";
import { getCurrentUserAndProfile } from "@/lib/auth";
import {
  SENDER_SLOT_WAIT_BUDGET_MS,
  sendIntervalMs,
} from "@/lib/email-rate-limit";
import {
  PersonalizationError,
  renderPersonalizedMessage,
} from "@/lib/personalization";
import {
  hasCampaignOwnedContent,
  hasContactNameColumn,
} from "@/lib/contact-name-support";

export type CampaignStatus =
  | "draft"
  | "queued"
  | "sending"
  | "completed"
  | "partially_failed"
  | "failed"
  | "cancelled";
export type UsageSnapshot = {
  date: string;
  emails_sent: number;
  emails_reserved: number;
  daily_limit: number;
  remaining: number;
};

export async function getUsageSnapshot(userId: string) {
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("get_daily_usage_snapshot", {
    target_user_id: userId,
  });
  if (error) throw new Error("Unable to load quota.");
  return data as UsageSnapshot;
}

export async function activateQuotaCode(code: string) {
  const current = await getCurrentUserAndProfile();
  if (
    !current.user ||
    !current.profile ||
    current.profile.account_status !== "active"
  )
    throw new Error("Not authorized.");
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("activate_quota_upgrade", {
    target_user_id: current.user.id,
    input_code: code,
  });
  if (error)
    throw new Error(
      error.message.includes("invalid_quota_code")
        ? "That upgrade code is invalid or has already been used."
        : "Unable to activate the quota upgrade.",
    );
  await admin.from("activity_logs").insert({
    user_id: current.user.id,
    activity_type: "quota_upgrade_activated",
    // Generic wording: the same code system also carries search upgrade
    // codes, so the log must not claim a specific entitlement.
    title: "Upgrade code activated",
    description: "A quota upgrade code was activated on this account.",
    metadata: { daily_limit: data },
  });
  return Number(data);
}

/** A server-validated schedule. `utcIso` is the canonical instant the
 *  scheduler must use; `timeZone` is the IANA zone for display/audit;
 *  `usageDate` (UTC) is the daily quota the reservation belongs to. */
export interface CampaignScheduling {
  utcIso: string;
  timeZone: string;
  usageDate: string;
}

export type CampaignRecipientInput = {
  email: string;
  companyName?: string | null;
  /** Explicit user-provided contact person (trusted source only). */
  contactName?: string | null;
};
export type CampaignAttachmentInput = {
  storage_path: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
};

/**
 * Two payload shapes, one engine (Drafts feature removal):
 *
 *  - OWNED (migration 20261110000000 applied): the client submits the FULL
 *    application — subject, body HTML, recipients, staged attachments — and
 *    the campaign stores it self-contained. NO application_draft row is
 *    created, read, updated or referenced (draft_id is written as NULL).
 *  - LEGACY (migration not yet applied): `draftId` + persisted recipients;
 *    the draft stays the content source exactly as before. This path exists
 *    ONLY so deploying the code before the manual migration cannot break
 *    sending (same contract as the contact_name / praktikum probes).
 *
 * The send/schedule server actions pick the shape from the cached probe.
 */
export type CreateCampaignInput =
  | {
      senderAccountId: string;
      goal: ApplicationGoal;
      subject: string;
      bodyHtml: string;
      recipients: CampaignRecipientInput[];
      attachments?: CampaignAttachmentInput[];
      /** When set, the campaign is queued but gated until `utcIso` — it flows
       *  through the same durable worker at the scheduled instant. Omit for
       *  the unchanged immediate-send path. */
      scheduling?: CampaignScheduling;
    }
  | {
      draftId: string;
      senderAccountId: string;
      goal: ApplicationGoal;
      recipientEmails: Array<{ email: string; companyName?: string | null }>;
      scheduling?: CampaignScheduling;
    };

export async function createCampaign(input: CreateCampaignInput) {
  return "draftId" in input
    ? createLegacyCampaign(input)
    : createOwnedCampaign(input);
}

async function createOwnedCampaign(input: {
  senderAccountId: string;
  goal: ApplicationGoal;
  subject: string;
  bodyHtml: string;
  recipients: CampaignRecipientInput[];
  attachments?: CampaignAttachmentInput[];
  scheduling?: CampaignScheduling;
}) {
  const current = await getCurrentUserAndProfile();
  if (
    !current.user ||
    !current.profile ||
    current.profile.account_status !== "active"
  )
    throw new Error("Not authorized.");
  await assertSenderOwnership(current.user.id, input.senderAccountId);
  const admin = createAdminClient();
  // Sanitize with the SAME whitelist every other write path uses; the
  // renderer re-sanitizes before the provider, but the stored template must
  // already be clean (no scripts, no handlers, no foreign schemes).
  const subject = input.subject.trim().slice(0, 500);
  const bodyHtml = sanitizeEmailHtml(input.bodyHtml);
  const bodyText = htmlToText(bodyHtml);
  // Recipients arrive from the client and are re-validated server-side —
  // the single normalization gate (dedupe, invalid marking, length caps).
  // Only `valid` recipients are queued, exactly like the legacy path.
  const recipients = validateRecipientList(input.recipients);
  const validRecipients = recipients.filter(
    (recipient) => recipient.validation_status === "valid",
  );
  if (!subject || !bodyText || validRecipients.length === 0)
    throw new Error(
      "Add a subject, message, and at least one valid recipient before sending.",
    );
  if (validRecipients.length > 1000)
    throw new Error("A campaign cannot contain more than 1,000 recipients.");
  // Attachments are the objects the composer already uploaded to the
  // user's staging prefix; only their metadata is persisted here. Hostile
  // input is dropped field-by-field (never an error for a bad file).
  const attachments = (input.attachments ?? [])
    .filter(
      (item): item is CampaignAttachmentInput =>
        Boolean(item) &&
        typeof item.storage_path === "string" &&
        item.storage_path.length > 0 &&
        item.storage_path.length <= 512 &&
        !item.storage_path.includes("\0") &&
        !item.storage_path.includes(".."),
    )
    .map((item) => ({
      storage_path: item.storage_path,
      filename: String(item.filename ?? "attachment").slice(0, 255),
      mime_type: String(item.mime_type ?? "application/octet-stream").slice(
        0,
        100,
      ),
      size_bytes: Math.trunc(Number(item.size_bytes) || 0),
    }))
    .filter((item) => item.size_bytes > 0 && item.size_bytes <= MAX_ATTACHMENT_SIZE)
    .slice(0, 20);
  // email_drafts quota (1 op = 1 created application email, locked
  // definition). The DRAFT-FREE campaign owns the content and creates no
  // application_draft row, so the metering point is HERE — after every
  // validation (a rejected submission must not consume quota) and before
  // any persistence. `createLegacyCampaign` is deliberately NOT metered:
  // its draft was already metered at `createBlankDraft` time (double-count
  // guard). Reserve is atomic + idempotent per run id; lookup failure is
  // fail-closed. Refunds happen on every failure path below — release only
  // touches `status='reserved'` rows, so an operation that was never
  // successfully reserved is never refunded.
  const draftRunId = randomUUID();
  const draftReservation = await reserveFeatureOp(
    current.user.id,
    "email_drafts",
    draftRunId,
  );
  if (draftReservation.outcome === "quota_exhausted")
    throw new DraftQuotaError("quota_exhausted");
  if (draftReservation.outcome === "feature_disabled")
    throw new DraftQuotaError("feature_disabled");
  if (draftReservation.outcome === "error")
    throw new DraftQuotaError("quota_unavailable");
  const draftMetered =
    draftReservation.outcome === "reserved" ||
    draftReservation.outcome === "already_reserved";
  const releaseDraftQuota = () =>
    draftMetered
      ? releaseFeatureOp(current.user.id, "email_drafts", draftRunId)
      : Promise.resolve({ outcome: "no_op" as const });
  const { data: capacity, error: capacityError } = await admin.rpc(
    input.scheduling ? "reserve_email_capacity_on" : "reserve_email_capacity",
    input.scheduling
      ? {
          target_user_id: current.user.id,
          requested: validRecipients.length,
          on_date: input.scheduling.usageDate,
        }
      : { target_user_id: current.user.id, requested: validRecipients.length },
  );
  if (capacityError) {
    // No campaign was created → the email_drafts slot goes back.
    await releaseDraftQuota();
    throw new Error(
      capacityError.message.includes("daily_quota_exceeded")
        ? "Daily email quota exceeded."
        : "Unable to reserve daily email capacity.",
    );
  }
  const usage = capacity as UsageSnapshot;
  const supportsContactName = await hasContactNameColumn();
  const { data: campaign, error: campaignError } = await admin
    .from("email_campaigns")
    .insert({
      user_id: current.user.id,
      // Draft-free: the campaign owns its content; it references NO draft.
      draft_id: null,
      email_account_id: input.senderAccountId,
      usage_date: usage.date,
      status: "queued",
      total_recipients: validRecipients.length,
      queued_count: validRecipients.length,
      reserved_count: validRecipients.length,
      subject,
      body_html: bodyHtml,
      goal: input.goal,
      ...(input.scheduling
        ? {
            scheduled_at: input.scheduling.utcIso,
            timezone: input.scheduling.timeZone,
          }
        : {}),
    })
    .select("id")
    .single<{ id: string }>();
  if (campaignError || !campaign) {
    await admin.rpc("release_email_capacity", {
      target_user_id: current.user.id,
      reservation_date: usage.date,
      released: validRecipients.length,
    });
    await releaseDraftQuota();
    throw new Error("Unable to create campaign.");
  }
  const { error: messagesError } = await admin.from("email_messages").insert(
    validRecipients.map((recipient) => ({
      campaign_id: campaign.id,
      user_id: current.user.id,
      recipient_email: recipient.email,
      company_name: recipient.company_name,
      // Per-recipient personalization data: the worker renders each message
      // from THIS row's values only (see processCampaignBatch).
      ...(supportsContactName
        ? { contact_name: recipient.contact_name }
        : {}),
      subject,
      status: "queued",
      next_attempt_at: input.scheduling ? input.scheduling.utcIso : null,
    })),
  );
  if (messagesError) {
    await admin.from("email_campaigns").delete().eq("id", campaign.id);
    await admin.rpc("release_email_capacity", {
      target_user_id: current.user.id,
      reservation_date: usage.date,
      released: validRecipients.length,
    });
    await releaseDraftQuota();
    throw new Error("Unable to queue campaign messages.");
  }
  if (attachments.length > 0) {
    const { error: attachmentsError } = await admin
      .from("email_campaign_attachments")
      .insert(
        attachments.map((attachment) => ({
          campaign_id: campaign.id,
          user_id: current.user.id,
          storage_path: attachment.storage_path,
          filename: attachment.filename,
          mime_type: attachment.mime_type,
          size_bytes: attachment.size_bytes,
        })),
      );
    if (attachmentsError) {
      await admin.from("email_campaigns").delete().eq("id", campaign.id);
      await admin.rpc("release_email_capacity", {
        target_user_id: current.user.id,
        reservation_date: usage.date,
        released: validRecipients.length,
      });
      await releaseDraftQuota();
      throw new Error("Unable to save attachments.");
    }
  }
  // The application email exists and is queued → make the reservation final.
  // Best-effort: if the completion RPC itself fails, the run ledger holds a
  // `reserved` row that the 15-min stale-expiry sweep reconciles (the op is
  // already durable, so keeping the counter is the safe direction).
  if (draftMetered)
    await completeFeatureOp(current.user.id, "email_drafts", draftRunId);
  await admin.from("activity_logs").insert({
    user_id: current.user.id,
    activity_type: "campaign_created",
    title: "Application campaign created",
    description: `${validRecipients.length} application${validRecipients.length === 1 ? "" : "s"} queued for review and sending.`,
    metadata: {
      campaign_id: campaign.id,
      recipient_count: validRecipients.length,
    },
  });
  return { campaignId: campaign.id, usage };
}

/** Legacy (pre-migration) path: the application draft remains the content
 *  source. Kept verbatim so the product behaves EXACTLY as before until the
 *  manual migration 20261110000000 is applied.
 *
 *  QUOTA: deliberately NOT metered here — the draft was already metered
 *  against `email_drafts` at `createBlankDraft` time; metering the campaign
 *  too would double-count one application email. */
async function createLegacyCampaign(input: {
  draftId: string;
  senderAccountId: string;
  goal: ApplicationGoal;
  recipientEmails: Array<{ email: string; companyName?: string | null }>;
  scheduling?: CampaignScheduling;
}) {
  const current = await getCurrentUserAndProfile();
  if (
    !current.user ||
    !current.profile ||
    current.profile.account_status !== "active"
  )
    throw new Error("Not authorized.");
  await assertDraftOwnership(current.user.id, input.draftId);
  await assertSenderOwnership(current.user.id, input.senderAccountId);
  const admin = createAdminClient();
  const { data: draft, error: draftError } = await admin
    .from("application_drafts")
    .select("id, subject, body_html, body_text, sender_email_account_id")
    .eq("id", input.draftId)
    .eq("user_id", current.user.id)
    .single<{
      id: string;
      subject: string;
      body_html: string;
      body_text: string;
      sender_email_account_id: string;
    }>();
  if (draftError || !draft) throw new Error("Draft not found.");
  // contact_name is OPTIONAL in the schema (manual migration) — querying
  // it on a pre-migration database would error and the campaign would see
  // ZERO recipients ("Add a subject, message, and at least one valid
  // recipient before sending."). The base select only names columns that
  // always exist; the optional contact select runs (cached probe) only
  // when the column is there. The greeting then degrades to the general
  // formal one — exactly what the renderer does for missing metadata.
  const supportsContactName = await hasContactNameColumn();
  const [{ data: persistedRecipients }, { data: contactRows }] =
    await Promise.all([
      admin
        .from("application_draft_recipients")
        .select("email, company_name")
        .eq("draft_id", input.draftId)
        .order("created_at"),
      supportsContactName
        ? admin
            .from("application_draft_recipients")
            .select("email, contact_name")
            .eq("draft_id", input.draftId)
        : Promise.resolve({
            data: [] as Array<{ email: string; contact_name: string | null }>,
            error: null,
          }),
    ]);
  const contactByEmail = new Map(
    (contactRows ?? []).map((row) => [row.email, row.contact_name ?? null]),
  );
  const recipients = validateRecipientList(
    (persistedRecipients ?? []).map((recipient) => ({
      email: recipient.email,
      companyName: recipient.company_name,
      contactName: contactByEmail.get(recipient.email) ?? undefined,
    })),
  );
  const validRecipients = recipients.filter(
    (recipient) => recipient.validation_status === "valid",
  );
  if (
    !draft.subject.trim() ||
    !htmlToText(draft.body_html) ||
    validRecipients.length === 0
  )
    throw new Error(
      "Add a subject, message, and at least one valid recipient before sending.",
    );
  if (validRecipients.length > 1000)
    throw new Error("A campaign cannot contain more than 1,000 recipients.");
  // Scheduled sends reserve against the SCHEDULED UTC date (not today), so
  // the whole existing capacity lifecycle (finalize/cancel release against
  // usage_date) stays unchanged. Immediate sends keep the original RPC.
  const { data: capacity, error: capacityError } = await admin.rpc(
    input.scheduling ? "reserve_email_capacity_on" : "reserve_email_capacity",
    input.scheduling
      ? {
          target_user_id: current.user.id,
          requested: validRecipients.length,
          on_date: input.scheduling.usageDate,
        }
      : { target_user_id: current.user.id, requested: validRecipients.length },
  );
  if (capacityError)
    throw new Error(
      capacityError.message.includes("daily_quota_exceeded")
        ? "Daily email quota exceeded."
        : "Unable to reserve daily email capacity.",
    );
  const usage = capacity as UsageSnapshot;
  const { data: campaign, error: campaignError } = await admin
    .from("email_campaigns")
    .insert({
      user_id: current.user.id,
      draft_id: input.draftId,
      email_account_id: input.senderAccountId,
      usage_date: usage.date,
      status: "queued",
      total_recipients: validRecipients.length,
      queued_count: validRecipients.length,
      reserved_count: validRecipients.length,
      // Scheduling: queued + gated. The messages' next_attempt_at (below)
      // is what the existing claim predicates use to hold the campaign back
      // until the instant; scheduled_at/timezone are canonical + audit.
      ...(input.scheduling
        ? {
            scheduled_at: input.scheduling.utcIso,
            timezone: input.scheduling.timeZone,
          }
        : {}),
    })
    .select("id")
    .single<{ id: string }>();
  if (campaignError || !campaign) {
    await admin.rpc("release_email_capacity", {
      target_user_id: current.user.id,
      reservation_date: usage.date,
      released: validRecipients.length,
    });
    throw new Error("Unable to create campaign.");
  }
  const { error: messagesError } = await admin.from("email_messages").insert(
    validRecipients.map((recipient) => ({
      campaign_id: campaign.id,
      user_id: current.user.id,
      recipient_email: recipient.email,
      company_name: recipient.company_name,
      // Per-recipient personalization data: the worker renders each
      // message from THIS row's values only (see processCampaignBatch).
      // Omitted entirely when the column does not exist yet.
      ...(supportsContactName
        ? { contact_name: recipient.contact_name }
        : {}),
      subject: draft.subject,
      status: "queued",
      // Due-gate: a message is claimable only at/after this instant, so a
      // scheduled campaign can never be sent early by ANY worker, poller or
      // open browser tab. Immediate campaigns leave it null (unchanged).
      next_attempt_at: input.scheduling ? input.scheduling.utcIso : null,
    })),
  );
  if (messagesError) {
    await admin.from("email_campaigns").delete().eq("id", campaign.id);
    await admin.rpc("release_email_capacity", {
      target_user_id: current.user.id,
      reservation_date: usage.date,
      released: validRecipients.length,
    });
    throw new Error("Unable to queue campaign messages.");
  }
  await admin.from("activity_logs").insert({
    user_id: current.user.id,
    activity_type: "campaign_created",
    title: "Application campaign created",
    description: `${validRecipients.length} application${validRecipients.length === 1 ? "" : "s"} queued for review and sending.`,
    metadata: {
      campaign_id: campaign.id,
      recipient_count: validRecipients.length,
    },
  });
  return { campaignId: campaign.id, usage };
}

export interface CampaignContext {
  id: string;
  user_id: string;
  /** Legacy campaigns reference their content draft; draft-free campaigns
   *  (post migration 20261110000000) have NULL here. */
  draft_id: string | null;
  // Phase 15: nullable — historical campaigns may outlive their
  // sender (ON DELETE SET NULL). Active campaigns always keep a
  // sender (disconnect is blocked while active); the guard in
  // processCampaignBatch makes that invariant explicit.
  email_account_id: string | null;
  usage_date: string;
  status: CampaignStatus;
  started_at: string | null;
  created_at: string;
  /** Canonical UTC instant for scheduled campaigns; null = immediate. */
  scheduled_at: string | null;
  /** IANA zone the user chose (display/audit); null = immediate. */
  timezone: string | null;
  /** OWNED content (migration 20261110000000): the campaign's subject
   *  template, body template and goal. Absent (undefined) on pre-migration
   *  databases and unused for legacy campaigns. */
  subject?: string | null;
  body_html?: string | null;
  goal?: string | null;
}

async function getCampaignContext(
  userId: string,
  campaignId: string,
): Promise<CampaignContext> {
  const admin = createAdminClient();
  // Two literal selects (supabase-js types the select string): the owned
  // columns only exist after the manual migration, so they are named in a
  // query only when the cached probe proves them.
  const owned = await hasCampaignOwnedContent();
  const { data, error } = owned
    ? await admin
        .from("email_campaigns")
        .select(
          "id, user_id, draft_id, email_account_id, usage_date, status, started_at, created_at, scheduled_at, timezone, subject, body_html, goal",
        )
        .eq("id", campaignId)
        .eq("user_id", userId)
        .single<CampaignContext>()
    : await admin
        .from("email_campaigns")
        .select(
          "id, user_id, draft_id, email_account_id, usage_date, status, started_at, created_at, scheduled_at, timezone",
        )
        .eq("id", campaignId)
        .eq("user_id", userId)
        .single<Omit<CampaignContext, "subject" | "body_html" | "goal">>();
  if (error || !data) throw new Error("Campaign not found.");
  return data as CampaignContext;
}

/** A message claimed as `sending` without any DB progress for this long is
 *  treated as lost: the worker that claimed it died (crash, redeploy,
 *  network partition). 15 minutes is far above any provider round-trip. */
export const STALE_SENDING_AFTER_MINUTES = 15;
/** A campaign that was created but never started (still `queued`, no
 *  `started_at`) is treated as abandoned after this long — its reserved
 *  capacity belongs to a UTC date that has already passed, so it can never
 *  be used. 24 hours. */
export const STALE_QUEUED_AFTER_HOURS = 24;

export interface CampaignRecoveryResult {
  recovered: boolean;
  /** In-flight (`sending`) messages re-finalized as failed with the
   *  deterministic code `worker_stalled`. */
  stalledMessagesFailed: number;
  /** A never-started campaign older than the TTL was cancelled (its queued
   *  messages + reserved capacity released). */
  staleCampaignCancelled: boolean;
  /** Campaign status after recovery. */
  status: CampaignStatus;
}

/**
 * Deterministic stale-state recovery for one campaign (session-scoped to
 * `userId`). Runs server-side with the service role on every campaign
 * access (monitor page, worker tick). No invented data: stalled in-flight
 * messages are re-finalized through the existing `finalize_email_message`
 * RPC (correct counters + capacity release), and a never-started campaign
 * past the TTL is cancelled through the existing `cancel_queued_campaign`
 * RPC.
 */
export async function recoverStaleCampaigns(
  userId: string,
  campaignId: string,
): Promise<CampaignRecoveryResult> {
  const admin = createAdminClient();
  const campaign = await getCampaignContext(userId, campaignId);
  if (
    ["completed", "partially_failed", "failed", "cancelled"].includes(
      campaign.status,
    )
  )
    return {
      recovered: false,
      stalledMessagesFailed: 0,
      staleCampaignCancelled: false,
      status: campaign.status,
    };

  let stalledMessagesFailed = 0;
  const stalledBeforeMs = Date.now() - STALE_SENDING_AFTER_MINUTES * 60_000;
  const { data: stalled } = await admin
    .from("email_messages")
    .select("id")
    .eq("campaign_id", campaign.id)
    .eq("user_id", userId)
    .eq("status", "sending")
    .lt("updated_at", new Date(stalledBeforeMs).toISOString());
  for (const message of (stalled ?? []) as Array<{ id: string }>) {
    const { data } = await admin.rpc("finalize_email_message", {
      target_message_id: message.id,
      succeeded: false,
      provider_id: null,
      failure_code: "worker_stalled",
      failure_message:
        "The sending worker stalled before reporting a result. This message was not confirmed as sent; resend the campaign to retry it.",
    });
    if (data === true) stalledMessagesFailed += 1;
  }

  let staleCampaignCancelled = false;
  if (campaign.status === "queued" && !campaign.started_at) {
    // Abandoned-TTL baseline: an immediate campaign ages from created_at.
    // A SCHEDULED campaign ages from its scheduled instant instead — the
    // queued state before the instant is normal (the campaign may be days
    // away), and after the instant it gets the same 24h grace for
    // scheduler downtime before being cancelled + capacity-released.
    const baselineMs = campaign.scheduled_at
      ? Date.parse(campaign.scheduled_at)
      : new Date(campaign.created_at).getTime();
    if (Date.now() > baselineMs + STALE_QUEUED_AFTER_HOURS * 3_600_000) {
      const { data, error } = await admin.rpc("cancel_queued_campaign", {
        target_user_id: userId,
        target_campaign_id: campaign.id,
      });
      if (!error && data === true) staleCampaignCancelled = true;
    }
  }

  const status = (await getCampaignContext(userId, campaignId)).status;
  return {
    recovered: stalledMessagesFailed > 0 || staleCampaignCancelled,
    stalledMessagesFailed,
    staleCampaignCancelled,
    status,
  };
}

/**
 * Safe-by-construction rate-limit log line. Only the provider name, the
 * action, the sender account UUID and (for send_allowed) the message UUID
 * are ever logged — never credentials, message content, or any personal
 * data.
 */
function logRateLimit(
  action: "slot_reserved" | "waiting" | "send_allowed",
  accountId: string,
  extra = "",
) {
  console.info(
    `[EMAIL_RATE_LIMIT] provider=gmail action=${action} account=${accountId}${
      extra ? ` ${extra}` : ""
    }`,
  );
}

/**
 * Smart Sending — reserve the sender account's atomic slot BEFORE claiming
 * a message. The slot is one Postgres row per Gmail account, shared by ALL
 * of the account's campaigns, workers, tabs and reloads; the reservation is
 * a single conditional UPDATE in the database, so exactly one caller can
 * win per interval window (no check-then-act race, no in-process state).
 *
 * If the slot is busy, wait (bounded by the wait budget) and retry. If it
 * is still busy when the budget is exhausted, return false WITHOUT having
 * claimed anything — the caller stops the batch and the messages simply
 * stay `queued` for the next tick. They are never failed, never sent and
 * never deleted while waiting.
 */
export async function reserveSenderSlot(
  admin: ReturnType<typeof createAdminClient>,
  accountId: string,
): Promise<boolean> {
  const deadline = Date.now() + SENDER_SLOT_WAIT_BUDGET_MS;
  for (;;) {
    const { data, error } = await admin.rpc("reserve_sender_slot", {
      target_account_id: accountId,
      min_interval_ms: sendIntervalMs(),
    });
    if (error) throw new Error("Unable to reserve the sending slot.");
    if (data?.reserved) {
      logRateLimit("slot_reserved", accountId);
      return true;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    const waitMs = Math.min(Number(data?.wait_ms ?? sendIntervalMs()), remaining);
    logRateLimit("waiting", accountId, `wait_ms=${Math.round(waitMs)}`);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
}

/**
 * How long the campaign's sender slot is busy right now (0 = free). Used
 * by the UI to show a REAL "waiting for sending slot" state — never a
 * faked one. Throws like the rest of the engine on database errors.
 */
export async function getSenderSlotWaitMs(
  userId: string,
  campaignId: string,
): Promise<number> {
  const campaign = await getCampaignContext(userId, campaignId);
  if (!campaign.email_account_id) return 0;
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("get_sender_slot_wait_ms", {
    target_account_id: campaign.email_account_id,
  });
  if (error) throw new Error("Unable to load the sending state.");
  const wait = Number(data ?? 0);
  return Number.isFinite(wait) ? wait : 0;
}

export async function processCampaignBatch(
  userId: string,
  campaignId: string,
  batchSize = 5,
) {
  const admin = createAdminClient();
  // Recover lost in-flight messages / abandoned queued state first, so a
  // stalled campaign is self-healing on the next worker tick.
  await recoverStaleCampaigns(userId, campaignId);
  const campaign = await getCampaignContext(userId, campaignId);
  if (
    ["completed", "partially_failed", "failed", "cancelled"].includes(
      campaign.status,
    )
  )
    return { processed: 0, status: campaign.status };
  // Invariant (Phase 15): an active campaign always has a live sender
  // (disconnect is blocked while campaigns are active). A null sender
  // on an active campaign is an inconsistent state — fail loudly and
  // deterministically instead of deep in provider code.
  if (!campaign.email_account_id)
    throw new Error("Campaign has no sender account; nothing to send.");
  // Content resolution (Drafts feature removal): a campaign that carries its
  // body on the campaign row (migration 20261110000000, backfilled for
  // historical campaigns) renders from ITSELF and never touches a draft —
  // draft-free campaigns have draft_id NULL and no draft can exist. Only a
  // campaign row with an EMPTY owned body falls back to its historical
  // draft (a pre-migration row that was never backfilled). Personalization
  // below is identical in both cases: the template is read-only.
  let bodyHtml: string;
  let bodyText: string;
  let attachments: Array<{
    filename: string;
    mime_type: string;
    storage_path: string;
  }>;
  if (
    typeof campaign.body_html === "string" &&
    campaign.body_html.trim() !== ""
  ) {
    bodyHtml = campaign.body_html;
    bodyText = htmlToText(bodyHtml);
    const { data: campaignAttachments } = await admin
      .from("email_campaign_attachments")
      .select("filename, mime_type, storage_path")
      .eq("campaign_id", campaign.id);
    attachments = (campaignAttachments ?? []) as Array<{
      filename: string;
      mime_type: string;
      storage_path: string;
    }>;
  } else {
    if (!campaign.draft_id)
      throw new Error("Campaign content is missing.");
    const { data: draft, error: draftError } = await admin
      .from("application_drafts")
      .select("body_html, body_text")
      .eq("id", campaign.draft_id)
      .single<{ body_html: string; body_text: string }>();
    if (draftError || !draft) throw new Error("Draft not found.");
    bodyHtml = draft.body_html;
    bodyText = draft.body_text;
    const { data: draftAttachments } = await admin
      .from("application_draft_attachments")
      .select("filename, mime_type, storage_path")
      .eq("draft_id", campaign.draft_id);
    attachments = (draftAttachments ?? []) as Array<{
      filename: string;
      mime_type: string;
      storage_path: string;
    }>;
  }
  let processed = 0;
  for (let index = 0; index < Math.min(batchSize, 5); index += 1) {
    // Smart Sending — reserve the sender's atomic slot BEFORE claiming a
    // message. The slot is per Gmail account and shared by every campaign
    // on that account, so no combination of workers, campaigns, tabs or
    // reloads can ever put two sends from this account less than the
    // minimum interval apart. If the slot is still busy after the wait
    // budget, stop WITHOUT claiming: nothing changed state, the messages
    // stay queued for the next tick (never failed, never sent).
    const slotFree = await reserveSenderSlot(admin, campaign.email_account_id);
    if (!slotFree) break;
    const { data: message } = await admin.rpc("claim_next_email_message", {
      target_user_id: userId,
      target_campaign_id: campaignId,
    });
    if (!message?.id) break;
    processed += 1;
    try {
      const { data: recipient } = await admin
        .from("email_messages")
        .select("recipient_email, subject, attempt_count, company_name")
        .eq("id", message.id)
        .single<{
          recipient_email: string;
          subject: string;
          attempt_count: number;
          company_name: string | null;
        }>();
      if (!recipient)
        throw {
          code: "message_missing",
          message: "Message could not be loaded.",
          temporary: false,
          reconnect: false,
        } satisfies ProviderFailure;
      // Smart personalization: render THIS recipient's independent copy
      // from the campaign template using only this row's data. The
      // template (with its tokens) is never modified, nothing is memoized
      // across recipients, and no rendered output ever leaks into another
      // recipient's message. Rendering BEFORE the provider is created so
      // an unresolvable variable can never burn a send slot or reach the
      // provider. A render failure is deterministic → the existing
      // per-recipient failure path (finalize as failed, no retry).
      // contact_name is OPTIONAL in the schema (manual migration): it is
      // read from the CLAIMED row, because claim_next_email_message
      // `returns public.email_messages` (the full record) — so the code
      // never names the column in a query and keeps working pre-migration
      // (undefined → the general formal greeting).
      const contactName: string | null =
        (message as { contact_name?: string | null }).contact_name ?? null;
      let rendered: { subject: string; bodyHtml: string; bodyText: string };
      try {
        rendered = renderPersonalizedMessage(
          {
            subject: recipient.subject,
            bodyHtml,
            bodyText,
          },
          {
            email: recipient.recipient_email,
            companyName: recipient.company_name,
            contactName,
          },
        );
      } catch (error) {
        throw {
          code: "personalization_failed",
          message:
            error instanceof PersonalizationError
              ? "The message contains a personalization variable that could not be resolved for this recipient."
              : "The message could not be personalized for this recipient.",
          temporary: false,
          reconnect: false,
        } satisfies ProviderFailure;
      }
      const provider = await createEmailProvider(
        userId,
        campaign.email_account_id,
        (attachments ?? []).map((attachment) => ({
          filename: attachment.filename,
          mimeType: attachment.mime_type,
          storagePath: attachment.storage_path,
        })),
      );
      logRateLimit("send_allowed", campaign.email_account_id, `message=${message.id}`);
      const result = await provider.sendEmail({
        to: recipient.recipient_email,
        subject: rendered.subject,
        html: sanitizeEmailHtml(rendered.bodyHtml),
        text: rendered.bodyText,
        attachments: [],
      });
      await admin.rpc("finalize_email_message", {
        target_message_id: message.id,
        succeeded: true,
        provider_id: result.providerMessageId,
        failure_code: null,
        failure_message: null,
      });
    } catch (error) {
      const providerError = error as Partial<ProviderFailure>;
      const temporary = providerError.temporary === true;
      const attempt = Number(
        (message as { attempt_count?: number }).attempt_count ?? 1,
      );
      if (temporary && attempt < 3)
        await admin.rpc("retry_email_message", {
          target_message_id: message.id,
          retry_code: providerError.code ?? "temporary",
          retry_message: providerError.message ?? "Temporary provider error.",
        });
      else
         await admin.rpc("finalize_email_message", {
          target_message_id: message.id,
          succeeded: false,
          provider_id: null,
          failure_code: providerError.code ?? "send_failed",
          failure_message:
            providerError.message ?? "Message could not be sent.",
        });
    }
    // Pacing note: the old fixed 250ms micro-pause is gone on purpose —
    // the sender slot reservation at the top of the loop is now the ONLY
    // pacing mechanism (real, atomic, per-account, 5–6 second guarantee).
  }
  return {
    processed,
    status: (await getCampaignContext(userId, campaignId)).status,
  };
}

export async function getCampaign(userId: string, campaignId: string) {
  const admin = createAdminClient();
  // Viewing the monitor also heals stale state (worker died, worker never
  // configured) so the user sees the real status.
  await recoverStaleCampaigns(userId, campaignId);
  const campaign = await getCampaignContext(userId, campaignId);
  const [{ data: messages }, usage] = await Promise.all([
    admin
      .from("email_messages")
      .select(
        "id, recipient_email, company_name, status, error_code, error_message, provider_message_id, sent_at, attempt_count",
      )
      .eq("campaign_id", campaignId)
      .eq("user_id", userId)
      .order("created_at"),
    getUsageSnapshot(userId),
  ]);
  return { campaign, messages: messages ?? [], usage };
}

/** Raised when a campaign must not be deleted yet (its queue is live). */
export class CampaignDeleteBlockedError extends Error {}

/**
 * Delete ONE campaign and its messages.
 *
 * Scope: the campaign row itself. `email_messages.campaign_id` is
 * `on delete cascade`, so the messages are removed atomically by the database
 * — the queue can never be left with orphaned rows, and no other campaign,
 * email account, token or credit is touched.
 *
 * Capacity: every message holds one unit of `daily_usage.emails_reserved`
 * (released by the engine when a message is finalized or cancelled), so the
 * messages that will never be sent (still queued) are released here against
 * the campaign's own usage date — exactly like cancelCampaign does.
 *
 * A campaign that is actively `sending` is refused: its messages are locked
 * by the running worker, which finalizes them itself. Deletion is refused on
 * the MESSAGE state as well — a `sending` message means the worker has
 * already claimed it, even for a campaign row that still reads `queued`.
 */
export async function deleteCampaign(userId: string, campaignId: string) {
  const admin = createAdminClient();
  const { data: campaign, error: loadError } = await admin
    .from("email_campaigns")
    .select("id, status, queued_count, usage_date")
    .eq("id", campaignId)
    .eq("user_id", userId)
    .single();
  if (loadError || !campaign) throw new Error("Campaign not found.");

  if (campaign.status === "sending")
    throw new CampaignDeleteBlockedError(
      "This campaign is currently being sent. Please wait until sending finishes before deleting it.",
    );

  // In-flight guard: the campaign row can still read `queued` for a moment
  // after the worker claims its first message (the `sending` flip commits in
  // the same worker tick). A claimed message means live in-flight work —
  // deleting now would strand it, so refuse on the message state too.
  const { count: inFlight, error: inFlightError } = await admin
    .from("email_messages")
    .select("id", { count: "exact", head: true })
    .eq("campaign_id", campaignId)
    .eq("user_id", userId)
    .eq("status", "sending");
  if (inFlightError) throw new Error("Unable to delete campaign.");
  if ((inFlight ?? 0) > 0)
    throw new CampaignDeleteBlockedError(
      "This campaign is currently being sent. Please wait until sending finishes before deleting it.",
    );

  const queued = Number(campaign.queued_count ?? 0);
  if (queued > 0 && campaign.usage_date) {
    await admin.rpc("release_email_capacity", {
      target_user_id: userId,
      reservation_date: campaign.usage_date,
      released: queued,
    });
  }

  // Campaign-owned attachments (post migration 20261110000000): collect the
  // storage paths BEFORE the cascade removes the rows, then sweep the
  // objects best-effort AFTER the delete (row-first, same contract as every
  // other erasure path — a surviving object is reclaimed by the storage
  // orphan janitor, never the other way around).
  let attachmentPaths: string[] = [];
  const owned = await hasCampaignOwnedContent();
  if (owned) {
    const { data: campaignAttachments } = await admin
      .from("email_campaign_attachments")
      .select("storage_path")
      .eq("campaign_id", campaignId)
      .eq("user_id", userId);
    attachmentPaths = (campaignAttachments ?? [])
      .map((item: { storage_path: string }) => item.storage_path)
      .filter(Boolean);
  }

  const { error } = await admin
    .from("email_campaigns")
    .delete()
    .eq("id", campaignId)
    .eq("user_id", userId);
  if (error) throw new Error("Unable to delete campaign.");

  if (attachmentPaths.length > 0) {
    await admin.storage
      .from("application-attachments")
      .remove(attachmentPaths)
      .catch(() => undefined);
  }

  await admin.from("activity_logs").insert({
    user_id: userId,
    activity_type: "campaign_deleted",
    title: "Application campaign deleted",
    metadata: { campaign_id: campaignId, released_capacity: queued },
  });
  return { campaignId, releasedCapacity: queued };
}

export async function cancelCampaign(userId: string, campaignId: string) {
  const admin = createAdminClient();
  const result = await admin.rpc("cancel_queued_campaign", {
    target_user_id: userId,
    target_campaign_id: campaignId,
  });
  if (result.error || !result.data)
    throw new Error("Unable to cancel campaign.");
  await admin.from("activity_logs").insert({
    user_id: userId,
    activity_type: "campaign_cancelled",
    title: "Application campaign cancelled",
    metadata: { campaign_id: campaignId },
  });
}

/**
 * Reschedule a not-yet-started campaign to a new future instant.
 *
 * Ownership is enforced twice: getCampaignContext (the campaign must belong
 * to the user) and the RPC itself (user-scoped FOR UPDATE lock). The RPC is
 * atomic — it refuses once any message was claimed (status 'sending' or
 * started_at set), and a quota-shortfall on the new date rolls back the
 * whole move. Only ever reachable while `scheduled_at` is still in the
 * future; already-sent messages can never be recalled (existing behaviour).
 */
export async function rescheduleCampaign(
  userId: string,
  campaignId: string,
  scheduling: CampaignScheduling,
) {
  await getCampaignContext(userId, campaignId); // ownership + existence
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("reschedule_campaign", {
    target_user_id: userId,
    target_campaign_id: campaignId,
    new_scheduled_at: scheduling.utcIso,
    new_timezone: scheduling.timeZone,
    new_usage_date: scheduling.usageDate,
  });
  if (error)
    throw new Error(
      error.message.includes("daily_quota_exceeded")
        ? "Daily email quota exceeded for the new date."
        : "Unable to reschedule campaign.",
    );
  if (data !== true)
    throw new Error(
      "This campaign can no longer be rescheduled — sending has already started.",
    );
  await admin.from("activity_logs").insert({
    user_id: userId,
    activity_type: "campaign_rescheduled",
    title: "Application campaign rescheduled",
    description: "The scheduled send time was changed before sending started.",
    metadata: { campaign_id: campaignId, scheduled_at: scheduling.utcIso },
  });
  return getCampaignContext(userId, campaignId);
}

/** One row of the Applications list. Either a campaign (one row PER
 *  campaign — campaigns never overwrite each other) or a composer draft
 *  that has not been sent yet. Every value is read from the database,
 *  user-scoped; nothing is synthesised. */
export interface ApplicationListItem {
  kind: "campaign" | "draft";
  /** Primary id of the row: the campaign id, or the draft id. */
  id: string;
  campaign_id: string | null;
  draft_id: string | null;
  title: string;
  company: string | null;
  goal: string;
  /** Engine status for campaign rows; always "draft" for draft rows. */
  status: string;
  total_recipients: number | null;
  sent_count: number | null;
  failed_count: number | null;
  /** Sender address only (display; the account itself lives in Email). */
  sender_email: string | null;
  created_at: string;
  /** Canonical UTC instant for scheduled campaigns (null = immediate). */
  scheduled_at: string | null;
  /** IANA zone the user chose (display/audit; null = immediate). */
  timezone: string | null;
}

function applicationTitle(
  subject: string,
  opportunityTitle: string | null,
): string {
  const trimmed = subject.trim();
  return trimmed || opportunityTitle || "Untitled application";
}

/**
 * The user's complete Applications list: every campaign as its own row
 * (independent ids, recipients, counters and errors per campaign).
 *
 * Drafts feature removal: once migration 20261110000000 is applied the list
 * contains CAMPAIGNS ONLY — no draft-only rows, no Drafts counter. Campaign
 * rows read their title/goal from the campaign's own columns (with the
 * historical draft still consulted for the opportunity title/company of
 * legacy campaigns). Before the migration is applied the legacy shape —
 * campaigns joined with their drafts plus draft-only rows — is returned
 * unchanged, so a code-first deploy can never break the list.
 */
export async function listUserCampaigns(
  userId: string,
): Promise<ApplicationListItem[]> {
  const admin = createAdminClient();
  const owned = await hasCampaignOwnedContent();
  // Two literal selects (supabase-js types the select string): the owned
  // columns only exist after the manual migration.
  const campaignsResult = owned
    ? await admin
        .from("email_campaigns")
        .select(
          "id, draft_id, email_account_id, status, total_recipients, sent_count, failed_count, created_at, scheduled_at, timezone, subject, goal",
        )
        .eq("user_id", userId)
        .order("created_at", { ascending: false })
    : await admin
        .from("email_campaigns")
        .select(
          "id, draft_id, email_account_id, status, total_recipients, sent_count, failed_count, created_at, scheduled_at, timezone",
        )
        .eq("user_id", userId)
        .order("created_at", { ascending: false });
  const draftsResult = await admin
    .from("application_drafts")
    .select(
      "id, goal, subject, created_at, opportunity_title, opportunity_company, sender_email_account_id",
    )
    .eq("user_id", userId)
    .order("created_at", { ascending: false });
  if (campaignsResult.error) throw new Error("Unable to load campaigns.");
  if (draftsResult.error) throw new Error("Unable to load applications.");

  const campaigns = (campaignsResult.data ?? []) as Array<{
    id: string;
    draft_id: string | null;
    /** OWNED columns (post migration 20261110000000). */
    subject?: string | null;
    goal?: string | null;
    email_account_id: string | null;
    status: string;
    total_recipients: number | null;
    sent_count: number | null;
    failed_count: number | null;
    created_at: string;
    scheduled_at: string | null;
    timezone: string | null;
  }>;
  const drafts = (draftsResult.data ?? []) as Array<{
    id: string;
    goal: string;
    subject: string;
    created_at: string;
    opportunity_title: string | null;
    opportunity_company: string | null;
    sender_email_account_id: string;
  }>;
  const draftById = new Map(drafts.map((draft) => [draft.id, draft]));
  const draftedIds = new Set(
    campaigns
      .map((campaign) => campaign.draft_id)
      .filter((id): id is string => Boolean(id)),
  );

  // Sender addresses for the accounts referenced by campaigns and drafts
  // (address only — safe to display; tokens never leave the server).
  const accountIds = new Set<string>();
  for (const campaign of campaigns)
    if (campaign.email_account_id) accountIds.add(campaign.email_account_id);
  for (const draft of drafts) accountIds.add(draft.sender_email_account_id);
  const senderByAccount = new Map<string, string>();
  if (accountIds.size > 0) {
    const { data: accounts } = await admin
      .from("email_accounts")
      .select("id, email_address")
      .in("id", [...accountIds]);
    for (const account of (accounts ?? []) as Array<{
      id: string;
      email_address: string;
    }>)
      senderByAccount.set(account.id, account.email_address);
  }

  // Draft-only rows are part of the list ONLY in the pre-migration legacy
  // shape. Post-migration the Drafts feature is gone: the dashboard shows
  // campaigns (Total/Sending/Sent/Failed) and nothing else.
  const pendingDrafts = owned
    ? []
    : drafts.filter((draft) => !draftedIds.has(draft.id));
  const recipientCountByDraft = new Map<string, number>();
  if (pendingDrafts.length > 0) {
    const { data: recipients } = await admin
      .from("application_draft_recipients")
      .select("draft_id")
      .in("draft_id", pendingDrafts.map((draft) => draft.id));
    for (const recipient of (recipients ?? []) as Array<{
      draft_id: string;
    }>)
      recipientCountByDraft.set(
        recipient.draft_id,
        (recipientCountByDraft.get(recipient.draft_id) ?? 0) + 1,
      );
  }

  const items: ApplicationListItem[] = [];
  for (const campaign of campaigns) {
    // The campaign's draft (legacy campaigns only — draft_id is ON DELETE
    // RESTRICT, so it still exists when referenced) is consulted for the
    // opportunity title/company and, pre-migration, for title/goal.
    // Draft-free campaigns carry their own title/goal columns.
    const draft = campaign.draft_id
      ? (draftById.get(campaign.draft_id) ?? undefined)
      : undefined;
    const ownedSubject =
      typeof campaign.subject === "string" ? campaign.subject : "";
    const ownedGoal = typeof campaign.goal === "string" ? campaign.goal : "";
    items.push({
      kind: "campaign",
      id: campaign.id,
      campaign_id: campaign.id,
      draft_id: campaign.draft_id,
      title:
        ownedSubject.trim() !== ""
          ? applicationTitle(ownedSubject, draft?.opportunity_title ?? null)
          : draft
            ? applicationTitle(draft.subject, draft.opportunity_title)
            : "Untitled application",
      company: draft?.opportunity_company ?? null,
      goal: ownedGoal || draft?.goal || "",
      status: campaign.status,
      total_recipients: campaign.total_recipients,
      sent_count: campaign.sent_count,
      failed_count: campaign.failed_count,
       sender_email: campaign.email_account_id
         ? (senderByAccount.get(campaign.email_account_id) ?? null)
         : null,
       created_at: campaign.created_at,
       scheduled_at: campaign.scheduled_at,
       timezone: campaign.timezone,
     });
   }
  for (const draft of pendingDrafts) {
    items.push({
      kind: "draft",
      id: draft.id,
      campaign_id: null,
      draft_id: draft.id,
      title: applicationTitle(draft.subject, draft.opportunity_title),
      company: draft.opportunity_company ?? null,
      goal: draft.goal,
      status: "draft",
      total_recipients: recipientCountByDraft.get(draft.id) ?? 0,
      sent_count: null,
      failed_count: null,
       sender_email: senderByAccount.get(draft.sender_email_account_id) ?? null,
       created_at: draft.created_at,
       scheduled_at: null,
       timezone: null,
     });
   }
  return items.sort(
    (a, b) =>
      b.created_at.localeCompare(a.created_at) || a.id.localeCompare(b.id),
  );
}
