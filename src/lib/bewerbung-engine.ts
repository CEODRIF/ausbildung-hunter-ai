/**
 * Bewerbung Automation — server-side I/O orchestration.
 *
 * This module is `server-only`. It reuses the EXISTING safe primitives
 * WITHOUT modifying them:
 *   - createAdminClient()          (service-role Supabase)
 *   - createEmailProvider()        (Gmail/Outlook send, token, MIME)
 *   - reserveSenderSlot()          (per-account 5–6 s pacing)
 *   - getUsageSnapshot()           (shared daily quota read)
 *   - reserve_email_capacity /     (atomic shared quota reserve/release)
 *     release_email_capacity       (RPCs — unmodified)
 *   - sanitizeEmailHtml /          (shared email HTML sanitization)
 *     htmlToText
 *   - createAIProvider()           (shared OpenAI-compatible text gen)
 *   - reserveAIUsage()             (shared AI daily quota)
 *   - extractPdfText()             (shared PDF text extraction)
 *
 * It writes ONLY to the isolated `bew_*` tables and reads the shared
 * `daily_usage` counter through the existing RPCs (so real sends correctly
 * count against the platform daily limit). The protected standard-email
 * feature, Email Verification and the storage of other users' data are never
 * touched.
 */
import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { createEmailProvider } from "@/lib/email-providers";
import { getUsageSnapshot, reserveSenderSlot } from "@/lib/email-campaigns";
import { htmlToText, sanitizeEmailHtml } from "@/lib/application-drafts";
import { createAIProvider } from "@/lib/ai-provider";
import { reserveAIUsage, storagePath } from "@/lib/ai-service";
import { extractPdfText } from "@/lib/pdf-extract";
import type { Profile } from "@/lib/auth";
import mammoth from "mammoth";
import { hasApplicantProfileColumns } from "@/lib/contact-name-support";
import { candidateProfileSchema, type CandidateProfile } from "@/lib/bewerbung-schema";
import {
  BEW_ATTACHMENT_BUCKET,
  deleteLetterPdf,
  ensureLetterPdf,
  letterPdfStoragePath,
  type ApplicantFacts,
  type LetterAttachmentRef,
} from "@/lib/bew-letter-pdf";

import {
  renderPersonalizedMessage,
  type PersonalizationTemplate,
  type RenderedMessage,
} from "@/lib/personalization";
import {
  assembleLetter,
  BEW_EMAIL_BODY_MAX,
  BEW_EMAIL_SUBJECT_MAX,
  buildImportResult,
  buildLetterPrompt,
  buildSubject,
  classifySendError,
  computeSendPlan,
  isBewEmailComplete,
  isBewPurpose,
  type ApplicantProfileField,
  validateApplicantProfile,
  isDocumentKind,
  isValidEmail,
  parsePdfCompanyCandidates,
  validateCompanyCount,
  validateDocumentInput,
  type BewImportResult,
  type BewPurpose,
  type DocumentKind,
  type PdfCompanyCandidate,
  type SendPlan,
  resolveLetterPosition,
  validateLetterQuality,
  buildLetterCorrectiveNote,
  buildLetterEvalPrompt,
  parseLetterEvalVerdict,
  BEW_MAX_LETTER_ATTEMPTS,
  BEW_POSITION_TITLE_MAX,
  BEW_POSITION_BRIEF_MAX,
  BEW_EMPLOYER_FACTS_MAX,
  type LetterPromptInput,
  type LetterQualityResult,
  type LetterEvalVerdict,
  BEW_PLATFORM_DAILY_CAP,
} from "@/lib/bewerbung-automation";

/* ------------------------------------------------------------------ *
 * Row types (mirror the migration)
 * ------------------------------------------------------------------ */

export type BewCampaignRow = {
  id: string;
  user_id: string;
  email_account_id: string | null;
  purpose: string;
  status: string;
  requested_count: number;
  valid_count: number;
  total_count: number;
  generated_count: number;
  sent_count: number;
  failed_count: number;
  excluded_count: number;
   usage_date: string;
   created_at: string;
   started_at: string | null;
   completed_at: string | null;
   /**
    * The campaign-level e-mail message (independent from the per-company
    * Anschreiben, which stays an ATTACHMENT). Optional in the type: rows read
    * before the 20261113000000 migration simply lack the columns — the code
    * treats absence as "no e-mail yet" (empty strings).
    */
   email_subject?: string;
   email_body_html?: string;
   /** Position brief (20261115000000) — the role this campaign targets. */
   position_title?: string;
   position_brief?: string;
   employer_facts?: string;
   /**
    * Scheduled send (20261116000000). The canonical UTC instant the batch is
    * due (null = immediate / not scheduled); every queued application carries
    * next_attempt_at = this value so the existing claim predicate defers it.
    * Optional in the type: rows read before the migration lack the column.
    */
   scheduled_at?: string | null;
   /** IANA zone the user chose for a scheduled send (display/audit only). */
   timezone?: string | null;
 };

export type BewApplicationRow = {
  id: string;
  campaign_id: string;
  user_id: string;
  seq: number;
  company_name: string;
  contact_name: string | null;
  company_email: string;
  company_address: string | null;
  subject: string;
  body_html: string;
  body_text: string;
  status: string;
  error_code: string | null;
  error_message: string | null;
  attempt_count: number;
  next_attempt_at: string | null;
  provider_message_id: string | null;
  sent_at: string | null;
  /** Position override (20261115000000); null/absent => inherit campaign. */
  position_title?: string | null;
  position_brief?: string | null;
  employer_facts?: string | null;
  /** Generation retries used for this letter (capped). */
  quality_attempts?: number;
  /** Lease for stale-generation recovery. */
  generation_started_at?: string | null;
  created_at: string;
  updated_at: string;
};

export type BewDocumentRow = {
  id: string;
  user_id: string;
  storage_path: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  kind: string;
  created_at: string;
};

export type BewCampaignDocumentRow = {
  id: string;
  campaign_id: string;
  document_id: string;
  user_id: string;
  kind: string;
  storage_path: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  created_at: string;
};

type Admin = ReturnType<typeof createAdminClient>;

/** A document ready to hand to createEmailProvider (ownership-validated). */
type AttachmentRef = { filename: string; mimeType: string; storagePath: string };

/* ------------------------------------------------------------------ *
 * Constants
 * ------------------------------------------------------------------ */

/** Max attempts for a TRANSIENT send failure before it is marked failed. */
export const BEW_MAX_SEND_ATTEMPTS = 3;
/** Bounded work per batch drain (mirrors the existing engine's cap of 5). */
export const BEW_MAX_BATCH = 5;
/** Retry backoff for a transient send failure (seconds). */
const BEW_RETRY_AFTER_SECONDS = 60;

const BEW_TERMINAL_CAMPAIGN = new Set([
  "completed",
  "partially_failed",
  "cancelled",
]);
/** App states from which a letter can be generated / regenerated. */
const BEW_GENERATABLE = ["pending", "failed"];
/** App states that are part of the send queue (must not be edited). */
const BEW_IN_FLIGHT = new Set(["queued", "sending", "sent"]);

/* ------------------------------------------------------------------ *
 * Schema probe (manual-migration safety contract)
 * ------------------------------------------------------------------ */

let bewSchemaProbe: Promise<boolean> | null = null;

/**
 * Whether the isolated `bew_*` tables exist (migration
 * 20261112000000_bewerbung_automation.sql applied). This repo applies
 * migrations MANUALLY, so code may run ahead of the schema. Only a CLEAN
 * read of all three core tables proves support; any error → false (the
 * feature then shows a "schema pending" state instead of crashing).
 */
export function hasBewAutomationSchema(): Promise<boolean> {
  bewSchemaProbe ??= (async () => {
    try {
      const admin = createAdminClient();
      const [c, a, d] = await Promise.all([
        admin.from("bew_campaigns").select("id").limit(1),
        admin.from("bew_applications").select("id").limit(1),
        admin.from("bew_documents").select("id").limit(1),
      ]);
      return c.error === null && a.error === null && d.error === null;
    } catch {
      return false;
    }
  })();
  return bewSchemaProbe;
}

/** Test hook: drop the cached probe. */
export function resetBewSchemaProbe(): void {
  bewSchemaProbe = null;
}

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

function todayUtcDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function nowIso(): string {
  return new Date().toISOString();
}

