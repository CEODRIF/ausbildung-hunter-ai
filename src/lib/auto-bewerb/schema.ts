/**
 * AUTO BEWERB — typed schemas. Pure, isomorphic (client + server + tests);
 * no DOM, no Supabase, no React.
 *
 * Contracts (mirrors the Studio):
 *  - The pasted advertisement is UNTRUSTED INPUT: fenced in AI prompts as
 *    data (never instructions); the model's structured answer is validated
 *    with the studio's AdExtract/AdAnalysis schemas BEFORE it touches the
 *    database or the UI (unknown keys stripped — the model can never
 *    smuggle extra fields into persisted state).
 *  - No-invention: every extracted value must be grounded in the ad text;
 *    missing values stay empty and are surfaced as "nicht angegeben".
 *  - The analyzed CV profile reuses the platform's CandidateProfile schema
 *    (bewerbung-schema.ts) — the same shape the scanner, the fact guard
 *    (studio/facts.ts) and formatProfileForPrompt() already consume, so
 *    AUTO BEWERB's documents are guarded and rendered by the EXISTING
 *    infrastructure without a parallel data model.
 */
import { z } from "zod";
import {
  adAnalysisSchema,
  adExtractSchema,
  isValidEmail,
  type AdAnalysis,
  type AdExtract,
} from "@/lib/studio/schema";
import type { CandidateProfile } from "@/lib/bewerbung-schema";
import type { CvDocument } from "@/lib/templates/cv";

// Re-export the ad contract so AUTO BEWERB code has one import surface.
export { adExtractSchema, adAnalysisSchema, isValidEmail };
export type { AdExtract, AdAnalysis };

// ---------------------------------------------------------------------------
// Workflow constants
// ---------------------------------------------------------------------------

/** Max companies per workflow (mirrors the studio batch cap). */
export const AUTO_BEWERB_COMPANY_LIMIT = 10;
/** Pseudo-attachment ids for the server-rendered per-company PDFs (the
 *  tailored CV / Anschreiben are rendered locally at send preparation —
 *  no AI, no external service — exactly like the studio's letter PDF). */
export const AUTO_BEWERB_CV_PDF_ID = "auto-bewerb-cv-pdf";
export const AUTO_BEWERB_LETTER_PDF_ID = "auto-bewerb-letter-pdf";

/** The 10-company cap, in 1..10 slots (0 = legacy/unassigned). */
export const AUTO_BEWERB_MAX_SLOT = AUTO_BEWERB_COMPANY_LIMIT;

// ---------------------------------------------------------------------------
// Step 1 — analyzed CV profile (stored: auto_bewerb_profiles.extracted)
// ---------------------------------------------------------------------------

/**
 * The analyzed + user-corrected profile IS a CandidateProfile (the scanner
 * shape): it feeds formatProfileForPrompt() and the fact guard directly.
 * The stored value is always zod-revalidated on read (defense in depth).
 */
export type AutoBewerbProfileExtract = CandidateProfile;

// ---------------------------------------------------------------------------
// Step 5 — cover letter content (stored document)
// ---------------------------------------------------------------------------

/**
 * A full German business letter: greeting … body … closing … signature
 * (the last paragraph is the signature line — the PDF folio renderer
 * (splitLetterParagraphs) expects exactly this shape).
 */
export const autoBewerbLetterSchema = z.object({
  text: z.string().trim().min(20).max(16_000),
  /** Tone used at generation (display only). */
  tone: z.enum(["professional", "formal", "engaged"]).default("professional"),
});
export type AutoBewerbLetter = z.infer<typeof autoBewerbLetterSchema>;

// ---------------------------------------------------------------------------
// Step 6 — shared email template + per-company email
// ---------------------------------------------------------------------------

/** Shared email-body template (auto_bewerb_email_templates.body). Plain
 *  text; tokens {company}, {position}, {contactName} are substituted from
 *  each company's stored extraction at send-preparation time. */
export const autoBewerbEmailTemplateSchema = z
  .string()
  .trim()
  .max(6_000);
export const AUTO_BEWERB_EMAIL_TEMPLATE_MAX = 6_000;

/** Per-company email subject (required before send). */
export const autoBewerbEmailSubjectSchema = z.string().trim().min(1).max(200);

/** Optional per-company body override (NULL = shared template). */
export const autoBewerbEmailBodyOverrideSchema = z.string().trim().max(6_000);

/** Substitute the shared-template tokens from a stored extraction.
 *  Pure and deterministic — never invents: a token without a stored value
 *  is replaced by "" (the sender sees the result in the review step). */
export function renderAutoBewerbEmailBody(
  template: string,
  extract: AdExtract | null,
): string {
  const company = (extract?.company ?? "").trim();
  const position = ((extract?.jobTitle ?? "").trim() || (extract?.occupation ?? "").trim());
  const contactName = (extract?.contactPerson ?? "").trim();
  return template
    .replace(/\{company\}/gi, company)
    .replace(/\{position\}/gi, position)
    .replace(/\{contactName\}/gi, contactName);
}

/** The three tokens the shared template supports (documented in the UI). */
export const AUTO_BEWERB_EMAIL_TOKENS = ["{company}", "{position}", "{contactName}"] as const;

