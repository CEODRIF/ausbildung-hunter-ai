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
  /** Position override (20261115000000); null/absent => inherit the campaign. */
  position_title?: string | null;
  position_brief?: string | null;
  employer_facts?: string | null;
  /** Smart-input extracted phone (20261117000000); verbatim, never invented. */
  company_phone?: string | null;
  /** Smart-input industry classification (20261117000000). */
  company_industry?: string | null;
  /** Advertisement dates (20261121000000); verbatim, never invented. */
  start_date?: string | null;
  end_date?: string | null;
  application_deadline?: string | null;
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
   /** Scheduled send (20261116000000): the canonical UTC instant the batch is
    *  due (null = immediate / not scheduled). Optional: pre-migration rows
    *  lack the column — treat as "not scheduled". */
   scheduled_at?: string | null;
   /** IANA zone the user chose for the scheduled send (display/audit). */
   timezone?: string | null;
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
  /** Per-company position override (20261115000000); absent/"" => inherit campaign. */
  positionTitle?: string;
  positionBrief?: string;
  employerFacts?: string;
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

/**
 * Split campaign rows into the ACTIVE review queue (entries that still
 * require review, correction or sending) and the SENT history (confirmed
 * sends). This is the single source of truth for what the Review step lists.
 *
 * Only confirmed-`sent` rows leave the active queue — failed, unconfirmed
 * (`needs_attention`), `cancelled`, `generated` and `excluded` rows stay
 * (the last one carries the restore action). This is a PURE view split: the
 * underlying records are never deleted, so a finished send simply clears the
 * active queue while the sent history, counters and recovery stay intact.
 */
export function splitBewReviewApps<T extends { status: string }>(
  apps: T[],
): { active: T[]; sent: T[] } {
  const active: T[] = [];
  const sent: T[] = [];
  for (const app of apps) (app.status === "sent" ? sent : active).push(app);
  return { active, sent };
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

/** Stable error codes the server actions surface (mapped to i18n by the UI). */
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
  | "CAMPAIGN_FULL"
  | "CAMPAIGN_SENDING"
  | "NOT_FOUND"
  | "NO_SENDER"
  | "SENDER_NOT_READY"
  | "DOCUMENTS_MISSING"
  | "EMAIL_INCOMPLETE"
  | "EMAIL_LOCKED"
  | "CANDIDATE_NAME_MISSING"
  | "PROFILE_INCOMPLETE"
   | "NOTHING_TO_SEND"
   | "QUOTA_EXHAUSTED"
   | "QUEUE_FAILED"
   | "INVALID_PAYLOAD"
   | "SAVE_FAILED"
   | "DELETE_FAILED"
   | "DOC_UPLOAD_FAILED"
   | "DOC_SAVE_FAILED"
   | "DOC_ATTACH_FAILED"
   | "INVALID_TIMEZONE"
   | "INVALID_SCHEDULE"
   | "SCHEDULE_NOT_FUTURE"
   | "CANNOT_RESCHEDULE"
   | "RESCHEDULE_FAILED"
   /* Smart-input (addBewCompany) — stable server codes; the EMPTY_INPUT
      code is produced client-side by the precheck. */
   | "EMPTY_INPUT"
   | "PARSE_NO_COMPANY"
   | "PARSE_NO_EMAIL"
   | "PARSE_INVALID_EMAIL"
   | "DUPLICATE_COMPANY"
   | "COUNT_EXCEEDED"
   | "POSITION_TOO_LONG"
   | "UNKNOWN";

const BEW_CODE_SET: ReadonlySet<string> = new Set<string>([
  "INVALID_COUNT",
  "INVALID_PURPOSE",
  "INVALID_RECORDS",
  "INVALID_KIND",
  "NO_FILE",
  "PDF_REQUIRED",
  "DOCUMENT_UNSUPPORTED",
  "DOCUMENT_TOO-LARGE",
  "DOCUMENT_EMPTY",
  "APPLICATION_LOCKED",
  "CAMPAIGN_CLOSED",
  "CAMPAIGN_FULL",
  "CAMPAIGN_SENDING",
  "NOT_FOUND",
  "NO_SENDER",
  "SENDER_NOT_READY",
  "DOCUMENTS_MISSING",
  "EMAIL_INCOMPLETE",
  "EMAIL_LOCKED",
  "CANDIDATE_NAME_MISSING",
  "PROFILE_INCOMPLETE",
  "NOTHING_TO_SEND",
  "QUOTA_EXHAUSTED",
  "QUEUE_FAILED",
  "INVALID_PAYLOAD",
  "SAVE_FAILED",
  "DELETE_FAILED",
  "DOC_UPLOAD_FAILED",
  "DOC_SAVE_FAILED",
  "DOC_ATTACH_FAILED",
  "INVALID_TIMEZONE",
  "INVALID_SCHEDULE",
  "SCHEDULE_NOT_FUTURE",
  "CANNOT_RESCHEDULE",
  "RESCHEDULE_FAILED",
  "EMPTY_INPUT",
  "PARSE_NO_COMPANY",
  "PARSE_NO_EMAIL",
  "PARSE_INVALID_EMAIL",
  "DUPLICATE_COMPANY",
  "COUNT_EXCEEDED",
  "POSITION_TOO_LONG",
]);

/**
 * True for the Next.js navigation error a server action rejects with when it
 * calls `redirect()` — here: the session expired mid-flow and the action
 * bounced the caller to /login. Such an error must NOT be swallowed into an
 * error message (that was the "Something went wrong" bug); the component
 * navigates instead (re-authentication).
 */
export function isNextRedirectError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.message === "NEXT_REDIRECT" ||
    (error as Error & { digest?: unknown }).digest === "NEXT_REDIRECT"
  );
}