function inSecondsIso(seconds: number): string {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

function left(value: string | null | undefined, max: number): string | null {
  if (!value) return null;
  return value.length > max ? value.slice(0, max) : value;
}

async function getBewCampaignOwned(
  admin: Admin,
  userId: string,
  campaignId: string,
): Promise<BewCampaignRow | null> {
  const { data } = await admin
    .from("bew_campaigns")
    .select("*")
    .eq("id", campaignId)
    .eq("user_id", userId)
    .maybeSingle();
  return (data as BewCampaignRow | null) ?? null;
}

/** Require an owned, non-terminal campaign or throw. */
async function requireOwnedCampaign(
  userId: string,
  campaignId: string,
): Promise<{ admin: Admin; campaign: BewCampaignRow }> {
  const admin = createAdminClient();
  const campaign = await getBewCampaignOwned(admin, userId, campaignId);
  if (!campaign) throw new Error("NOT_FOUND");
  return { admin, campaign };
}

const BEW_APP_STATUSES = [
  "pending",
  "generating",
  "generated",
  "excluded",
  "queued",
  "sending",
  "sent",
  "failed",
  "needs_attention",
  "cancelled",
] as const;

async function countByStatus(
  admin: Admin,
  campaignId: string,
): Promise<Record<string, number>> {
  const acc: Record<string, number> = {};
  for (const s of BEW_APP_STATUSES) {
    const { count } = await admin
      .from("bew_applications")
      .select("*", { count: "exact", head: true })
      .eq("campaign_id", campaignId)
      .eq("status", s);
    acc[s] = count ?? 0;
  }
  return acc;
}

/**
 * Recompute the campaign counters and terminal status from the application
 * rows (the source of truth — counters never drift). `needs_attention` is
 * treated as a non-success (it needs a human before it can be retried).
 *
 * TERMINAL-STATE RULE: the campaign only becomes terminal (`completed` /
 * `partially_failed`) when EVERY application is in a done state
 * (`sent` / `excluded` / `cancelled`). A partial batch (e.g. 3 of 5 sent,
 * 2 still `generated`) must keep the campaign OPEN so the remainder can be
 * queued in a later, explicit start. `failed` / `needs_attention` /
 * `generated` / `pending` applications are all still changeable (regenerate,
 * exclude, retry), so they never close the campaign.
 */
/**
 * The documented `valid_count` contract (bew_campaigns column comment): how
 * many applications actually carry a company + a recipient (a non-empty name
 * and a structurally valid e-mail). Excluded/cancelled rows do not count —
 * they were deliberately removed from the campaign.
 *
 * IMPORTANT: this is derived from the ROW VALUES, never from generation
 * status. The previous implementation stored `generated+queued+sending+sent`
 * here, which silently re-locked the wizard's step-1→2 gate to 0 the moment
 * any counter refresh ran while rows were still `pending`.
 */
function countValidCompanies(
  rows: Array<Pick<BewApplicationRow, "status" | "company_name" | "company_email">>,
): number {
  return rows.filter(
    (r) =>
      r.status !== "excluded" &&
      r.status !== "cancelled" &&
      (r.company_name ?? "").trim().length > 0 &&
      isValidEmail(r.company_email ?? ""),
  ).length;
}

async function refreshCampaignCounters(
  admin: Admin,
  campaignId: string,
): Promise<void> {
  const { data: appData, error: appError } = await admin
    .from("bew_applications")
    .select("*")
    .eq("campaign_id", campaignId);
  if (appError || !appData) {
    // Never clobber the counters with zeros when the read itself failed.
    console.error(
      "[bew] refreshCampaignCounters: cannot read applications; counters left as-is",
      appError?.message ?? "no rows returned",
    );
    return;
  }
  const apps = appData as unknown as BewApplicationRow[];
  const by: Record<string, number> = {};
  for (const s of BEW_APP_STATUSES) by[s] = 0;
  for (const row of apps) by[row.status] = (by[row.status] ?? 0) + 1;
  const total = apps.length;
  const inFlight = (by["queued"] ?? 0) + (by["sending"] ?? 0);
  const success = by["sent"] ?? 0;
  const problem = (by["failed"] ?? 0) + (by["needs_attention"] ?? 0);
  const done = success + (by["excluded"] ?? 0) + (by["cancelled"] ?? 0);
  const remaining = total - done;

  const { data: current } = await admin
    .from("bew_campaigns")
    .select("status, completed_at")
    .eq("id", campaignId)
    .maybeSingle();
  const currentRow = current as { status?: string; completed_at?: string | null } | null;
  const currentStatus = currentRow?.status ?? "sending";
  const currentCompletedAt = currentRow?.completed_at ?? null;

  let status = currentStatus;
  if (!BEW_TERMINAL_CAMPAIGN.has(currentStatus)) {
    if (remaining === 0) {
      // Every application is done (sent / excluded / cancelled).
      status = problem === 0 ? "completed" : "partially_failed";
    } else if (inFlight > 0) {
      status = "sending";
    } else if ((by["pending"] ?? 0) + (by["generating"] ?? 0) > 0) {
      status = "generating";
    } else {
      // Applications await an explicit (re)start — keep the campaign open.
      status = "draft";
    }
  }
  const completedAt = BEW_TERMINAL_CAMPAIGN.has(status)
    ? (currentCompletedAt ?? nowIso())
    : null;

  const { error: updateError } = await admin
    .from("bew_campaigns")
    .update({
      total_count: total,
      sent_count: success,
      failed_count: problem,
      excluded_count: by["excluded"] ?? 0,
      generated_count: by["generated"] ?? 0,
      valid_count: countValidCompanies(apps),
      status,
      completed_at: completedAt,
    })
    .eq("id", campaignId);
  if (updateError) {
    // Non-fatal mid-flow (the next operation/tick retries), but it must never
    // be silent again: a failed counter write previously froze the wizard's
    // step-1→2 gate with no error shown anywhere (42703 trigger regression).
    console.error(
      "[bew] refreshCampaignCounters: campaign counter update failed",
      updateError.message,
    );
  }
}

/* ------------------------------------------------------------------ *
 * Campaign + company operations (step 1)
 * ------------------------------------------------------------------ */

export interface CreateBewCampaignInput {
  userId: string;
  count: number;
  purpose: BewPurpose;
  emailAccountId?: string | null;
  /** The role this campaign targets (empty => general, never invented). */
  positionTitle?: string;
  positionBrief?: string;
  employerFacts?: string;
}

/** A resolved e-mail account row (ownership-verified by the query). */
interface ResolvedSenderAccount {
  id: string;
  email: string;
  is_active: boolean;
  requires_reconnect: boolean;
}

/**
 * The default sender: the user's own ACTIVE, healthy account (the feature is
 * designed around the already-connected Gmail — no new integration).
 * `null` when the user has no such account.
 */
async function resolveDefaultSenderAccount(
  admin: Admin,
  userId: string,
): Promise<ResolvedSenderAccount | null> {
  const { data: accounts } = await admin
    .from("email_accounts")
    .select("id, email, is_active, requires_reconnect")
    .eq("user_id", userId)
    .eq("is_active", true)
    .eq("requires_reconnect", false)
    .order("created_at", { ascending: true })
    .limit(1);
  return ((accounts ?? []) as ResolvedSenderAccount[])[0] ?? null;
}

/**
 * The full creation work (validation, default-sender resolution, campaign
 * insert, row seeding). `defaultSenderEmail` is the display e-mail of the
 * DEFAULT sender resolved in THIS call — so `createBewCampaignView` can build
 * the view without re-reading the account. `undefined` when the caller passed
 * an explicit `emailAccountId` (its e-mail was not read); `null` when no
 * default account exists (the view then has no sender to resolve either).
 */
async function createBewCampaignCore(
  input: CreateBewCampaignInput,
): Promise<{ row: BewCampaignRow; defaultSenderEmail: string | null | undefined }> {
  const check = validateCompanyCount(input.count);
  if (!check.ok) throw new Error("INVALID_COUNT");
  if (!isBewPurpose(input.purpose)) throw new Error("INVALID_PURPOSE");
  const positionTitle = (input.positionTitle ?? "").trim();
  const positionBrief = (input.positionBrief ?? "").trim();
  const employerFacts = (input.employerFacts ?? "").trim();
  if (positionTitle.length > BEW_POSITION_TITLE_MAX) throw new Error("POSITION_TOO_LONG");
  if (positionBrief.length > BEW_POSITION_BRIEF_MAX) throw new Error("POSITION_TOO_LONG");
  if (employerFacts.length > BEW_EMPLOYER_FACTS_MAX) throw new Error("POSITION_TOO_LONG");
  const admin = createAdminClient();
  // The schema probe and the default-sender read are INDEPENDENT — start both
  // now (the probe is cached process-wide; this saves one sequential round
  // trip on the first creation per process).
  const positionProbe = hasBewPositionColumns();

  let emailAccountId = input.emailAccountId ?? null;
  let defaultSenderEmail: string | null | undefined = undefined;
  if (!emailAccountId) {
    const sender = await resolveDefaultSenderAccount(admin, input.userId);
    emailAccountId = sender?.id ?? null;
    defaultSenderEmail = sender ? sender.email : null;
  }
  const positionSupported = await positionProbe;

  const { data: campaign, error: campaignError } = await admin
    .from("bew_campaigns")
    .insert({
      user_id: input.userId,
      email_account_id: emailAccountId,
      purpose: input.purpose,
      status: "draft",
      requested_count: check.value,
      usage_date: todayUtcDate(),
      ...(positionSupported
        ? {
            position_title: positionTitle,
            position_brief: positionBrief,
            employer_facts: employerFacts,
          }
        : {}),
    })
    .select("*")
    .single();
  if (campaignError || !campaign)
    throw new Error("Unable to create the automation campaign.");
  const row = campaign as BewCampaignRow;

  // Seed the requested number of empty application rows.
  const seeds = Array.from({ length: check.value }, (_, i) => ({
    campaign_id: row.id,
    user_id: input.userId,
    seq: i + 1,
    company_name: "",
    company_email: "",
    contact_name: null,
    company_address: null,
    subject: "",
    body_html: "",
    body_text: "",
    status: "pending",
  }));
  const { error: seedError } = await admin
    .from("bew_applications")
    .insert(seeds);
  if (seedError) {
    // Compensate: drop the campaign we just created (no quota was reserved).
    await admin.from("bew_campaigns").delete().eq("id", row.id);
    throw new Error("Unable to initialize the application list.");
  }

  return { row, defaultSenderEmail };
}

/**
 * Create a new automation campaign and seed `count` empty pending
 * applications (seq 1..count). The count is validated (1..100). No quota is
 * reserved and no e-mail is sent — this only prepares the structure.
 */
export async function createBewCampaign(
  input: CreateBewCampaignInput,
): Promise<BewCampaignRow> {
  const { row } = await createBewCampaignCore(input);
  return row;
}

/**
 * Create a new campaign AND build its fresh view in ONE operation (one
 * authenticated request from the client's perspective).
 *
 * Why: the "+ New series" flow used to call the create action and THEN a
 * separate `getBewCampaignView` action — two re-authentication round trips and
 * a redundant campaign re-read before the UI could show the new series. The
 * view is built from the just-inserted row (the default sender's e-mail is
 * reused when it was resolved in this call), so nothing is fetched twice.
 * The created campaign is identical to `createBewCampaign`'s — same
 * validation, seeding and compensation.
 */
export async function createBewCampaignView(
  input: CreateBewCampaignInput,
): Promise<BewCampaignView> {
  const { row, defaultSenderEmail } = await createBewCampaignCore(input);
  const admin = createAdminClient();
  return buildBewCampaignView(admin, row, input.userId, defaultSenderEmail);
}

/**
 * Replace the campaign's company records (from manual entry or a file
 * import). Every record is normalized/validated by the pure
 * `buildImportResult`; ALL rows are preserved (never silently discarded).
 * Regenerating invalidates any previously generated letters (companies
 * changed), so affected applications reset to `pending`.
 */
export async function saveBewCompanies(
  userId: string,
  campaignId: string,
  records: Array<Partial<{
    companyName: string;
    companyEmail: string;
    contactName: string | null;
    companyAddress: string | null;
    positionTitle: string;
    positionBrief: string;
    employerFacts: string;
  }>>,
): Promise<{ campaign: BewCampaignRow; result: BewImportResult }> {
  const { admin, campaign } = await requireOwnedCampaign(userId, campaignId);
  const positionSupported = await hasBewPositionColumns();
  const overrides = records.map((r) => ({
    positionTitle: (r.positionTitle ?? "").trim(),
    positionBrief: (r.positionBrief ?? "").trim(),
    employerFacts: (r.employerFacts ?? "").trim(),
  }));
  for (const o of overrides) {
    if (o.positionTitle.length > BEW_POSITION_TITLE_MAX) throw new Error("POSITION_TOO_LONG");
    if (o.positionBrief.length > BEW_POSITION_BRIEF_MAX) throw new Error("POSITION_TOO_LONG");
    if (o.employerFacts.length > BEW_EMPLOYER_FACTS_MAX) throw new Error("POSITION_TOO_LONG");
  }
  const result = buildImportResult(records, 1);

  // Replace existing applications with the imported set (reset letters).
  await admin.from("bew_applications").delete().eq("campaign_id", campaignId);
  const rows = result.rows.map((r, i) => {
    const ov = overrides[i];
    return {
      campaign_id: campaignId,
      user_id: userId,
      seq: r.seq,
      company_name: r.companyName,
      company_email: r.companyEmail,
      contact_name: r.contactName,
      company_address: r.companyAddress,
      subject: r.companyName ? buildSubject(campaign.purpose as BewPurpose, r.companyName) : "",
      body_html: "",
      body_text: "",
      status: "pending",
      ...(positionSupported && ov
        ? {
            position_title: ov.positionTitle || null,
            position_brief: ov.positionBrief || null,
            employer_facts: ov.employerFacts || null,
          }
        : {}),
    };
  });
  if (rows.length > 0) {
    const { error } = await admin.from("bew_applications").insert(rows);
    if (error) throw new Error("Unable to save the company list.");
  }
  // The campaign counters must land together with the rows: the wizard's
  // step-1→2 gate is derived from this state. A failed write here is a
  // FAILED save — throwing the stable SAVE_FAILED code turns the old silent
  // success (the 42703 trigger regression) into a visible error.
  const { error: counterError } = await admin
    .from("bew_campaigns")
    .update({
      total_count: rows.length,
      valid_count: countValidCompanies(rows),
      status: "draft",
    })
    .eq("id", campaignId);
  if (counterError) {
    console.error(
      "[bew] saveBewCompanies: campaign counter update failed",
      counterError.message,
    );
    throw new Error("SAVE_FAILED");
  }

  const fresh = await getBewCampaignOwned(admin, userId, campaignId);
  return { campaign: fresh ?? campaign, result };
}

/**
 * Best-effort PDF import of the COMPANY LIST (step 1, alternative input
 * method). Extracts readable text with the shared `extractPdfText` utility
 * and proposes candidates (e-mail + name guess from the same line).
 *
 * The result is a PREVIEW ONLY: nothing is stored here. The user reviews
 * the candidates in the UI and applies them through `saveBewCompanies` —
 * the exact same path as the CSV import, so no field is silently guessed.
 */
export async function importBewCompaniesFromPdf(
  file: File,
): Promise<{ candidates: PdfCompanyCandidate[]; excerpt: string }> {
  const buffer = Buffer.from(await file.arrayBuffer());
  const check = validateDocumentInput(file.type, buffer.length);
  if (!check.ok) throw new Error(`DOCUMENT_${check.error.toUpperCase()}`);
  if (file.type !== "application/pdf") throw new Error("PDF_REQUIRED");
  let text = "";
  try {
    text = await extractPdfText(buffer);
  } catch {
    text = ""; // best effort: unparseable PDF → empty preview, user informed
  }
  return { candidates: parsePdfCompanyCandidates(text), excerpt: text.slice(0, 4000) };
}

/**
 * Update a single application's company fields (manual edit, step 1).
 * Changing the recipient invalidates a generated letter (reset to pending)
 * so a stale letter is never sent to a new address.
 */
export async function updateBewApplicationFields(
  userId: string,
  applicationId: string,
  fields: {
    companyName: string;
    companyEmail: string;
    contactName: string | null;
    companyAddress: string | null;
    positionTitle?: string;
    positionBrief?: string;
    employerFacts?: string;
  },
): Promise<BewApplicationRow | null> {
  const admin = createAdminClient();
  // The schema probe is independent of the row read — start it now so its
  // (cold, process-first) round trip overlaps the ownership select instead of
  // queueing after it.
  const positionProbe = hasBewPositionColumns();
  const { data: existing } = await admin
    .from("bew_applications")
    .select("*")
    .eq("id", applicationId)
    .eq("user_id", userId)
    .maybeSingle();
  const app = existing as BewApplicationRow | null;
  if (!app) return null;
  if (BEW_IN_FLIGHT.has(app.status)) throw new Error("APPLICATION_LOCKED");
  if ((fields.positionTitle ?? "").trim().length > BEW_POSITION_TITLE_MAX) throw new Error("POSITION_TOO_LONG");
  if ((fields.positionBrief ?? "").trim().length > BEW_POSITION_BRIEF_MAX) throw new Error("POSITION_TOO_LONG");
  if ((fields.employerFacts ?? "").trim().length > BEW_EMPLOYER_FACTS_MAX) throw new Error("POSITION_TOO_LONG");

  const purpose =
    ((await getBewCampaignOwned(admin, userId, app.campaign_id))
      ?.purpose as BewPurpose) ?? "ausbildung";
  // Re-validate exactly like the import path so the row's derived fields
  // (name suggestion, subject) stay consistent.
  const validated = buildImportResult(
    [
      {
        companyName: fields.companyName,
        companyEmail: fields.companyEmail,
        contactName: fields.contactName,
        companyAddress: fields.companyAddress,
      },
    ],
    app.seq,
  ).rows[0];

  const positionSupportedUpdate = await positionProbe;
  const { data: updated } = await admin
    .from("bew_applications")
    .update({
      company_name: validated.companyName,
      company_email: validated.companyEmail,
      contact_name: validated.contactName,
      company_address: validated.companyAddress,
      subject: validated.companyName
        ? buildSubject(purpose, validated.companyName)
        : "",
      // A changed recipient invalidates the generated letter.
      status: "pending",
      body_html: "",
      body_text: "",
      error_code: null,
      error_message: null,
      next_attempt_at: null,
      ...(positionSupportedUpdate
        ? {
            position_title: (fields.positionTitle ?? "").trim() || null,
            position_brief: (fields.positionBrief ?? "").trim() || null,
            employer_facts: (fields.employerFacts ?? "").trim() || null,
          }
        : {}),
    })
    .eq("id", applicationId)
    .eq("user_id", userId)
    .select("*")
    .maybeSingle();
  // The row's validity changed → the campaign counters must follow
  // (otherwise valid_count drifts from the rows, e.g. a fixed row is not
  // counted, a broken one still is).
  await refreshCampaignCounters(admin, app.campaign_id);
  return (updated as BewApplicationRow | null) ?? null;
}

/* ------------------------------------------------------------------ *
 * Personal documents (step 2) — upload once, reuse across the campaign
 * ------------------------------------------------------------------ */

const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/**
 * Upload a CV / certificate / supporting document ONCE to the user's library.
 * Stored in the existing private `application-attachments` bucket (so the
 * unmodified send path can read it) with an owner-scoped `bew_documents`
 * row. Content is validated by MIME + size before any storage write; on a
 * failed metadata insert the storage object is removed (compensating).
 */
export async function uploadBewDocument(
  userId: string,
  file: File,
  kind: DocumentKind,
): Promise<BewDocumentRow> {
  if (!isDocumentKind(kind)) throw new Error("INVALID_KIND");
  const buffer = Buffer.from(await file.arrayBuffer());
  const check = validateDocumentInput(file.type, buffer.length);
  if (!check.ok) throw new Error(`DOCUMENT_${check.error.toUpperCase()}`);

  const admin = createAdminClient();
  const path = storagePath(userId, file.name);
  const { error: uploadError } = await admin.storage
    .from("application-attachments")
    .upload(path, buffer, { contentType: file.type, upsert: false });
  if (uploadError) {
    // Stable code (not raw storage text): the UI maps it to the user's
    // language without leaking paths or bucket details.
    console.error("[bew] uploadBewDocument: storage upload failed", uploadError.message);
    throw new Error("DOC_UPLOAD_FAILED");
  }

  const { data, error } = await admin
    .from("bew_documents")
    .insert({
      user_id: userId,
      storage_path: path,
      filename: file.name,
      mime_type: file.type,
      size_bytes: buffer.length,
      kind,
    })
    .select("*")
    .single();
  if (error || !data) {
    // Compensating: never leave an unregistered storage object behind.
    await admin.storage.from("application-attachments").remove([path]);
    console.error("[bew] uploadBewDocument: metadata insert failed", error?.message);
    throw new Error("DOC_SAVE_FAILED");
  }
  return data as unknown as BewDocumentRow;
}

async function loadCampaignDocuments(
  admin: Admin,
  campaignId: string,
  userId: string,
): Promise<BewCampaignDocumentRow[]> {
  const { data } = await admin
    .from("bew_campaign_documents")
    .select("*")
    .eq("campaign_id", campaignId)
    .eq("user_id", userId)
    .order("kind", { ascending: true })
    .order("filename", { ascending: true });
  return (data ?? []) as unknown as BewCampaignDocumentRow[];
}

/** The provider attachment list for a campaign (ownership-filtered). */
async function loadCampaignAttachments(
  admin: Admin,
  campaignId: string,
  userId: string,
): Promise<AttachmentRef[]> {
  const docs = await loadCampaignDocuments(admin, campaignId, userId);
  return docs.map((d) => ({
    filename: d.filename,
    mimeType: d.mime_type,
    storagePath: d.storage_path,
  }));
}

/**
 * The same file attached twice (e.g. the user's own Anschreiben PDF in the
 * document library AND the generated one) would double the e-mail size —
 * identical names collapse to the first occurrence.
 */
function dedupeAttachmentsByName(
  refs: Array<AttachmentRef>,
): Array<AttachmentRef> {
  const seen = new Set<string>();
  const out: Array<AttachmentRef> = [];
  for (const ref of refs) {
    const key = ref.filename.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
  }
  return out;
}

/**
 * Applicant facts for the letter header — the full applicant profile
 * (name, e-mail + the five address fields). NEVER invented: absent values
 * stay "". While the 20261114000000 migration is pending the new columns
 * are not SELECT-able (manual-migration safety), so they degrade to "" —
 * which makes the profile "incomplete" and gates NEW letter generation
 * with the stable PROFILE_INCOMPLETE code instead of silently producing
 * the old name+email-only letter.
 */
async function getApplicantFacts(admin: Admin, userId: string): Promise<ApplicantFacts> {
  const addressSupported = await hasApplicantProfileColumns();
  const { data } = await admin
    .from("profiles")
    .select(
      addressSupported
        ? "full_name, email, street, postal_code, city, country, phone"
        : "full_name, email",
    )
    .eq("id", userId)
    .maybeSingle();
  const row = (data ?? null) as
    | {
        full_name?: string | null;
        email?: string | null;
        street?: string | null;
        postal_code?: string | null;
        city?: string | null;
        country?: string | null;
        phone?: string | null;
      }
    | null;
  return {
    name: row?.full_name ?? "",
    email: row?.email ?? "",
    street: row?.street ?? "",
    postalCode: row?.postal_code ?? "",
    city: row?.city ?? "",
    country: row?.country ?? "",
    phone: row?.phone ?? "",
  };
}

/** Field record for validateApplicantProfile (name → fullName mapping). */
function applicantFields(f: ApplicantFacts): Partial<Record<ApplicantProfileField, unknown>> {
  return {
    fullName: f.name,
    street: f.street,
    postalCode: f.postalCode,
    city: f.city,
    country: f.country,
    email: f.email,
    phone: f.phone,
  };
}

/** True when all seven applicant fields are valid (the PDF header gate). */
function isApplicantComplete(f: ApplicantFacts): boolean {
  return validateApplicantProfile(applicantFields(f)).ok;
}

/**
 * Attach an already-uploaded document to a campaign (shared by every
 * application). Ownership of the document is enforced; the file itself is
 * never copied.
 */
export async function attachBewDocument(
  userId: string,
  campaignId: string,
  documentId: string,
  kind: DocumentKind,
): Promise<BewCampaignDocumentRow> {
  const { admin, campaign } = await requireOwnedCampaign(userId, campaignId);
  if (BEW_TERMINAL_CAMPAIGN.has(campaign.status))
    throw new Error("CAMPAIGN_CLOSED");
  const { data: doc } = await admin
    .from("bew_documents")
    .select("*")
    .eq("id", documentId)
    .eq("user_id", userId)
    .maybeSingle();
  if (!doc) throw new Error("NOT_FOUND");
  const d = doc as unknown as BewDocumentRow;
  const { data, error } = await admin
    .from("bew_campaign_documents")
    .upsert(
      {
        campaign_id: campaignId,
        document_id: documentId,
        user_id: userId,
        kind,
        storage_path: d.storage_path,
        filename: d.filename,
        mime_type: d.mime_type,
        size_bytes: d.size_bytes,
      },
      { onConflict: "campaign_id,document_id" },
    )
    .select("*")
    .single();
  if (error || !data) {
    console.error("[bew] attachBewDocument: attach failed", error?.message);
    throw new Error("DOC_ATTACH_FAILED");
  }
  return data as unknown as BewCampaignDocumentRow;
}

/** Detach a document from a campaign (the user's file is kept). */
export async function detachBewDocument(
  userId: string,
  campaignId: string,
  documentId: string,
): Promise<void> {
  const admin = createAdminClient();
  const { error } = await admin
    .from("bew_campaign_documents")
    .delete()
    .eq("campaign_id", campaignId)
    .eq("document_id", documentId)
    .eq("user_id", userId);
  if (error) {
    console.error("[bew] detachBewDocument: delete failed", error.message);
    throw new Error("DOC_ATTACH_FAILED");
  }
}

/** List the user's document library (for the upload picker). */
export async function listBewDocuments(userId: string): Promise<BewDocumentRow[]> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("bew_documents")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });
  return (data ?? []) as unknown as BewDocumentRow[];
}