// ---------------------------------------------------------------------------
// Supporting documents
// ---------------------------------------------------------------------------

export const AUTO_BEWERB_DOC_CATEGORIES = [
  "school_certificate",
  "professional_qualification",
  "language_certificate",
  "reference",
  "other",
] as const;
export type AutoBewerbDocCategory = (typeof AUTO_BEWERB_DOC_CATEGORIES)[number];

// ---------------------------------------------------------------------------
// Row types (mirror the migration columns; the DB is the source of truth)
// ---------------------------------------------------------------------------

export const autoBewerbAppStatuses = [
  "draft",
  "ready",
  "scheduled",
  "sending",
  "sent",
  "failed",
  "cancelled",
] as const;
export type AutoBewerbAppStatus = (typeof autoBewerbAppStatuses)[number];

export interface AutoBewerbProfileRow {
  id: string;
  user_id: string;
  cv_file_name: string;
  cv_mime_type: string;
  cv_size_bytes: number;
  cv_storage_path: string;
  cv_hash: string;
  extracted: AutoBewerbProfileExtract | null;
  analyzed_at: string;
  created_at: string;
  updated_at: string;
}

export interface AutoBewerbCompanyRow {
  id: string;
  user_id: string;
  company: string;
  company_key: string;
  slot_no: number;
  ad_raw: string;
  ad_extracted: AdExtract | null;
  ad_analysis: AdAnalysis | null;
  profile_snapshot: unknown;
  status: AutoBewerbAppStatus;
  recipient_email: string | null;
  email_subject: string | null;
  email_body: string | null;
  email_attach_cv: boolean;
  email_attach_letter: boolean;
  email_account_id: string | null;
  idempotency_key: string | null;
  approved: boolean;
  approved_at: string | null;
  scheduled_at: string | null;
  schedule_timezone: string | null;
  sent_at: string | null;
  provider_message_id: string | null;
  last_failure_code: string | null;
  ad_confirmed_at: string | null;
  cv_reviewed_at: string | null;
  letter_reviewed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface AutoBewerbDocumentRow {
  id: string;
  company_id: string;
  user_id: string;
  doc_type: "cv" | "cover_letter";
  version: number;
  content: unknown;
  created_at: string;
}

export interface AutoBewerbAttachmentRow {
  id: string;
  user_id: string;
  display_name: string;
  doc_category: string;
  mime_type: string;
  size_bytes: number;
  storage_path: string;
  file_hash: string;
  created_at: string;
}

export interface AutoBewerbEmailTemplateRow {
  user_id: string;
  body: string;
  updated_at: string;
}

export interface AutoBewerbSendAttemptRow {
  id: string;
  company_id: string;
  user_id: string;
  idempotency_key: string;
  recipient_email: string;
  subject: string;
  payload: AutoBewerbSendPayload;
  status: "queued" | "sending" | "sent" | "failed" | "cancelled";
  scheduled_at: string | null;
  attempt_count: number;
  next_attempt_at: string | null;
  provider_message_id: string | null;
  failure_code: string | null;
  failure_message: string | null;
  sent_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface AutoBewerbSendPayload {
  html: string;
  text: string;
  attachments: Array<{ filename: string; mimeType: string; storagePath: string }>;
}

// ---------------------------------------------------------------------------
// Workspace view types (isomorphic: the server assembles, the client renders)
// ---------------------------------------------------------------------------

/** Connected mailbox summary (shape mirrors the studio's email account). */
export interface AutoBewerbEmailAccount {
  id: string;
  provider: "gmail" | "outlook";
  email: string;
  is_active: boolean;
  requires_reconnect: boolean;
}

export interface AutoBewerbCompanyView {
  company: AutoBewerbCompanyRow;
  /** Latest parsed CV document (null = not generated). */
  cv: CvDocument | null;
  cvVersion: number | null;
  /** Latest parsed Anschreiben (null = not generated). */
  letter: { text: string; tone: "professional" | "formal" | "engaged" } | null;
  letterVersion: number | null;
  selectedAttachmentIds: string[];
  latestAttempt: AutoBewerbSendAttemptRow | null;
}

export interface AutoBewerbWorkspace {
  /** False = the manual migration has not been applied yet (UI shows the
   *  "setup pending" state and no workflow data). */
  ready: boolean;
  profile: {
    fileName: string;
    mimeType: string;
    sizeBytes: number;
    cvHash: string;
    analyzedAt: string;
    extracted: CandidateProfile | null;
  } | null;
  companies: AutoBewerbCompanyView[];
  attachments: AutoBewerbAttachmentRow[];
  emailTemplate: string;
  emailAccounts: AutoBewerbEmailAccount[];
}

/** All tables the AUTO BEWERB feature needs (the probe checks all seven). */
export const AUTO_BEWERB_TABLES = [
  "auto_bewerb_profiles",
  "auto_bewerb_companies",
  "auto_bewerb_documents",
  "auto_bewerb_attachments",
  "auto_bewerb_company_attachments",
  "auto_bewerb_email_templates",
  "auto_bewerb_send_attempts",
] as const;

/** Normalize a company name into its dedupe key (server-side; the client
 *  mirrors this for optimistic duplicate warnings only). */
export function normalizeCompanyKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9äöüß ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
