import "server-only";

import { randomUUID } from "node:crypto";
import { candidateProfileSchema } from "@/lib/bewerbung-schema";
import { effectiveUploadLimitBytes } from "@/lib/billing/entitlement-service";
import { detectFileType } from "@/lib/ai-service";
import {
  createEmailProvider,
  type ProviderFailure,
} from "@/lib/email-providers";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  BEW_ATTACHMENT_BUCKET,
  BEW_LETTER_PDF_MIME,
  buildLetterFolio,
  generateLetterPdf,
  letterPdfFilename,
  letterPdfStoragePath,
} from "@/lib/bew-letter-pdf";
import {
  cvHasContent,
  sanitizeCvDocument,
  type CvDocument,
} from "@/lib/templates/cv";
import {
  formatCvForPrompt,
  formatProfileForPrompt,
} from "@/lib/templates/cover-letter";
import {
  adAnalysisSchema,
  adExtractSchema,
  isValidEmail,
  STUDIO_LETTER_PDF_ID,
  type AdAnalysis,
  type AdExtract,
  type StudioApplicationRow,
  type StudioAttachmentRow,
  type StudioDocumentRow,
  type StudioSendAttemptRow,
  type StudioSendPayload,
  type StudioAppStatus,
} from "./studio/schema";
import { parseAdDeadline } from "./studio/quality";
import { zonedTimeToUtc } from "./studio/timezone";

/**
 * AI Bewerbung Studio — server-side data + dispatch engine.
 *
 * Ownership contract (same as bew_*): every read re-scopes by `user_id`;
 * every write runs with the service role AFTER the ownership check, because
 * RLS is SELECT-only for owners. The authenticated identity always comes
 * from the session (or the cron worker's RPC) — never from client input.
 *
 * Send safety:
 *  - a send requires approved = true (explicit user approval) and an active,
 *    owned email account, re-checked at dispatch time;
 *  - each logical send is one studio_send_attempts row with a unique
 *    idempotency_key; the claim is an atomic `update … where status='queued'`,
 *    so concurrent dispatchers can never double-send;
 *  - "uncertain" provider failures are terminal (no auto-resend);
 *  - temporary failures retry with backoff up to 3 attempts.
 */

export type StudioErrorCode =
  | "schema_pending"
  | "not_found"
  | "not_approved"
  | "send_in_progress"
  | "no_email_account"
  | "invalid_recipient"
  | "invalid_file_type"
  | "file_too_large"
  | "invalid_schedule"
  | "schedule_after_deadline"
  | "not_cancellable"
  | "storage_error"
  | "dispatch_error";

export type StudioOpResult<T = undefined> =
  | { ok: true; value?: T }
  | { ok: false; code: StudioErrorCode; message: string };

const fail = (code: StudioErrorCode, message: string): StudioOpResult<never> => ({
  ok: false,
  code,
  message,
});

/** File types the private `application-attachments` bucket accepts. */
const ATTACHMENT_MIME: Record<string, string> = {
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  png: "image/png",
  jpeg: "image/jpeg",
};
const ATTACHMENT_BUCKET = "application-attachments";
/** Re-export: the letter-PDF marker lives in the isomorphic schema. */
export { STUDIO_LETTER_PDF_ID } from "./studio/schema";
const ATTACHMENT_HARD_CAP_BYTES = 10 * 1024 * 1024;
const MAX_SEND_ATTEMPTS = 3;

function sanitizeFileName(name: string): string {
  // Character filter, then collapse dot-runs and strip leading dots so the
  // display name can never contain '..' (traversal-ish names stay inert).
  const filtered = name.replace(/[^a-zA-Z0-9.äöüßÄÖÜ-]/g, "_");
  return (
    filtered
      .replace(/\.{2,}/g, ".")
      .replace(/^\.+/, "")
      .slice(0, 255) || "datei"
  );
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Plain-text email body → minimal HTML (paragraphs only, fully escaped). */
export function emailBodyToHtml(body: string): string {
  return body
    .split(/\n{2,}/)
    .map((p) => p.replace(/\n/g, "<br>"))
    .filter((p) => p.trim())
    .map((p) => `<p>${escapeHtml(p).trim()}</p>`)
    .join("\n");
}

// ---------------------------------------------------------------------------
// Schema probe (graceful degradation before the manual migration is applied)
// ---------------------------------------------------------------------------

/** Every table the studio feature needs — the manual migration creates all
 *  four, so the probe checks all four (a partially applied migration must
 *  not look "ready"). */
export const STUDIO_TABLES = [
  "studio_applications",
  "studio_documents",
  "studio_attachments",
  "studio_send_attempts",
] as const;

/** A NEGATIVE probe is only trusted this long: a transient Supabase error
 *  (or a migration applied moments later) must not pin the "setup pending"
 *  state for the whole serverless instance. Positive results are cached. */
const PROBE_NEGATIVE_TTL_MS = 60_000;

let probeCache: { at: number; missing: string[] } | null = null;

/** Names of the studio tables that are NOT reachable right now
 *  (empty array = fully ready). Safe to call from page, actions and routes. */
export function getStudioMissingTables(): Promise<string[]> {
  if (probeCache) {
    const positive = probeCache.missing.length === 0;
    if (positive || Date.now() - probeCache.at < PROBE_NEGATIVE_TTL_MS) {
      return Promise.resolve(probeCache.missing);
    }
  }
  return (async () => {
    const results = await Promise.all(
      STUDIO_TABLES.map(async (table): Promise<string | null> => {
        try {
          const { error } = await createAdminClient().from(table).select("id").limit(1);
          return error ? table : null;
        } catch {
          return table;
        }
      }),
    );
    const missing = results.filter((t): t is string => t !== null);
    probeCache = { at: Date.now(), missing };
    return missing;
  })();
}

/** Backward-compatible boolean probe (true = all studio tables reachable). */
export function hasStudioSchema(): Promise<boolean> {
  return getStudioMissingTables().then((missing) => missing.length === 0);
}

/** Map a PostgREST insert error to a safe, actionable UI outcome.
 *  Only allow-listed error shapes are forwarded (missing table / missing
 *  column / duplicate key) — raw driver details never reach the client. */
function classifyInsertError(error: { message?: string } | null | undefined): StudioOpResult<never> {
  const msg = error?.message ?? "";
  if (/could not find the table|pgrst205|relation "public\.studio_applications" does not exist/i.test(msg)) {
    return fail("schema_pending", "Studio-Datenbank wird vorbereitet.");
  }
  const col = msg.match(/^column "([a-z0-9_]+)" does not exist/i);
  if (col) {
    return fail(
      "storage_error",
      `Das Datenbank-Schema ist veraltet (Feld "${col[1]}" fehlt) — bitte das Studio-Migrations-Skript neu anwenden.`,
    );
  }
  if (/duplicate key/i.test(msg)) {
    return fail("storage_error", "Diese Bewerbung wurde gerade eben gespeichert — bitte die Seite aktualisieren.");
  }
  return fail("storage_error", "Speichern fehlgeschlagen. Bitte erneut versuchen.");
}

// ---------------------------------------------------------------------------
// Applications
// ---------------------------------------------------------------------------

export async function listStudioApplications(
  userId: string,
): Promise<StudioApplicationRow[]> {
  const { data, error } = await createAdminClient()
    .from("studio_applications")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) return [];
  return (data ?? []) as unknown as StudioApplicationRow[];
}

