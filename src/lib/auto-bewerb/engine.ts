import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { effectiveUploadLimitBytes } from "@/lib/billing/entitlement-service";
import { detectFileType } from "@/lib/ai-service";
import {
  createEmailProvider,
  type ProviderFailure,
} from "@/lib/email-providers";
import {
  BEW_LETTER_PDF_MIME,
  buildLetterFolio,
  generateLetterPdf,
  letterPdfFilename,
} from "@/lib/bew-letter-pdf";
import {
  cvHasContent,
  sanitizeCvDocument,
  type CvDocument,
} from "@/lib/templates/cv";
import { candidateProfileSchema, type CandidateProfile } from "@/lib/bewerbung-schema";
import {
  autoBewerbLetterSchema,
  AUTO_BEWERB_COMPANY_LIMIT,
  AUTO_BEWERB_DOC_CATEGORIES,
  AUTO_BEWERB_TABLES,
  classifyProbeError,
  isValidEmail,
  normalizeCompanyKey,
  resolveAutoBewerbRecipient,
  buildAutoBewerbGreeting,
  substituteEmailTokens,
  type AutoBewerbEmailSettings,
  adExtractSchema,
  adAnalysisSchema,
  type AdAnalysis,
  type AdExtract,
  type AutoBewerbAttachmentRow,
  type AutoBewerbCompanyRow,
  type AutoBewerbDocumentRow,
  type AutoBewerbProfileRow,
  type AutoBewerbSendAttemptRow,
  type AutoBewerbSendPayload,
  type AutoBewerbAppStatus,
} from "./schema";
import { generateCvPdf, cvPdfFilename } from "./cv-pdf";
import { parseAdDeadline } from "../studio/quality";
import { zonedTimeToUtc } from "../studio/timezone";
import {
  emailBodyToHtml,
  escapeHtml,
  listUserEmailAccounts,
} from "../studio";
import { sanitizeEmailHtml, htmlToText } from "../email-sanitize";
import {
  PROFILE_PHOTO_EXT,
  PROFILE_PHOTO_MAX_BYTES,
  PROFILE_PHOTO_MIME,
  buildPhotoRef,
  profilePhotoStoragePath,
  validateProfilePhoto,
} from "./profile-photo";
import { processProfilePhoto, resolvePhotoDataUrl } from "./profile-photo-process";
import type { AutoBewerbProfilePhotoRow } from "./schema";
import { SIGNATURE_MIME, signatureStoragePaths, validateSignature } from "./signature";

/**
 * AUTO BEWERB — server-side data + dispatch engine (the /auto-bewerb workflow).
 *
 * Ownership contract (identical to the studio and bew tables): every read
 * re-scopes by `user_id`;
 * `user_id`; every write runs with the service role AFTER the ownership
 * check, because RLS is SELECT-only for owners. The identity always comes
 * from the session (or the cron worker's RPC) — never from client input.
 *
 * Send safety:
 *  - a send requires approved = true (explicit user confirmation showing the
 *    exact recipients + attachments) and an active, owned email account,
 *    re-checked at dispatch time;
 *  - each logical send is one auto_bewerb_send_attempts row with a unique
 *    idempotency_key; the claim is an atomic `update … where status='queued'`,
 *    so concurrent dispatchers can never double-send;
 *  - "uncertain" provider failures are terminal (no auto-resend);
 *  - temporary failures retry with backoff up to 3 attempts.
 *  - The shared email-body template is rendered (token substitution) at
 *    PREPARE time only — the stored row keeps the raw template/override so
 *    editing the template updates every future send (never a past one).
 */

export type AutoBewerbErrorCode =
  | "schema_pending"
  | "not_found"
  | "not_approved"
  | "send_in_progress"
  | "already_sent"
  | "no_email_account"
  | "invalid_recipient"
  | "invalid_file_type"
  | "file_too_large"
  | "invalid_schedule"
  | "schedule_after_deadline"
  | "not_cancellable"
  | "workflow_full"
  | "company_duplicate"
  | "not_deletable"
  | "no_template"
  | "no_subject"
  | "missing_cv"
  | "missing_letter"
  | "cv_render_failed"
  | "cv_upload_failed"
  | "letter_render_failed"
  | "letter_upload_failed"
  | "invalid_document"
  | "storage_error"
  | "dispatch_error";

export type AutoBewerbOpResult<T = undefined> =
  | { ok: true; value?: T }
  | { ok: false; code: AutoBewerbErrorCode; message: string };

const fail = (code: AutoBewerbErrorCode, message: string): AutoBewerbOpResult<never> => ({
  ok: false,
  code,
  message,
});

/** File types the private `application-attachments` bucket accepts
 *  (same allow-list as the studio attachments). */
const ATTACHMENT_MIME: Record<string, string> = {
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  png: "image/png",
  jpeg: "image/jpeg",
};
const ATTACHMENT_BUCKET = "application-attachments";
const ATTACHMENT_HARD_CAP_BYTES = 10 * 1024 * 1024;
const MAX_SEND_ATTEMPTS = 3;
const DOC_CATEGORIES_SET = new Set<string>(AUTO_BEWERB_DOC_CATEGORIES);

/** Storage paths for the server-rendered per-company PDFs (private bucket). */
export const autoBewerbCvPdfStoragePath = (userId: string, companyId: string): string =>
  `auto-bewerb/cv/${userId}/${companyId}.pdf`;
export const autoBewerbLetterPdfStoragePath = (userId: string, companyId: string): string =>
  `auto-bewerb/letter/${userId}/${companyId}.pdf`;

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

// ---------------------------------------------------------------------------
// Schema probe (graceful degradation before the manual migration is applied)
// ---------------------------------------------------------------------------

/** A NEGATIVE probe is only trusted this long: a transient Supabase error
 *  (or a migration applied moments later — including the PostgREST
 *  schema-cache refresh that follows a migration) must not pin the "setup
 *  pending" state for the whole serverless instance. Positive results are
 *  cached. */
const PROBE_NEGATIVE_TTL_MS = 60_000;

let probeCache: { at: number; missing: string[]; blocked: string[] } | null = null;

export interface AutoBewerbProbeResult {
  /** Relations that do not exist yet (or that PostgREST has not seen yet —
   *  schema-cache lag reports the same error shape; transient). */
  missing: string[];
  /** Relations whose probe was refused/failed for a reason OTHER than
   *  "not found" (permissions, connectivity, …). These are never reported
   *  as missing tables. */
  blocked: string[];
}

/**
 * Probe all seven AUTO BEWERB tables through the SAME admin client the
 * engine uses for its real queries, so probe failure tracks the actual
 * access problem.
 *
 * The probe query is deliberately `select("*")` — NOT `select("id")`: not
 * every table has an `id` column (`auto_bewerb_company_attachments` has a
 * composite primary key, `auto_bewerb_email_templates` is keyed by
 * `user_id`). A column-specific probe reports a fully migrated database as
 * "tables missing" forever — no retry can fix that.
 *
 * Error classes stay distinct: only the "relation not found" shape counts
 * as missing; everything else is logged with its PostgREST error text
 * (server-side diagnostics) and surfaced as a separate honest UI state.
 */
export async function getAutoBewerbProbe(): Promise<AutoBewerbProbeResult> {
  if (probeCache) {
    const positive = probeCache.missing.length === 0 && probeCache.blocked.length === 0;
    if (positive || Date.now() - probeCache.at < PROBE_NEGATIVE_TTL_MS) {
      return { missing: probeCache.missing, blocked: probeCache.blocked };
    }
  }
  const results = await Promise.all(
    AUTO_BEWERB_TABLES.map(async (table): Promise<{ table: string; error: string | null }> => {
      try {
        const { error } = await createAdminClient().from(table).select("*").limit(1);
        return { table, error: error?.message ?? null };
      } catch (e) {
        return { table, error: e instanceof Error ? e.message : String(e) };
      }
    }),
  );
  const missing: string[] = [];
  const blocked: string[] = [];
  for (const { table, error } of results) {
    if (!error) continue;
    if (classifyProbeError({ message: error }) === "missing") {
      missing.push(table);
    } else {
      blocked.push(table);
      console.error(`[auto-bewerb] schema probe blocked on "${table}": ${error}`);
    }
  }
  probeCache = { at: Date.now(), missing, blocked };
  return { missing, blocked };
}

/** Boolean probe (true = all AUTO BEWERB tables reachable). */
export function hasAutoBewerbSchema(): Promise<boolean> {
  return getAutoBewerbProbe().then((p) => p.missing.length === 0 && p.blocked.length === 0);
}

/** Map a PostgREST insert error to a safe, actionable UI outcome (only
 *  allow-listed shapes are forwarded — raw driver details stay server-side). */
function classifyInsertError(error: { message?: string } | null | undefined): AutoBewerbOpResult<never> {
  const raw = error?.message ?? "";
  const msg = raw.replace(/^\d{5}: /, "");
  if (/could not find the table|pgrst205|relation "public\.auto_bewerb_companies" does not exist/i.test(msg)) {
    return fail("schema_pending", "AUTO BEWERB Datenbank wird vorbereitet.");
  }
  const col = msg.match(/^column "([a-z0-9_]+)" does not exist/i);
  if (col) {
    return fail(
      "storage_error",
      `Das Datenbank-Schema ist veraltet (Feld "${col[1]}" fehlt) — bitte die AUTO BEWERB Migration neu anwenden.`,
    );
  }
  if (/value too long for type/i.test(msg)) {
    return fail(
      "storage_error",
      "Das Datenbank-Schema ist veraltet (Spaltentyp zu kurz) — bitte die AUTO BEWERB Migration neu anwenden.",
    );
  }
  // Two concurrent creates that both computed the same smallest free slot:
  // the unique index refused the second one — a safe "workflow full", never
  // an 11th company.
  if (/auto_bewerb_companies_user_slot_unique/i.test(msg)) {
    return fail("workflow_full", "Der Workflow ist voll (max. 10 Unternehmen). Bitte ein Unternehmen entfernen, um Platz zu schaffen.");
  }
  // Same company added twice: the partial unique index is the arbiter.
  if (/auto_bewerb_companies_user_company_unique/i.test(msg)) {
    return fail("company_duplicate", "Dieses Unternehmen wurde bereits hinzugefügt.");
  }
  if (/duplicate key/i.test(msg)) {
    return fail("storage_error", "Dieser Eintrag wurde gerade eben gespeichert — bitte die Seite aktualisieren.");
  }
  console.error(`[auto-bewerb] unclassified auto_bewerb_companies write error: ${raw}`);
  return fail("storage_error", "Speichern fehlgeschlagen. Bitte erneut versuchen.");
}

// ---------------------------------------------------------------------------
// Step 1 — the analyzed CV profile (one row per user)
// ---------------------------------------------------------------------------

