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

import {
  assembleLetter,
  buildImportResult,
  buildLetterPrompt,
  buildSubject,
  classifySendError,
  computeSendPlan,
  isBewPurpose,
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
}

/**
 * Create a new automation campaign and seed `count` empty pending
 * applications (seq 1..count). The count is validated (1..100). No quota is
 * reserved and no e-mail is sent — this only prepares the structure.
 */
export async function createBewCampaign(
  input: CreateBewCampaignInput,
): Promise<BewCampaignRow> {
  const check = validateCompanyCount(input.count);
  if (!check.ok) throw new Error("INVALID_COUNT");
  if (!isBewPurpose(input.purpose)) throw new Error("INVALID_PURPOSE");
  const admin = createAdminClient();

  // Default sender: the user's own ACTIVE, healthy account (the feature is
  // designed around the already-connected Gmail — no new integration).
  let emailAccountId = input.emailAccountId ?? null;
  if (!emailAccountId) {
    const { data: accounts } = await admin
      .from("email_accounts")
      .select("id")
      .eq("user_id", input.userId)
      .eq("is_active", true)
      .eq("requires_reconnect", false)
      .order("created_at", { ascending: true })
      .limit(1);
    emailAccountId = ((accounts ?? []) as Array<{ id: string }>)[0]?.id ?? null;
  }

  const { data: campaign, error: campaignError } = await admin
    .from("bew_campaigns")
    .insert({
      user_id: input.userId,
      email_account_id: emailAccountId,
      purpose: input.purpose,
      status: "draft",
      requested_count: check.value,
      usage_date: todayUtcDate(),
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

  return row;
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
  }>>,
): Promise<{ campaign: BewCampaignRow; result: BewImportResult }> {
  const { admin, campaign } = await requireOwnedCampaign(userId, campaignId);
  const result = buildImportResult(records, 1);

  // Replace existing applications with the imported set (reset letters).
  await admin.from("bew_applications").delete().eq("campaign_id", campaignId);
  const rows = result.rows.map((r) => ({
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
  }));
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
  },
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
  if (uploadError) throw new Error("Unable to upload the document.");

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
    await admin.storage.from("application-attachments").remove([path]);
    throw new Error("Unable to register the document.");
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
  if (error || !data) throw new Error("Unable to attach the document.");
  return data as unknown as BewCampaignDocumentRow;
}