export interface StudioApplicationBundle {
  app: StudioApplicationRow;
  documents: StudioDocumentRow[];
  attachments: StudioAttachmentRow[];
  attempts: StudioSendAttemptRow[];
}

export async function getStudioApplication(
  userId: string,
  id: string,
): Promise<StudioApplicationBundle | null> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("studio_applications")
    .select("*")
    .eq("id", id)
    .eq("user_id", userId)
    .maybeSingle();
  if (error || !data) return null;
  const app = data as unknown as StudioApplicationRow;
  // Re-validate the persisted JSON (defense in depth — it was validated at
  // write time, but old/partial rows must never break the UI).
  app.ad_extracted = app.ad_extracted
    ? adExtractSchema.safeParse(app.ad_extracted).success
      ? adExtractSchema.parse(app.ad_extracted)
      : null
    : null;
  app.ad_analysis = app.ad_analysis
    ? adAnalysisSchema.safeParse(app.ad_analysis).success
      ? adAnalysisSchema.parse(app.ad_analysis)
      : null
    : null;

  const [{ data: docs }, { data: atts }, { data: attsAttempts }] = await Promise.all([
    admin.from("studio_documents").select("*").eq("application_id", id).order("created_at", { ascending: false }),
    admin.from("studio_attachments").select("*").eq("application_id", id).order("created_at", { ascending: true }),
    admin.from("studio_send_attempts").select("*").eq("application_id", id).order("created_at", { ascending: false }),
  ]);
  return {
    app,
    documents: (docs ?? []) as unknown as StudioDocumentRow[],
    attachments: (atts ?? []) as unknown as StudioAttachmentRow[],
    attempts: (attsAttempts ?? []) as unknown as StudioSendAttemptRow[],
  };
}

export async function createStudioApplication(
  userId: string,
  input: {
    adRaw: string;
    extract?: AdExtract | null;
    analysis?: AdAnalysis | null;
    profileSnapshot?: unknown;
  },
): Promise<StudioOpResult<StudioApplicationRow>> {
  if (!(await hasStudioSchema())) return fail("schema_pending", "Studio-Datenbank wird vorbereitet.");
  const { data, error } = await createAdminClient()
    .from("studio_applications")
    .insert({
      user_id: userId,
      ad_raw: input.adRaw.slice(0, 30_000),
      ad_extracted: input.extract ?? null,
      ad_analysis: input.analysis ?? null,
      profile_snapshot: input.profileSnapshot ?? null,
      status: "draft",
    })
    .select("*")
    .single();
  if (error || !data) return classifyInsertError(error);
  void logStudioActivity(userId, "studio_application_created", "Bewerbungs-Studio: neue Bewerbung erstellt");
  return { ok: true, value: data as unknown as StudioApplicationRow };
}

export type StudioAppPatch = Partial<
  Pick<
    StudioApplicationRow,
    | "ad_extracted"
    | "ad_analysis"
    | "profile_snapshot"
    | "status"
    | "recipient_email"
    | "email_account_id"
    | "approved"
    | "approved_at"
    | "scheduled_at"
    | "schedule_timezone"
    | "sent_at"
    | "provider_message_id"
    | "idempotency_key"
    | "last_failure_code"
  >
>;

async function patchApplication(
  userId: string,
  id: string,
  patch: StudioAppPatch,
): Promise<StudioApplicationRow | null> {
  const { data, error } = await createAdminClient()
    .from("studio_applications")
    .update(patch)
    .eq("id", id)
    .eq("user_id", userId)
    .select("*")
    .maybeSingle();
  if (error || !data) return null;
  return data as unknown as StudioApplicationRow;
}

export async function updateStudioApplication(
  userId: string,
  id: string,
  patch: StudioAppPatch,
): Promise<StudioOpResult<StudioApplicationRow>> {
  const app = await patchApplication(userId, id, patch);
  if (!app) return fail("not_found", "Anwendung nicht gefunden.");
  return { ok: true, value: app };
}

