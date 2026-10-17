/**
 * Bewerbung Automation — client-side DTO types.
 *
 * These mirror the server rows from `@/lib/bewerbung-engine` (the engine is
 * server-only; this file is its serializable shadow at the RSC→client
 * boundary). Keep field names identical to the `bew_*` columns on purpose —
 * it makes the data flow auditable end to end.
 */
import { isValidEmail } from "@/lib/bewerbung-automation";

export type BewAppStatus =
  | "pending"
  | "generating"
  | "generated"
  | "excluded"
  | "queued"
  | "sending"
  | "sent"
  | "failed"
  | "needs_attention"
  | "cancelled";

export type BewCampaignStatus =
  | "draft"
  | "generating"
  | "sending"
  | "completed"
  | "partially_failed"
  | "cancelled";

export interface BewApplicationDTO {
  id: string;
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
  provider_message_id: string | null;
  sent_at: string | null;
}

export interface BewCampaignDTO {
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
  /** The campaign-level e-mail message (independent from the per-company
   *  Anschreiben, which stays a PDF attachment). Optional: rows read before
   *  the 20261113000000 migration lack the columns — treat as "". */
  email_subject?: string;
  email_body_html?: string;
}

export interface BewCampaignDocumentDTO {
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
}

export interface BewUsageDTO {
  remaining: number;
  daily_limit: number;
}

export interface BewViewDTO {
  campaign: BewCampaignDTO;
  applications: BewApplicationDTO[];
  documents: BewCampaignDocumentDTO[];
  usage: BewUsageDTO;
  senderEmail: string | null;
}

/** A company record as entered / imported (all four fields, trimmed;
 *  empty string = absent — the save payload converts empties to null). */
export interface CompanyRecord {
  companyName: string;
  companyEmail: string;
  contactName: string;
  companyAddress: string;
}

/** Client-side import preview row (before anything is stored). */
export interface PreviewRow {
  seq: number;
  companyName: string;
  companyEmail: string;
  contactName: string | null;
  companyAddress: string | null;
  valid: boolean;
  problems: string[];
}

export interface PreviewResult {
  rows: PreviewRow[];
  validCount: number;
  invalidEmailCount: number;
  duplicateEmails: string[];
}

export type Step = 1 | 2 | 3 | 4 | 5;

/* ------------------------------------------------------------------ *
 * Send eligibility — the SINGLE client-side rule for "may be sent".
 * The server re-enforces every one of these conditions independently
 * (startBewSend gates + per-claim checks); this is display/UX only.
 * ------------------------------------------------------------------ */

/** Campaign-level: a CV + at least one certificate/supporting document. */
export function hasRequiredDocuments(
  documents: Array<{ kind: string }>,
): { cv: boolean; certs: boolean } {
  return {
    cv: documents.some((d) => d.kind === "cv"),
    certs: documents.some(
      (d) => d.kind === "certificate" || d.kind === "supporting",
    ),
  };
}

/** Row-level flags shown in the review table (why a row is NOT eligible). */
export function appSendFlags(app: {
  status: string;
  company_email: string;
  body_html: string;
}): Array<"bad_email" | "empty_letter" | "not_generated"> {
  const flags: Array<"bad_email" | "empty_letter" | "not_generated"> = [];
  if (!isValidEmail(app.company_email)) flags.push("bad_email");
  if (!app.body_html || !app.body_html.trim()) flags.push("empty_letter");
  if (app.status !== "generated") flags.push("not_generated");
  return flags;
}

/** A row is eligible when it has a complete letter, a valid recipient and
 *  the campaign carries the required document set. */
export function isEligibleForSend(
  app: { status: string; company_email: string; body_html: string },
  view: { documents: Array<{ kind: string }> },
): boolean {
  if (appSendFlags(app).length > 0) return false;
  const docs = hasRequiredDocuments(view.documents);
  return docs.cv && docs.certs;
}

/** Stable error codes the server actions throw (mapped to i18n by the UI). */
export type BewErrorCode =
  | "INVALID_COUNT"
  | "INVALID_PURPOSE"
  | "INVALID_RECORDS"
  | "INVALID_KIND"
  | "NO_FILE"
  | "PDF_REQUIRED"
  | "DOCUMENT_UNSUPPORTED"
  | "DOCUMENT_TOO-LARGE"
  | "DOCUMENT_EMPTY"
  | "APPLICATION_LOCKED"
  | "CAMPAIGN_CLOSED"
  | "NOT_FOUND"
  | "NO_SENDER"
  | "SENDER_NOT_READY"
  | "DOCUMENTS_MISSING"
  | "EMAIL_INCOMPLETE"
  | "EMAIL_LOCKED"
  | "CANDIDATE_NAME_MISSING"
  | "NOTHING_TO_SEND"
  | "QUOTA_EXHAUSTED"
  | "QUEUE_FAILED"
  | "INVALID_PAYLOAD"
  | "SAVE_FAILED"
  | "DOC_UPLOAD_FAILED"
  | "DOC_SAVE_FAILED"
  | "DOC_ATTACH_FAILED"
  | "UNKNOWN";

export function bewErrorCode(error: unknown): BewErrorCode {
  const message = error instanceof Error ? error.message : "";
  if (
    message === "INVALID_COUNT" ||
    message === "INVALID_PURPOSE" ||
    message === "INVALID_RECORDS" ||
    message === "INVALID_KIND" ||
    message === "NO_FILE" ||
    message === "PDF_REQUIRED" ||
    message === "APPLICATION_LOCKED" ||
    message === "CAMPAIGN_CLOSED" ||
    message === "NOT_FOUND" ||
     message === "NO_SENDER" ||
     message === "SENDER_NOT_READY" ||
     message === "DOCUMENTS_MISSING" ||
     message === "EMAIL_INCOMPLETE" ||
     message === "EMAIL_LOCKED" ||
     message === "CANDIDATE_NAME_MISSING" ||
     message === "NOTHING_TO_SEND" ||
    message === "QUOTA_EXHAUSTED" ||
    message === "QUEUE_FAILED" ||
    message === "INVALID_PAYLOAD" ||
    message === "SAVE_FAILED" ||
    message === "DOC_UPLOAD_FAILED" ||
    message === "DOC_SAVE_FAILED" ||
    message === "DOC_ATTACH_FAILED"
  )
    return message as BewErrorCode;
  if (message.startsWith("DOCUMENT_")) return message as BewErrorCode;
  return "UNKNOWN";
}