export async function getAutoBewerbProfile(userId: string): Promise<AutoBewerbProfileRow | null> {
  const { data, error } = await createAdminClient()
    .from("auto_bewerb_profiles")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();
  if (error || !data) return null;
  const row = data as unknown as AutoBewerbProfileRow;
  // Re-validate the persisted extraction (defense in depth).
  row.extracted = row.extracted
    ? candidateProfileSchema.safeParse(row.extracted).success
      ? candidateProfileSchema.parse(row.extracted)
      : null
    : null;
  return row;
}

export interface SaveAutoBewerbProfileInput {
  cvFileName: string;
  cvMime: string;
  cvSizeBytes: number;
  cvStoragePath: string;
  /** sha256 hex of the uploaded bytes (reuse fingerprint). */
  cvHash: string;
  extracted: CandidateProfile;
}

/** Upsert the user's CV profile. When the stored file differs, the OLD
 *  storage object is removed (best effort) — the replacement is the source
 *  of truth, and the extracted data belongs to the new file. */
export async function saveAutoBewerbProfile(
  userId: string,
  input: SaveAutoBewerbProfileInput,
): Promise<AutoBewerbOpResult<AutoBewerbProfileRow>> {
  if (!(await hasAutoBewerbSchema())) return fail("schema_pending", "AUTO BEWERB Datenbank wird vorbereitet.");
  const parsed = candidateProfileSchema.safeParse(input.extracted);
  if (!parsed.success) return fail("invalid_document", "Das extrahierte Profil ist ungültig.");
  const extracted = { ...parsed.data, goal: "ausbildung" as const };
  const admin = createAdminClient();

  const { data: existingData } = await admin
    .from("auto_bewerb_profiles")
    .select("id, cv_storage_path")
    .eq("user_id", userId)
    .maybeSingle();
  const existing = (existingData ?? null) as { id: string; cv_storage_path: string } | null;

  if (existing && existing.cv_storage_path !== input.cvStoragePath) {
    // Replace: drop the previous file so no orphan object remains.
    await admin
      .storage.from(ATTACHMENT_BUCKET)
      .remove([existing.cv_storage_path])
      .catch(() => undefined);
  }

  const now = new Date().toISOString();
  if (existing) {
    const { data, error } = await admin
      .from("auto_bewerb_profiles")
      .update({
        cv_file_name: input.cvFileName.slice(0, 255),
        cv_mime_type: input.cvMime,
        cv_size_bytes: Math.max(0, input.cvSizeBytes),
        cv_storage_path: input.cvStoragePath,
        cv_hash: input.cvHash,
        extracted,
        analyzed_at: now,
      })
      .eq("id", existing.id)
      .eq("user_id", userId)
      .select("*")
      .maybeSingle();
    if (error || !data) return fail("storage_error", "Profil konnte nicht gespeichert werden.");
    void logAutoBewerbActivity(userId, "auto_bewerb_profile_replaced", "AUTO BEWERB: Lebenslauf ersetzt");
    return { ok: true, value: data as unknown as AutoBewerbProfileRow };
  }

  const { data, error } = await admin
    .from("auto_bewerb_profiles")
    .insert({
      user_id: userId,
      cv_file_name: input.cvFileName.slice(0, 255),
      cv_mime_type: input.cvMime,
      cv_size_bytes: Math.max(0, input.cvSizeBytes),
      cv_storage_path: input.cvStoragePath,
      cv_hash: input.cvHash,
      extracted,
      analyzed_at: now,
    })
    .select("*")
    .single();
  if (error || !data) {
    console.error(`[auto-bewerb] profile insert failed: ${error?.message ?? "unknown"}`);
    return fail("storage_error", "Profil konnte nicht gespeichert werden.");
  }
  void logAutoBewerbActivity(userId, "auto_bewerb_profile_created", "AUTO BEWERB: Lebenslauf analysiert");
  return { ok: true, value: data as unknown as AutoBewerbProfileRow };
}

/** Persist the user's CORRECTIONS of the extracted profile (Step 1 review).
 *  The file itself is untouched; the corrected profile becomes the source of
 *  truth for every generated document (guarded against it, never the other
 *  way round). */
export async function updateAutoBewerbProfileExtract(
  userId: string,
  extracted: CandidateProfile,
): Promise<AutoBewerbOpResult<AutoBewerbProfileRow>> {
  const parsed = candidateProfileSchema.safeParse(extracted);
  if (!parsed.success) return fail("invalid_document", "Das Profil ist ungültig.");
  const { data, error } = await createAdminClient()
    .from("auto_bewerb_profiles")
    .update({ extracted: { ...parsed.data, goal: "ausbildung" as const } })
    .eq("user_id", userId)
    .select("*")
    .maybeSingle();
  if (error || !data) return fail("not_found", "Profil nicht gefunden.");
  return { ok: true, value: data as unknown as AutoBewerbProfileRow };
}

/** Delete the whole CV profile (user request): removes the stored file and
 *  the row. Already-generated company documents keep their reviewed content
 *  (they are versioned copies, not live links). */
export async function deleteAutoBewerbProfile(userId: string): Promise<AutoBewerbOpResult> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("auto_bewerb_profiles")
    .select("cv_storage_path")
    .eq("user_id", userId)
    .maybeSingle();
  if (!data) return fail("not_found", "Profil nicht gefunden.");
  await admin
    .storage.from(ATTACHMENT_BUCKET)
    .remove([(data as { cv_storage_path: string }).cv_storage_path])
    .catch(() => undefined);
  const { error } = await admin.from("auto_bewerb_profiles").delete().eq("user_id", userId);
  if (error) return fail("storage_error", "Löschen fehlgeschlagen.");
  void logAutoBewerbActivity(userId, "auto_bewerb_profile_deleted", "AUTO BEWERB: Lebenslauf gelöscht");
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Step 1 — professional profile photo (independent of the CV file)
// ---------------------------------------------------------------------------

/**
 * The photo feature has its OWN schema probe (migration
 * 20261216000000_auto_bewerb_profile_photo.sql): a deployment of this code
 * BEFORE the migration is applied must degrade ONLY the photo card, never
 * the whole 7-table workflow (AUTO_BEWERB_TABLES stays untouched).
 *
 * Negative results are cached 60 s (same TTL as the table probe): a
 * schema-cache refresh after a just-applied migration must not pin the
 * "photo unavailable" state for the whole serverless instance.
 */
const PHOTO_PROBE_NEGATIVE_TTL_MS = 60_000;
let photoProbeCache: { at: number; available: boolean } | null = null;

export async function getAutoBewerbPhotoProbe(): Promise<{ available: boolean }> {
  if (photoProbeCache) {
    if (photoProbeCache.available || Date.now() - photoProbeCache.at < PHOTO_PROBE_NEGATIVE_TTL_MS) {
      return { available: photoProbeCache.available };
    }
  }
  let available = true;
  try {
    const { error } = await createAdminClient()
      .from("auto_bewerb_profile_photos")
      .select("*")
      .limit(1);
    if (error) {
      available = classifyProbeError({ message: error.message ?? String(error) }) !== "missing";
      if (!available) {
        // Missing table = migration not applied yet: an expected, silent state.
      } else {
        console.error(`[auto-bewerb] photo schema probe blocked: ${error}`);
      }
    }
  } catch (e) {
    available = false;
    console.error(`[auto-bewerb] photo schema probe error: ${e instanceof Error ? e.message : e}`);
  }
  photoProbeCache = { at: Date.now(), available };
  return { available };
}

/** Boolean probe (true = the profile-photo table is reachable). */
export function hasAutoBewerbPhotoSchema(): Promise<boolean> {
  return getAutoBewerbPhotoProbe().then((p) => p.available);
}

export async function getAutoBewerbProfilePhoto(userId: string): Promise<AutoBewerbProfilePhotoRow | null> {
  const { data, error } = await createAdminClient()
    .from("auto_bewerb_profile_photos")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();
  if (error || !data) return null;
  return data as unknown as AutoBewerbProfilePhotoRow;
}

const PHOTO_EXT_BY_MIME: Record<string, "jpg" | "png" | "webp"> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

/** The current photo's frozen CV reference (null = no photo / unsupported /
 *  unknown mime — the workflow simply continues without a photograph). */
export async function getAutoBewerbProfilePhotoRef(userId: string): Promise<string | null> {
  const row = await getAutoBewerbProfilePhoto(userId).catch(() => null);
  const ext = row ? PHOTO_EXT_BY_MIME[row.photo_mime_type] : undefined;
  return row && ext ? buildPhotoRef(row.photo_hash, ext) : null;
}

/**
 * Upload / REPLACE the candidate's professional photo.
 *
 * Pipeline: magic-byte validation (the bytes are the source of truth) →
 * size + dimension caps → best-effort optimization (aspect preserved; a
 * failed optimization keeps the original validated bytes) → sha256 of the
 * STORED bytes → private bucket under `${userId}/auto-bewerb/photo/`
 * (owner-scoped, unguessable, content-deduplicated) → upsert of the single
 * owner row (the ONLY "current photo" source of truth).
 *
 * Replaced objects are deliberately KEPT in storage: previously generated
 * CVs freeze the photo by hash reference and must never silently change.
 */
export async function uploadAutoBewerbProfilePhoto(
  userId: string,
  buffer: Buffer,
): Promise<AutoBewerbOpResult<{ ref: string; hash: string; mime: string; sizeBytes: number }>> {
  if (!(await hasAutoBewerbPhotoSchema())) {
    return fail("schema_pending", "Die Foto-Funktion wird vorbereitet. Bitte die Migration anwenden und erneut laden.");
  }
  const validation = validateProfilePhoto(buffer);
  if (!validation.ok) {
    const message =
      validation.code === "too_large"
        ? `Das Foto ist zu groß (max. ${Math.floor(PROFILE_PHOTO_MAX_BYTES / 1024 / 1024)} MB).`
        : validation.code === "too_small"
          ? "Das Foto ist zu klein (mind. 300 px pro Seite)."
          : validation.code === "too_high_resolution"
            ? "Das Foto hat eine unzulässig hohe Auflösung (max. 8000 px pro Seite)."
            : "Nur JPG, JPEG, PNG oder WEBP werden akzeptiert.";
    return fail(validation.code === "too_large" ? "file_too_large" : "invalid_file_type", message);
  }

  const processed =
    (await processProfilePhoto(buffer, validation.type)) ?? {
      buffer,
      ext: PROFILE_PHOTO_EXT[validation.type],
      mime: PROFILE_PHOTO_MIME[validation.type],
      width: 0,
      height: 0,
      optimized: false,
    };
  if (processed.buffer.length > PROFILE_PHOTO_MAX_BYTES) {
    return fail("file_too_large", `Das Foto ist zu groß (max. ${Math.floor(PROFILE_PHOTO_MAX_BYTES / 1024 / 1024)} MB).`);
  }

  const admin = createAdminClient();
  const fileHash = createHash("sha256").update(processed.buffer).digest("hex");
  const path = profilePhotoStoragePath(userId, fileHash, processed.ext);
  const { error: uploadError } = await admin
    .storage.from(ATTACHMENT_BUCKET)
    .upload(path, processed.buffer, { contentType: processed.mime, upsert: true });
  if (uploadError) return fail("storage_error", "Foto-Upload fehlgeschlagen. Bitte erneut versuchen.");

  const now = new Date().toISOString();
  const { error } = await admin
    .from("auto_bewerb_profile_photos")
    .upsert(
      {
        user_id: userId,
        photo_mime_type: processed.mime,
        photo_size_bytes: processed.buffer.length,
        photo_hash: fileHash,
        photo_storage_path: path,
        uploaded_at: now,
      },
      { onConflict: "user_id" },
    );
  if (error) {
    // Roll the object back so no orphan private file remains.
    await admin.storage.from(ATTACHMENT_BUCKET).remove([path]).catch(() => undefined);
    console.error(`[auto-bewerb] photo upsert failed: ${error.message}`);
    return fail("storage_error", "Foto konnte nicht gespeichert werden. Bitte erneut versuchen.");
  }
  void logAutoBewerbActivity(userId, "auto_bewerb_profile_photo_uploaded", "AUTO BEWERB: Bewerbungsfoto hochgeladen");
  return {
    ok: true,
    value: { ref: buildPhotoRef(fileHash, processed.ext), hash: fileHash, mime: processed.mime, sizeBytes: processed.buffer.length },
  };
}