/** Best-effort text extraction for personalization (never throws). */
async function extractDocumentText(
  admin: Admin,
  path: string,
  mime: string,
): Promise<string> {
  try {
    const { data, error } = await admin.storage
      .from("application-attachments")
      .download(path);
    if (error || !data) return "";
    const buffer = Buffer.from(await data.arrayBuffer());
    if (mime === "application/pdf") {
      try {
        return await extractPdfText(buffer);
      } catch {
        return "";
      }
    }
    if (mime === DOCX_MIME) {
      try {
        const result = await mammoth.extractRawText({ buffer });
        return result.value;
      } catch {
        return "";
      }
    }
    if (mime === "text/plain") return buffer.toString("utf8");
    return "";
  } catch {
    return "";
  }
}

/* ------------------------------------------------------------------ *
 * Letter generation (step 3)
 * ------------------------------------------------------------------ */

export interface GenerateBewResult {
  generated: number;
  failed: number;
  remaining: number;
  aiQuotaHit: boolean;
}

/* ---------------- Position-brief migration probe ---------------- */

let bewPositionProbe: Promise<boolean> | null = null;

/**
 * Migration-state probe for the 20261115000000 position-brief columns.
 * Same contract as the other probes: a CLEAN READ proves support; any error
 * (e.g. the column is missing because the migration is pending) resolves to
 * false, and the feature degrades to "no position" instead of a 42703 crash.
 */