/**
 * Extract the stable error code a server action threw, if there is one.
 *
 * Two places are checked:
 *   1. the message — `withStableError` re-throws `Error(code)`, so the code
 *      IS the message on the normal path;
 *   2. the digest — across the RSC→client boundary a thrown error can be
 *      re-wrapped by the framework (the message becomes a generic string),
 *      while the digest keeps the original code. Without this fallback the
 *      re-wrapped error degraded to `UNKNOWN` ("Something went wrong") even
 *      though the server had told us exactly what happened.
 *
 * `UNKNOWN` is reserved for errors that are genuinely not mapped (the
 * localized message stays actionable and the internals never leak).
 */
export function bewErrorCode(error: unknown): BewErrorCode {
  if (!(error instanceof Error)) return "UNKNOWN";
  const message = error.message;
  if (BEW_CODE_SET.has(message)) return message as BewErrorCode;
  if (message.startsWith("DOCUMENT_")) return message as BewErrorCode;
  const digest = (error as Error & { digest?: unknown }).digest;
  if (typeof digest === "string" && BEW_CODE_SET.has(digest))
    return digest as BewErrorCode;
  if (typeof digest === "string" && digest.startsWith("DOCUMENT_"))
    return digest as BewErrorCode;
  return "UNKNOWN";
}

/**
 * The ONE client-side error resolution for this page — it replaces the six
 * per-step copies of `errMessage`, which all had the same two holes:
 *
 *   1. a NEXT_REDIRECT (session expired mid-flow) was rendered as a generic
 *      error message instead of triggering re-authentication;
 *   2. the re-wrapped-error case (code moved into the digest) degraded to
 *      the generic message.
 *
 * Behavior:
 *   - expired session → `navigate("/login")` (when given) and return `null`.
 *     An expired session is NOT an operation failure — callers treat `null`
 *     as "handled, show nothing";
 *   - stable code (message or digest) → its localized `bewauto.err.{code}`;
 *   - anything else → the localized `bewauto.err.UNKNOWN`.
 */
export function resolveBewError(
  error: unknown,
  t: (k: string, v?: Record<string, string | number>) => string,
  navigate?: (path: string) => void,
): string | null {
  if (isNextRedirectError(error)) {
    if (navigate) navigate("/login");
    return null;
  }
  const code = bewErrorCode(error);
  const key = `bewauto.err.${code}`;
  const translated = t(key);
  return translated === key ? t("bewauto.err.UNKNOWN") : translated;
}