/** Remove the current photo (user request). The storage object is KEPT —
 *  previously saved CVs hold the frozen hash reference (see upload). */
export async function deleteAutoBewerbProfilePhoto(userId: string): Promise<AutoBewerbOpResult> {
  if (!(await hasAutoBewerbPhotoSchema())) return fail("schema_pending", "Die Foto-Funktion wird vorbereitet.");
  const { error } = await createAdminClient()
    .from("auto_bewerb_profile_photos")
    .delete()
    .eq("user_id", userId);
  if (error) return fail("storage_error", "Das Foto konnte nicht entfernt werden. Bitte erneut versuchen.");
  void logAutoBewerbActivity(userId, "auto_bewerb_profile_photo_removed", "AUTO BEWERB: Bewerbungsfoto entfernt");
  return { ok: true };
}

/**
 * Resolve a CV photo reference to renderable bytes for the VERIFIED owner.
 * The storage path is constructed from the session-verified userId — the
 * reference itself carries only the content hash (no path, no URL).
 * A missing object (photo removed) resolves to null: the renderer then
 * simply omits the photo, it never fails the document.
 */
export async function resolveAutoBewerbPhotoDataUrl(
  userId: string,
  ref: string | null,
): Promise<string | null> {
  if (!ref) return null;
  if (ref.startsWith("data:image/")) {
    // Legacy inline data URL (CV Builder documents) — no storage access.
    return ref.length <= 8 * 1024 * 1024 ? ref : null;
  }
  try {
    return await resolvePhotoDataUrl(userId, ref, async (uid, hash, ext) => {
      const path = profilePhotoStoragePath(uid, hash, ext);
      const storage = createAdminClient().storage.from(ATTACHMENT_BUCKET) as {
        download: (p: string) => Promise<{ data: Blob | null; error: { message?: string } | null }>;
      };
      const { data, error } = await storage.download(path);
      if (error || !data) return null;
      return Buffer.from(await data.arrayBuffer());
    });
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Step 5 — the candidate's GENUINE handwritten signature
// ---------------------------------------------------------------------------
//
// One signature per user, at a FIXED owner-scoped path in the private
// `application-attachments` bucket — deliberately NOT a row in the
// `auto_bewerb_attachments` e-mail library (no migration, and it can never
// become a standalone e-mail attachment). The image is embedded INTO the
// cover-letter PDF (a separate attachment), between the closing and the name.
// It is the user's uploaded image — never generated or invented.

/** Upload / REPLACE the candidate's signature. Only the raw uploaded bytes
 *  (magic-byte validated, ≤ 5 MB, PNG or JPEG) are stored — the browser's
 *  MIME hint and file name are ignored. The opposite-format object is removed
 *  so exactly ONE signature always exists for the owner. */
export async function uploadAutoBewerbSignature(
  userId: string,
  buffer: Buffer,
): Promise<AutoBewerbOpResult<{ mime: string; sizeBytes: number }>> {
  const validation = validateSignature(buffer);
  if (!validation.ok) {
    const message =
      validation.code === "too_large"
        ? "Die Signatur ist zu groß (max. 5 MB)."
        : "Nur PNG oder JPEG werden akzeptiert.";
    return fail(validation.code === "too_large" ? "file_too_large" : "invalid_file_type", message);
  }
  const admin = createAdminClient();
  const { png, jpg } = signatureStoragePaths(userId);
  const target = validation.type === "png" ? png : jpg;
  const other = validation.type === "png" ? jpg : png;
  const { error: uploadError } = await admin
    .storage.from(ATTACHMENT_BUCKET)
    .upload(target, buffer, { contentType: SIGNATURE_MIME[validation.type], upsert: true });
  if (uploadError) return fail("storage_error", "Signatur-Upload fehlgeschlagen. Bitte erneut versuchen.");
  // Drop the opposite-format object: only ONE signature may exist per owner.
  await admin.storage.from(ATTACHMENT_BUCKET).remove([other]).catch(() => undefined);
  void logAutoBewerbActivity(userId, "auto_bewerb_signature_uploaded", "AUTO BEWERB: Signatur hochgeladen");
  return { ok: true, value: { mime: SIGNATURE_MIME[validation.type], sizeBytes: buffer.length } };
}

/** Remove the candidate's signature (user request). Both fixed paths are
 *  cleared (one of them is always the live object). */
export async function deleteAutoBewerbSignature(userId: string): Promise<AutoBewerbOpResult> {
  const admin = createAdminClient();
  const { png, jpg } = signatureStoragePaths(userId);
  const { error } = await admin.storage.from(ATTACHMENT_BUCKET).remove([png, jpg]);
  if (error) return fail("storage_error", "Die Signatur konnte nicht entfernt werden. Bitte erneut versuchen.");
  void logAutoBewerbActivity(userId, "auto_bewerb_signature_removed", "AUTO BEWERB: Signatur entfernt");
  return { ok: true };
}

/**
 * The current signature image for the VERIFIED owner (null = none). The
 * storage path is built from the session-verified userId — never client
 * input. PNG is tried first, then JPEG (the two fixed paths). A missing or
 * unreadable object resolves to null: the letter then renders with the
 * verified name line only (never a fabricated signature, never a failure).
 */
export async function getAutoBewerbSignatureImage(
  userId: string,
): Promise<{ bytes: Uint8Array; mime: string } | null> {
  const admin = createAdminClient();
  const { png, jpg } = signatureStoragePaths(userId);
  const candidates: Array<[string, string]> = [
    [png, "image/png"],
    [jpg, "image/jpeg"],
  ];
  for (const [path, mime] of candidates) {
    try {
      const { data, error } = await admin.storage.from(ATTACHMENT_BUCKET).download(path);
      if (!error && data) {
        const bytes = new Uint8Array(await data.arrayBuffer());
        if (bytes.length > 0) return { bytes, mime };
      }
    } catch {
      // Not found / transient → try the other format.
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Step 2 — companies (one per job advertisement, max 10)
// ---------------------------------------------------------------------------

export interface CreateAutoBewerbCompanyInput {
  adRaw: string;
  /** Display name — from the user's edit or the extraction's company field. */
  company?: string | null;
  extract?: AdExtract | null;
  analysis?: AdAnalysis | null;
  /** Candidate-facts fingerprint ({ cvHash }) at analysis time (reuse proof). */
  profileSnapshot?: unknown;
}

export async function createAutoBewerbCompany(
  userId: string,
  input: CreateAutoBewerbCompanyInput,
): Promise<AutoBewerbOpResult<AutoBewerbCompanyRow>> {
  if (!(await hasAutoBewerbSchema())) return fail("schema_pending", "AUTO BEWERB Datenbank wird vorbereitet.");
  const adRaw = input.adRaw.trim().slice(0, 30_000);
  if (adRaw.length < 1) return fail("invalid_recipient", "Bitte einen Anzeigentext eingeben.");
  const displayName = (input.company ?? input.extract?.company ?? input.extract?.jobTitle ?? "").trim().slice(0, 200);
  const company = displayName || "Unternehmen";
  const companyKey = normalizeCompanyKey(displayName);

  const admin = createAdminClient();
  // Duplicate check (upfront, for a friendly message + existing card):
  if (companyKey) {
    const { data: dup } = await admin
      .from("auto_bewerb_companies")
      .select("id, company")
      .eq("user_id", userId)
      .eq("company_key", companyKey)
      .maybeSingle();
    if (dup) {
      return fail(
        "company_duplicate",
        `„${(dup as { company: string }).company}“ ist bereits in Ihrem Workflow. Bitte eine bestehende Karte bearbeiten.`,
      );
    }
  }
  // 10-company cap (server-enforced; slot unique index is the race arbiter).
  const { data: slotRows, error: slotErr } = await admin
    .from("auto_bewerb_companies")
    .select("slot_no")
    .eq("user_id", userId);
  if (slotErr) return classifyInsertError(slotErr);
  const active = (slotRows ?? []) as Array<{ slot_no?: number | null }>;
  if (active.length >= AUTO_BEWERB_COMPANY_LIMIT) {
    return fail("workflow_full", "Der Workflow ist voll (max. 10 Unternehmen). Bitte ein Unternehmen entfernen, um Platz zu schaffen.");
  }
  const usedSlots = new Set(
    active.map((r) => r.slot_no).filter((s): s is number => typeof s === "number" && s >= 1 && s <= AUTO_BEWERB_COMPANY_LIMIT),
  );
  let slotNo = 1;
  while (usedSlots.has(slotNo)) slotNo += 1;

  const { data, error } = await admin
    .from("auto_bewerb_companies")
    .insert({
      user_id: userId,
      company,
      company_key: companyKey,
      slot_no: slotNo,
      ad_raw: adRaw,
      ad_extracted: input.extract ?? null,
      ad_analysis: input.analysis ?? null,
      profile_snapshot: input.profileSnapshot ?? null,
      status: "draft",
      // AUTO-CONFIRMATION: the ad text was pasted + analyzed by the user and
      // is persisted by this very write — the server stamps the confirmation
      // inside the successful insert. A failed insert creates no row, so a
      // company can never be "confirmed" without existing.
      ad_confirmed_at: new Date().toISOString(),
    })
    .select("*")
    .single();
  if (error || !data) return classifyInsertError(error);
  void logAutoBewerbActivity(userId, "auto_bewerb_company_created", "AUTO BEWERB: Unternehmen hinzugefügt", undefined, { company });
  return { ok: true, value: data as unknown as AutoBewerbCompanyRow };
}

export async function listAutoBewerbCompanies(userId: string): Promise<AutoBewerbCompanyRow[]> {
  const { data, error } = await createAdminClient()
    .from("auto_bewerb_companies")
    .select("*")
    .eq("user_id", userId)
    .order("slot_no", { ascending: true })
    .limit(AUTO_BEWERB_COMPANY_LIMIT);
  if (error) return [];
  return revalidateCompanies(data ?? []);
}

function revalidateCompanies(rows: unknown[]): AutoBewerbCompanyRow[] {
  return (rows as unknown as AutoBewerbCompanyRow[]).map((row) => {
    const app: AutoBewerbCompanyRow = { ...row };
    // Re-validate persisted JSON (old/partial rows must never break the UI).
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
    return app;
  });
}

export interface AutoBewerbCompanyBundle {
  company: AutoBewerbCompanyRow;
  documents: AutoBewerbDocumentRow[];
  attempts: AutoBewerbSendAttemptRow[];
}

export async function getAutoBewerbCompany(
  userId: string,
  id: string,
): Promise<AutoBewerbCompanyBundle | null> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("auto_bewerb_companies")
    .select("*")
    .eq("id", id)
    .eq("user_id", userId)
    .maybeSingle();
  if (error || !data) return null;
  const company = revalidateCompanies([data as unknown])[0];
  const [docsRes, attsRes] = await Promise.all([
    admin.from("auto_bewerb_documents").select("*").eq("company_id", id).order("version", { ascending: false }),
    admin.from("auto_bewerb_send_attempts").select("*").eq("company_id", id).order("created_at", { ascending: false }),
  ]);
  return {
    company,
    documents: (docsRes.data ?? []) as unknown as AutoBewerbDocumentRow[],
    attempts: (attsRes.data ?? []) as unknown as AutoBewerbSendAttemptRow[],
  };
}

export type AutoBewerbCompanyPatch = Partial<
  Pick<
    AutoBewerbCompanyRow,
    | "company"
    | "ad_raw"
    | "ad_extracted"
    | "ad_analysis"
    | "profile_snapshot"
    | "status"
    | "idempotency_key"
    | "approved"
    | "approved_at"
    | "scheduled_at"
    | "schedule_timezone"
    | "sent_at"
    | "provider_message_id"
    | "last_failure_code"
    | "ad_confirmed_at"
    | "cv_reviewed_at"
    | "letter_reviewed_at"
  >
> & {
  /** Internal: derived from `company` by the engine (dedupe key). */
  company_key?: string;
};

async function patchCompany(
  userId: string,
  id: string,
  patch: AutoBewerbCompanyPatch,
): Promise<AutoBewerbCompanyRow | null> {
  // Auto-confirmation: every successful save of the ad content IS the
  // confirmation (the manual "Anzeige bestätigen" step was removed). Editing
  // the extraction or the raw ad text re-stamps the confirmation server-side;
  // unrelated patches (email fields, review marks) leave the timestamp alone.
  // Renaming the company re-derives the dedupe key (a rename into an existing
  // name is a unique violation → company_duplicate at the caller).
  const extended: AutoBewerbCompanyPatch = { ...patch };
  if ("ad_extracted" in patch || "ad_raw" in patch) {
    extended.ad_confirmed_at = new Date().toISOString();
  }
  if ("company" in patch && typeof patch.company === "string") {
    extended.company_key = normalizeCompanyKey(patch.company);
  }
  const { data, error } = await createAdminClient()
    .from("auto_bewerb_companies")
    .update(extended)
    .eq("id", id)
    .eq("user_id", userId)
    .select("*")
    .maybeSingle();
  if (error || !data) return null;
  return revalidateCompanies([data as unknown])[0];
}

export async function updateAutoBewerbCompany(
  userId: string,
  id: string,
  patch: AutoBewerbCompanyPatch,
): Promise<AutoBewerbOpResult<AutoBewerbCompanyRow>> {
  if ("company" in patch) {
    const name = (patch.company ?? "").trim().slice(0, 200);
    if (name.length < 1) return fail("company_duplicate", "Der Unternehmensname darf nicht leer sein.");
  }
  if ("ad_raw" in patch) {
    const ad = (patch.ad_raw ?? "").trim();
    if (ad.length < 1 || ad.length > 30_000) return fail("invalid_document", "Der Anzeigentext ist ungültig.");
  }
  const app = await patchCompany(userId, id, patch);
  if (!app) {
    // Distinguish the unique-violation case (rename into an existing company)
    // from a plain miss: re-run the probe-free check by error shape.
    const probe = await createAdminClient()
      .from("auto_bewerb_companies")
      .select("id")
      .eq("id", id)
      .eq("user_id", userId)
      .maybeSingle();
    if (!probe.data) return fail("not_found", "Unternehmen nicht gefunden.");
    return fail("company_duplicate", "Dieses Unternehmen wurde bereits hinzugefügt.");
  }
  return { ok: true, value: app };
}

export async function approveAutoBewerbCompany(
  userId: string,
  companyId: string,
): Promise<AutoBewerbOpResult<AutoBewerbCompanyRow>> {
  const admin = createAdminClient();
  const { data: existing } = await admin
    .from("auto_bewerb_companies")
    .select("id, status")
    .eq("id", companyId)
    .eq("user_id", userId)
    .maybeSingle();
  if (!existing) return fail("not_found", "Unternehmen nicht gefunden.");
  const current = (existing as { status: string }).status;
  if (current === "sent") return fail("already_sent", "Diese Bewerbung wurde bereits versendet.");
  const app = await patchCompany(userId, companyId, {
    approved: true,
    approved_at: new Date().toISOString(),
    status: current === "draft" ? "ready" : (current as AutoBewerbAppStatus),
  });
  if (!app) return fail("not_found", "Unternehmen nicht gefunden.");
  void logAutoBewerbActivity(userId, "auto_bewerb_company_approved", "AUTO BEWERB: Bewerbung genehmigt");
  return { ok: true, value: app };
}

/** Delete one company: cancels queued attempts FIRST (never send after
 *  cancellation), removes the company's rendered PDFs and child rows, then
 *  the row (freeing its slot). The USER-LEVEL document library is untouched
 *  (its objects are shared across companies). */
export async function deleteAutoBewerbCompany(
  userId: string,
  companyId: string,
): Promise<AutoBewerbOpResult> {
  const admin = createAdminClient();
  const { data: appData, error: appError } = await admin
    .from("auto_bewerb_companies")
    .select("*")
    .eq("id", companyId)
    .eq("user_id", userId)
    .maybeSingle();
  if (appError || !appData) return fail("not_found", "Unternehmen nicht gefunden.");
  const app = appData as unknown as AutoBewerbCompanyRow;
  if (app.status === "sending") {
    return fail("not_deletable", "Der Versand läuft gerade — bitte warten, bis er abgeschlossen ist.");
  }

  // 1) Cancel queued attempts so the scheduler can never fire.
  const { data: attempts } = await admin
    .from("auto_bewerb_send_attempts")
    .select("id")
    .eq("company_id", companyId)
    .eq("user_id", userId);
  for (const a of (attempts ?? []) as unknown as Array<{ id: string }>) {
    await admin
      .from("auto_bewerb_send_attempts")
      .update({ status: "cancelled", failure_code: "company_deleted" })
      .eq("id", a.id)
      .eq("status", "queued");
  }

  // 2) Remove the company's rendered PDFs (library objects stay).
  await admin
    .storage.from(ATTACHMENT_BUCKET)
    .remove([autoBewerbCvPdfStoragePath(userId, companyId), autoBewerbLetterPdfStoragePath(userId, companyId)])
    .catch(() => undefined);

  // 3) Delete child rows explicitly (scoped to this company AND the owner).
  for (const table of ["auto_bewerb_documents", "auto_bewerb_send_attempts", "auto_bewerb_company_attachments"] as const) {
    const { error: childError } = await admin
      .from(table)
      .delete()
      .eq("company_id", companyId)
      .eq("user_id", userId);
    if (childError) return fail("storage_error", "Löschen fehlgeschlagen.");
  }

  // 4) Delete the company row itself (frees its slot_no).
  const { error: delError } = await admin
    .from("auto_bewerb_companies")
    .delete()
    .eq("id", companyId)
    .eq("user_id", userId);
  if (delError) return fail("storage_error", "Löschen fehlgeschlagen.");
  void logAutoBewerbActivity(userId, "auto_bewerb_company_deleted", "AUTO BEWERB: Unternehmen entfernt", undefined, {
    company: app.company,
  });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Steps 4–5 — versioned generated documents (per company)
// ---------------------------------------------------------------------------

export type AutoBewerbDocType = "cv" | "cover_letter";

/** Save a NEW version of the company's tailored CV (CvDocument) or
 *  Anschreiben ({ text, tone }). Regenerating one company never touches
 *  another company's documents (separate rows per company_id). A new version
 *  re-opens the matching review confirmation. */
export async function saveAutoBewerbDocument(
  userId: string,
  companyId: string,
  docType: AutoBewerbDocType,
  content: unknown,
): Promise<AutoBewerbOpResult<AutoBewerbDocumentRow>> {
  if (!(await hasAutoBewerbSchema())) return fail("schema_pending", "AUTO BEWERB Datenbank wird vorbereitet.");
  const admin = createAdminClient();
  const { data: app } = await admin
    .from("auto_bewerb_companies")
    .select("id")
    .eq("id", companyId)
    .eq("user_id", userId)
    .maybeSingle();
  if (!app) return fail("not_found", "Unternehmen nicht gefunden.");

  // Server-side content validation (never trust the client's JSON shape).
  let normalized: unknown = content;
  if (docType === "cv") {
    const cv = sanitizeCvDocument(content);
    if (!cv || !cvHasContent(cv)) {
      return fail("invalid_document", "Der Lebenslauf ist leer oder ungültig.");
    }
    normalized = cv;
  } else {
    const letter = autoBewerbLetterSchema.safeParse(content);
    if (!letter.success) {
      return fail("invalid_document", "Das Anschreiben ist ungültig.");
    }
    normalized = letter.data;
  }

  const { data: latest } = await admin
    .from("auto_bewerb_documents")
    .select("version")
    .eq("company_id", companyId)
    .eq("doc_type", docType)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  const version = ((latest?.version as number | undefined) ?? 0) + 1;

  const { data, error } = await admin
    .from("auto_bewerb_documents")
    .insert({
      company_id: companyId,
      user_id: userId,
      doc_type: docType,
      version,
      content: normalized,
    })
    .select("*")
    .single();
  if (error || !data) return fail("storage_error", "Dokument konnte nicht gespeichert werden.");
  // A NEW version is not "reviewed" until the user confirms it again.
  await patchCompany(userId, companyId, docType === "cv" ? { cv_reviewed_at: null } : { letter_reviewed_at: null });
  return { ok: true, value: data as unknown as AutoBewerbDocumentRow };
}

/** Parse the latest stored document of a type into its typed content
 *  (null = not generated yet or unparsable). */
export async function getLatestAutoBewerbDocument(
  userId: string,
  companyId: string,
  docType: AutoBewerbDocType,
): Promise<AutoBewerbDocumentRow | null> {
  const { data, error } = await createAdminClient()
    .from("auto_bewerb_documents")
    .select("*")
    .eq("company_id", companyId)
    .eq("user_id", userId)
    .eq("doc_type", docType)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  return data as unknown as AutoBewerbDocumentRow;
}

/** Typed accessor: latest CV as CvDocument (re-sanitized) or null. */
export async function getLatestAutoBewerbCv(
  userId: string,
  companyId: string,
): Promise<CvDocument | null> {
  const doc = await getLatestAutoBewerbDocument(userId, companyId, "cv");
  return doc ? sanitizeCvDocument(doc.content) : null;
}

// ---------------------------------------------------------------------------
// Step 3 — supporting-document library (user-level, reusable, hash-deduped)
// ---------------------------------------------------------------------------

export interface UploadAutoBewerbAttachmentResult {
  row: AutoBewerbAttachmentRow;
  /** true = identical bytes were already stored (no second upload). */
  reused: boolean;
}

/** Upload a supporting document into the user's LIBRARY (not bound to any
 *  company). Identical bytes for the same user reuse the existing row
 *  (no duplicate storage object). Content is the source of truth: the file
 *  type comes from magic bytes, never the browser hint. */
export async function uploadAutoBewerbAttachment(
  userId: string,
  input: { name: string; buffer: Buffer; category: string },
): Promise<AutoBewerbOpResult<UploadAutoBewerbAttachmentResult>> {
  if (!(await hasAutoBewerbSchema())) return fail("schema_pending", "AUTO BEWERB Datenbank wird vorbereitet.");
  const admin = createAdminClient();

  const detected = detectFileType(input.buffer);
  if (!detected || !ATTACHMENT_MIME[detected]) {
    return fail("invalid_file_type", "Nicht unterstützter Dateityp. Erlaubt: PDF, DOC, DOCX, PNG, JPEG.");
  }
  const cap = Math.min(await effectiveUploadLimitBytes(userId), ATTACHMENT_HARD_CAP_BYTES);
  if (input.buffer.length > cap) {
    return fail("file_too_large", `Datei ist zu groß (max. ${Math.floor(cap / 1024 / 1024)} MB).`);
  }

  const fileHash = createHash("sha256").update(input.buffer).digest("hex");
  // Hash dedupe: same user + same bytes → the stored row wins (no second
  // storage object, no duplicate library entry — retries are idempotent).
  const { data: existingData } = await admin
    .from("auto_bewerb_attachments")
    .select("*")
    .eq("user_id", userId)
    .eq("file_hash", fileHash)
    .maybeSingle();
  if (existingData) {
    return { ok: true, value: { row: existingData as unknown as AutoBewerbAttachmentRow, reused: true } };
  }

  const displayName = sanitizeFileName(input.name);
  const path = `${userId}/auto-bewerb/docs/${randomUUID()}-${displayName}`;
  const mime = ATTACHMENT_MIME[detected];
  const { error: uploadError } = await admin
    .storage.from(ATTACHMENT_BUCKET)
    .upload(path, input.buffer, { contentType: mime, upsert: false });
  if (uploadError) return fail("storage_error", "Upload fehlgeschlagen. Bitte erneut versuchen.");

  const { data, error } = await admin
    .from("auto_bewerb_attachments")
    .insert({
      user_id: userId,
      display_name: displayName,
      doc_category: DOC_CATEGORIES_SET.has(input.category) ? input.category : "other",
      mime_type: mime,
      size_bytes: input.buffer.length,
      storage_path: path,
      file_hash: fileHash,
    })
    .select("*")
    .single();
  if (error || !data) {
    // Roll the object back so no orphan private file remains.
    await admin.storage.from(ATTACHMENT_BUCKET).remove([path]).catch(() => undefined);
    if (/auto_bewerb_attachments_user_hash_unique/i.test(error?.message ?? "")) {
      // Concurrent identical upload won the race — treat as a safe reuse.
      const { data: winner } = await admin
        .from("auto_bewerb_attachments")
        .select("*")
        .eq("user_id", userId)
        .eq("file_hash", fileHash)
        .maybeSingle();
      if (winner) return { ok: true, value: { row: winner as unknown as AutoBewerbAttachmentRow, reused: true } };
    }
    return fail("storage_error", "Upload konnte nicht abgeschlossen werden.");
  }
  void logAutoBewerbActivity(userId, "auto_bewerb_document_uploaded", "AUTO BEWERB: Dokument hochgeladen", undefined, {
    name: displayName,
  });
  return { ok: true, value: { row: data as unknown as AutoBewerbAttachmentRow, reused: false } };
}

export async function listAutoBewerbAttachments(userId: string): Promise<AutoBewerbAttachmentRow[]> {
  const { data, error } = await createAdminClient()
    .from("auto_bewerb_attachments")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: true });
  if (error) return [];
  return (data ?? []) as unknown as AutoBewerbAttachmentRow[];
}

async function fetchOwnedAttachment(userId: string, attachmentId: string): Promise<AutoBewerbAttachmentRow | null> {
  const { data, error } = await createAdminClient()
    .from("auto_bewerb_attachments")
    .select("*")
    .eq("id", attachmentId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error || !data) return null;
  return data as unknown as AutoBewerbAttachmentRow;
}

export async function renameAutoBewerbAttachment(
  userId: string,
  attachmentId: string,
  newName: string,
): Promise<AutoBewerbOpResult> {
  const name = sanitizeFileName(newName);
  if (name.length < 2) return fail("invalid_file_type", "Ungültiger Dateiname.");
  const existing = await fetchOwnedAttachment(userId, attachmentId);
  if (!existing) return fail("not_found", "Dokument nicht gefunden.");
  const { error } = await createAdminClient()
    .from("auto_bewerb_attachments")
    .update({ display_name: name })
    .eq("id", attachmentId)
    .eq("user_id", userId);
  if (error) return fail("storage_error", "Umbenennung fehlgeschlagen.");
  return { ok: true };
}

/** Delete a library document. Company selections to it cascade away (FK);
 *  already-prepared send payloads keep their own storage references until
 *  they are sent or cancelled (a send never reads this table at dispatch). */
export async function deleteAutoBewerbAttachment(
  userId: string,
  attachmentId: string,
): Promise<AutoBewerbOpResult> {
  const existing = await fetchOwnedAttachment(userId, attachmentId);
  if (!existing) return fail("not_found", "Dokument nicht gefunden.");
  const admin = createAdminClient();
  await admin.storage.from(ATTACHMENT_BUCKET).remove([existing.storage_path]).catch(() => undefined);
  const { error } = await admin
    .from("auto_bewerb_attachments")
    .delete()
    .eq("id", attachmentId)
    .eq("user_id", userId);
  if (error) return fail("storage_error", "Löschen fehlgeschlagen.");
  void logAutoBewerbActivity(userId, "auto_bewerb_document_deleted", "AUTO BEWERB: Dokument gelöscht");
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Step 6 — the SHARED email-body template (one row per user)
// ---------------------------------------------------------------------------

export async function getAutoBewerbEmailTemplate(userId: string): Promise<string> {
  const { data, error } = await createAdminClient()
    .from("auto_bewerb_email_templates")
    .select("body")
    .eq("user_id", userId)
    .maybeSingle();
  if (error || !data) return "";
  return String((data as { body: string }).body ?? "");
}

export async function saveAutoBewerbEmailTemplate(
  userId: string,
  body: string,
): Promise<AutoBewerbOpResult<string>> {
  if (!(await hasAutoBewerbSchema())) return fail("schema_pending", "AUTO BEWERB Datenbank wird vorbereitet.");
  const normalized = body.trim().slice(0, 6_000);
  const { error } = await createAdminClient()
    .from("auto_bewerb_email_templates")
    .upsert({ user_id: userId, body: normalized }, { onConflict: "user_id" });
  if (error) return fail("storage_error", "Vorlage konnte nicht gespeichert werden.");
  return { ok: true, value: normalized };
}

// ---------------------------------------------------------------------------
// Step 6 — the ONE GLOBAL e-mail configuration (one row per user, extended
// template row: recipient / subject / account / attachment flags)
// ---------------------------------------------------------------------------

/** Column probe for the email-settings migration (same idiom as the photo
 *  probe). Negative results are cached 60 s so a just-applied migration is
 *  not pinned as "unsupported" by the schema cache. */
const EMAIL_SETTINGS_PROBE_NEGATIVE_TTL_MS = 60_000;
let emailSettingsProbeCache: { at: number; available: boolean } | null = null;

export async function getAutoBewerbEmailSettingsProbe(): Promise<{ available: boolean }> {
  if (emailSettingsProbeCache) {
    if (emailSettingsProbeCache.available || Date.now() - emailSettingsProbeCache.at < EMAIL_SETTINGS_PROBE_NEGATIVE_TTL_MS) {
      return { available: emailSettingsProbeCache.available };
    }
  }
  let available = true;
  try {
    const { error } = await createAdminClient()
      .from("auto_bewerb_email_templates")
      .select("recipient")
      .limit(1);
    if (error) {
      const msg = error.message ?? String(error);
      // Missing column (42703) or missing table = migration not applied yet:
      // an expected, silent state (legacy per-company fallback).
      const expected =
        classifyProbeError({ message: msg }) === "missing" ||
        /42703|column .* does not exist|could not find a column/i.test(msg);
      if (!expected) console.error(`[auto-bewerb] email-settings schema probe blocked: ${error}`);
      available = false;
    }
  } catch (e) {
    available = false;
    console.error(`[auto-bewerb] email-settings schema probe error: ${e instanceof Error ? e.message : e}`);
  }
  emailSettingsProbeCache = { at: Date.now(), available };
  return { available };
}

/** The user's global e-mail configuration (null = migration not applied). */
export async function getAutoBewerbEmailSettings(userId: string): Promise<AutoBewerbEmailSettings | null> {
  const probe = await getAutoBewerbEmailSettingsProbe();
  if (!probe.available) return null;
  const { data, error } = await createAdminClient()
    .from("auto_bewerb_email_templates")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();
  if (error || !data) return null;
  const r = data as Record<string, unknown>;
  return {
    body: String(r.body ?? ""),
    recipient: String(r.recipient ?? ""),
    subject: String(r.subject ?? ""),
    accountId: String(r.account_id ?? ""),
    attachCv: Boolean(r.attach_cv),
    attachLetter: Boolean(r.attach_letter),
  };
}

/** Persist the ONE global configuration (single upsert — one row per user). */
export async function saveAutoBewerbEmailSettings(
  userId: string,
  s: AutoBewerbEmailSettings,
): Promise<AutoBewerbOpResult> {
  if (!(await hasAutoBewerbSchema())) return fail("schema_pending", "AUTO BEWERB Datenbank wird vorbereitet.");
  const probe = await getAutoBewerbEmailSettingsProbe();
  if (!probe.available)
    return fail("storage_error", "E-Mail-Einstellungen: Datenbank-Migration ausstehend (20261217000000_auto_bewerb_email_settings.sql).");
  const { error } = await createAdminClient()
    .from("auto_bewerb_email_templates")
    .upsert(
      {
        user_id: userId,
        body: s.body.slice(0, 6_000),
        recipient: s.recipient.slice(0, 320),
        subject: s.subject.slice(0, 200),
        account_id: s.accountId || null,
        attach_cv: s.attachCv,
        attach_letter: s.attachLetter,
      },
      { onConflict: "user_id" },
    );
  if (error) return fail("storage_error", "E-Mail-Einstellungen konnten nicht gespeichert werden.");
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Step 7 — send preparation (immediate or scheduled)
// ---------------------------------------------------------------------------

export interface AutoBewerbScheduleInput {
  timeZone: string;
  year: number;
  month: number; // 1-12
  day: number;
  hour: number; // 0-23
  minute: number; // 0-59
}

export interface AutoBewerbSendInput {
  companyId: string;
  schedule?: AutoBewerbScheduleInput | null;
  /**
   * Everything else (recipient, subject, account, attachments, body) comes
   * from the ONE global e-mail configuration (Step 6) or, on databases
   * without the settings migration, from the legacy per-company values —
   * never from the client. The per-company DELIVERY destination is resolved
   * server-side from the verified data (global explicit recipient → legacy
   * manual recipient → the ad's extracted applicationEmail).
   */
}

export interface AutoBewerbSendResult {
  ok: boolean;
  code?: AutoBewerbErrorCode;
  message?: string;
  attemptId?: string;
  scheduledAt?: string | null;
  /** Set when an immediate send was dispatched inline. */
  dispatchStatus?: "sent" | "failed" | "queued" | "duplicate";
  failureCode?: string | null;
}

/** Fetch the user's profile letterhead facts (for the rendered PDFs). */
async function fetchProfileLetterhead(userId: string): Promise<Record<string, string | null | undefined>> {
  // NOTE: profiles is keyed by `id` (references auth.users) — NOT user_id
  // (the studio's `.eq("user_id", …)` query silently returns no row).
  const { data } = await createAdminClient()
    .from("profiles")
    .select("full_name, email, phone, street, postal_code, city, country")
    .eq("id", userId)
    .maybeSingle();
  return (data ?? {}) as Record<string, string | null | undefined>;
}

export async function prepareAutoBewerbSend(
  userId: string,
  input: AutoBewerbSendInput,
): Promise<AutoBewerbSendResult> {
  if (!(await hasAutoBewerbSchema()))
    return { ok: false, code: "schema_pending", message: "AUTO BEWERB Datenbank wird vorbereitet." };
  const admin = createAdminClient();

  const { data: appData, error: appError } = await admin
    .from("auto_bewerb_companies")
    .select("*")
    .eq("id", input.companyId)
    .eq("user_id", userId)
    .maybeSingle();
  if (appError || !appData) return { ok: false, code: "not_found", message: "Unternehmen nicht gefunden." };
  const app = revalidateCompanies([appData as unknown])[0];
  if (!app.approved)
    return { ok: false, code: "not_approved", message: "Bitte genehmigen Sie die Bewerbung zuerst." };
  if (app.status === "sent")
    return { ok: false, code: "already_sent", message: "Diese Bewerbung wurde bereits versendet." };
   // ONE global e-mail configuration for the whole batch (Step 6): subject,
   // body, sending account and attachment flags come EXCLUSIVELY from the
   // global settings — no company (and no client input) can override them.
   // The SAME shared template is used for every company; its supported
   // {{tokens}} are personalized per recipient from verified data (missing →
   // empty, never invented). Per-company: the DELIVERY destination (explicit
   // global recipient → legacy manual value → the ad's extracted
   // applicationEmail) and the CV/Anschreiben PDFs. Databases without the
   // settings migration keep the legacy per-company values (fallback).
  const settings = await getAutoBewerbEmailSettings(userId);
  let subject: string;
  let accountId: string;
  let attachCv: boolean;
  let attachLetter: boolean;
  let bodyText: string;
  const recipient = settings
    ? resolveAutoBewerbRecipient(settings.recipient, app.recipient_email, app.ad_extracted)
    : resolveAutoBewerbRecipient("", app.recipient_email, app.ad_extracted);
  if (settings) {
    bodyText = settings.body.trim();
    subject = settings.subject.trim().slice(0, 200);
    accountId = settings.accountId;
    attachCv = settings.attachCv;
    attachLetter = settings.attachLetter;
  } else {
    const template = await getAutoBewerbEmailTemplate(userId);
    bodyText = template.trim();
    subject = (app.email_subject ?? "").trim().slice(0, 200);
    accountId = app.email_account_id ?? "";
    attachCv = app.email_attach_cv;
    attachLetter = app.email_attach_letter;
  }
  if (!bodyText)
    return { ok: false, code: "no_template", message: "Es fehlt die gemeinsame E-Mail-Vorlage. Bitte zuerst eine Vorlage speichern." };
  if (!subject)
    return { ok: false, code: "no_subject", message: "Es fehlt der gemeinsame E-Mail-Betreff." };
  if (!isValidEmail(recipient))
    return { ok: false, code: "invalid_recipient", message: "Keine verifizierte Empfänger-Adresse für dieses Unternehmen gefunden." };

  // Email account: owned + active (createEmailProvider re-checks at send time).
  const { data: account } = await admin
    .from("email_accounts")
    .select("id")
    .eq("id", accountId)
    .eq("user_id", userId)
    .eq("is_active", true)
    .maybeSingle();
  if (!account)
    return { ok: false, code: "no_email_account", message: "Kein aktives E-Mail-Konto verbunden." };

  // Per-recipient personalization (Step 6): the SAME shared template is used
  // for every company, personalized at send time from VERIFIED data only.
  // Missing values render EMPTY — never a leftover placeholder, never invented.
  const pr = await fetchProfileLetterhead(userId);
  const candidateName = String(pr.full_name ?? "").trim();
  const contactPerson = String(app.ad_extracted?.contactPerson ?? "").trim();
  const companyName = String(app.ad_extracted?.company || app.company || "").trim();
  const position = String(app.ad_extracted?.jobTitle || app.ad_extracted?.occupation || "").trim();
  const greeting = buildAutoBewerbGreeting(contactPerson);
  const tokenValues: Record<string, string> = {
    candidate_name: candidateName,
    contact_person: contactPerson,
    company_name: companyName,
    greeting,
    position,
  };
  // Subject is plain text → substitute as-is.
  subject = substituteEmailTokens(subject, tokenValues).slice(0, 200);
  // Body is HTML → substitute HTML-ESCAPED values, then sanitize (defense in
  // depth: the stored body was already sanitized at save time).
  const payloadHtml = sanitizeEmailHtml(
    substituteEmailTokens(bodyText, {
      candidate_name: escapeHtml(candidateName),
      contact_person: escapeHtml(contactPerson),
      company_name: escapeHtml(companyName),
      greeting: escapeHtml(greeting),
      position: escapeHtml(position),
    }),
  );
  const payloadText = htmlToText(payloadHtml);

  // Attachments: the GLOBAL document library. Every owned document in the
  // user's library is attached to every application — the library is the
  // single source of truth, so no per-company selection exists (and no
  // client-supplied document ids are ever trusted). Ownership is re-scoped
  // server-side by user_id at send preparation time; the library's sha256
  // dedupe guarantees each document appears exactly once.
  const payloadAttachments: AutoBewerbSendPayload["attachments"] = [];
  // Never attach the same file twice (dedupe by the real storage path).
  const pushAttachment = (att: AutoBewerbSendPayload["attachments"][number]) => {
    if (!payloadAttachments.some((x) => x.storagePath === att.storagePath)) payloadAttachments.push(att);
  };
  const { data: libraryAtts } = await admin
    .from("auto_bewerb_attachments")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: true });
  for (const a of (libraryAtts ?? []) as unknown as AutoBewerbAttachmentRow[]) {
    pushAttachment({ filename: a.display_name, mimeType: a.mime_type, storagePath: a.storage_path });
  }

  // The tailored CV PDF — resolved STRICTLY from THIS company's own stored CV
  // (getLatestAutoBewerbCv(userId, app.id)), rendered locally and written to a
  // company-scoped storage path (auto-bewerb/cv/{userId}/{companyId}.pdf).
  // When the (global) "attach CV" flag is ON, a missing or unrenderable CV
  // BLOCKS this company's send preparation — the e-mail is never sent without
  // the document it promised, and another company's CV is never substituted.
  if (attachCv) {
    const cv = await getLatestAutoBewerbCv(userId, app.id);
    if (!cv)
      return {
        ok: false,
        code: "missing_cv",
        message: "Für dieses Unternehmen fehlt das maßgeschneiderte CV — bitte zuerst im Schritt 4 erstellen.",
      };
    let cvBytes: Uint8Array;
    try {
      // The sent PDF carries the SAME frozen photo the preview shows
      // (reference resolved ownership-scoped; missing → no photo).
      const photoDataUrl = await resolveAutoBewerbPhotoDataUrl(userId, cv.personal.photo);
      cvBytes = await generateCvPdf(cv, { photoDataUrl });
    } catch (error) {
      console.error("[auto-bewerb] CV PDF rendering failed:", error instanceof Error ? error.message : error);
      return { ok: false, code: "cv_render_failed", message: "Das CV-PDF für dieses Unternehmen konnte nicht erstellt werden." };
    }
    const cvPath = autoBewerbCvPdfStoragePath(userId, app.id);
    const { error: cvUploadError } = await admin
      .storage.from(ATTACHMENT_BUCKET)
      .upload(cvPath, Buffer.from(cvBytes), { contentType: BEW_LETTER_PDF_MIME, upsert: true });
    if (cvUploadError) {
      console.error(`[auto-bewerb] CV PDF upload failed for company ${app.id}: ${cvUploadError.message}`);
      return { ok: false, code: "cv_upload_failed", message: "Das CV-PDF für dieses Unternehmen konnte nicht gespeichert werden." };
    }
    pushAttachment({
      filename: cvPdfFilename(cv.personal.fullName),
      mimeType: BEW_LETTER_PDF_MIME,
      storagePath: cvPath,
    });
  }

  // The Anschreiben PDF — resolved STRICTLY from THIS company's own stored
  // letter (getLatestAutoBewerbDocument(userId, app.id, "cover_letter")),
  // rendered with the user's letterhead and written to a company-scoped
  // storage path (auto-bewerb/letter/{userId}/{companyId}.pdf). When the
  // (global) "attach cover letter" flag is ON, a missing or unrenderable
  // letter BLOCKS this company's send preparation.
  if (attachLetter) {
    const letterDoc = await getLatestAutoBewerbDocument(userId, app.id, "cover_letter");
    const letterParse = letterDoc ? autoBewerbLetterSchema.safeParse(letterDoc.content) : null;
    if (!letterParse?.success || !letterParse.data.text.trim())
      return {
        ok: false,
        code: "missing_letter",
        message: "Für dieses Unternehmen fehlt das individualisierte Anschreiben — bitte zuerst im Schritt 5 erstellen.",
      };
    let letterBytes: Uint8Array;
    try {
      // The genuine uploaded signature (if any) is embedded into the PDF —
      // a missing/unreadable image degrades to the verified name line only.
      const signatureImage = await getAutoBewerbSignatureImage(userId);
      const folio = buildLetterFolio({
        applicantName: pr.full_name ?? null,
        applicantEmail: pr.email ?? null,
        applicantStreet: pr.street ?? null,
        applicantPostalCode: pr.postal_code ?? null,
        applicantCity: pr.city ?? null,
        applicantCountry: pr.country ?? null,
        applicantPhone: pr.phone ?? null,
        companyName: app.ad_extracted?.company ?? app.company,
        companyContactName: app.ad_extracted?.contactPerson || null,
        companyAddress: app.ad_extracted?.companyAddress || null,
        subject: subject,
        bodyHtml: emailBodyToHtml(letterParse.data.text),
        signatureImage,
      });
      letterBytes = await generateLetterPdf(folio, { singlePage: true });
    } catch (error) {
      console.error("[auto-bewerb] letter PDF rendering failed:", error instanceof Error ? error.message : error);
      return { ok: false, code: "letter_render_failed", message: "Das Anschreiben-PDF für dieses Unternehmen konnte nicht erstellt werden." };
    }
    const letterPath = autoBewerbLetterPdfStoragePath(userId, app.id);
    const { error: letterUploadError } = await admin
      .storage.from(ATTACHMENT_BUCKET)
      .upload(letterPath, Buffer.from(letterBytes), { contentType: BEW_LETTER_PDF_MIME, upsert: true });
    if (letterUploadError) {
      console.error(`[auto-bewerb] letter PDF upload failed for company ${app.id}: ${letterUploadError.message}`);
      return { ok: false, code: "letter_upload_failed", message: "Das Anschreiben-PDF für dieses Unternehmen konnte nicht gespeichert werden." };
    }
    pushAttachment({
      filename: letterPdfFilename(app.ad_extracted?.company || app.company),
      mimeType: BEW_LETTER_PDF_MIME,
      storagePath: letterPath,
    });
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
    const deadline = parseAdDeadline(app.ad_extracted?.applicationDeadline ?? null);
    if (deadline !== null && utcMs > deadline)
      return { ok: false, code: "schedule_after_deadline", message: "Der geplante Versand liegt nach der Bewerbungsfrist." };
    scheduledAt = new Date(utcMs).toISOString();
    scheduleTz = input.schedule.timeZone;
  }

  const idempotencyKey = randomUUID();
  const payload: AutoBewerbSendPayload = {
    html: payloadHtml,
    text: payloadText,
    attachments: payloadAttachments,
  };

  // ATOMIC SEND-SLOT CLAIM (duplicate-send prevention, server-side): only ONE
  // concurrent prepare for this company can flip the status out of
  // {draft, ready, failed}; a losing racer (double click, two tabs, replayed
  // request) sees zero rows and must NOT create a second attempt.
  const { data: claimedRows } = await admin
    .from("auto_bewerb_companies")
    .update({
      // The RESOLVED per-company delivery destination (verified data only) —
      // the global subject/account/attachment flags document the ONE shared
      // configuration that produced this attempt.
      recipient_email: recipient,
      email_account_id: accountId,
      idempotency_key: idempotencyKey,
      email_subject: subject,
      // Legacy column: cleared on every send preparation — per-company body
      // overrides no longer exist (single source of truth = global template).
      email_body: null,
      email_attach_cv: attachCv,
      email_attach_letter: attachLetter,
      status: scheduledAt ? "scheduled" : "sending",
      scheduled_at: scheduledAt,
      schedule_timezone: scheduleTz,
      last_failure_code: null,
    })
    .eq("id", app.id)
    .eq("user_id", userId)
    .in("status", ["draft", "ready", "failed"])
    .select("id");
  if (!claimedRows || claimedRows.length === 0) {
    return { ok: false, code: "send_in_progress", message: "Es läuft bereits ein Versand für diese Bewerbung." };
  }

  const { data: attempt, error: attemptError } = await admin
    .from("auto_bewerb_send_attempts")
    .insert({
      company_id: app.id,
      user_id: userId,
      idempotency_key: idempotencyKey,
      recipient_email: recipient,
      subject,
      payload,
      status: "queued",
      scheduled_at: scheduledAt,
    })
    .select("*")
    .single();
  if (attemptError || !attempt) {
    // Release the claim so the user can retry (no orphan "sending" state).
    await patchCompany(userId, app.id, {
      status: "ready", idempotency_key: null, scheduled_at: null, schedule_timezone: null,
    });
    return { ok: false, code: "storage_error", message: "Versand konnte nicht vorbereitet werden." };
  }

  void logAutoBewerbActivity(
    userId,
    scheduledAt ? "auto_bewerb_send_scheduled" : "auto_bewerb_send_requested",
    scheduledAt ? "AUTO BEWERB: Versand geplant" : "AUTO BEWERB: Versand gestartet",
    undefined,
    { companyId: app.id, recipient, company: app.company },
  );

  // Immediate dispatch happens inline (server action context — same trust
  // boundary as every other send in this codebase).
  if (!scheduledAt) {
    const result = await dispatchAutoBewerbAttempt((attempt as unknown as AutoBewerbSendAttemptRow).id);
    return {
      ok: true,
      attemptId: (attempt as unknown as AutoBewerbSendAttemptRow).id,
      scheduledAt: null,
      dispatchStatus: result.duplicate ? "duplicate" : result.ok ? "sent" : "failed",
      failureCode: result.failureCode ?? null,
    };
  }
  return { ok: true, attemptId: (attempt as unknown as AutoBewerbSendAttemptRow).id, scheduledAt };
}

// ---------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------

export async function cancelAutoBewerbSend(
  userId: string,
  attemptId: string,
): Promise<AutoBewerbOpResult> {
  const admin = createAdminClient();
  const { data: attemptData } = await admin
    .from("auto_bewerb_send_attempts")
    .select("id, company_id, status")
    .eq("id", attemptId)
    .eq("user_id", userId)
    .maybeSingle();
  if (!attemptData) return fail("not_found", "Versand nicht gefunden.");
  const attempt = attemptData as { id: string; company_id: string; status: string };
  if (attempt.status !== "queued")
    return fail("not_cancellable", "Nur geplante (noch nicht laufende) Versände können abgebrochen werden.");
  const { error } = await admin
    .from("auto_bewerb_send_attempts")
    .update({ status: "cancelled" })
    .eq("id", attempt.id)
    .eq("user_id", userId);
  if (error) return fail("storage_error", "Abbrechen fehlgeschlagen.");
  await patchCompany(userId, attempt.company_id, {
    status: "ready",
    scheduled_at: null,
    schedule_timezone: null,
  });
  void logAutoBewerbActivity(userId, "auto_bewerb_send_cancelled", "AUTO BEWERB: Versand abgebrochen");
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Dispatch (the only place an AUTO BEWERB email can leave the building)
// ---------------------------------------------------------------------------

export interface AutoBewerbDispatchResult {
  ok: boolean;
  duplicate: boolean;
  status: "sent" | "failed" | "queued" | "skipped";
  failureCode?: string | null;
}

const backoffMs = (attempt: number): number => 2 * 60_000 * 2 ** (attempt - 1); // 2m, 4m, 8m

/**
 * Dispatch ONE send attempt. The ONLY code path that can send an AUTO
 * BEWERB email.
 *
 * Claim semantics: exactly one dispatcher may execute a given attempt.
 *  - `claimed: false` (inline / page-load path): an atomic
 *    `update … where status = 'queued'` is the claim; a zero-row result
 *    means another dispatcher won (duplicate).
 *  - `claimed: true` (cron path): the RPC `claim_due_auto_bewerb_attempts`
 *    already flipped the row to 'sending' under FOR UPDATE SKIP LOCKED and
 *    returned it to this worker exclusively — skip the inline claim.
 *
 * attempt_count is incremented EXACTLY ONCE per executed claim (inside the
 * claim update or right after the RPC claim) — never by the RPC itself — so
 * both paths count identically and the retry budget (3) cannot be bypassed
 * or double-consumed.
 */
export async function dispatchAutoBewerbAttempt(
  attemptId: string,
  opts: { claimed?: boolean } = {},
): Promise<AutoBewerbDispatchResult> {
  const admin = createAdminClient();

  const { data: attemptData } = await admin
    .from("auto_bewerb_send_attempts")
    .select("*")
    .eq("id", attemptId)
    .maybeSingle();
  if (!attemptData) return { ok: false, duplicate: false, status: "skipped" };
  const attempt = attemptData as unknown as AutoBewerbSendAttemptRow;
  if (attempt.status === "sent") return { ok: true, duplicate: true, status: "sent" };
  if (attempt.status === "cancelled" || attempt.status === "failed")
    return { ok: false, duplicate: false, status: "skipped" };

  // Re-check consent + company state at EXECUTION time (a scheduled send may
  // be hours old; the user could have reconnected a different mailbox). All
  // three failures are TERMINAL (no auto-retry): they only resolve by a new,
  // explicitly confirmed send.
  const { data: appData } = await admin
    .from("auto_bewerb_companies")
    .select("id, approved, email_account_id, status")
    .eq("id", attempt.company_id)
    .maybeSingle();
  if (!appData)
    return terminalAttempt(admin, attempt, "company_missing", "Unternehmen nicht mehr vorhanden.");
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
      .from("auto_bewerb_send_attempts")
      .update({ attempt_count: executedCount })
      .eq("id", attempt.id);
  } else {
    const { data: claimedRows } = await admin
      .from("auto_bewerb_send_attempts")
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
      .from("auto_bewerb_send_attempts")
      .update({ status: "sent", provider_message_id: result.providerMessageId, sent_at: sentAt, next_attempt_at: null })
      .eq("id", attempt.id);
    await admin
      .from("auto_bewerb_companies")
      .update({ status: "sent", sent_at: sentAt, provider_message_id: result.providerMessageId, last_failure_code: null })
      .eq("id", app.id);
    void logAutoBewerbActivity(attempt.user_id, "auto_bewerb_application_sent", "AUTO BEWERB: Bewerbung versendet", undefined, {
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
        .from("auto_bewerb_send_attempts")
        .update({
          status: "failed",
          failure_code: code,
          failure_message: message,
          next_attempt_at: null,
          attempt_count: executedCount,
        })
        .eq("id", attempt.id);
      await admin
        .from("auto_bewerb_companies")
        .update({ status: "failed", last_failure_code: code })
        .eq("id", app.id);
      void logAutoBewerbActivity(attempt.user_id, "auto_bewerb_send_failed", "AUTO BEWERB: Versand fehlgeschlagen", message, { code });
      return { ok: false, duplicate: false, status: "failed", failureCode: code };
    }
    // Temporary provider hiccup → retry with backoff. The row goes back to
    // 'queued'; the next dispatch re-validates consent + account first, and
    // the idempotent claim guarantees at most one execution at a time.
    const next = new Date(Date.now() + backoffMs(Math.max(1, executedCount))).toISOString();
    await admin
      .from("auto_bewerb_send_attempts")
      .update({ status: "queued", next_attempt_at: next, failure_code: code, failure_message: message, attempt_count: executedCount })
      .eq("id", attempt.id);
    void logAutoBewerbActivity(attempt.user_id, "auto_bewerb_send_retry", "AUTO BEWERB: Versand wird wiederholt", message, { code, next });
    return { ok: false, duplicate: false, status: "queued", failureCode: code };
  }
}

/** Terminal failure (no retry budget): pre-claim validation errors. */
async function terminalAttempt(
  admin: ReturnType<typeof createAdminClient>,
  attempt: AutoBewerbSendAttemptRow,
  code: string,
  message: string,
): Promise<AutoBewerbDispatchResult> {
  await admin
    .from("auto_bewerb_send_attempts")
    .update({ status: "failed", failure_code: code, failure_message: message, next_attempt_at: null })
    .eq("id", attempt.id);
  await admin
    .from("auto_bewerb_companies")
    .update({ status: "failed", last_failure_code: code })
    .eq("id", attempt.company_id);
  void logAutoBewerbActivity(attempt.user_id, "auto_bewerb_send_failed", "AUTO BEWERB: Versand nicht möglich", message, { code });
  return { ok: false, duplicate: false, status: "failed", failureCode: code };
}

// ---------------------------------------------------------------------------
// Scheduler entry points (cron + page-load catch-up)
// ---------------------------------------------------------------------------

export interface AutoBewerbSweepResult {
  recovered: number;
  claimed: number;
  results: AutoBewerbDispatchResult[];
}

/** Cron worker: recover stale rows, claim due attempts, dispatch each. */
export async function claimAndDispatchDueAutoBewerbAttempts(limit = 5, budgetMs = 45_000): Promise<AutoBewerbSweepResult> {
  const deadline = Date.now() + budgetMs;
  const admin = createAdminClient();
  const { data: recovered } = await admin.rpc("recover_stale_auto_bewerb_attempts");
  const recoveredCount = Number(recovered ?? 0) || 0;
  const { data: rows, error } = await admin.rpc("claim_due_auto_bewerb_attempts", { p_limit: limit });
  if (error || !Array.isArray(rows))
    return { recovered: recoveredCount, claimed: 0, results: [] };
  const results: AutoBewerbDispatchResult[] = [];
  for (const row of rows as Array<Pick<AutoBewerbSendAttemptRow, "id">>) {
    // Soft wall-clock budget: stop dispatching early; rows already flipped
    // to 'sending' by the claim RPC are recovered by the next tick's
    // recover_stale_auto_bewerb_attempts (durable Postgres state, no loss).
    if (Date.now() > deadline) break;
    // The RPC already flipped the row to 'sending' (exclusive claim), so
    // dispatch runs WITHOUT re-claiming — the attempt budget is still
    // enforced inside dispatch (attempt_count += 1 exactly once).
    results.push(await dispatchAutoBewerbAttempt(row.id, { claimed: true }));
    if (results.length >= 10) break;
  }
  return { recovered: recoveredCount, claimed: rows.length, results };
}

/** Best-effort page-load catch-up: process at most `limit` DUE attempts of
 *  the visiting user (server-side; the browser only triggers the re-check). */
export async function processDueAutoBewerbAttemptsForUser(userId: string, limit = 1): Promise<AutoBewerbSweepResult> {
  const admin = createAdminClient();
  const nowMs = Date.now();
  const due = (ts: string | null): boolean => ts === null || new Date(ts).getTime() <= nowMs;
  const { data: rows } = await admin
    .from("auto_bewerb_send_attempts")
    .select("id, scheduled_at, next_attempt_at")
    .eq("user_id", userId)
    .eq("status", "queued")
    .order("created_at", { ascending: true })
    .limit(10);
  const dueRows = ((rows ?? []) as Array<{ id: string; scheduled_at: string | null; next_attempt_at: string | null }>)
    .filter((r) => due(r.scheduled_at) && due(r.next_attempt_at))
    .slice(0, limit);
  const results: AutoBewerbDispatchResult[] = [];
  for (const row of dueRows) {
    results.push(await dispatchAutoBewerbAttempt(row.id));
  }
  return { recovered: 0, claimed: results.length, results };
}

// ---------------------------------------------------------------------------
// Audit trail (shared activity_logs table — best-effort, never breaks flow)
// ---------------------------------------------------------------------------

async function logAutoBewerbActivity(
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
    console.error("[auto-bewerb] activity log failed", error instanceof Error ? error.message : error);
  }
}

// ---------------------------------------------------------------------------
// Workspace view (the single server-side assembly for the page)
// ---------------------------------------------------------------------------

export type { AutoBewerbCompanyView, AutoBewerbWorkspace, AutoBewerbEmailAccount } from "./schema";
import type { AutoBewerbCompanyView, AutoBewerbWorkspace } from "./schema";

/**
 * The full AUTO BEWERB workspace in a bounded number of queries:
 * profile + template + accounts + library (4) and, when companies exist,
 * documents + selections + attempts in 3 bulk queries (never per company).
 */
export async function getAutoBewerbWorkspace(userId: string): Promise<AutoBewerbWorkspace> {
  const probe = await getAutoBewerbProbe();
  const ready = probe.missing.length === 0 && probe.blocked.length === 0;
  // "missing_tables" wins for the message when both classes occur: it is the
  // more actionable one (apply the migration), and a blocked probe on a
  // missing database is the same root cause anyway.
  const setupIssue: AutoBewerbWorkspace["setupIssue"] = !ready
    ? probe.missing.length > 0
      ? "missing_tables"
      : "probe_error"
    : null;
  const empty: AutoBewerbWorkspace = {
    ready,
    setupIssue,
    profile: null,
    photoSupported: false,
    photo: null,
    companies: [],
    attachments: [],
    emailTemplate: "",
    emailSettings: null,
    emailSettingsSupported: false,
    emailAccounts: [],
    candidateName: "",
  };
  if (!ready) return empty;

  const admin = createAdminClient();
  const [profileRow, templateRes, companies, attachments, emailAccounts, photoProbe, photoRow, settingsProbe, letterhead] =
    await Promise.all([
      getAutoBewerbProfile(userId),
      admin.from("auto_bewerb_email_templates").select("*").eq("user_id", userId).maybeSingle(),
      listAutoBewerbCompanies(userId),
      listAutoBewerbAttachments(userId),
      listUserEmailAccounts(userId),
      getAutoBewerbPhotoProbe(),
      getAutoBewerbProfilePhoto(userId),
      getAutoBewerbEmailSettingsProbe(),
      fetchProfileLetterhead(userId),
    ]);
  const photoSupported = photoProbe.available;
  const emailSettingsSupported = settingsProbe.available;
  const templateRow = (templateRes.data ?? null) as Record<string, unknown> | null;
  const emailTemplate = String(templateRow?.body ?? "");
  /** The ONE global e-mail configuration (supported → always an object;
   *  missing row = an empty configuration to fill in). */
  const emailSettings: AutoBewerbEmailSettings | null = emailSettingsSupported
    ? {
        body: emailTemplate,
        recipient: String(templateRow?.recipient ?? ""),
        subject: String(templateRow?.subject ?? ""),
        accountId: String(templateRow?.account_id ?? ""),
        attachCv: templateRow?.attach_cv === null || templateRow?.attach_cv === undefined ? true : Boolean(templateRow.attach_cv),
        attachLetter: templateRow?.attach_letter === null || templateRow?.attach_letter === undefined ? true : Boolean(templateRow.attach_letter),
      }
    : null;
  const photoExtByMime: Record<string, "jpg" | "png" | "webp"> = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
  };
  const photo =
    photoSupported && photoRow && photoExtByMime[photoRow.photo_mime_type]
      ? {
          ref: buildPhotoRef(photoRow.photo_hash, photoExtByMime[photoRow.photo_mime_type]),
          mime: photoRow.photo_mime_type,
          sizeBytes: photoRow.photo_size_bytes,
          uploadedAt: photoRow.uploaded_at,
        }
      : null;
  const ids = companies.map((c) => c.id);
  const [docsRes, attemptsRes] = ids.length
    ? await Promise.all([
        admin.from("auto_bewerb_documents").select("*").in("company_id", ids),
        admin.from("auto_bewerb_send_attempts").select("*").in("company_id", ids),
      ])
    : ([
        { data: null, error: null },
        { data: null, error: null },
      ] as const);

  const group = <T extends { company_id: string }>(rows: T[]): Map<string, T[]> => {
    const m = new Map<string, T[]>();
    for (const r of rows) {
      const list = m.get(r.company_id) ?? [];
      list.push(r);
      m.set(r.company_id, list);
    }
    return m;
  };
  const docsByCompany = group((docsRes.data ?? []) as unknown as AutoBewerbDocumentRow[]);
  const attemptsByCompany = group((attemptsRes.data ?? []) as unknown as AutoBewerbSendAttemptRow[]);

  const views: AutoBewerbCompanyView[] = companies.map((company) => {
    const docs = (docsByCompany.get(company.id) ?? []).sort((a, b) => b.version - a.version);
    const cvDoc = docs.find((d) => d.doc_type === "cv") ?? null;
    const letterDoc = docs.find((d) => d.doc_type === "cover_letter") ?? null;
    const cv = cvDoc ? sanitizeCvDocument(cvDoc.content) : null;
    const parsedLetter = letterDoc ? autoBewerbLetterSchema.safeParse(letterDoc.content) : null;
    const attempts = (attemptsByCompany.get(company.id) ?? []).sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
    return {
      company,
      cv,
      cvVersion: cvDoc ? cvDoc.version : null,
      // Exact per-company PDF filenames (the review UI shows these verbatim).
      // The FILENAME is the same applicant across companies; the CONTENT and
      // the company-scoped storage path differ per company.
      cvPdfName: cv ? cvPdfFilename(cv.personal.fullName) : null,
      letter: parsedLetter?.success
        ? { text: parsedLetter.data.text, tone: parsedLetter.data.tone }
        : null,
      letterVersion: letterDoc ? letterDoc.version : null,
      letterPdfName: parsedLetter?.success ? letterPdfFilename(company.ad_extracted?.company || company.company) : null,
      latestAttempt: attempts[0] ?? null,
    };
  });

  return {
    ready: true,
    setupIssue: null,
    profile: profileRow
      ? {
          fileName: profileRow.cv_file_name,
          mimeType: profileRow.cv_mime_type,
          sizeBytes: profileRow.cv_size_bytes,
          cvHash: profileRow.cv_hash,
          analyzedAt: profileRow.analyzed_at,
          extracted: profileRow.extracted,
        }
      : null,
    photoSupported,
    photo,
    companies: views,
    attachments,
    emailTemplate,
    emailSettings,
    emailSettingsSupported,
    emailAccounts,
    candidateName: String(letterhead.full_name ?? "").trim(),
  };
}