// ---------------------------------------------------------------------------
// Documents (versioned)
// ---------------------------------------------------------------------------

export type StudioDocType = "cv" | "cover_letter" | "email";

export async function saveStudioDocument(
  userId: string,
  applicationId: string,
  docType: StudioDocType,
  content: unknown,
): Promise<StudioOpResult<StudioDocumentRow>> {
  if (!(await hasStudioSchema())) return fail("schema_pending", "Studio-Datenbank wird vorbereitet.");
  const admin = createAdminClient();
  const { data: app } = await admin
    .from("studio_applications")
    .select("id")
    .eq("id", applicationId)
    .eq("user_id", userId)
    .maybeSingle();
  if (!app) return fail("not_found", "Anwendung nicht gefunden.");

  const { data: latest } = await admin
    .from("studio_documents")
    .select("version")
    .eq("application_id", applicationId)
    .eq("doc_type", docType)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  const version = ((latest?.version as number | undefined) ?? 0) + 1;

  const { data, error } = await admin
    .from("studio_documents")
    .insert({
      application_id: applicationId,
      user_id: userId,
      doc_type: docType,
      version,
      content,
    })
    .select("*")
    .single();
  if (error || !data) return fail("storage_error", "Dokument konnte nicht gespeichert werden.");
  return { ok: true, value: data as unknown as StudioDocumentRow };
}

export async function getLatestStudioDocument(
  userId: string,
  applicationId: string,
  docType: StudioDocType,
): Promise<StudioDocumentRow | null> {
  const { data, error } = await createAdminClient()
    .from("studio_documents")
    .select("*")
    .eq("application_id", applicationId)
    .eq("user_id", userId)
    .eq("doc_type", docType)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  return data as unknown as StudioDocumentRow;
}

/** Parse a stored CV document row into a valid CvDocument (or null). */
export function parseStoredCv(doc: StudioDocumentRow | null): CvDocument | null {
  if (!doc) return null;
  return sanitizeCvDocument(doc.content);
}

export function parseStoredLetter(
  doc: StudioDocumentRow | null,
): { text: string; tone: string } | null {
  if (!doc) return null;
  const c = doc.content as { text?: unknown; tone?: unknown };
  if (typeof c?.text !== "string" || !c.text.trim()) return null;
  return {
    text: c.text.slice(0, 16_000),
    tone: typeof c?.tone === "string" ? c.tone : "professional",
  };
}

// ---------------------------------------------------------------------------
// Attachments (private bucket application-attachments)
// ---------------------------------------------------------------------------

export async function uploadStudioAttachment(
  userId: string,
  applicationId: string,
  input: { name: string; buffer: Buffer; category: string },
): Promise<StudioOpResult<StudioAttachmentRow>> {
  if (!(await hasStudioSchema())) return fail("schema_pending", "Studio-Datenbank wird vorbereitet.");
  const admin = createAdminClient();
  const { data: app } = await admin
    .from("studio_applications")
    .select("id")
    .eq("id", applicationId)
    .eq("user_id", userId)
    .maybeSingle();
  if (!app) return fail("not_found", "Anwendung nicht gefunden.");

  // Content is the source of truth (magic bytes) — never the browser hint.
  const detected = detectFileType(input.buffer);
  if (!detected || !ATTACHMENT_MIME[detected]) {
    return fail("invalid_file_type", "Nicht unterstützter Dateityp. Erlaubt: PDF, DOC, DOCX, PNG, JPEG.");
  }
  const cap = Math.min(await effectiveUploadLimitBytes(userId), ATTACHMENT_HARD_CAP_BYTES);
  if (input.buffer.length > cap) {
    return fail("file_too_large", `Datei ist zu groß (max. ${Math.floor(cap / 1024 / 1024)} MB).`);
  }

  const path = `${userId}/studio/${randomUUID()}-${sanitizeFileName(input.name)}`;
  const mime = ATTACHMENT_MIME[detected];
  const { error: uploadError } = await admin
    .storage.from(ATTACHMENT_BUCKET)
    .upload(path, input.buffer, { contentType: mime, upsert: false });
  if (uploadError) return fail("storage_error", "Upload fehlgeschlagen. Bitte erneut versuchen.");

  const { data, error } = await admin
    .from("studio_attachments")
    .insert({
      application_id: applicationId,
      user_id: userId,
      display_name: sanitizeFileName(input.name),
      doc_category: ATTACHMENT_CATEGORIES_SET.has(input.category) ? input.category : "other",
      mime_type: mime,
      size_bytes: input.buffer.length,
      storage_path: path,
    })
    .select("*")
    .single();
  if (error || !data) {
    // Roll the object back so no orphan private file remains.
    await admin.storage.from(ATTACHMENT_BUCKET).remove([path]).catch(() => undefined);
    return fail("storage_error", "Upload konnte nicht abgeschlossen werden.");
  }
  void logStudioActivity(userId, "studio_attachment_uploaded", "Bewerbungs-Studio: Dokument hochgeladen", undefined, {
    name: sanitizeFileName(input.name),
  });
  return { ok: true, value: data as unknown as StudioAttachmentRow };
}

const ATTACHMENT_CATEGORIES_SET = new Set([
  "school_certificate",
  "professional_qualification",
  "language_certificate",
  "reference",
  "other",
]);

export async function listStudioAttachments(
  userId: string,
  applicationId: string,
): Promise<StudioAttachmentRow[]> {
  const { data, error } = await createAdminClient()
    .from("studio_attachments")
    .select("*")
    .eq("application_id", applicationId)
    .eq("user_id", userId)
    .order("created_at", { ascending: true });
  if (error) return [];
  return (data ?? []) as unknown as StudioAttachmentRow[];
}

