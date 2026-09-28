import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import {
  assertDraftOwnership,
  assertSenderOwnership,
  sanitizeEmailHtml,
  htmlToText,
  validateRecipientList,
  type ApplicationGoal,
} from "@/lib/application-drafts";
import {
  createEmailProvider,
  type ProviderFailure,
} from "@/lib/email-providers";
import { getCurrentUserAndProfile } from "@/lib/auth";

export type CampaignStatus =
  | "draft"
  | "queued"
  | "sending"
  | "completed"
  | "partially_failed"
  | "failed"
  | "cancelled";
export type MessageStatus =
  "queued" | "sending" | "sent" | "failed" | "cancelled";
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
    title: "100 daily application emails activated",
    description: "The DRIF089 quota upgrade is active.",
    metadata: { daily_limit: data },
  });
  return Number(data);
}

export async function createCampaign(input: {
  draftId: string;
  senderAccountId: string;
  goal: ApplicationGoal;
  recipientEmails: Array<{ email: string; companyName?: string | null }>;
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
  const { data: persistedRecipients } = await admin
    .from("application_draft_recipients")
    .select("email, company_name")
    .eq("draft_id", input.draftId)
    .order("created_at");
  const recipients = validateRecipientList(
    (persistedRecipients ?? []).map((recipient) => ({
      email: recipient.email,
      companyName: recipient.company_name,
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
  const { data: capacity, error: capacityError } = await admin.rpc(
    "reserve_email_capacity",
    { target_user_id: current.user.id, requested: validRecipients.length },
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
      subject: draft.subject,
      status: "queued",
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

async function getCampaignContext(userId: string, campaignId: string) {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("email_campaigns")
    .select(
      "id, user_id, draft_id, email_account_id, usage_date, status, started_at, created_at",
    )
    .eq("id", campaignId)
    .eq("user_id", userId)
    .single<{
      id: string;
      user_id: string;
      draft_id: string;
      // Phase 15: nullable — historical campaigns may outlive their
      // sender (ON DELETE SET NULL). Active campaigns always keep a
      // sender (disconnect is blocked while active); the guard in
      // processCampaignBatch makes that invariant explicit.
      email_account_id: string | null;
      usage_date: string;
      status: CampaignStatus;
      started_at: string | null;
      created_at: string;
    }>();
  if (error || !data) throw new Error("Campaign not found.");
  return data;
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
    const staleBeforeMs = Date.now() - STALE_QUEUED_AFTER_HOURS * 3_600_000;
    if (new Date(campaign.created_at).getTime() < staleBeforeMs) {
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
  const { data: draft, error: draftError } = await admin
    .from("application_drafts")
    .select("body_html, body_text")
    .eq("id", campaign.draft_id)
    .single<{ body_html: string; body_text: string }>();
  if (draftError || !draft) throw new Error("Draft not found.");
  const { data: attachments } = await admin
    .from("application_draft_attachments")
    .select("filename, mime_type, storage_path")
    .eq("draft_id", campaign.draft_id);
  let processed = 0;
  for (let index = 0; index < Math.min(batchSize, 5); index += 1) {
    const { data: message } = await admin.rpc("claim_next_email_message", {
      target_user_id: userId,
      target_campaign_id: campaignId,
    });
    if (!message?.id) break;
    processed += 1;
    try {
      const { data: recipient } = await admin
        .from("email_messages")
        .select("recipient_email, subject, attempt_count")
        .eq("id", message.id)
        .single<{
          recipient_email: string;
          subject: string;
          attempt_count: number;
        }>();
      if (!recipient)
        throw {
          code: "message_missing",
          message: "Message could not be loaded.",
          temporary: false,
          reconnect: false,
        } satisfies ProviderFailure;
      const provider = await createEmailProvider(
        userId,
        campaign.email_account_id,
        (attachments ?? []).map((attachment) => ({
          filename: attachment.filename,
          mimeType: attachment.mime_type,
          storagePath: attachment.storage_path,
        })),
      );
      const result = await provider.sendEmail({
        to: recipient.recipient_email,
        subject: recipient.subject,
        html: sanitizeEmailHtml(draft.body_html),
        text: draft.body_text,
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
    await new Promise((resolve) => setTimeout(resolve, 250));
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
