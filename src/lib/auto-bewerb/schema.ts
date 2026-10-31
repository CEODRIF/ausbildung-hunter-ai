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
import { renderGreeting } from "@/lib/personalization";
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
  /**
   * Trace: the ORIGINAL template (Bewerbungsvorlagen_50, page 1..50) this
   * letter was generated FROM. Present on every template-based letter;
   * optional for backward compatibility with pre-template rows.
   */
  templateId: z.string().max(120).optional(),
  templatePage: z.number().int().min(1).max(50).optional(),
  templateTitle: z.string().max(300).optional(),
});
export type AutoBewerbLetter = z.infer<typeof autoBewerbLetterSchema>;

// ---------------------------------------------------------------------------
// Step 6 — ONE global e-mail configuration for the whole batch
// ---------------------------------------------------------------------------

/** Shared email body (auto_bewerb_email_templates.body). Sanitized HTML,
 *  editable in the Step 6 rich-text editor. It is ONE shared template used
 *  for every company; the supported {{tokens}} are personalized per recipient
 *  at send time (missing values become empty — never invented). */
export const autoBewerbEmailTemplateSchema = z
  .string()
  .trim()
  .max(6_000);
export const AUTO_BEWERB_EMAIL_TEMPLATE_MAX = 6_000;

/** Shared e-mail subject (one for every application). */
export const autoBewerbEmailSubjectSchema = z.string().trim().min(1).max(200);
export const AUTO_BEWERB_EMAIL_SUBJECT_MAX = 200;

/** The ONE global e-mail configuration (Step 6). Identical for every
 *  company in the batch; the only per-company difference is the delivery
 *  destination, which stays that company's verified address. */
export interface AutoBewerbEmailSettings {
  /** Shared body (sanitized HTML) — one template for every company; the
   *  supported {{tokens}} are personalized per recipient at send time. */
  body: string;
  /** Optional explicit GLOBAL recipient. "" = deliver to each company's
   *  verified application email (never to one company's address). */
  recipient: string;
  /** The one shared subject for every application. */
  subject: string;
  /** The one shared sending account (email_accounts.id; "" = none). */
  accountId: string;
  /** Attach the server-rendered tailored-CV PDF (globally). */
  attachCv: boolean;
  /** Attach the server-rendered Anschreiben PDF (globally). */
  attachLetter: boolean;
}

/** Action input — zod-validated before it reaches the engine. */
export const autoBewerbEmailSettingsSchema = z.object({
  body: autoBewerbEmailTemplateSchema,
  recipient: z.string().trim().max(320),
  subject: z.string().trim().max(200),
  accountId: z.string().trim().max(64),
  attachCv: z.boolean(),
  attachLetter: z.boolean(),
});
export type AutoBewerbEmailSettingsInput = z.infer<typeof autoBewerbEmailSettingsSchema>;

/** Resolve the DELIVERY destination for one company, in priority order:
 *  1. the legacy per-company manual value (preserved — never overwritten),
 *  2. the VERIFIED application email extracted from that company's ad.
 *  The first parameter (the old shared/global recipient) is DEPRECATED —
 *  the Step 6 override was removed, so no caller passes a value; the
 *  parameter stays only for signature compatibility with stored data.
 *  Returns "" when nothing is available — the caller must then refuse to
 *  send. Pure and deterministic; never invents an address. */
export function resolveAutoBewerbRecipient(
  globalRecipient: string | null | undefined,
  legacyRecipient: string | null | undefined,
  extract: AdExtract | null | undefined,
): string {
  const global = (globalRecipient ?? "").trim().toLowerCase();
  if (global) return global;
  const legacy = (legacyRecipient ?? "").trim().toLowerCase();
  if (legacy) return legacy;
  return (extract?.applicationEmail ?? "").trim().toLowerCase();
}

// ---------------------------------------------------------------------------
// Per-recipient personalization (Step 6 e-mail template)
// ---------------------------------------------------------------------------