export function hasBewPositionColumns(): Promise<boolean> {
  bewPositionProbe ??= (async () => {
    try {
      const admin = createAdminClient();
      const { error } = await admin
        .from("bew_campaigns")
        .select("position_title")
        .limit(1);
      return error === null;
    } catch {
      return false;
    }
  })();
  return bewPositionProbe;
}

/** Test hook: drop the cached position-columns probe. */
export function resetBewPositionColumnsProbe(): void {
  bewPositionProbe = null;
}

/* ---------------- Candidate (CV) profile load ---------------- */

/**
 * Load the applicant's latest PARSED + VERIFIED candidate profile (from the
 * CV scanner, `candidate_profiles`). This structured profile is the
 * trustworthy evidence base for the Anschreiben and is preferred over the raw
 * extracted text. Ownership-filtered; returns null when the user has not
 * scanned a CV (the engine then falls back to the raw CV text).
 */
async function loadCandidateProfile(
  admin: Admin,
  userId: string,
): Promise<CandidateProfile | null> {
  const { data } = await admin
    .from("candidate_profiles")
    .select("profile_json")
    .eq("user_id", userId)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const raw = (data as { profile_json: unknown } | null)?.profile_json ?? null;
  if (!raw) return null;
  try {
    return candidateProfileSchema.parse(raw);
  } catch {
    return null; // malformed stored profile → degrade to raw CV text
  }
}

/* ---------------- Stale-generation recovery ---------------- */

/** How long a 'generating' row may sit before it is considered stale. */
const BEW_GENERATION_STALE_MS = 10 * 60 * 1000;

/**
 * Reclaim application rows stuck in 'generating' (e.g. the process crashed
 * mid-generation). Safe + idempotent:
 *  - only rows STILL 'generating' whose lease (generation_started_at) is older
 *    than the window, AND with an empty body and no sent_at, are touched;
 *  - generated / sent rows are NEVER reset;
 *  - the campaign is only re-marked 'generating' when something was reclaimed.
 * Returns the number of reclaimed rows.
 */
export async function reclaimStaleGenerating(
  admin: Admin,
  userId: string,
  campaignId: string,
  staleMs: number = BEW_GENERATION_STALE_MS,
): Promise<number> {
  const cutoff = new Date(Date.now() - staleMs).toISOString();
  const { data, error } = await admin
    .from("bew_applications")
    .update({
      status: "pending",
      error_code: null,
      error_message: null,
      generation_started_at: null,
    })
    .eq("campaign_id", campaignId)
    .eq("user_id", userId)
    .eq("status", "generating")
    .eq("body_html", "")
    .is("sent_at", null)
    .lt("generation_started_at", cutoff)
    .select("id");
  if (error) throw error;
  const reclaimed = (data ?? []).length;
  if (reclaimed > 0) {
    await admin
      .from("bew_campaigns")
      .update({ status: "generating" })
      .eq("id", campaignId)
      .eq("status", "completed");
  }
  return reclaimed;
}

/* ---------------- Optional model-based quality eval ---------------- */

/**
 * Model-based quality evaluation (best-effort). Returns a parsed verdict, or
 * null when the provider is unavailable, the call fails, or the response is
 * not a well-formed verdict — in which case the caller falls back to the
 * deterministic gate (never over-rejects a sound letter on eval flakiness).
 */
async function runModelEval(
  userId: string,
  letterBody: string,
  promptInput: LetterPromptInput,
): Promise<LetterEvalVerdict | null> {
  try {
    await reserveAIUsage(userId);
    const out = await createAIProvider().generateText(
      [{ role: "user", content: buildLetterEvalPrompt(letterBody, promptInput) }],
      60_000,
    );
    return parseLetterEvalVerdict(out);
  } catch {
    return null;
  }
}

/**
 * Generate a distinct Anschreiben for up to `limit` (bounded) applications.
 *
 *  - Only `pending`/`failed` applications are generated (successful letters
 *    are never duplicated) — so this is the safe "retry the failed ones"
 *    path when called after a partial failure.
 *  - The CV + certificate text is extracted ONCE and shared; each letter is
 *    built from the SAME facts but a per-company prompt (company name,
 *    contact, address) so every letter is distinct.
 *  - `reserveAIUsage` is the shared AI-quota gate; hitting it parks the rest
 *    as `pending` (reported via `aiQuotaHit`) instead of erroring the batch.
 *  - A per-letter AI failure marks THAT application `failed` (retryable) and
 *    continues with the rest.
 */
export async function generateBewLetters(
  userId: string,
  campaignId: string,
  profile: Profile,
  opts: { limit?: number; onlyFailed?: boolean } = {},
): Promise<GenerateBewResult> {
  const { admin, campaign } = await requireOwnedCampaign(userId, campaignId);
  if (BEW_TERMINAL_CAMPAIGN.has(campaign.status))
    throw new Error("CAMPAIGN_CLOSED");
  // The full applicant header (seven mandatory profile fields) is required
  // before any NEW Anschreiben is generated. Stable code — the wizard maps
  // it to a localized "complete your profile" explanation. No rows are
  // claimed and nothing is mutated before this gate.
  const applicantFacts = await getApplicantFacts(admin, userId);
  if (!isApplicantComplete(applicantFacts)) throw new Error("PROFILE_INCOMPLETE");
  const limit = Math.min(Math.max(1, opts.limit ?? BEW_MAX_BATCH), BEW_MAX_BATCH);
  const purpose = (campaign.purpose as BewPurpose) || "ausbildung";

  // Shared facts: CV + certificates (extracted once).
  const docs = await loadCampaignDocuments(admin, campaignId, userId);
  const cv = docs.find((d) => d.kind === "cv");
  const cvText = cv
    ? await extractDocumentText(admin, cv.storage_path, cv.mime_type)
    : "";
  const others = docs.filter(
    (d) => d.kind === "certificate" || d.kind === "supporting",
  );
  const certText = (
    await Promise.all(
      others.slice(0, 5).map((d) =>
        extractDocumentText(admin, d.storage_path, d.mime_type),
      ),
    )
  ).join("\n\n");

  // Structured, verified CV evidence (preferred) + raw text (fallback).
  const candidate = await loadCandidateProfile(admin, userId);
  // Optional model-based quality eval (off by default; opt-in via env so the
  // deterministic gate keeps the suite fast and quota-stable).
  const modelEvalEnabled =
    process.env.BEW_LETTER_MODEL_EVAL === "1" ||
    process.env.BEW_LETTER_MODEL_EVAL === "true";
  // Reclaim rows a previous run left stuck in 'generating' (best-effort; a
  // test mock without the lease columns simply no-ops here).
  try {
    await reclaimStaleGenerating(admin, userId, campaignId);
  } catch {
    /* no-op when the lease columns / .lt() are unavailable */
  }

  // Claim a bounded set (atomic: only rows still in a generatable state flip).
  const wanted = opts.onlyFailed ? ["failed"] : [...BEW_GENERATABLE];
  const { data: candidateRows } = await admin
    .from("bew_applications")
    .select("id")
    .eq("campaign_id", campaignId)
    .in("status", wanted)
    .order("seq", { ascending: true })
    .limit(limit);
  const ids = ((candidateRows ?? []) as Array<{ id: string }>).map((r) => r.id);
  if (ids.length === 0)
    return { generated: 0, failed: 0, remaining: 0, aiQuotaHit: false };
  const { data: claimedRows } = await admin
    .from("bew_applications")
    .update({ status: "generating", generation_started_at: new Date().toISOString() })
    .in("id", ids)
    .in("status", wanted)
    .select("*");
  const apps = (claimedRows ?? []) as unknown as BewApplicationRow[];

  let generated = 0;
  let failed = 0;
  let aiQuotaHit = false;

  let stopAll = false;
  for (const app of apps) {
    if (stopAll) break;

    const pos = resolveLetterPosition(app, campaign);
    const promptInput: LetterPromptInput = {
      purpose,
      position: { title: pos.title, brief: pos.brief },
      employer: {
        companyName: app.company_name,
        contactName: app.contact_name,
        companyAddress: app.company_address,
        facts: pos.employerFacts,
      },
      applicant: { candidate, cvText, certificatesText: certText },
    };
    const subject = app.subject || buildSubject(purpose, app.company_name);

    let attempts = 0;
    let lastGate: LetterQualityResult | null = null;
    let lastVerdict: LetterEvalVerdict | null = null;
    let aiError: string | null = null;
    let accepted = false;

    while (attempts < BEW_MAX_LETTER_ATTEMPTS && !stopAll) {
      attempts += 1;
      try {
        await reserveAIUsage(userId);
      } catch {
        aiQuotaHit = true;
        stopAll = true;
        // Park this (and the rest, via stopAll) for later; not a generation
        // failure. Orphaned 'generating' rows are reclaimed on the next run.
        await admin
          .from("bew_applications")
          .update({
            status: "pending",
            error_code: "ai_quota",
            error_message: null,
            quality_attempts: attempts,
          })
          .eq("id", app.id);
        break;
      }

      let prompt = buildLetterPrompt(promptInput);
      if (attempts > 1) {
        const base: LetterQualityResult =
          lastGate ?? { accepted: false, words: 0, hardFailures: ["too_short"], issues: [] };
        const corrective =
          buildLetterCorrectiveNote(base) +
          (lastVerdict && lastVerdict.reasons.length
            ? " Prüferhinweise: " + lastVerdict.reasons.join("; ")
            : "");
        prompt += `\n\nVERBESSERUNG: ${corrective}`;
      }

      let aiBody: string;
      try {
        aiBody = await createAIProvider().generateText(
          [{ role: "user", content: prompt }],
          90_000,
        );
      } catch (err) {
        aiError = err instanceof Error ? err.message : "AI generation failed";
        break; // provider error — not a quality failure
      }

      const letter = assembleLetter({
        aiBody,
        contactName: app.contact_name,
        signature: profile.full_name,
      });
      const bodyHtml = sanitizeEmailHtml(letter.bodyHtml);
      const bodyText = htmlToText(bodyHtml) || letter.bodyText;

      // Deterministic quality gate (always on). Gate the MODEL'S body, not the
      // assembled letter — the greeting/closing/signature are deterministic
      // boilerplate and must not inflate the measured length.
      const gate = validateLetterQuality({
        bodyText: aiBody,
        positionTitle: pos.title,
        companyName: app.company_name,
      });
      if (!gate.accepted) {
        lastGate = gate;
        continue; // hard failure → bounded retry
      }

      // Optional model-based eval (deterministic gate already passed).
      if (modelEvalEnabled) {
        const verdict = await runModelEval(userId, bodyText, promptInput);
        if (verdict && !verdict.ok && attempts < BEW_MAX_LETTER_ATTEMPTS) {
          lastVerdict = verdict;
          lastGate = gate;
          continue;
        }
      }

      // Accept.
      await admin
        .from("bew_applications")
        .update({
          status: "generated",
          body_html: bodyHtml,
          body_text: bodyText,
          subject,
          error_code: null,
          error_message: null,
          quality_attempts: attempts,
        })
        .eq("id", app.id);
      // The Anschreiben PDF follows the letter (best-effort here; the send
      // path re-ensures it, so a transient failure never loses the letter).
      try {
        await ensureLetterPdf({
          userId,
          app: {
            id: app.id,
            company_name: app.company_name,
            contact_name: app.contact_name,
            company_address: app.company_address,
            subject,
            body_html: bodyHtml,
          },
          // The FULL applicant facts (validated complete by the
          // PROFILE_INCOMPLETE gate above) — the PDF carries all seven fields.
          applicant: applicantFacts,
        });
      } catch (pdfError) {
        console.error(
          "[bew] generateBewLetters: letter PDF generation failed",
          pdfError,
        );
      }
      generated += 1;
      accepted = true;
      break;
    }

    if (accepted) continue;
    if (stopAll) continue; // quota: already parked as pending

    if (aiError) {
      await admin
        .from("bew_applications")
        .update({
          status: "failed",
          error_code: "generation_failed",
          error_message: left(aiError, 500),
          quality_attempts: attempts,
        })
        .eq("id", app.id);
      failed += 1;
    } else {
      // Exhausted the bounded attempts on quality: a clear failure, never a
      // silently-accepted poor letter.
      const gate =
        lastGate ?? { accepted: false, words: 0, hardFailures: ["quality_gate"], issues: [] };
      const summary =
        "Qualitätsprüfung fehlgeschlagen: " +
        [...gate.hardFailures, ...gate.issues].join(", ");
      await admin
        .from("bew_applications")
        .update({
          status: "failed",
          error_code: "quality_gate",
          error_message: left(summary, 500),
          quality_attempts: attempts,
        })
        .eq("id", app.id);
      failed += 1;
    }
  }

  const { error: statusError } = await admin
    .from("bew_campaigns")
    .update({ status: "generating" })
    .eq("id", campaignId)
    .eq("status", "draft");
  if (statusError)
    console.error(
      "[bew] generateBewLetters: campaign status update failed",
      statusError.message,
    );
  const by = await countByStatus(admin, campaignId);
  const remaining = (by["pending"] ?? 0) + (by["failed"] ?? 0);
  return { generated, failed, remaining, aiQuotaHit };
}