/** Detach a document from a campaign (the user's file is kept). */
export async function detachBewDocument(
  userId: string,
  campaignId: string,
  documentId: string,
): Promise<void> {
  const admin = createAdminClient();
  await admin
    .from("bew_campaign_documents")
    .delete()
    .eq("campaign_id", campaignId)
    .eq("document_id", documentId)
    .eq("user_id", userId);
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
    .update({ status: "generating" })
    .in("id", ids)
    .in("status", wanted)
    .select("*");
  const apps = (claimedRows ?? []) as unknown as BewApplicationRow[];

  let generated = 0;
  let failed = 0;
  let aiQuotaHit = false;

  for (const app of apps) {
    try {
      await reserveAIUsage(userId);
    } catch {
      aiQuotaHit = true;
      // Park this (and the rest) for later; not a generation failure.
      await admin
        .from("bew_applications")
        .update({ status: "pending", error_code: "ai_quota", error_message: null })
        .eq("id", app.id);
      break;
    }
    try {
      const prompt = buildLetterPrompt({
        purpose,
        companyName: app.company_name,
        contactName: app.contact_name,
        companyAddress: app.company_address,
        applicantName: profile.full_name,
        cvText,
        certificatesText: certText,
      });
      const aiBody = await createAIProvider().generateText(
        [{ role: "user", content: prompt }],
        90_000,
      );
      const letter = assembleLetter({
        aiBody,
        contactName: app.contact_name,
        signature: profile.full_name,
      });
      const bodyHtml = sanitizeEmailHtml(letter.bodyHtml);
      const bodyText = htmlToText(bodyHtml) || letter.bodyText;
      await admin
        .from("bew_applications")
        .update({
          status: "generated",
          body_html: bodyHtml,
          body_text: bodyText,
          subject:
            app.subject || buildSubject(purpose, app.company_name),
          error_code: null,
          error_message: null,
        })
        .eq("id", app.id);
      generated += 1;
    } catch (error) {
      await admin
        .from("bew_applications")
        .update({
          status: "failed",
          error_code: "generation_failed",
          error_message: left(
            error instanceof Error ? error.message : "generation failed",
            500,
          ),
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
  return (data as BewApplicationRow | null) ?? null;
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
  opts: { selectedSeqs?: number[] } = {},
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

  const snapshot = await getUsageSnapshot(userId);
  const plan = computeSendPlan({
    requested: candidates.length,
    remaining: snapshot.remaining,
  });
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
    await reserveCapacity(admin, userId, plan.batch);
    reserved = plan.batch;
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message.includes("daily_quota_exceeded")) {
      const snap = await getUsageSnapshot(userId);
      return {
        ok: false,
        error: "QUOTA_EXHAUSTED",
        plan: computeSendPlan({ requested: candidates.length, remaining: snap.remaining }),
        senderEmail: sender.email,
        hasCv,
        hasCertificates,
      };
    }
    throw error;
  }

  candidates.sort((a, b) => a.seq - b.seq);
  const toQueue = candidates.slice(0, plan.batch);
  const { error: queueError } = await admin
    .from("bew_applications")
    .update({ status: "queued", next_attempt_at: null })
    .in("id", toQueue.map((a) => a.id))
    .eq("campaign_id", campaignId);
  if (queueError) {
    await releaseCapacity(admin, userId, campaign.usage_date, reserved);
    return { ok: false, error: "QUEUE_FAILED" };
  }

  const { error: statusError } = await admin
    .from("bew_campaigns")
    .update({ status: "sending", started_at: campaign.started_at ?? nowIso() })
    .eq("id", campaignId);
  if (statusError) {
    // The claim RPC only drains campaigns with status 'sending' — if this
    // flip fails, the queued batch could never be consumed and the reserved
    // quota would leak. Roll back cleanly instead.
    console.error(
      "[bew] startBewSend: campaign status update failed",
      statusError.message,
    );
    await releaseCapacity(admin, userId, campaign.usage_date, reserved);
    return { ok: false, error: "QUEUE_FAILED" };
  }

  // Consume the queue right away (bounded); the rest continues via the
  // worker / cron / monitor. A failure here is never fatal.
  try {
    await processBewSendBatch(userId, campaignId, BEW_MAX_BATCH);
  } catch {
    // The campaign is intact and keeps draining on the next tick.
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
  const max = Math.min(Math.max(1, batchSize), BEW_MAX_BATCH);
  let processed = 0;
  let sent = 0;
  let failed = 0;
  let uncertain = 0;

  for (let i = 0; i < max; i += 1) {
    const slot = await reserveSenderSlot(admin, campaign.email_account_id);
    if (!slot)
      return { processed, sent, failed, uncertain, slotBusy: true, stop: "slot-busy" };

    const { data: claimedRow, error: claimError } = await admin.rpc(
      "claim_next_bew_application",
      { target_user_id: userId, target_campaign_id: campaignId },
    );
    if (claimError) throw new Error("claim failed");
    const app = claimedRow as BewApplicationRow | null;
    if (!app || !app.id) {
      await refreshCampaignCounters(admin, campaignId);
      return { processed, sent, failed, uncertain, slotBusy: false, stop: "queue-empty" };
    }
    processed += 1;

    const html = sanitizeEmailHtml(app.body_html);
    const text = htmlToText(app.body_html) || app.body_text;

    let provider: Awaited<ReturnType<typeof createEmailProvider>>;
    try {
      provider = await createEmailProvider(userId, campaign.email_account_id, attachments);
    } catch (error) {
      const c = classifySendError(error);
      if (c.kind === "reconnect") {
        await markBewApp(admin, app.id, "needs_attention", c.code, c.message);
        await releaseCapacity(admin, userId, campaign.usage_date, 1);
        failed += 1;
        await refreshCampaignCounters(admin, campaignId);
        return { processed, sent, failed, uncertain, slotBusy: false, stop: "reconnect" };
      }
      await markBewApp(admin, app.id, "failed", c.code, c.message);
      await releaseCapacity(admin, userId, campaign.usage_date, 1);
      failed += 1;
      continue;
    }

    try {
      const result = await provider.sendEmail({
        to: app.company_email,
        subject: app.subject,
        html,
        text,
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
        await refreshCampaignCounters(admin, campaignId);
        return { processed, sent, failed, uncertain, slotBusy: false, stop: "reconnect" };
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

  await refreshCampaignCounters(admin, campaignId);
  return { processed, sent, failed, uncertain, slotBusy: false, stop: "done" };
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
 * All campaigns still draining (status `sending`), oldest first — the input
 * for the cron tick. Bounded; a backlog drains over multiple ticks.
 */
export async function listSendingBewCampaigns(
  limit = 20,
): Promise<Array<{ id: string; user_id: string }>> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("bew_campaigns")
    .select("id, user_id")
    .eq("status", "sending")
    .order("started_at", { ascending: true })
    .limit(limit);
  if (error) return [];
  return (data ?? []) as Array<{ id: string; user_id: string }>;
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

export async function getBewCampaignView(
  userId: string,
  campaignId: string,
): Promise<BewCampaignView | null> {
  const admin = createAdminClient();
  const campaign = await getBewCampaignOwned(admin, userId, campaignId);
  if (!campaign) return null;
  const [{ data: apps }, { data: docs }] = await Promise.all([
    admin
      .from("bew_applications")
      .select("*")
      .eq("campaign_id", campaignId)
      .eq("user_id", userId)
      .order("seq", { ascending: true }),
    admin
      .from("bew_campaign_documents")
      .select("*")
      .eq("campaign_id", campaignId)
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

  return {
    campaign,
    applications: (apps ?? []) as unknown as BewApplicationRow[],
    documents: (docs ?? []) as unknown as BewCampaignDocumentRow[],
    usage,
    senderEmail,
  };
}
