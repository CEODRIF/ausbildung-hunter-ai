/**
 * AI Bewerbung Studio — typed schemas. Pure, isomorphic (client + server +
 * tests); no DOM, no Supabase, no React.
 *
 * The pasted advertisement is UNTRUSTED INPUT. It is fenced in AI prompts as
 * data (never instructions) and the model's structured answer is validated
 * with these schemas BEFORE it touches the database or the UI. Unknown keys
 * are stripped (zod default object behavior) — the model can never smuggle
 * extra fields into persisted state.
 *
 * No-invention contract (mirrors the cover-letter route):
 *  - Every extracted value must be plausibly grounded in the supplied ad text;
 *    the prompt forbids inventing companies, contacts, dates or requirements.
 *  - `matchScore` describes PROFILE-TO-AD ALIGNMENT only. It must never be
 *    presented as a probability of being hired.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// Section A — advertisement text input
// ---------------------------------------------------------------------------

/** Hard input cap: a full ad is a few KB; 20k chars is generous and bounds
 *  the AI cost of one analysis. */
export const AD_TEXT_MAX_LENGTH = 20_000;
/** Below this the text is too short to be a usable advertisement. */
export const AD_TEXT_MIN_LENGTH = 40;

export const studioAdTextSchema = z
  .string()
  .trim()
  .min(AD_TEXT_MIN_LENGTH)
  .max(AD_TEXT_MAX_LENGTH);

// ---------------------------------------------------------------------------
// Section B — structured extraction (AdExtract)
// ---------------------------------------------------------------------------

const shortText = (max: number) => z.string().trim().max(max);

export const adExtractSchema = z.object({
  /** Advertised role title exactly as given in the ad ("Auszubildende:r ..."). */
  jobTitle: shortText(200).default(""),
  /** Ausbildungsgang / occupation ("Kaufmann für Büromanagement"). */
  occupation: shortText(200).default(""),
  company: shortText(200).default(""),
  companyAddress: shortText(300).default(""),
  /** City / region. */
  location: shortText(200).default(""),
  /** Planned start, free text as printed ("01.08.2027", "zum nächstmöglichen ..."). */
  startDate: shortText(100).default(""),
  /** Application deadline, free text as printed. */
  applicationDeadline: shortText(100).default(""),
  requiredQualifications: z.array(shortText(300)).max(30).default([]),
  preferredQualifications: z.array(shortText(300)).max(30).default([]),
  technicalSkills: z.array(shortText(120)).max(40).default([]),
  softSkills: z.array(shortText(120)).max(40).default([]),
  /** Language requirements ("Deutsch C1", "Englisch fließend"). */
  languageRequirements: z.array(shortText(200)).max(10).default([]),
  educationRequirement: shortText(300).default(""),
  responsibilities: z.array(shortText(400)).max(30).default([]),
  /** Documents the employer explicitly asks for ("Bewerbung mit Zeugnissen"). */
  requestedDocuments: z.array(shortText(200)).max(20).default([]),
  /** How to apply ("per E-Mail an ...", "über das Portal ..."). */
  applicationMethod: shortText(400).default(""),
  /** Only when the ad explicitly names a person. */
  contactPerson: shortText(200).default(""),
  /** Only when the ad explicitly contains an application email. */
  applicationEmail: shortText(320).default(""),
  /** Company-specific details explicitly supportable by the ad (facts only). */
  companyNotes: z.array(shortText(400)).max(10).default([]),
  /** What the ad does NOT say / is ambiguous (drives the clarification UI). */
  missingOrAmbiguous: z.array(shortText(300)).max(20).default([]),
});
export type AdExtract = z.infer<typeof adExtractSchema>;

/** Lightweight email syntax check (full validation happens at send time).
 *  Length capped at 320 to match the recipient column constraint. */
export function isValidEmail(value: string): boolean {
  const v = value.trim();
  return v.length >= 5 && v.length <= 320 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v);
}

// ---------------------------------------------------------------------------
// Section B — requirements vs. candidate profile (AdAnalysis)
// ---------------------------------------------------------------------------

export const adMatchStatusSchema = z.enum([
  "matched",
  "missing",
  "partial",
  "transferable",
  "unknown",
]);
export type AdMatchStatus = z.infer<typeof adMatchStatusSchema>;

export const adMatchItemSchema = z.object({
  requirement: shortText(300),
  status: adMatchStatusSchema,
  /** Why (grounded in the profile/ad), short. */
  note: shortText(400).default(""),
});
export type AdMatchItem = z.infer<typeof adMatchItemSchema>;

export const adAnalysisSchema = z.object({
  /** 0–100 profile-to-ad alignment. NEVER a hiring probability. */
  matchScore: z.number().int().min(0).max(100).default(0),
  matched: z.array(adMatchItemSchema).max(50).default([]),
  missing: z.array(adMatchItemSchema).max(50).default([]),
  transferable: z.array(adMatchItemSchema).max(50).default([]),
  weaknesses: z.array(shortText(300)).max(10).default([]),
  recommendations: z.array(shortText(400)).max(10).default([]),
  /** Questions the candidate should answer before generating documents. */
  questions: z.array(shortText(300)).max(10).default([]),
});
export type AdAnalysis = z.infer<typeof adAnalysisSchema>;