/** The personalization tokens the Step 6 editor can insert. The SAME shared
 *  template is used for every company; these are substituted per recipient at
 *  send time from VERIFIED data (never invented — missing → empty). */
export const AUTO_BEWERB_EMAIL_TOKENS = [
  "candidate_name",
  "contact_person",
  "company_name",
  "greeting",
  "position",
] as const;
export type AutoBewerbEmailToken = (typeof AUTO_BEWERB_EMAIL_TOKENS)[number];

/** Substitute `{{token}}` placeholders with per-recipient values. Unknown or
 *  missing tokens become an EMPTY string (never a leftover placeholder, never
 *  an invented value). Works on plain text (subject) and HTML (body — the
 *  caller must HTML-escape the values first). */
export function substituteEmailTokens(
  text: string | null | undefined,
  values: Partial<Record<AutoBewerbEmailToken, string>>,
): string {
  return (text ?? "").replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key: string) => {
    const v = values[key as AutoBewerbEmailToken];
    return v === undefined ? "" : v;
  });
}

/** The German salutation for a recipient — the platform's single greeting
 *  source (renderGreeting): an explicit "Herr …" / "Frau …" from the ad
 *  renders the proper salutation ("Sehr geehrter Herr …," /
 *  "Sehr geehrte Frau …,"); anything else (incl. an ungendered name) falls
 *  back to "Sehr geehrte Damen und Herren,". Gender is NEVER guessed. */
export function buildAutoBewerbGreeting(contactPerson: string | null | undefined): string {
  return renderGreeting(contactPerson);
}

/** The concise, professional DEFAULT e-mail template (pre-filled in the
 *  editor when the user has none yet) — the platform's business-e-mail
 *  house style (bewerbung-automation email-templates, "ausbildung"):
 *  greeting token, application sentence with the company, the attachments
 *  presented explicitly, interview request, standard closing. The subject
 *  follows the platform convention (company-based; degrades safely when the
 *  position is missing). The subject/body are editable; the Anschreiben
 *  PDF is a SEPARATE attachment and is never inserted here. */
export const AUTO_BEWERB_EMAIL_DEFAULT_SUBJECT = "Bewerbung um einen Ausbildungsplatz bei {{company_name}}";
export const AUTO_BEWERB_EMAIL_DEFAULT_BODY = [
  "<p>{{greeting}}</p>",
  "<p>hiermit bewerbe ich mich um einen Ausbildungsplatz bei {{company_name}}.</p>",
  "<p>Meine vollständigen Bewerbungsunterlagen (Lebenslauf und mein Anschreiben) finden Sie im Anhang.</p>",
  "<p>Über die Gelegenheit, mich und meine Motivation in einem persönlichen Gespräch vorzustellen, freue ich mich sehr.</p>",
  "<p>Mit freundlichen Grüßen</p>",
  "<p>{{candidate_name}}</p>",
].join("\n");

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

/** One row per user — the current professional profile photo (Step 1).
 *  The object itself lives in the private bucket under
 *  `${user_id}/auto-bewerb/photo/${photo_hash}.<ext>`; the frozen CV
 *  reference is `abphoto:v1:<photo_hash>:<ext>`. */
export interface AutoBewerbProfilePhotoRow {
  user_id: string;
  photo_mime_type: string;
  photo_size_bytes: number;
  photo_hash: string;
  photo_storage_path: string;
  uploaded_at: string;
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
  /** @deprecated LEGACY per-company body override — no longer read anywhere
   *  in the UI or the sending pipeline (single source of truth = the global
   *  template); the send preparation clears it on write. Kept on the row
   *  type only because the DB column still exists (no destructive change). */
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
   /** Exact filename of THIS company's tailored CV PDF (null = no CV). */
   cvPdfName: string | null;
   /** Latest parsed Anschreiben (null = not generated). */
   letter: { text: string; tone: "professional" | "formal" | "engaged" } | null;
   letterVersion: number | null;
    /** Exact filename of THIS company's individualized cover-letter PDF (null = no letter). */
    letterPdfName: string | null;
    latestAttempt: AutoBewerbSendAttemptRow | null;
    /** The ORIGINAL template (Bewerbungsvorlagen_50 page) this letter was
     *  generated FROM (null = not yet generated or legacy letter). */
    letterTemplate: { id: string; page: number; title: string } | null;
    /** Live deterministic auto-selection from the 50-template library — the
     *  top match for THIS ad (what "generate" uses when no manual choice). */
    suggestedTemplate: { id: string; page: number; title: string } | null;
}