/* ------------------------------------------------------------------ *
 * Review (step 4)
 * ------------------------------------------------------------------ */

/**
 * Edit a letter (and optionally its subject) before sending. Blocked once
 * the application is in the send queue or already sent. Sanitizes the HTML
 * and re-derives the plain-text body so the preview and the send match.
 */
export async function updateBewLetter(
  userId: string,
  applicationId: string,
  payload: { subject?: string; bodyHtml: string },
): Promise<BewApplicationRow | null> {
  const admin = createAdminClient();
  const { data: existing } = await admin
    .from("bew_applications")
    .select("*")
    .eq("id", applicationId)
    .eq("user_id", userId)
    .maybeSingle();
  const app = existing as BewApplicationRow | null;
  if (!app) return null;
  if (BEW_IN_FLIGHT.has(app.status) || app.status === "pending")
    throw new Error("APPLICATION_LOCKED");

  const bodyHtml = sanitizeEmailHtml(payload.bodyHtml ?? "");
  const bodyText = htmlToText(bodyHtml);
  const { data } = await admin
    .from("bew_applications")
    .update({
      body_html: bodyHtml,
      body_text: bodyText,
      subject: payload.subject !== undefined ? payload.subject : app.subject,
      status: "generated",
      error_code: null,
      error_message: null,
    })
     .eq("id", applicationId)
     .eq("user_id", userId)
     .select("*")
     .maybeSingle();
  const updated = (data as BewApplicationRow | null) ?? null;
  // The letter changed → regenerate THIS application's PDF (force). The
  // letter save stands regardless; the send path re-ensures as a last resort.
  if (updated) {
    try {
      const applicant = await getApplicantFacts(admin, userId);
      await ensureLetterPdf({
        userId,
        app: {
          id: updated.id,
          company_name: updated.company_name,
          contact_name: updated.contact_name,
          company_address: updated.company_address,
          subject: updated.subject,
          body_html: updated.body_html,
        },
        applicant,
        force: true,
      });
    } catch (pdfError) {
      console.error(
        "[bew] updateBewLetter: letter PDF regeneration failed",
        pdfError,
      );
    }
  }
  return updated;
}

/** Exclude an application from the campaign (blocked once in flight). */
export async function excludeBewApplication(
  userId: string,
  applicationId: string,
): Promise<BewApplicationRow | null> {
  const admin = createAdminClient();
  const { data: existing } = await admin
    .from("bew_applications")
    .select("*")
    .eq("id", applicationId)
    .eq("user_id", userId)
    .maybeSingle();
  const app = existing as BewApplicationRow | null;
  if (!app) return null;
  if (BEW_IN_FLIGHT.has(app.status)) throw new Error("APPLICATION_LOCKED");
  const { data } = await admin
    .from("bew_applications")
    .update({ status: "excluded", error_code: null, error_message: null })
    .eq("id", applicationId)
    .eq("user_id", userId)
    .select("*")
    .maybeSingle();
  await refreshCampaignCounters(admin, app.campaign_id);
  return (data as BewApplicationRow | null) ?? null;
}

/**
 * Restore an EXCLUDED application to the campaign (step 4).
 *
 * - With a complete letter (non-empty body + valid e-mail) it goes back to
 *   `generated` — ready to be (re)sent without regenerating.
 * - Without, it returns to `pending` so the generation step picks it up.
 * Only `excluded` rows are restorable; in-flight rows are locked.
 */
export async function restoreBewApplication(
  userId: string,
  applicationId: string,
): Promise<BewApplicationRow | null> {
  const admin = createAdminClient();
  const { data: existing } = await admin
    .from("bew_applications")
    .select("*")
    .eq("id", applicationId)
    .eq("user_id", userId)
    .maybeSingle();
  const app = existing as BewApplicationRow | null;
  if (!app) return null;
  if (app.status !== "excluded") throw new Error("APPLICATION_LOCKED");
  const complete =
    Boolean(app.body_html && app.body_html.trim()) &&
    isValidEmail(app.company_email);
  const { data } = await admin
    .from("bew_applications")
    .update({
      status: complete ? "generated" : "pending",
      error_code: null,
      error_message: null,
    })
      .eq("id", applicationId)
      .eq("user_id", userId)
      .eq("status", "excluded")
      .select("*")
      .maybeSingle();
    await refreshCampaignCounters(admin, app.campaign_id);
    return (data as BewApplicationRow | null) ?? null;
  }

/**
 * Save the campaign-level e-mail message (subject + HTML body).
 *
 * This is INDEPENDENT from the per-company Anschreiben: it never touches
 * an application row, a letter or a letter PDF. The body is sanitized with
 * the shared safe-email HTML utility on the way in (the send path
 * re-sanitizes as defence in depth). Variables stay as tokens — they are
 * resolved per recipient at send time only.
 *
 * Locked once a send is in flight (changing the message mid-campaign
 * would diverge queued rows from what was gated) and in terminal states.
 * Empty values are allowed to be stored (the send gate `EMAIL_INCOMPLETE`
 * blocks the actual send until the message is whole).
 */
export async function updateBewCampaignEmail(
  userId: string,
  campaignId: string,
  payload: { subject: string; bodyHtml: string },
): Promise<void> {
  const { admin, campaign } = await requireOwnedCampaign(userId, campaignId);
  if (BEW_TERMINAL_CAMPAIGN.has(campaign.status))
    throw new Error("CAMPAIGN_CLOSED");
  if (campaign.status === "sending") throw new Error("EMAIL_LOCKED");

  const subject = (payload.subject ?? "").trim();
  if (subject.length > BEW_EMAIL_SUBJECT_MAX) throw new Error("INVALID_PAYLOAD");
  const bodyHtml = (payload.bodyHtml ?? "").slice(0, BEW_EMAIL_BODY_MAX);

  const { error } = await admin
    .from("bew_campaigns")
    .update({
      email_subject: subject,
      email_body_html: sanitizeEmailHtml(bodyHtml),
    })
    .eq("id", campaignId)
    .eq("user_id", userId);
  if (error) {
    console.error("[bew] updateBewCampaignEmail: update failed", error.message);
    throw new Error("SAVE_FAILED");
  }
}

/* ------------------------------------------------------------------ *
 * Sending (step 5) — safe, quota-aware, idempotent
 * ------------------------------------------------------------------ */

async function reserveCapacity(admin: Admin, userId: string, n: number) {
  const { error } = await admin.rpc("reserve_email_capacity", {
    target_user_id: userId,
    requested: n,
  });
  if (error) throw new Error(error.message);
}

/**
 * Reserve the shared daily quota against an EXPLICIT future date (a scheduled
 * send). Reuses the existing date-parameterised RPC `reserve_email_capacity_on`
 * (the twin of `reserve_email_capacity` that the protected engine introduced
 * for scheduled campaigns) — no new quota mechanism. `daily_quota_exceeded`
 * propagates so the caller can explain the shortfall.
 */
async function reserveCapacityOnDate(
  admin: Admin,
  userId: string,
  date: string,
  n: number,
) {
  const { error } = await admin.rpc("reserve_email_capacity_on", {
    target_user_id: userId,
    requested: n,
    on_date: date,
  });
  if (error) throw new Error(error.message);
}