// ---------------------------------------------------------------------------
// Section D — tailored CV generation output
// ---------------------------------------------------------------------------

/**
 * Post-generation fact guard input: the VERIFIED facts the CV may contain.
 * The guard (studio-facts.ts) rejects a generated CV whose contact data or
 * experience entries introduce values that are not a subset of these.
 */
export interface VerifiedFacts {
  name: string;
  email: string;
  phone: string;
  location: string;
  linkedin: string;
  /** All known education degrees/institutions/years. */
  education: string[];
  /** All known job titles/companies/date ranges. */
  experience: string[];
  /** All known skills. */
  skills: string[];
  /** All known languages + levels. */
  languages: string[];
}

// ---------------------------------------------------------------------------
// Section E — cover letter content (stored document)
// ---------------------------------------------------------------------------

export const studioLetterContentSchema = z.object({
  /** The full letter text (greeting … closing), German. */
  text: z.string().trim().min(20).max(16_000),
  /** Tone used at generation (display only). */
  tone: z.enum(["professional", "formal", "engaged"]).default("professional"),
});
export type StudioLetterContent = z.infer<typeof studioLetterContentSchema>;

// ---------------------------------------------------------------------------
// Section H — application email draft
// ---------------------------------------------------------------------------

export const studioEmailDraftSchema = z.object({
  subject: z.string().trim().min(1).max(200),
  /** Plain-text body (German). Rendered to simple HTML at send time. */
  body: z.string().trim().min(20).max(6_000),
});
export type StudioEmailDraft = z.infer<typeof studioEmailDraftSchema>;

/** Stored email document content = draft + the selected attachment ids. */
/**
 * Pseudo-attachment id for the server-rendered Anschreiben PDF (the stored
 * letter is rendered locally at send preparation — no AI, no external
 * service). The user selects it explicitly like any other attachment.
 */
export const STUDIO_LETTER_PDF_ID = "studio-letter-pdf";

export const studioEmailContentSchema = z.object({
  subject: z.string().trim().min(1).max(200),
  body: z.string().trim().min(20).max(6_000),
  /** Attachment ids the user selected for the email: studio_attachments
   *  uuids plus the optional server-rendered letter PDF marker. */
  attachmentIds: z.array(z.union([z.string().uuid(), z.literal(STUDIO_LETTER_PDF_ID)])).max(10).default([]),
});
export type StudioEmailContent = z.infer<typeof studioEmailContentSchema>;

// ---------------------------------------------------------------------------
// Section G — quality review issues
// ---------------------------------------------------------------------------

export const qualityIssueSchema = z.object({
  /** Stable machine key (for de-dup and tests). */
  key: z.string().min(1).max(80),
  severity: z.enum(["blocking", "optional"]),
  section: z.enum(["cv", "cover_letter", "email", "attachments", "general"]),
  detail: z.string().max(300),
});
export type QualityIssue = z.infer<typeof qualityIssueSchema>;

// ---------------------------------------------------------------------------
// Row types (mirror the migration columns; the DB is the source of truth)
// ---------------------------------------------------------------------------

export const studioAppStatuses = [
  "draft",
  "ready",
  "scheduled",
  "sending",
  "sent",
  "failed",
  "cancelled",
] as const;
export type StudioAppStatus = (typeof studioAppStatuses)[number];

export interface StudioApplicationRow {
  id: string;
  user_id: string;
  ad_raw: string;
  ad_extracted: AdExtract | null;
  ad_analysis: AdAnalysis | null;
  profile_snapshot: unknown;
  status: StudioAppStatus;
  email_account_id: string | null;
  recipient_email: string | null;
  idempotency_key: string | null;
  approved: boolean;
  approved_at: string | null;
  scheduled_at: string | null;
  schedule_timezone: string | null;
  sent_at: string | null;
  provider_message_id: string | null;
  last_failure_code: string | null;
  /** Batch workspace confirmations (migration 20261211000000_studio_batch).
   *  NULL = not yet confirmed; editing the underlying data clears the
   *  matching timestamp (completion is re-derived server-side). */
  ad_confirmed_at: string | null;
  profile_confirmed_at: string | null;
  cv_reviewed_at: string | null;
  letter_reviewed_at: string | null;
  checklist_ack_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface StudioDocumentRow {
  id: string;
  application_id: string;
  user_id: string;
  doc_type: "cv" | "cover_letter" | "email";
  version: number;
  content: unknown;
  created_at: string;
}

export interface StudioAttachmentRow {
  id: string;
  application_id: string;
  user_id: string;
  display_name: string;
  doc_category: string;
  mime_type: string;
  size_bytes: number;
  storage_path: string;
  required: boolean;
  created_at: string;
}

export interface StudioSendAttemptRow {
  id: string;
  application_id: string;
  user_id: string;
  idempotency_key: string;
  recipient_email: string;
  subject: string;
  payload: StudioSendPayload;
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

export interface StudioSendPayload {
  html: string;
  text: string;
  attachments: Array<{ filename: string; mimeType: string; storagePath: string }>;
}

/** Allowed document categories for supporting documents (Section F). */
export const ATTACHMENT_CATEGORIES = [
  "school_certificate",
  "professional_qualification",
  "language_certificate",
  "reference",
  "other",
] as const;
export type AttachmentCategory = (typeof ATTACHMENT_CATEGORIES)[number];