async function fetchOwnedAttachment(
  userId: string,
  attachmentId: string,
  applicationId?: string,
): Promise<StudioAttachmentRow | null> {
  let query = createAdminClient()
    .from("studio_attachments")
    .select("*")
    .eq("id", attachmentId)
    .eq("user_id", userId);
  if (applicationId) query = query.eq("application_id", applicationId);
  const { data, error } = await query.maybeSingle();
  if (error || !data) return null;
  return data as unknown as StudioAttachmentRow;
}

export async function renameStudioAttachment(
  userId: string,
  attachmentId: string,
  newName: string,
): Promise<StudioOpResult> {
  const name = sanitizeFileName(newName);
  if (name.length < 2) return fail("invalid_file_type", "Ungültiger Dateiname.");
  const existing = await fetchOwnedAttachment(userId, attachmentId);
  if (!existing) return fail("not_found", "Dokument nicht gefunden.");
  const { error } = await createAdminClient()
    .from("studio_attachments")
    .update({ display_name: name })
    .eq("id", attachmentId)
    .eq("user_id", userId);
  if (error) return fail("storage_error", "Umbenennung fehlgeschlagen.");
  return { ok: true };
}

export async function deleteStudioAttachment(
  userId: string,
  attachmentId: string,
): Promise<StudioOpResult> {
  const existing = await fetchOwnedAttachment(userId, attachmentId);
  if (!existing) return fail("not_found", "Dokument nicht gefunden.");
  const admin = createAdminClient();
  await admin.storage.from(ATTACHMENT_BUCKET).remove([existing.storage_path]).catch(() => undefined);
  const { error } = await admin
    .from("studio_attachments")
    .delete()
    .eq("id", attachmentId)
    .eq("user_id", userId);
  if (error) return fail("storage_error", "Löschen fehlgeschlagen.");
  void logStudioActivity(userId, "studio_attachment_deleted", "Bewerbungs-Studio: Dokument gelöscht");
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Approval
// ---------------------------------------------------------------------------

export async function approveApplication(
  userId: string,
  applicationId: string,
): Promise<StudioOpResult<StudioApplicationRow>> {
  const now = new Date().toISOString();
  const admin = createAdminClient();
  const { data: existing } = await admin
    .from("studio_applications")
    .select("id, status")
    .eq("id", applicationId)
    .eq("user_id", userId)
    .maybeSingle();
  if (!existing) return fail("not_found", "Anwendung nicht gefunden.");
  const current = (existing as { status: string }).status;
  if (current === "sent") return fail("not_cancellable", "Bewerbung wurde bereits versendet.");
  const app = await patchApplication(userId, applicationId, {
    approved: true,
    approved_at: now,
    status: current === "draft" ? "ready" : (current as StudioAppStatus),
  });
  if (!app) return fail("not_found", "Anwendung nicht gefunden.");
  void logStudioActivity(userId, "studio_application_approved", "Bewerbungs-Studio: Bewerbung genehmigt");
  return { ok: true, value: app };
}

// ---------------------------------------------------------------------------
// Send preparation (immediate or scheduled)
// ---------------------------------------------------------------------------

export interface StudioScheduleInput {
  timeZone: string;
  year: number;
  month: number; // 1-12
  day: number;
  hour: number; // 0-23
  minute: number; // 0-59
}

export interface StudioSendInput {
  applicationId: string;
  recipientEmail: string;
  emailAccountId: string;
  subject: string;
  body: string;
  attachmentIds: string[];
  schedule: StudioScheduleInput | null;
}

export interface StudioSendResult {
  ok: boolean;
  code?: StudioErrorCode | string;
  message?: string;
  attemptId?: string;
  scheduledAt?: string | null;
  /** Set when an immediate send was dispatched inline. */
  dispatchStatus?: "sent" | "failed" | "queued" | "duplicate";
  failureCode?: string | null;
}

export async function prepareStudioSend(
  userId: string,
  input: StudioSendInput,
): Promise<StudioSendResult> {
  if (!(await hasStudioSchema()))
    return { ok: false, code: "schema_pending", message: "Studio-Datenbank wird vorbereitet." };
  const admin = createAdminClient();

  const { data: appData, error: appError } = await admin
    .from("studio_applications")
    .select("*")
    .eq("id", input.applicationId)
    .eq("user_id", userId)
    .maybeSingle();
  if (appError || !appData) return { ok: false, code: "not_found", message: "Anwendung nicht gefunden." };
  const app = appData as unknown as StudioApplicationRow;
  if (!app.approved)
    return { ok: false, code: "not_approved", message: "Bitte genehmigen Sie die Bewerbung zuerst." };
  if (app.status === "sent")
    return { ok: false, code: "already_sent", message: "Diese Bewerbung wurde bereits versendet." };
  if (!isValidEmail(input.recipientEmail))
    return { ok: false, code: "invalid_recipient", message: "Ungültige Empfänger-E-Mail." };
  const subject = input.subject.trim().slice(0, 200);
  const body = input.body.trim().slice(0, 6000);
  if (!subject || !body)
    return { ok: false, code: "invalid_recipient", message: "Betreff und Text sind erforderlich." };

  // Email account: owned + active (createEmailProvider re-checks at send time).
  const { data: account } = await admin
    .from("email_accounts")
    .select("id")
    .eq("id", input.emailAccountId)
    .eq("user_id", userId)
    .eq("is_active", true)
    .maybeSingle();
  if (!account)
    return { ok: false, code: "no_email_account", message: "Kein aktives E-Mail-Konto verbunden." };

  // Attachments: owned + belong to THIS application.
  const payloadAttachments: StudioSendPayload["attachments"] = [];
  if (input.attachmentIds.length > 0) {
    const { data: atts } = await admin
      .from("studio_attachments")
      .select("*")
      .eq("user_id", userId)
      .eq("application_id", app.id)
      .in("id", input.attachmentIds.slice(0, 10));
    for (const a of (atts ?? []) as unknown as StudioAttachmentRow[]) {
      payloadAttachments.push({
        filename: a.display_name,
        mimeType: a.mime_type,
        storagePath: a.storage_path,
      });
    }
    if (payloadAttachments.length !== Math.min(input.attachmentIds.filter((id) => id !== STUDIO_LETTER_PDF_ID).length, 10))
      return { ok: false, code: "not_found", message: "Ein angehängtes Dokument konnte nicht zugeordnet werden." };
  }

  // Optional server-rendered Anschreiben PDF — ONLY when the user explicitly
  // selected it. Rendered locally from the stored letter (deterministic PDF
  // pipeline, zero cost, no third-party). Missing applicant fields are
  // omitted from the letterhead, never invented.
  if (input.attachmentIds.includes(STUDIO_LETTER_PDF_ID)) {
    const letterDoc = await getLatestStudioDocument(userId, app.id, "cover_letter");
    const letter = parseStoredLetter(letterDoc);
    const ex2 = app.ad_extracted ? adExtractSchema.safeParse(app.ad_extracted) : null;
    if (letter?.text.trim() && ex2?.success) {
      const { data: prof } = await admin
        .from("profiles")
        .select("full_name, email, phone, street, postal_code, city, country")
        .eq("user_id", userId)
        .maybeSingle();
      const pr = (prof ?? {}) as Record<string, string | null | undefined>;
      try {
        const folio = buildLetterFolio({
          applicantName: pr.full_name ?? null,
          applicantEmail: pr.email ?? null,
          applicantStreet: pr.street ?? null,
          applicantPostalCode: pr.postal_code ?? null,
          applicantCity: pr.city ?? null,
          applicantCountry: pr.country ?? null,
          applicantPhone: pr.phone ?? null,
          companyName: ex2.data.company,
          companyContactName: ex2.data.contactPerson || null,
          companyAddress: ex2.data.companyAddress || null,
          subject: subject,
          bodyHtml: emailBodyToHtml(letter.text),
        });
        const bytes = await generateLetterPdf(folio);
        const path = letterPdfStoragePath(userId, app.id);
        const { error: letterUploadError } = await admin
          .storage.from(BEW_ATTACHMENT_BUCKET)
          .upload(path, Buffer.from(bytes), { contentType: BEW_LETTER_PDF_MIME, upsert: true });
        if (letterUploadError) {
          // A missing letter PDF must not block the send the user approved —
          // drop the attachment, keep everything else.
          void letterUploadError;
        } else {
          payloadAttachments.push({
            filename: letterPdfFilename(ex2.data.company),
            mimeType: BEW_LETTER_PDF_MIME,
            storagePath: path,
          });
        }
      } catch {
        /* rendering failure → attachment dropped, send proceeds without it */
      }
    }
  }

  // Schedule validation (explicit timezone; future; before the ad deadline).
  let scheduledAt: string | null = null;
  let scheduleTz: string | null = null;
  if (input.schedule) {
    const utcMs = zonedTimeToUtc(
      input.schedule.year, input.schedule.month, input.schedule.day,
      input.schedule.hour, input.schedule.minute, input.schedule.timeZone,
    );
    if (utcMs === null)
      return { ok: false, code: "invalid_schedule", message: "Ungültiges Datum, Uhrzeit oder Zeitzone." };
    if (utcMs <= Date.now() + 60_000)
      return { ok: false, code: "invalid_schedule", message: "Der Versandzeitpunkt muss in der Zukunft liegen." };
    const extract = app.ad_extracted
      ? adExtractSchema.safeParse(app.ad_extracted)
      : null;
    const deadline = parseAdDeadline(extract?.success ? extract.data.applicationDeadline : null);
    if (deadline !== null && utcMs > deadline)
      return { ok: false, code: "schedule_after_deadline", message: "Der geplante Versand liegt nach der Bewerbungsfrist." };
    scheduledAt = new Date(utcMs).toISOString();
    scheduleTz = input.schedule.timeZone;
  }

  const idempotencyKey = randomUUID();
  const payload: StudioSendPayload = {
    html: emailBodyToHtml(body),
    text: body,
    attachments: payloadAttachments,
  };

  // ATOMIC SEND-SLOT CLAIM (duplicate-send prevention, server-side):
  // only ONE concurrent prepare for this application can flip the status out
  // of {draft, ready, failed}; a losing racer (double click, two tabs,
  // replayed request) sees zero rows and must NOT create a second attempt.
  // The per-attempt idempotency key is the second layer: even if two attempts
  // ever existed for one logical send, the dispatch claim (atomic
  // queued→sending) guarantees at most one execution per attempt, and the
  // 'sent' status guard blocks any further prepares.
  const { data: claimedRows } = await admin
    .from("studio_applications")
    .update({
      recipient_email: input.recipientEmail.trim().toLowerCase(),
      email_account_id: input.emailAccountId,
      idempotency_key: idempotencyKey,
      status: scheduledAt ? "scheduled" : "sending",
      scheduled_at: scheduledAt,
      schedule_timezone: scheduleTz,
      last_failure_code: null,
    })
    .eq("id", app.id)
    .eq("user_id", userId)
    .in("status", ["draft", "ready", "failed"])
    .select("id");
  if (!claimedRows || claimedRows.length === 0)
    return {
      ok: false,
      code: "send_in_progress",
      message: "Es läuft bereits ein Versand für diese Bewerbung.",
    };

  const { data: attempt, error: attemptError } = await admin
    .from("studio_send_attempts")
    .insert({
      application_id: app.id,
      user_id: userId,
      idempotency_key: idempotencyKey,
      recipient_email: input.recipientEmail.trim().toLowerCase(),
      subject,
      payload,
      status: "queued",
      scheduled_at: scheduledAt,
    })
    .select("*")
    .single();
  if (attemptError || !attempt) {
    // Release the claim so the user can retry (no orphan "sending" state).
    await patchApplication(userId, app.id, { status: "ready", idempotency_key: null, scheduled_at: null, schedule_timezone: null });
    return { ok: false, code: "storage_error", message: "Versand konnte nicht vorbereitet werden." };
  }

  void logStudioActivity(
    userId,
    scheduledAt ? "studio_send_scheduled" : "studio_send_requested",
    scheduledAt ? "Bewerbungs-Studio: Versand geplant" : "Bewerbungs-Studio: Versand gestartet",
    undefined,
    { applicationId: app.id, recipient: input.recipientEmail },
  );

  // Immediate dispatch happens inline (server action context — same trust
  // boundary as every other send in this codebase).
  if (!scheduledAt) {
    const result = await dispatchStudioAttempt((attempt as unknown as StudioSendAttemptRow).id);
    return {
      ok: true,
      attemptId: (attempt as unknown as StudioSendAttemptRow).id,
      scheduledAt: null,
      dispatchStatus: result.duplicate ? "duplicate" : result.ok ? "sent" : "failed",
      failureCode: result.failureCode ?? null,
    };
  }
  return { ok: true, attemptId: (attempt as unknown as StudioSendAttemptRow).id, scheduledAt };
}

// ---------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------

export async function cancelStudioSend(
  userId: string,
  attemptId: string,
): Promise<StudioOpResult> {
  const admin = createAdminClient();
  const { data: attemptData } = await admin
    .from("studio_send_attempts")
    .select("id, application_id, status")
    .eq("id", attemptId)
    .eq("user_id", userId)
    .maybeSingle();
  if (!attemptData) return fail("not_found", "Versand nicht gefunden.");
  const attempt = attemptData as { id: string; application_id: string; status: string };
  if (attempt.status !== "queued")
    return fail("not_cancellable", "Nur geplante (noch nicht laufende) Versände können abgebrochen werden.");
  const { error } = await admin
    .from("studio_send_attempts")
    .update({ status: "cancelled" })
    .eq("id", attempt.id)
    .eq("user_id", userId);
  if (error) return fail("storage_error", "Abbrechen fehlgeschlagen.");
  await patchApplication(userId, attempt.application_id, {
    status: "ready",
    scheduled_at: null,
    schedule_timezone: null,
  });
  void logStudioActivity(userId, "studio_send_cancelled", "Bewerbungs-Studio: Versand abgebrochen");
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Dispatch (the only place a studio email can leave the building)
// ---------------------------------------------------------------------------

export interface StudioDispatchResult {
  ok: boolean;
  duplicate: boolean;
  status: "sent" | "failed" | "queued" | "skipped";
  failureCode?: string | null;
}

const backoffMs = (attempt: number): number => 2 * 60_000 * 2 ** (attempt - 1); // 2m, 4m, 8m

/**
 * Dispatch ONE send attempt. The ONLY code path that can send a studio email.
 *
 * Claim semantics: exactly one dispatcher may execute a given attempt.
 *  - `claimed: false` (inline / page-load path): an atomic
 *    `update … where status = 'queued'` is the claim; a zero-row result
 *    means another dispatcher won (duplicate).
 *  - `claimed: true` (cron path): the RPC `claim_due_studio_attempts`
 *    already flipped the row to 'sending' under FOR UPDATE SKIP LOCKED and
 *    returned it to this worker exclusively — skip the inline claim.
 *
 * attempt_count is incremented EXACTLY ONCE per executed claim (inside the
 * claim update or right after the RPC claim) — never by the RPC itself — so
 * both paths count identically and the retry budget (3) cannot be bypassed
 * or double-consumed.
 */
export async function dispatchStudioAttempt(
  attemptId: string,
  opts: { claimed?: boolean } = {},
): Promise<StudioDispatchResult> {
  const admin = createAdminClient();

  const { data: attemptData } = await admin
    .from("studio_send_attempts")
    .select("*")
    .eq("id", attemptId)
    .maybeSingle();
  if (!attemptData) return { ok: false, duplicate: false, status: "skipped" };
  const attempt = attemptData as unknown as StudioSendAttemptRow;
  if (attempt.status === "sent") return { ok: true, duplicate: true, status: "sent" };
  if (attempt.status === "cancelled" || attempt.status === "failed")
    return { ok: false, duplicate: false, status: "skipped" };

  // Re-check consent + application state at EXECUTION time (a scheduled send
  // may be hours old; the user could have reconnected a different mailbox).
  // All three failures are TERMINAL (no auto-retry): they only resolve by a
  // new, explicitly approved send.
  const { data: appData } = await admin
    .from("studio_applications")
    .select("id, approved, email_account_id, status")
    .eq("id", attempt.application_id)
    .maybeSingle();
  if (!appData)
    return terminalAttempt(admin, attempt, "application_missing", "Bewerbung nicht mehr vorhanden.");
  const app = appData as { id: string; approved: boolean; email_account_id: string | null; status: string };
  if (!app.approved)
    return terminalAttempt(admin, attempt, "not_approved", "Bewerbung wurde nicht genehmigt.");
  if (!app.email_account_id)
    return terminalAttempt(admin, attempt, "no_email_account", "E-Mail-Konto wurde getrennt.");

  // The claim (atomic on the inline path; the increment happens here).
  let executedCount: number;
  if (opts.claimed) {
    executedCount = attempt.attempt_count + 1;
    await admin
      .from("studio_send_attempts")
      .update({ attempt_count: executedCount })
      .eq("id", attempt.id);
  } else {
    const { data: claimedRows } = await admin
      .from("studio_send_attempts")
      .update({ status: "sending", attempt_count: attempt.attempt_count + 1 })
      .eq("id", attempt.id)
      .eq("status", "queued")
      .select("id, attempt_count");
    if (!claimedRows || claimedRows.length === 0)
      return { ok: true, duplicate: true, status: "skipped" };
    executedCount = Number((claimedRows[0] as { attempt_count?: number }).attempt_count ?? attempt.attempt_count + 1);
  }

  try {
    const provider = await createEmailProvider(attempt.user_id, app.email_account_id, attempt.payload.attachments);
    const result = await provider.sendEmail({
      to: attempt.recipient_email,
      subject: attempt.subject,
      html: attempt.payload.html,
      text: attempt.payload.text,
      attachments: [], // provider fetches the (ownership-checked) storage paths itself
    });
    const sentAt = new Date().toISOString();
    await admin
      .from("studio_send_attempts")
      .update({ status: "sent", provider_message_id: result.providerMessageId, sent_at: sentAt, next_attempt_at: null })
      .eq("id", attempt.id);
    await admin
      .from("studio_applications")
      .update({ status: "sent", sent_at: sentAt, provider_message_id: result.providerMessageId, last_failure_code: null })
      .eq("id", app.id);
    void logStudioActivity(attempt.user_id, "studio_application_sent", "Bewerbungs-Studio: Bewerbung versendet", undefined, {
      recipient: attempt.recipient_email,
      providerMessageId: result.providerMessageId,
    });
    return { ok: true, duplicate: false, status: "sent" };
  } catch (error) {
    const pf = (error as Partial<ProviderFailure>) ?? {};
    const code = pf.code ?? "dispatch_error";
    const message = (pf.message ?? "Versand fehlgeschlagen.").slice(0, 300);
    // `executedCount` = attempts actually made, INCLUDING this one.
    if (pf.uncertain || executedCount >= MAX_SEND_ATTEMPTS || !pf.temporary) {
      // uncertain = maybe already delivered → NEVER auto-retry.
      await admin
        .from("studio_send_attempts")
        .update({
          status: "failed",
          failure_code: code,
          failure_message: message,
          next_attempt_at: null,
          attempt_count: executedCount,
        })
        .eq("id", attempt.id);
      await admin
        .from("studio_applications")
        .update({ status: "failed", last_failure_code: code })
        .eq("id", app.id);
      void logStudioActivity(attempt.user_id, "studio_send_failed", "Bewerbungs-Studio: Versand fehlgeschlagen", message, { code });
      return { ok: false, duplicate: false, status: "failed", failureCode: code };
    }
    // Temporary provider hiccup → retry with backoff. The row goes back to
    // 'queued'; the next dispatch re-validates consent + account first, and
    // the idempotent claim guarantees at most one execution at a time.
    const next = new Date(Date.now() + backoffMs(Math.max(1, executedCount))).toISOString();
    await admin
      .from("studio_send_attempts")
      .update({ status: "queued", next_attempt_at: next, failure_code: code, failure_message: message, attempt_count: executedCount })
      .eq("id", attempt.id);
    void logStudioActivity(attempt.user_id, "studio_send_retry", "Bewerbungs-Studio: Versand wird wiederholt", message, { code, next });
    return { ok: false, duplicate: false, status: "queued", failureCode: code };
  }
}

/** Terminal failure (no retry budget): pre-claim validation errors. */
async function terminalAttempt(
  admin: ReturnType<typeof createAdminClient>,
  attempt: StudioSendAttemptRow,
  code: string,
  message: string,
): Promise<StudioDispatchResult> {
  await admin
    .from("studio_send_attempts")
    .update({ status: "failed", failure_code: code, failure_message: message, next_attempt_at: null })
    .eq("id", attempt.id);
  await admin
    .from("studio_applications")
    .update({ status: "failed", last_failure_code: code })
    .eq("id", attempt.application_id);
  void logStudioAttempt(attempt.user_id, code, message);
  return { ok: false, duplicate: false, status: "failed", failureCode: code };
}

function logStudioAttempt(userId: string, code: string, message: string): void {
  void logStudioActivity(userId, "studio_send_failed", "Bewerbungs-Studio: Versand nicht möglich", message, { code });
}

// ---------------------------------------------------------------------------
// Scheduler entry points (cron + page-load catch-up)
// ---------------------------------------------------------------------------

export interface StudioSweepResult {
  recovered: number;
  claimed: number;
  results: StudioDispatchResult[];
}

/** Cron worker: recover stale rows, claim due attempts, dispatch each. */
export async function claimAndDispatchDueStudioAttempts(limit = 5, budgetMs = 45_000): Promise<StudioSweepResult> {
  const deadline = Date.now() + budgetMs;
  const admin = createAdminClient();
  const { data: recovered } = await admin.rpc("recover_stale_studio_attempts");
  const recoveredCount = Number(recovered ?? 0) || 0;
  const { data: rows, error } = await admin.rpc("claim_due_studio_attempts", { p_limit: limit });
  if (error || !Array.isArray(rows))
    return { recovered: recoveredCount, claimed: 0, results: [] };
  const results: StudioDispatchResult[] = [];
  for (const row of rows as Array<Pick<StudioSendAttemptRow, "id">>) {
    // Soft wall-clock budget: stop dispatching early; rows already flipped
    // to 'sending' by the claim RPC are recovered by the next tick's
    // recover_stale_studio_attempts (durable Postgres state, no loss).
    if (Date.now() > deadline) break;
    // The RPC already flipped the row to 'sending' (exclusive claim), so
    // dispatch runs WITHOUT re-claiming — the attempt budget is still
    // enforced inside dispatch (attempt_count += 1 exactly once).
    results.push(await dispatchStudioAttempt(row.id, { claimed: true }));
    if (results.length >= 10) break;
  }
  return { recovered: recoveredCount, claimed: rows.length, results };
}

/** Best-effort page-load catch-up: process at most `limit` DUE attempts of
 *  the visiting user (server-side; the browser only triggers the re-check).
 *  Due-ness is filtered in JS (two independent null-or-past conditions —
 *  clearer than PostgREST or() gymnastics; the set is small per user). */
export async function processDueStudioAttemptsForUser(userId: string, limit = 1): Promise<StudioSweepResult> {
  const admin = createAdminClient();
  const nowMs = Date.now();
  const due = (ts: string | null): boolean => ts === null || new Date(ts).getTime() <= nowMs;
  const { data: rows } = await admin
    .from("studio_send_attempts")
    .select("id, scheduled_at, next_attempt_at")
    .eq("user_id", userId)
    .eq("status", "queued")
    .order("created_at", { ascending: true })
    .limit(10);
  const dueRows = ((rows ?? []) as Array<{ id: string; scheduled_at: string | null; next_attempt_at: string | null }>)
    .filter((r) => due(r.scheduled_at) && due(r.next_attempt_at))
    .slice(0, limit);
  const results: StudioDispatchResult[] = [];
  for (const row of dueRows) {
    results.push(await dispatchStudioAttempt(row.id));
  }
  return { recovered: 0, claimed: results.length, results };
}

// ---------------------------------------------------------------------------
// Audit trail (shared activity_logs table — best-effort, never breaks flow)
// ---------------------------------------------------------------------------

async function logStudioActivity(
  userId: string,
  activityType: string,
  title: string,
  description?: string,
  metadata?: Record<string, unknown>,
): Promise<void> {
  try {
    await createAdminClient().from("activity_logs").insert({
      user_id: userId,
      activity_type: activityType.slice(0, 80),
      title: title.slice(0, 160),
      description: description?.slice(0, 1000) ?? null,
      metadata: metadata ?? {},
    });
  } catch (error) {
    console.error("[studio] activity log failed", error instanceof Error ? error.message : error);
  }
}

// ---------------------------------------------------------------------------
// Page-data helpers
// ---------------------------------------------------------------------------

export interface StudioEmailAccount {
  id: string;
  provider: "gmail" | "outlook";
  email: string;
  is_active: boolean;
  requires_reconnect: boolean;
}

/** The user's connected mailboxes (for the send panel; ownership-scoped). */
export async function listUserEmailAccounts(userId: string): Promise<StudioEmailAccount[]> {
  try {
    const { data, error } = await createAdminClient()
      .from("email_accounts")
      .select("id, provider, email, is_active, requires_reconnect")
      .eq("user_id", userId)
      .order("created_at", { ascending: true });
    if (error || !data) return [];
    return data as unknown as StudioEmailAccount[];
  } catch {
    return [];
  }
}

/** Latest scanner candidate profile (verified, zod-parsed) or null. */
export async function getLatestCandidateProfile(
  userId: string,
): Promise<import("@/lib/bewerbung-schema").CandidateProfile | null> {
  try {
    const { data } = await createAdminClient()
      .from("candidate_profiles")
      .select("profile_json")
      .eq("user_id", userId)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const parsed = candidateProfileSchema.safeParse((data as { profile_json?: unknown } | null)?.profile_json);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// AI input assembly helpers (used by the /api/bewerbung-studio/* routes)
// ---------------------------------------------------------------------------

export interface StudioUserFacts {
  fullName?: string | null;
  email?: string | null;
  phone?: string | null;
  location?: string | null;
  linkedin?: string | null;
}

export interface StudioCandidateContext {
  /** Latest scanner profile (verified, zod-parsed) or null. */
  profile: import("@/lib/bewerbung-schema").CandidateProfile | null;
  profileText: string;
  /** The user's own CV (browser source of truth), sanitized server-side.
   *  The CV is an INPUT to generation — it is NEVER written to Supabase. */
  cv: CvDocument | null;
  cvText: string;
  hasCvContent: boolean;
  /** The DB profile's contact fields (for verified-facts collection). */
  user: StudioUserFacts | null;
}

/** Fetch the latest scanner profile + format the client-supplied CV for
 *  prompts. Used by every /api/bewerbung-studio/* generation route. */
export async function buildStudioCandidateContext(
  userId: string,
  rawClientCv: unknown,
  user: StudioUserFacts | null,
): Promise<StudioCandidateContext> {
  let profile: import("@/lib/bewerbung-schema").CandidateProfile | null = null;
  try {
    const { data } = await createAdminClient()
      .from("candidate_profiles")
      .select("profile_json")
      .eq("user_id", userId)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const parsed = candidateProfileSchema.safeParse((data as { profile_json?: unknown } | null)?.profile_json);
    if (parsed.success) profile = parsed.data;
  } catch {
    profile = null;
  }
  const cv = sanitizeCvDocument(rawClientCv);
  return {
    profile,
    profileText: formatProfileForPrompt(profile),
    cv,
    cvText: formatCvForPrompt(cv),
    hasCvContent: cv ? cvHasContent(cv) : false,
    user,
  };
}