async function releaseCapacity(
  admin: Admin,
  userId: string,
  date: string,
  n: number,
) {
  if (n <= 0) return;
  await admin.rpc("release_email_capacity", {
    target_user_id: userId,
    reservation_date: date,
    released: n,
  });
}

async function getSenderAccount(
  admin: Admin,
  userId: string,
  accountId: string,
): Promise<{ id: string; email: string } | null> {
  const { data } = await admin
    .from("email_accounts")
    .select("id, email, is_active, requires_reconnect")
    .eq("id", accountId)
    .eq("user_id", userId)
    .maybeSingle();
  const a = data as
    | { id: string; email: string; is_active: boolean; requires_reconnect: boolean }
    | null;
  if (!a || !a.is_active || a.requires_reconnect) return null;
  return { id: a.id, email: a.email };
}

export interface StartSendResult {
  ok: boolean;
  error?: string;
  plan?: SendPlan;
  queuedCount?: number;
  senderEmail?: string | null;
  hasCv?: boolean;
  hasCertificates?: boolean;
}

/**
 * Explicitly start sending (the ONLY entry point that can enqueue e-mails).
 *
 * Order (all server-side, ownership-verified):
 *   1. campaign owned + non-terminal + has a sender account;
 *   2. sender account is active and not flagged for reconnect;
 *   3. required documents present (a CV + at least one certificate);
 *   4. candidates = generated + valid e-mail + non-empty body (∩ selection);
 *   5. plan = min(requested, remaining quota, platform cap);
 *   6. ATOMICALLY reserve the shared daily quota for the batch;
 *   7. queue the eligible batch and drain the first bounded slice now.
 *
 * If fewer remain in the quota than were requested, only the affordable
 * batch is queued and the plan explains the rest (deferred) — it never
 * silently sends more than the effective limit.
 */
export async function startBewSend(
  userId: string,
  campaignId: string,
  opts: {
    selectedSeqs?: number[];
    /**
     * SCHEDULED send (reuses the existing scheduler): when present, the batch
     * is persisted WITHOUT sending. Every queued application carries
     * next_attempt_at = scheduling.utcIso, so the EXISTING
     * claim_next_bew_application predicate (and thus /api/cron/bew-scheduler)
     * defers it until the due instant. The campaign stores the canonical UTC
     * instant + zone + the scheduled usage_date; started_at is left null until
     * the first real claim. No immediate drain runs for a scheduled batch.
     */
    scheduling?: { utcIso: string; timeZone: string };
  } = {},
): Promise<StartSendResult> {
  const { admin, campaign } = await requireOwnedCampaign(userId, campaignId);
  if (BEW_TERMINAL_CAMPAIGN.has(campaign.status))
    return { ok: false, error: "CAMPAIGN_CLOSED" };
  if (!campaign.email_account_id) return { ok: false, error: "NO_SENDER" };

  const sender = await getSenderAccount(
    admin,
    userId,
    campaign.email_account_id,
  );
  if (!sender) return { ok: false, error: "SENDER_NOT_READY" };

  const docs = await loadCampaignDocuments(admin, campaignId, userId);
  const hasCv = docs.some((d) => d.kind === "cv");
  const hasCertificates = docs.some(
    (d) => d.kind === "certificate" || d.kind === "supporting",
  );
  if (!hasCv || !hasCertificates)
    return {
      ok: false,
      error: "DOCUMENTS_MISSING",
      senderEmail: sender.email,
      hasCv,
      hasCertificates,
    };

  // The CAMPAIGN e-mail message (subject + body) is the outgoing e-mail —
  // the per-company Anschreiben is an attachment, never the body. Block the
  // send — and say exactly what is missing — until the message is whole.
  const emailSubject = (campaign.email_subject ?? "").trim();
  const emailBodyHtml = campaign.email_body_html ?? "";
  if (!isBewEmailComplete(emailSubject, emailBodyHtml))
    return {
      ok: false,
      error: "EMAIL_INCOMPLETE",
      senderEmail: sender.email,
      hasCv,
      hasCertificates,
    };

  // {{candidate_name}} resolves from the profile — a message that uses it
  // cannot be sent when the profile name is missing (no empty signatures).
  if (/\{\{\s*candidate_name\s*\}\}/.test(emailSubject + emailBodyHtml)) {
    const applicant = await getApplicantFacts(admin, userId);
    if (!(applicant.name ?? "").trim())
      return {
        ok: false,
        error: "CANDIDATE_NAME_MISSING",
        senderEmail: sender.email,
        hasCv,
        hasCertificates,
      };
  }

  const { data: all } = await admin
    .from("bew_applications")
    .select("*")
    .eq("campaign_id", campaignId)
    .eq("user_id", userId);
  let candidates = ((all ?? []) as unknown as BewApplicationRow[]).filter(
    (a) =>
      a.status === "generated" &&
      isValidEmail(a.company_email) &&
      a.body_html.trim() !== "",
  );
  if (opts.selectedSeqs && opts.selectedSeqs.length > 0) {
    const sel = new Set(opts.selectedSeqs);
    candidates = candidates.filter((a) => sel.has(a.seq));
  }
  if (candidates.length === 0)
    return {
      ok: false,
      error: "NOTHING_TO_SEND",
      senderEmail: sender.email,
      hasCv,
      hasCertificates,
    };

  const scheduling = opts.scheduling ?? null;

  // IMMEDIATE: plan against TODAY's remaining shared daily quota (unchanged).
  // SCHEDULED: the batch is due LATER, so it reserves against the SCHEDULED
  // date's quota (the daily limit that day) — today's remaining is irrelevant.
  // The real per-date quota is enforced by reserveCapacityOnDate below
  // (daily_quota_exceeded => explained, nothing reserved).
  let usageDate: string;
  let plan: SendPlan;
  if (scheduling) {
    usageDate = scheduling.utcIso.slice(0, 10);
    plan = computeSendPlan({
      requested: candidates.length,
      remaining: BEW_PLATFORM_DAILY_CAP,
      platformCap: BEW_PLATFORM_DAILY_CAP,
    });
  } else {
    usageDate = campaign.usage_date;
    const snapshot = await getUsageSnapshot(userId);
    plan = computeSendPlan({
      requested: candidates.length,
      remaining: snapshot.remaining,
    });
  }
  if (plan.batch === 0)
    return {
      ok: false,
      error: "QUOTA_EXHAUSTED",
      plan,
      senderEmail: sender.email,
      hasCv,
      hasCertificates,
    };

  let reserved = 0;
  try {
    if (scheduling)
      await reserveCapacityOnDate(admin, userId, usageDate, plan.batch);
    else await reserveCapacity(admin, userId, plan.batch);
    reserved = plan.batch;
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message.includes("daily_quota_exceeded")) {
      const snap = scheduling ? null : await getUsageSnapshot(userId);
      const remaining = snap
        ? snap.remaining
        : BEW_PLATFORM_DAILY_CAP;
      return {
        ok: false,
        error: "QUOTA_EXHAUSTED",
        plan: computeSendPlan({
          requested: candidates.length,
          remaining,
          platformCap: BEW_PLATFORM_DAILY_CAP,
        }),
        senderEmail: sender.email,
        hasCv,
        hasCertificates,
      };
    }
    throw error;
  }

  candidates.sort((a, b) => a.seq - b.seq);
  const toQueue = candidates.slice(0, plan.batch);
  // Scheduling = future-dated: next_attempt_at gates the EXISTING claim
  // predicate, so NOTHING is sent before the due instant. Immediate = null
  // (due now) — identical to the previous behavior.
  const { error: queueError } = await admin
    .from("bew_applications")
    .update({
      status: "queued",
      next_attempt_at: scheduling ? scheduling.utcIso : null,
    })
    .in("id", toQueue.map((a) => a.id))
    .eq("campaign_id", campaignId);
  if (queueError) {
    await releaseCapacity(admin, userId, usageDate, reserved);
    return { ok: false, error: "QUEUE_FAILED" };
  }

  // IMMEDIATE: flip to sending + stamp started_at now (unchanged).
  // SCHEDULED: flip to sending, persist the schedule (canonical UTC instant +
  // zone) and point the quota at the scheduled date — but LEAVE started_at
  // null: the first REAL claim coalesces it at the due instant, and a
  // null started_at is what keeps the batch reschedulable / cancellable while
  // it is still pending.
  const campaignUpdate: Record<string, unknown> = { status: "sending" };
  if (scheduling) {
    campaignUpdate.scheduled_at = scheduling.utcIso;
    campaignUpdate.timezone = scheduling.timeZone;
    campaignUpdate.usage_date = usageDate;
  } else {
    campaignUpdate.started_at = campaign.started_at ?? nowIso();
  }
  const { error: statusError } = await admin
    .from("bew_campaigns")
    .update(campaignUpdate)
    .eq("id", campaignId);
  if (statusError) {
    // The claim RPC only drains campaigns with status 'sending' — if this
    // flip fails, the queued batch could never be consumed and the reserved
    // quota would leak. Roll back cleanly instead.
    console.error(
      "[bew] startBewSend: campaign update failed",
      statusError.message,
    );
    await releaseCapacity(admin, userId, usageDate, reserved);
    return { ok: false, error: "QUEUE_FAILED" };
  }

  // IMMEDIATE only: consume the queue right away (bounded); the rest continues
  // via the worker / cron / monitor. A failure here is never fatal.
  // SCHEDULED: deliberately NO drain here — the durable scheduler
  // (/api/cron/bew-scheduler) picks the batch up at scheduled_at. The browser
  // is not needed for sending, and the claim predicate guarantees nothing is
  // claimed (sent) before the due instant.
  if (!scheduling) {
    try {
      await processBewSendBatch(userId, campaignId, BEW_MAX_BATCH);
    } catch {
      // The campaign is intact and keeps draining on the next tick.
    }
  }

  return {
    ok: true,
    plan,
    queuedCount: toQueue.length,
    senderEmail: sender.email,
    hasCv,
    hasCertificates,
  };
}

export interface SendBatchResult {
  processed: number;
  sent: number;
  failed: number;
  uncertain: number;
  slotBusy: boolean;
  stop: string;
}

/**
 * Drain up to `batchSize` queued applications for one campaign.
 *
 * Reuses the existing SAFE primitives: `reserveSenderSlot` (per-account
 * pacing) → `claim_next_bew_application` (atomic FOR UPDATE SKIP LOCKED —
 * the idempotency core) → `createEmailProvider().sendEmail` → the shared
 * quota RPCs. A single batch can therefore never double-send, even when the
 * browser, the worker and the cron tick overlap.
 *
 * Outcome handling (see classifySendError):
 *   - confirmed 2xx  → `sent`, quota consumed (bew_record_email_sent)
 *   - transient      → back to `queued` for a bounded retry (quota kept)
 *   - definitive     → `failed`, quota released
 *   - reconnect dead → `needs_attention`, quota released, batch STOPS
 *   - ambiguous      → `needs_attention`, quota consumed (no auto-retry)
 */