export interface AutoBewerbWorkspace {
  /** False = the manual migration has not been applied yet (UI shows the
   *  "setup pending" state and no workflow data). */
  ready: boolean;
  /** WHY it is not ready (null when ready): lets the UI tell "tables missing"
   *  apart from "database reachable but the probe was blocked" — the two
   *  states need different, both honest messages. */
  setupIssue: "missing_tables" | "probe_error" | null;
  profile: {
    fileName: string;
    mimeType: string;
    sizeBytes: number;
    cvHash: string;
    analyzedAt: string;
    extracted: CandidateProfile | null;
  } | null;
  /** False = the profile-photo migration is not applied yet (the UI hides
   *  the photo card — the REST of the workflow is unaffected). */
  photoSupported: boolean;
  /** The current profile photo (null = none uploaded or feature not
   *  supported). `ref` is the frozen CV reference token; the preview is
   *  streamed by the ownership-checked /api/auto-bewerb/profile-photo
   *  route (never a storage URL). */
  photo: {
    ref: string;
    mime: string;
    sizeBytes: number;
    uploadedAt: string;
  } | null;
  companies: AutoBewerbCompanyView[];
  attachments: AutoBewerbAttachmentRow[];
  /** The shared e-mail body (always — also the legacy mode's template). */
  emailTemplate: string;
  /** The ONE global e-mail configuration (null = the email-settings
   *  migration is not applied yet → the legacy per-company fallback). */
  emailSettings: AutoBewerbEmailSettings | null;
  /** False = the email-settings columns do not exist yet (the UI shows the
   *  legacy per-company editor + a pending-migration notice; the rest of
   *  the workflow is unaffected). */
  emailSettingsSupported: boolean;
  emailAccounts: AutoBewerbEmailAccount[];
  /** The candidate's full name (profiles.full_name) — powers the
   *  {{candidate_name}} token in the e-mail template + the manifest preview.
   *  "" = not set (the token then renders empty, never invented). */
  candidateName: string;
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

/**
 * Classify a schema-probe failure into its HONEST class:
 *  - "missing": the relation does not exist (or PostgREST has not seen it
 *    yet — schema-cache lag reports the same pgrst205/42P01 shape; that is
 *    transient and the negative cache TTL lets a retry recover).
 *  - "blocked": the table exists but the probe was refused or failed for
 *    ANOTHER reason (permission 42501, missing column 42703, connection
 *    error, …). Reporting these as "missing" would pin the page on a wrong
 *    "tables not created" message forever.
 * Pure string mapping over the PostgREST error text — safe to unit test.
 */
export function classifyProbeError(error: { message?: string } | null | undefined): "missing" | "blocked" {
  const raw = error?.message ?? "";
  if (
    /pgrst205/i.test(raw) ||
    /could not find a table/i.test(raw) ||
    /could not find the table/i.test(raw) ||
    // 42P01 only counts when it names one of OUR relations — a bare code
    // match would misreport unrelated missing relations as "setup pending".
    /42p01[^\n]*auto_bewerb_[a-z_]+/i.test(raw) ||
    /relation\s+"?(?:public\.)?auto_bewerb_[a-z_]*"?\s+does not exist/i.test(raw)
  ) {
    return "missing";
  }
  return "blocked";
}

/** Normalize a company name into its dedupe key (server-side; the client
 *  mirrors this for optimistic duplicate warnings only). */
export function normalizeCompanyKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9äöüß ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