export async function processBewSendBatch(
  userId: string,
  campaignId: string,
  batchSize: number,
): Promise<SendBatchResult> {
  const admin = createAdminClient();
  const campaign = await getBewCampaignOwned(admin, userId, campaignId);
  if (
    !campaign ||
    campaign.status !== "sending" ||
    BEW_TERMINAL_CAMPAIGN.has(campaign.status)
  )
    return { processed: 0, sent: 0, failed: 0, uncertain: 0, slotBusy: false, stop: "not-sending" };
  if (!campaign.email_account_id)
    return { processed: 0, sent: 0, failed: 0, uncertain: 0, slotBusy: false, stop: "no-sender" };

  const attachments = await loadCampaignAttachments(admin, campaignId, userId);
  const applicant = await getApplicantFacts(admin, userId);
  const max = Math.min(Math.max(1, batchSize), BEW_MAX_BATCH);
  let processed = 0;
  let sent = 0;
  let failed = 0;
  let uncertain = 0;

  let stop: SendBatchResult["stop"] = "done";

  // The campaign e-mail message — the outgoing subject/body for EVERY
  // recipient (personalized per recipient below). The per-company
  // Anschreiben is a separate artifact: it travels as its own PDF
  // attachment and is NEVER used as the e-mail body.
  const emailTemplate: PersonalizationTemplate = {
    subject: (campaign.email_subject ?? "").trim(),
    bodyHtml: sanitizeEmailHtml(campaign.email_body_html ?? ""),
    bodyText: htmlToText(campaign.email_body_html ?? ""),
  };
  // Defensive re-gate: startBewSend already blocks an empty message, and
  // the message is locked while sending — but a drain must never ship an
  // empty e-mail. Stop WITHOUT claiming or sending: rows stay queued, no
  // quota moves, nothing is mutated.
  if (!isBewEmailComplete(emailTemplate.subject, emailTemplate.bodyHtml))
    return { processed: 0, sent: 0, failed: 0, uncertain: 0, slotBusy: false, stop: "email-incomplete" };

  // Same defensive rule for the applicant header: a drain must never (re)
  // generate a letter PDF without the full profile. Stop WITHOUT claiming
  // or sending: rows stay queued, no quota moves, nothing is mutated.
  if (!isApplicantComplete(applicant))
    return { processed: 0, sent: 0, failed: 0, uncertain: 0, slotBusy: false, stop: "profile-incomplete" };

  try {
    for (let i = 0; i < max; i += 1) {
      const slot = await reserveSenderSlot(admin, campaign.email_account_id);
      if (!slot) {
        stop = "slot-busy";
        break;
      }

      const { data: claimedRow, error: claimError } = await admin.rpc(
        "claim_next_bew_application",
        { target_user_id: userId, target_campaign_id: campaignId },
      );
      if (claimError) throw new Error("claim failed");
      const app = claimedRow as BewApplicationRow | null;
      if (!app || !app.id) {
        stop = "queue-empty";
        break;
      }
      processed += 1;

      // Resolve the campaign e-mail for THIS recipient — independently, from
      // this row's own company/contact data plus the profile name. The
      // letter's body_html is NOT involved in the e-mail body at all.
      let email: RenderedMessage;
      try {
        email = renderPersonalizedMessage(
          emailTemplate,
          {
            email: app.company_email,
            companyName: app.company_name,
            contactName: app.contact_name,
          },
          { candidateName: applicant.name },
        );
      } catch (personalizationError) {
        // A token could not be resolved safely for this recipient (hand-typed
        // spaced variant, missing candidate name, …): fail THIS row with a
        // stable code — nothing is sent, the quota slot is released, the rest
        // of the batch continues.
        console.error(
          "[bew] send batch: personalization failed",
          personalizationError,
        );
        await markBewApp(
          admin,
          app.id,
          "failed",
          "personalization_failed",
          left(
            personalizationError instanceof Error
              ? personalizationError.message
              : "personalization failed",
            500,
          ),
        );
        await releaseCapacity(admin, userId, campaign.usage_date, 1);
        failed += 1;
        continue;
      }

      // The recipient gets the PDF file, not raw HTML: ensure THIS company's
      // Anschreiben PDF exists (generates on first send / after edits, heals
      // orphans). If it cannot be produced, this application is BLOCKED with a
      // stable, localized error — never sent without its letter.
      let pdfRef: LetterAttachmentRef | null = null;
      try {
        pdfRef = await ensureLetterPdf({ userId, app, applicant });
      } catch (pdfError) {
        console.error("[bew] send batch: letter PDF ensure failed", pdfError);
      }
      if (!pdfRef) {
        await markBewApp(
          admin,
          app.id,
          "failed",
          "pdf_generation_failed",
          "The cover letter PDF could not be generated for this application.",
        );
        await releaseCapacity(admin, userId, campaign.usage_date, 1);
        failed += 1;
        continue;
      }
      // Campaign documents (CV + certificates) + this company's PDF — no
      // duplicate attachment names in one e-mail.
      const appAttachments = dedupeAttachmentsByName([...attachments, pdfRef]);

      let provider: Awaited<ReturnType<typeof createEmailProvider>>;
      try {
        provider = await createEmailProvider(userId, campaign.email_account_id, appAttachments);
      } catch (error) {
        const c = classifySendError(error);
        if (c.kind === "reconnect") {
          await markBewApp(admin, app.id, "needs_attention", c.code, c.message);
          await releaseCapacity(admin, userId, campaign.usage_date, 1);
          failed += 1;
          stop = "reconnect";
          break;
        }
        await markBewApp(admin, app.id, "failed", c.code, c.message);
        await releaseCapacity(admin, userId, campaign.usage_date, 1);
        failed += 1;
        continue;
      }

      try {
        const result = await provider.sendEmail({
          to: app.company_email,
          subject: email.subject,
          html: email.bodyHtml,
          text: email.bodyText,
          attachments: [],
        });
        // The provider confirmed delivery (2xx + id). Count as sent.
        await admin.rpc("bew_record_email_sent", {
          target_user_id: userId,
          reservation_date: campaign.usage_date,
        });
        await admin
          .from("bew_applications")
          .update({
            status: "sent",
            provider_message_id: result.providerMessageId,
            sent_at: nowIso(),
            error_code: null,
            error_message: null,
          })
          .eq("id", app.id);
        // Post-send CLEANUP (best-effort, idempotent): the provider
        // authoritatively confirmed the send, so this app's generated
        // Anschreiben PDF is no longer needed. Only the deterministic,
        // owner-scoped letter path is deleted — NEVER the CV, the
        // certificates, or another user's objects. deleteLetterPdf is
        // non-throwing and non-fatal by design: the row stays "sent", the
        // quota stays consumed, the e-mail is never re-triggered, and the
        // post-drain sweep retries a failed delete safely.
        await deleteLetterPdf(userId, app.id, admin);
        sent += 1;
      } catch (error) {
        const c = classifySendError(error);
        if (c.kind === "retry" && app.attempt_count < BEW_MAX_SEND_ATTEMPTS) {
          await admin
            .from("bew_applications")
            .update({
              status: "queued",
              error_code: c.code,
              error_message: left(c.message, 500),
              next_attempt_at: inSecondsIso(BEW_RETRY_AFTER_SECONDS),
            })
            .eq("id", app.id);
          // Quota stays reserved for the retry.
        } else if (c.kind === "reconnect") {
          await markBewApp(admin, app.id, "needs_attention", c.code, c.message);
          await releaseCapacity(admin, userId, campaign.usage_date, 1);
          failed += 1;
          stop = "reconnect";
          break;
        } else if (c.kind === "uncertain") {
          // May already be delivered — consume quota (safe) but NEVER retry.
          await admin.rpc("bew_record_email_sent", {
            target_user_id: userId,
            reservation_date: campaign.usage_date,
          });
          await markBewApp(admin, app.id, "needs_attention", c.code, c.message);
          uncertain += 1;
        } else {
          await markBewApp(admin, app.id, "failed", c.code, c.message);
          await releaseCapacity(admin, userId, campaign.usage_date, 1);
          failed += 1;
        }
      }
    }
  } finally {
    /* Idempotent RETRY of any cleanup the per-app delete could not finish
       (transient storage error): for EVERY sent row of this campaign the
       letter object is by definition no longer needed, so a best-effort
       delete is always safe. Non-sent rows (queued retries, failed,
       needs_attention, pending, excluded, cancelled) are never touched —
       their PDF may still be sent, re-sent or reviewed.

       Runs on ALL drain exits (slot-busy, queue-empty, reconnect, claim
       error included): it is read-only with respect to application state,
       so it can never double-send an e-mail or corrupt a row — it only
       re-attempts previously failed deletes. */
    await cleanupSentLetterPdfs(admin, userId, campaignId);
    await refreshCampaignCounters(admin, campaignId);
  }

  return {
    processed,
    sent,
    failed,
    uncertain,
    slotBusy: stop === "slot-busy",
    stop,
  };
}

/**
 * Sweep the deterministic letter-PDF paths of every SENT application in the
 * campaign and delete what is still there. Idempotent (missing object =
 * success) and owner-scoped (the path is built from `userId`, never taken
 * from client input). Any failure is logged and retried on the next drain;
 * it never changes an application's status and never resends e-mail.
 */
async function cleanupSentLetterPdfs(
  admin: Admin,
  userId: string,
  campaignId: string,
): Promise<number> {
  const { data, error } = await admin
    .from("bew_applications")
    .select("id")
    .eq("campaign_id", campaignId)
    .eq("user_id", userId)
    .eq("status", "sent");
  if (error || !data) {
    // A failed read is not an authorization to delete — skip, retry next drain.
    if (error)
      console.error(
        "[bew] cleanupSentLetterPdfs: cannot read sent applications; sweep skipped",
        error.message,
      );
    return 0;
  }
  let deleted = 0;
  for (const row of data as Array<{ id: string }>) {
    const path = letterPdfStoragePath(userId, row.id);
    // Fast no-op when the object is already gone (the common case on the
    // second drain).
    const { data: obj } = await admin.storage
      .from(BEW_ATTACHMENT_BUCKET)
      .download(path);
    if (!obj) continue;
    // Non-throwing; logs its own failure (→ retried on the next drain).
    if (await deleteLetterPdf(userId, row.id, admin)) deleted += 1;
  }
  return deleted;
}

async function markBewApp(
  admin: Admin,
  id: string,
  status: string,
  code: string | null,
  message: string | null,
) {
  await admin
    .from("bew_applications")
    .update({
      status,
      error_code: code,
      error_message: left(message, 500),
    })
    .eq("id", id);
}

/**
 * Cancel all still-queued applications and release their reserved quota in
 * one transaction (in-flight `sending` rows are left to finalize).
 */
export async function cancelBewSend(
  userId: string,
  campaignId: string,
): Promise<{ cancelled: number }> {
  const admin = createAdminClient();
  const campaign = await getBewCampaignOwned(admin, userId, campaignId);
  if (!campaign) throw new Error("NOT_FOUND");
  const { data, error } = await admin.rpc("bew_cancel_queued", {
    target_user_id: userId,
    target_campaign_id: campaignId,
  });
  if (!error) await refreshCampaignCounters(admin, campaignId);
  return { cancelled: typeof data === "number" ? data : 0 };
}

/**
 * Reschedule a PENDING (not-yet-started) scheduled batch to a new future
 * instant. Reuses the existing atomic `bew_reschedule` RPC (mirrors the
 * protected engine's reschedule_campaign): it locks the campaign row, refuses
 * once any application has been claimed (started_at set), moves the quota to
 * the new date atomically, and re-gates every queued application to the new
 * due instant. Already-sent applications can never be recalled.
 *
 * Ownership is enforced twice: getBewCampaignOwned (the batch belongs to the
 * user) and the RPC itself (user-scoped FOR UPDATE lock).
 */
export async function rescheduleBewSend(
  userId: string,
  campaignId: string,
  scheduling: { utcIso: string; timeZone: string },
): Promise<{ ok: true }> {
  const admin = createAdminClient();
  const campaign = await getBewCampaignOwned(admin, userId, campaignId);
  if (!campaign) throw new Error("NOT_FOUND");
  const { data, error } = await admin.rpc("bew_reschedule", {
    target_user_id: userId,
    target_campaign_id: campaignId,
    new_scheduled_at: scheduling.utcIso,
    new_timezone: scheduling.timeZone,
    new_usage_date: scheduling.utcIso.slice(0, 10),
  });
  if (error) {
    if (error.message.includes("daily_quota_exceeded"))
      throw new Error("QUOTA_EXHAUSTED");
    throw new Error("RESCHEDULE_FAILED");
  }
  if (data !== true)
    throw new Error("CANNOT_RESCHEDULE"); // already started / not pending
  await refreshCampaignCounters(admin, campaignId);
  return { ok: true };
}

/** (Re)assign the sending account to a campaign (ownership-verified). */
export async function setCampaignSender(
  userId: string,
  campaignId: string,
  accountId: string,
): Promise<BewCampaignRow> {
  const { admin, campaign } = await requireOwnedCampaign(userId, campaignId);
  if (BEW_TERMINAL_CAMPAIGN.has(campaign.status))
    throw new Error("CAMPAIGN_CLOSED");
  const { data } = await admin
    .from("email_accounts")
    .select("id")
    .eq("id", accountId)
    .eq("user_id", userId)
    .eq("is_active", true)
    .maybeSingle();
  if (!data) throw new Error("SENDER_NOT_READY");
  const { data: updated, error: updateError } = await admin
    .from("bew_campaigns")
    .update({ email_account_id: accountId })
    .eq("id", campaignId)
    .eq("user_id", userId)
    .select("*")
    .maybeSingle();
  if (updateError) {
    console.error(
      "[bew] setCampaignSender: campaign update failed",
      updateError.message,
    );
    throw new Error("SAVE_FAILED");
  }
  if (!updated) throw new Error("NOT_FOUND");
  return updated as unknown as BewCampaignRow;
}

/* ------------------------------------------------------------------ *
 * Reads for the page / monitor
 * ------------------------------------------------------------------ */

/**
 * All campaigns that have drainable work now (or have it coming), in tick
 * priority order — the input for the cron tick.
 *
 * DUE-AWARE selection (regression fix for scheduled batches): a PENDING
 * scheduled batch carries started_at = NULL by design (the first REAL claim
 * stamps it), so the old single `ORDER BY started_at ASC` — Postgres NULLS
 * LAST for ascending — always listed it AFTER every in-flight campaign and,
 * behind the tick's bounded campaign cap, a batch that was now due could be
 * starved by idle in-flight campaigns. The tick now selects, in order:
 *
 *   1. IN-FLIGHT campaigns (started_at set) — oldest start first (the
 *      previous FIFO; finishing an already-draining campaign keeps priority);
 *   2. DUE scheduled campaigns (started_at NULL, scheduled_at <= now) —
 *      nearest due instant first; these are exactly the batches the tick
 *      exists to release at their instant;
 *   3. anomalous sending rows with NEITHER timestamp (legacy/manual) — last:
 *      drained (never stranded) without outrunning real work.
 *
 * NOT-yet-due scheduled campaigns are deliberately EXCLUDED: the claim
 * predicate defers them (nothing claimable), and processing them would only
 * burn the tick's bounded campaign slots and wall budget.
 *
 * Manual-migration safety: scheduled_at is an ADDITIVE column (20261116).
 * On a database where that read fails (migration pending), the function
 * degrades to the pre-scheduling selection (in-flight campaigns only) —
 * never to an EMPTY list: a tick that lists nothing sends nothing, ever.
 *
 * Bounded: at most `limit` campaigns per tick; a backlog drains over
 * multiple ticks (each no-op scan is cheap — one claim RPC finding nothing).
 */
export async function listSendingBewCampaigns(
  limit = 20,
): Promise<Array<{ id: string; user_id: string }>> {
  const admin = createAdminClient();
  const now = nowIso();
  type Candidate = {
    id: string;
    user_id: string;
    started_at: string | null;
    scheduled_at?: string | null;
  };
  const inFlightQ = admin
    .from("bew_campaigns")
    .select("id, user_id, started_at, scheduled_at")
    .eq("status", "sending")
    .not("started_at", "is", null)
    .order("started_at", { ascending: true })
    .limit(limit);
  const dueScheduledQ = admin
    .from("bew_campaigns")
    .select("id, user_id, started_at, scheduled_at")
    .eq("status", "sending")
    .is("started_at", null)
    .lte("scheduled_at", now)
    .order("scheduled_at", { ascending: true })
    .limit(limit);
  const legacyQ = admin
    .from("bew_campaigns")
    .select("id, user_id, started_at, scheduled_at")
    .eq("status", "sending")
    .is("started_at", null)
    .is("scheduled_at", null)
    .limit(limit);
  const [inFlight, dueScheduled, legacy] = await Promise.all([
    inFlightQ,
    dueScheduledQ,
    legacyQ,
  ]);
  if (inFlight.error) return [];
  if (dueScheduled.error || legacy.error) {
    // scheduled_at read failed (migration pending on this database): fall
    // back to the pre-scheduling list instead of an empty one.
    return ((inFlight.data ?? []) as Candidate[]).slice(0, limit).map((r) => ({
      id: r.id,
      user_id: r.user_id,
    }));
  }
  const merged: Candidate[] = [
    ...((inFlight.data ?? []) as Candidate[]),
    ...((dueScheduled.data ?? []) as Candidate[]),
    ...((legacy.data ?? []) as Candidate[]),
  ];
  return merged.slice(0, limit).map((r) => ({ id: r.id, user_id: r.user_id }));
}

/**
 * Bounded RETRY pass for the post-send letter-PDF cleanup (called by the
 * scheduler tick, not by any user action).
 *
 * `processBewSendBatch` sweeps a campaign on every drain while it is still
 * `sending` — but the final drain can flip the campaign to a terminal state
 * (`completed` / `partially_failed`), after which no further drain runs. A
 * delete that failed exactly in that final drain would otherwise leave a
 * small orphaned object behind. This pass therefore sweeps TERMINAL
 * campaigns whose `completed_at` falls inside a 24 h window:
 *
 *   - idempotent: deleting an already-gone object is a logged no-op;
 *   - owner-scoped: paths are built from the campaign's user id, never from
 *     client input; only that user's own bucket prefix is touched;
 *   - state-safe: only SENT rows' objects are candidates (their e-mail is
 *     confirmed delivered); it never changes any application status and can
 *     never trigger a send;
 *   - bounded: ≤ `limit` campaigns, each ≤ its number of sent rows, and a
 *     hard 24 h recency window — old campaigns are never re-scanned.
 */
export async function cleanupRecentlyCompletedBewLetterPdfs(
  limit = 20,
  windowMs = 24 * 60 * 60 * 1000,
): Promise<{ campaigns: number; deleted: number }> {
  const admin = createAdminClient();
  const since = new Date(Date.now() - windowMs).toISOString();
  const { data, error } = await admin
    .from("bew_campaigns")
    .select("id, user_id")
    .in("status", ["completed", "partially_failed"])
    .gte("completed_at", since)
    .order("completed_at", { ascending: true })
    .limit(limit);
  if (error) {
    // Never crash the tick: the next tick retries (or the object simply
    // ages out of the window — bounded garbage, small size).
    console.error(
      "[bew] cleanupRecentlyCompletedBewLetterPdfs: campaign read failed",
      error.message,
    );
    return { campaigns: 0, deleted: 0 };
  }
  let campaigns = 0;
  let deleted = 0;
  for (const camp of (data ?? []) as Array<{ id: string; user_id: string }>) {
    campaigns += 1;
    deleted += await cleanupSentLetterPdfs(admin, camp.user_id, camp.id);
  }
  if (deleted > 0)
    console.info(
      `[bew] letter PDF cleanup: swept ${campaigns} recently completed campaign(s), deleted ${deleted} orphaned object(s)`,
    );
  return { campaigns, deleted };
}

export async function getLatestBewCampaignId(userId: string): Promise<string | null> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("bew_campaigns")
    .select("id")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(1);
  return ((data ?? []) as Array<{ id: string }>)[0]?.id ?? null;
}

export interface BewCampaignView {
  campaign: BewCampaignRow;
  applications: BewApplicationRow[];
  documents: BewCampaignDocumentRow[];
  usage: { remaining: number; daily_limit: number };
  /**
   * The e-mail that will actually send (null when the attached account is
   * missing or needs a reconnect) — shown in the final confirmation so the
   * user knows exactly whose mailbox is used.
   */
  senderEmail: string | null;
}

/**
 * Build the view from an ALREADY ownership-verified campaign row (read the
 * applications + documents in parallel, then usage, then the sender display
 * e-mail). `senderEmailOverride` — the sender's display e-mail resolved in
 * the SAME operation (see `createBewCampaignView`) — skips the redundant
 * account read; `undefined` means "resolve it here" (the normal read path).
 */
async function buildBewCampaignView(
  admin: Admin,
  campaign: BewCampaignRow,
  userId: string,
  senderEmailOverride?: string | null,
): Promise<BewCampaignView> {
  const [{ data: apps }, { data: docs }] = await Promise.all([
    admin
      .from("bew_applications")
      .select("*")
      .eq("campaign_id", campaign.id)
      .eq("user_id", userId)
      .order("seq", { ascending: true }),
    admin
      .from("bew_campaign_documents")
      .select("*")
      .eq("campaign_id", campaign.id)
      .eq("user_id", userId)
      .order("kind", { ascending: true })
      .order("filename", { ascending: true }),
  ]);
  let usage = { remaining: 0, daily_limit: 0 };
  try {
    const snap = await getUsageSnapshot(userId);
    usage = { remaining: snap.remaining, daily_limit: snap.daily_limit };
  } catch {
    // Quota read is non-fatal for the view.
  }

  // Resolve the sender display e-mail (ownership-verified, read-only).
  let senderEmail: string | null = null;
  if (campaign.email_account_id) {
    if (senderEmailOverride !== undefined) {
      // The account was read moments ago in the same operation (and the
      // default-sender query already filters to active, healthy accounts).
      senderEmail = senderEmailOverride;
    } else {
      const { data: acct } = await admin
        .from("email_accounts")
        .select("email, is_active, requires_reconnect")
        .eq("id", campaign.email_account_id)
        .eq("user_id", userId)
        .maybeSingle();
      const a = acct as
        | { email: string; is_active: boolean; requires_reconnect: boolean }
        | null;
      if (a && a.is_active && !a.requires_reconnect) senderEmail = a.email;
    }
  }

  return {
    campaign,
    applications: (apps ?? []) as unknown as BewApplicationRow[],
    documents: (docs ?? []) as unknown as BewCampaignDocumentRow[],
    usage,
    senderEmail,
  };
}

export async function getBewCampaignView(
  userId: string,
  campaignId: string,
): Promise<BewCampaignView | null> {
  const admin = createAdminClient();
  const campaign = await getBewCampaignOwned(admin, userId, campaignId);
  if (!campaign) return null;
  return buildBewCampaignView(admin, campaign, userId);
}
