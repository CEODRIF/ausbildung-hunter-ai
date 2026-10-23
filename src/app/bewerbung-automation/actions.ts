"use server";

/**
 * Bewerbung Automation — server actions.
 *
 * The ONLY bridge between the /bewerbung-automation client component and the
 * isolated `bew_*` engine. Every action re-authenticates (identity is NEVER
 * trusted from the client), then delegates to `@/lib/bewerbung-engine`, which
 * itself only reuses the existing safe sending/quota primitives and writes to
 * the feature's own tables. The protected standard-email, Email Verification
 * and Unsubscribe paths are not touched here.
 *
 * Errors are thrown with STABLE CODES (e.g. "INVALID_COUNT", "NO_SENDER") so
 * the client can map them to localized messages without leaking internals.
 */

import { redirect } from "next/navigation";
import { getCurrentUserAndProfile } from "@/lib/auth";
import type { Profile } from "@/lib/auth";
import {
  isBewPurpose,
  isDocumentKind,
  BEW_MAX_COUNT,
  type BewPurpose,
  type DocumentKind,
} from "@/lib/bewerbung-automation";
import {
  BEW_MAX_BATCH,
  addBewCompany,
  attachBewDocument,
  cancelBewSend,
  createBewCampaign,
  createBewCampaignView,
  detachBewDocument,
  excludeBewApplication,
  generateBewLetters,
  getBewCampaignView,
  listBewDocuments,
  processBewSendBatch,
  rescheduleBewSend,
  restoreBewApplication,
  saveBewCompanies,
  setBewCompanyCount,
  setCampaignSender,
  addBewCompanyRows,
  startBewSend,
  updateBewApplicationFields,
  updateBewCampaignEmail,
  updateBewLetter,
} from "@/lib/bewerbung-engine";
import {
  isSupportedTimezone,
  wallClockToUtc,
  type DstResolution,
} from "@/lib/schedule-time";
import { isNextRedirectError } from "@/components/bewerbung-automation/types";
import type {
  BewApplicationRow,
  BewCampaignView,
  CreateBewCampaignInput,
  StartSendResult,
} from "@/lib/bewerbung-engine";

/** Re-authenticate on every action; redirect unauthenticated callers. */
async function requireUser(): Promise<{ userId: string; profile: Profile }> {
  const { user, profile } = await getCurrentUserAndProfile();
  if (!user || !profile || profile.account_status !== "active")
    redirect("/login");
  return { userId: user.id, profile };
}

function readString(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === "string" ? value : "";
}

function readJson<T>(formData: FormData, key: string, fallback: T): T {
  const raw = readString(formData, key);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error("INVALID_PAYLOAD");
  }
}

/** A schedule must be at least this far in the future — anything closer is
 *  treated as "now" and rejected (the user should pick "Jetzt senden").
 *  Measured against the SERVER clock (the browser clock is never trusted). */
const BEW_MIN_FUTURE_MS = 60_000;

/**
 * Parse + validate an OPTIONAL schedule from the form (the same hidden
 * inputs the reused ScheduleForm posts: scheduleYear..scheduleTimezone +
 * dstResolution). Returns null when no schedule fields are present (an
 * IMMEDIATE send). The server clock is authoritative for "future"; the
 * wall-clock → UTC conversion is re-run here, exactly like the protected
 * engine's schedule action — the browser preview is never persisted.
 *
 * Throws STABLE codes (INVALID_TIMEZONE / INVALID_SCHEDULE / SCHEDULE_NOT_FUTURE)
 * so the client can map them to localized messages without leaking internals.
 */
function readScheduling(
  formData: FormData,
): { utcIso: string; timeZone: string } | null {
  const rawYear = formData.get("scheduleYear");
  const timeZone = String(formData.get("scheduleTimezone") ?? "");
  // No schedule fields => immediate send (the common path, unchanged).
  if (rawYear === null || rawYear === "" || !timeZone) return null;

  if (!isSupportedTimezone(timeZone)) throw new Error("INVALID_TIMEZONE");
  const year = Number(formData.get("scheduleYear"));
  const month = Number(formData.get("scheduleMonth"));
  const day = Number(formData.get("scheduleDay"));
  const hour = Number(formData.get("scheduleHour"));
  const minute = Number(formData.get("scheduleMinute"));
  const rawResolution = String(formData.get("dstResolution") ?? "");
  const resolution: DstResolution | null =
    rawResolution === "start" || rawResolution === "end"
      ? rawResolution
      : null;

  const result = wallClockToUtc(
    { year, month, day, hour, minute },
    timeZone,
    resolution,
  );
  if (!result.ok) throw new Error("INVALID_SCHEDULE");
  if (result.utcMs - Date.now() < BEW_MIN_FUTURE_MS)
    throw new Error("SCHEDULE_NOT_FUTURE");
  return { utcIso: result.utcIso, timeZone };
}

type CompanyRecord = {
  companyName: string;
  companyEmail: string;
  contactName: string | null;
  companyAddress: string | null;
  positionTitle: string;
  positionBrief: string;
  employerFacts: string;
};

/**
 * Every stable code this page can surface (engine + action level). These
 * are the ONLY messages that may cross the RSC→client boundary as an
 * error message — anything else is an internal failure and gets replaced.
 */
const BEW_KNOWN_CODES = new Set<string>([
  // engine
  "APPLICATION_LOCKED",
  "CAMPAIGN_CLOSED",
  "CAMPAIGN_FULL",
  "CANNOT_RESCHEDULE",
  "CAPACITY_EXCEEDED",
  "COUNT_EXCEEDED",
  "DELETE_FAILED",
  "DOC_ATTACH_FAILED",
  "DOC_SAVE_FAILED",
  "DOC_UPLOAD_FAILED",
  "DUPLICATE_COMPANY",
  "EMAIL_LOCKED",
  "INVALID_COUNT",
  "INVALID_KIND",
  "INVALID_PAYLOAD",
  "INVALID_PURPOSE",
  "NOT_FOUND",
  "PDF_REQUIRED",
  "POSITION_TOO_LONG",
   "PROFILE_INCOMPLETE",
   "QUOTA_EXHAUSTED",
   "AUTOMATION_DISABLED",
   "AUTOMATION_QUOTA_EXHAUSTED",
   "AUTOMATION_UNAVAILABLE",
   "RESCHEDULE_FAILED",
  "SAVE_FAILED",
  "SENDER_NOT_READY",
  // action level (scheduling / validation / send start)
  "INVALID_TIMEZONE",
  "INVALID_SCHEDULE",
  "SCHEDULE_NOT_FUTURE",
  "INVALID_RECORDS",
  "NO_SENDER",
  "NOTHING_TO_SEND",
  "QUEUE_FAILED",
  "CAMPAIGN_SENDING",
  "DOCUMENTS_MISSING",
  "EMAIL_INCOMPLETE",
  "CANDIDATE_NAME_MISSING",
  // smart-input (re-declared here for the shared guard)
  "EMPTY_INPUT",
  "PARSE_NO_COMPANY",
  "PARSE_NO_EMAIL",
  "PARSE_INVALID_EMAIL",
]);

/**
 * The single error boundary between this page's engine and the client —
 * the "no generic error" rule (the reported recurring
 * "Something went wrong. Please try again." came from errors that crossed
 * this boundary without it):
 *
 *   1. A re-authentication redirect PROPAGATES unchanged — the client
 *      navigates to /login (an expired session must never be shown as an
 *      operation failure);
 *   2. a KNOWN stable code is re-thrown as a CLEAN `Error(code)` — the
 *      code is the whole message, so even if the framework re-wraps the
 *      error in transit, the client recovers it from the message or the
 *      digest (see `bewErrorCode`) and localizes it;
 *   3. anything unexpected is logged server-side (internals — SQL text,
 *      paths, provider errors — NEVER reach the client) and replaced by
 *      the action's fallback code, which is always localized.
 */
async function withStableError<T>(
  action: string,
  fallback: string,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (isNextRedirectError(e)) throw e; // re-authentication — propagate
    const message = e instanceof Error ? e.message : "";
    if (message.startsWith("DOCUMENT_") || BEW_KNOWN_CODES.has(message)) {
      throw new Error(message);
    }
    console.error(`[bew] ${action}: unexpected failure`, message || String(e));
    throw new Error(fallback);
  }
}

/* ------------------------------ Step 0 ------------------------------ */

function readCampaignInput(
  userId: string,
  formData: FormData,
): CreateBewCampaignInput {
  const purpose = readString(formData, "purpose") as BewPurpose;
  if (!isBewPurpose(purpose)) throw new Error("INVALID_PURPOSE");
  return {
    userId,
    count: Number(readString(formData, "count")),
    purpose,
    positionTitle: readString(formData, "positionTitle"),
    positionBrief: readString(formData, "positionBrief"),
    employerFacts: readString(formData, "employerFacts"),
  };
}

/** Create a new campaign (validates the 1..100 count server-side). */
export async function bewCreateCampaign(
  formData: FormData,
): Promise<{ campaignId: string; count: number }> {
  const { userId } = await requireUser();
  const campaign = await createBewCampaign(readCampaignInput(userId, formData));
  return { campaignId: campaign.id, count: campaign.requested_count };
}

/**
 * Create a new campaign AND return its fresh view in ONE action (one
 * re-authentication, no follow-up `bewGetView` round trip). The client uses
 * this for "+ New series": the returned view is the confirmed, persisted
 * state of the brand-new campaign.
 */
export async function bewCreateCampaignView(
  formData: FormData,
): Promise<BewCampaignView> {
  const { userId } = await requireUser();
  return await createBewCampaignView(readCampaignInput(userId, formData));
}

/* ------------------------------ Step 1 ------------------------------ */

/** Save/replace the company records (manual entry or import). */
export async function bewSaveCompanies(
  formData: FormData,
): Promise<{ campaignId: string; total: number; valid: number; duplicates: string[] }> {
  const { userId } = await requireUser(); // redirect propagates when signed out
  const campaignId = readString(formData, "campaignId");
  return withStableError("bewSaveCompanies", "SAVE_FAILED", async () => {
    const records = readJson<CompanyRecord[]>(formData, "records", []);
    if (records.length > BEW_MAX_COUNT) throw new Error("INVALID_RECORDS");
    const { campaign, result } = await saveBewCompanies(
      userId,
      campaignId,
      records.map((r) => ({
        companyName: r.companyName ?? "",
        companyEmail: r.companyEmail ?? "",
        // Contract: optional fields are null (never empty strings) downstream.
        contactName: r.contactName || null,
        companyAddress: r.companyAddress || null,
        positionTitle: r.positionTitle ?? "",
        positionBrief: r.positionBrief ?? "",
        employerFacts: r.employerFacts ?? "",
      })),
    );
    return {
      campaignId: campaign.id,
      total: result.rows.length,
      valid: result.validCount,
      duplicates: result.duplicateEmails,
    };
  });
}

/** The smart-add result — a JSON-safe union, never a thrown raw error.
 *  NOTE: the campaign STATE is not among these — company entry is decoupled
 *  from the series lifecycle (a terminal series is reopened by receiving a
 *  row); CAMPAIGN_CLOSED / CAMPAIGN_SENDING still apply to the OTHER
 *  series-scoped operations. */
export type BewAddCompanyCode =
  | "INVALID_PAYLOAD"
  | "PARSE_NO_COMPANY"
  | "PARSE_NO_EMAIL"
  | "PARSE_INVALID_EMAIL"
  | "POSITION_TOO_LONG"
  | "DUPLICATE_COMPANY"
  | "COUNT_EXCEEDED"
  | "CAPACITY_EXCEEDED"
  | "NOT_FOUND"
  | "SAVE_FAILED";

export type BewAddCompanyResult =
  | { ok: true; row: BewApplicationRow }
  | { ok: false; code: BewAddCompanyCode };

const BEW_STABLE_ADD_CODES = new Set<string>([
  "INVALID_PAYLOAD",
  "PARSE_NO_COMPANY",
  "PARSE_NO_EMAIL",
  "PARSE_INVALID_EMAIL",
  "POSITION_TOO_LONG",
  "DUPLICATE_COMPANY",
  "COUNT_EXCEEDED",
  "CAPACITY_EXCEEDED",
  "NOT_FOUND",
  "SAVE_FAILED",
]);

/**
 * Add ONE company to the campaign from a pasted advertisement (the
 * smart-input "Auto-organize"). The pasted text is re-parsed and re-validated
 * SERVER-side — the client's live preview is advisory only, and the returned
 * row is the persisted truth the client appends to its list.
 *
 * Error contract — the two sources of the generic "Something went wrong"
 * are closed here:
 *   1. An expired/absent session STILL redirects to /login (the
 *      NEXT_REDIRECT error deliberately PROPAGATES, so the client
 *      re-authenticates instead of showing a misleading message);
 *   2. Every other failure RESOLVES with a stable code (a plain object —
 *      a thrown error can be re-wrapped by the framework and lose its code
 *      across the RSC→client boundary). Known engine codes pass through
 *      untouched; anything unexpected is mapped to SAVE_FAILED, so the UI
 *      always shows an actionable localized message and the user keeps
 *      their pasted text. `row` is set exactly when the insert persisted.
 */
export async function bewAddCompany(
  formData: FormData,
): Promise<BewAddCompanyResult> {
  const { userId } = await requireUser(); // redirect on purpose when signed out
  const campaignId = readString(formData, "campaignId");
  const text = readString(formData, "text");
  try {
    const row = await addBewCompany(userId, campaignId, text);
    return { ok: true, row };
  } catch (e) {
    const message = e instanceof Error ? e.message : "";
    const code: BewAddCompanyCode = BEW_STABLE_ADD_CODES.has(message)
      ? (message as BewAddCompanyCode)
      : "SAVE_FAILED";
    if (code === "SAVE_FAILED" && message) {
      // An unexpected (non-engine) failure: keep the internals server-side.
      console.error("[bew] bewAddCompany: unexpected failure", message);
    }
    return { ok: false, code };
  }
}

/**
 * Set the campaign's TARGET company count (requested_count). The rows are
 * untouched — the target is a goal the user fills manually or by import.
 * The server re-validates the 1..100 range (INVALID_COUNT) and enforces the
 * same locks as the other step-1 mutations (CAMPAIGN_CLOSED /
 * APPLICATION_LOCKED). Returns the server-confirmed value.
 */
export async function bewSetCompanyCount(
  formData: FormData,
): Promise<{ campaignId: string; requestedCount: number }> {
  const { userId } = await requireUser(); // redirect propagates when signed out
  const campaignId = readString(formData, "campaignId");
  const count = Number(readString(formData, "count"));
  const campaign = await withStableError("bewSetCompanyCount", "SAVE_FAILED", () =>
    setBewCompanyCount(userId, campaignId, count),
  );
  return { campaignId: campaign.id, requestedCount: campaign.requested_count };
}

/**
 * Add REAL empty company rows to the campaign (grows the series beyond the
 * seeded rows, up to the 100-per-campaign platform cap). The server
 * re-validates the batch (INVALID_COUNT), clamps it to the remaining room,
 * rejects a full campaign (CAMPAIGN_FULL) and enforces the same locks as
 * the other step-1 mutations (CAMPAIGN_CLOSED / APPLICATION_LOCKED).
 * Returns the server-confirmed numbers.
 */
export async function bewAddCompanyRows(
  formData: FormData,
): Promise<{ campaignId: string; added: number; total: number }> {
  const { userId } = await requireUser(); // redirect propagates when signed out
  const campaignId = readString(formData, "campaignId");
  const count = Number(readString(formData, "count"));
  const res = await withStableError("bewAddCompanyRows", "SAVE_FAILED", () =>
    addBewCompanyRows(userId, campaignId, count),
  );
  return { campaignId, ...res };
}

/**
 * Edit a single company row (invalidates a stale generated letter).
 * A missing / stale / foreign entry id is a NOT_FOUND failure (never a
 * silent null "success" — the client rolls the edit back and shows the
 * localized message).
 */
export async function bewUpdateCompany(
  formData: FormData,
): Promise<BewApplicationRow> {
  const { userId } = await requireUser(); // redirect propagates when signed out
  const applicationId = readString(formData, "applicationId");
  const row = await withStableError("bewUpdateCompany", "SAVE_FAILED", async () => {
    const payload = readJson<CompanyRecord>(formData, "payload", {
      companyName: "",
      companyEmail: "",
      contactName: null,
      companyAddress: null,
      positionTitle: "",
      positionBrief: "",
      employerFacts: "",
    });
    const updated = await updateBewApplicationFields(userId, applicationId, {
      companyName: payload.companyName ?? "",
      companyEmail: payload.companyEmail ?? "",
      contactName: payload.contactName || null,
      companyAddress: payload.companyAddress || null,
      positionTitle: payload.positionTitle ?? "",
      positionBrief: payload.positionBrief ?? "",
      employerFacts: payload.employerFacts ?? "",
    });
    if (!updated) throw new Error("NOT_FOUND");
    return updated;
  });
  return row;
}

/**
 * Save the campaign-level e-mail message (subject + HTML body) — the
 * message that actually goes out. The per-company Anschreiben (and its
 * PDF) is a separate attachment and is NOT touched by this action.
 * Locked while a send is in flight (EMAIL_LOCKED) and in terminal states
 * (CAMPAIGN_CLOSED); the body is server-sanitized.
 */
export async function bewSaveEmail(formData: FormData): Promise<{ ok: true }> {
  const { userId } = await requireUser(); // redirect propagates when signed out
  const campaignId = readString(formData, "campaignId");
  const subject = readString(formData, "subject");
  const bodyHtml = readString(formData, "bodyHtml");
  await withStableError("bewSaveEmail", "SAVE_FAILED", () =>
    updateBewCampaignEmail(userId, campaignId, { subject, bodyHtml }),
  );
  return { ok: true };
}

  /* ------------------------------ Step 2 ------------------------------ */

// NOTE: the two File-carrying operations are ROUTE HANDLERS, not server
// actions — server actions cap the request body at 1 MB by default while
// documents/PDFs may be 10 MB (the original `bewUploadDocument` action
// failed exactly that way: a small CV passed, a certificate 413'd in the
// framework layer). See /api/bew/documents and /api/bew/companies-pdf.

/** Attach a library document to the campaign (shared by all applications). */
export async function bewAttachDocument(
  formData: FormData,
): Promise<{ ok: true }> {
  const { userId } = await requireUser(); // redirect propagates when signed out
  const campaignId = readString(formData, "campaignId");
  const documentId = readString(formData, "documentId");
  const kind = readString(formData, "kind") as DocumentKind;
  if (!isDocumentKind(kind)) throw new Error("INVALID_KIND");
  await withStableError("bewAttachDocument", "SAVE_FAILED", () =>
    attachBewDocument(userId, campaignId, documentId, kind),
  );
  return { ok: true };
}

/** Detach a document from the campaign (the user's file is kept). */
export async function bewDetachDocument(
  formData: FormData,
): Promise<{ ok: true }> {
  const { userId } = await requireUser(); // redirect propagates when signed out
  const campaignId = readString(formData, "campaignId");
  const documentId = readString(formData, "documentId");
  await withStableError("bewDetachDocument", "SAVE_FAILED", () =>
    detachBewDocument(userId, campaignId, documentId),
  );
  return { ok: true };
}

/** The user's document library (for the upload/attach picker). */
export async function bewListDocuments(): Promise<
  Array<{ id: string; filename: string; kind: string; sizeBytes: number }>
> {
  const { userId } = await requireUser(); // redirect propagates when signed out
  const docs = await withStableError("bewListDocuments", "SAVE_FAILED", () =>
    listBewDocuments(userId),
  );
  return docs.map((d) => ({
    id: d.id,
    filename: d.filename,
    kind: d.kind,
    sizeBytes: d.size_bytes,
  }));
}

/** (Re)assign the sending e-mail account to the campaign. */
export async function bewSetSender(
  formData: FormData,
): Promise<{ ok: true }> {
  const { userId } = await requireUser(); // redirect propagates when signed out
  const campaignId = readString(formData, "campaignId");
  const accountId = readString(formData, "accountId");
  await withStableError("bewSetSender", "SAVE_FAILED", () =>
    setCampaignSender(userId, campaignId, accountId),
  );
  return { ok: true };
}

/* ------------------------------ Step 3 ------------------------------ */

/** Generate distinct Anschreiben (bounded; onlyFailed = safe retry path). */
export async function bewGenerateLetters(
  formData: FormData,
): Promise<{
  generated: number;
  failed: number;
  remaining: number;
  aiQuotaHit: boolean;
}> {
  const { userId, profile } = await requireUser(); // redirect propagates when signed out
  const campaignId = readString(formData, "campaignId");
  const onlyFailed = readString(formData, "onlyFailed") === "1";
  return await withStableError("bewGenerateLetters", "SAVE_FAILED", () =>
    generateBewLetters(userId, campaignId, profile, { onlyFailed }),
  );
}

/* ------------------------------ Step 4 ------------------------------ */

/**
 * Edit a letter (subject + HTML body) before sending.
 * A missing / stale / foreign entry id is a NOT_FOUND failure (never a
 * silent null "success" — the letter editor must keep the draft and show
 * the localized message instead of closing as if saved).
 */
export async function bewUpdateLetter(
  formData: FormData,
): Promise<BewApplicationRow> {
  const { userId } = await requireUser(); // redirect propagates when signed out
  const applicationId = readString(formData, "applicationId");
  const subject = readString(formData, "subject");
  const bodyHtml = readString(formData, "bodyHtml");
  const row = await withStableError("bewUpdateLetter", "SAVE_FAILED", async () => {
    const updated = await updateBewLetter(userId, applicationId, { subject, bodyHtml });
    if (!updated) throw new Error("NOT_FOUND");
    return updated;
  });
  return row;
}

/** The stable codes the exclusion can fail with (never a raw/internal error). */
export type BewExcludeApplicationCode =
  | "NOT_FOUND"
  | "APPLICATION_LOCKED"
  | "DELETE_FAILED";

export type BewExcludeApplicationResult =
  | { ok: true }
  | { ok: false; code: BewExcludeApplicationCode };

const BEW_STABLE_EXCLUDE_CODES = new Set<string>([
  "NOT_FOUND",
  "APPLICATION_LOCKED",
  "DELETE_FAILED",
]);

/**
 * Exclude (soft-delete) ONE company row — the red X on step 1.
 *
 * Error contract — the same "no generic error" rules as `bewAddCompany`,
 * because the previous version of this action had exactly two generic-error
 * holes (the reported "Something went wrong. Please try again." on delete):
 *   1. An expired/absent session STILL redirects to /login (the
 *      NEXT_REDIRECT error deliberately PROPAGATES, so the client
 *      re-authenticates instead of swallowing the redirect into
 *      err.UNKNOWN — the same bug class the smart-input flow already
 *      received a fix for);
 *   2. Every other failure RESOLVES with a stable code (a plain object —
 *      a thrown error can be re-wrapped by the framework and lose its code
 *      across the RSC→client boundary):
 *        - NOT_FOUND          — the id is missing, stale or another
 *                               user's (ownership: the engine query is
 *                               user_id-scoped, so a foreign id is
 *                               indistinguishable from a vanished one and
 *                               yields no data leak);
 *        - APPLICATION_LOCKED — the row is in flight (queued/sending);
 *                               `sent` is terminal and can be excluded;
 *        - DELETE_FAILED      — an unexpected persistence failure (the
 *                               internals are logged server-side only).
 *
 * `ok` is true EXACTLY when the exclusion persisted. The previous version
 * ignored the engine's null result, so a missing/stale id was reported as a
 * success: the UI hid the row while nothing was deleted server-side (the row
 * then "came back" on the next refresh).
 */
export async function bewExcludeApplication(
  formData: FormData,
): Promise<BewExcludeApplicationResult> {
  const { userId } = await requireUser(); // redirect on purpose when signed out
  const applicationId = readString(formData, "applicationId");
  try {
    const row = await excludeBewApplication(userId, applicationId);
    if (!row) return { ok: false, code: "NOT_FOUND" };
    return { ok: true };
  } catch (e) {
    // A re-authentication request must never be mapped into a delete error —
    // propagate it so the client navigates to /login.
    if (isNextRedirectError(e)) throw e;
    const message = e instanceof Error ? e.message : "";
    const code: BewExcludeApplicationCode = BEW_STABLE_EXCLUDE_CODES.has(message)
      ? (message as BewExcludeApplicationCode)
      : "DELETE_FAILED";
    if (code === "DELETE_FAILED" && message) {
      // An unexpected (non-engine) failure: keep the internals server-side.
      console.error("[bew] bewExcludeApplication: unexpected failure", message);
    }
    return { ok: false, code };
  }
}

/**
 * Restore a previously excluded application (keeps its letter if complete).
 * The restored row is the confirmation — a missing / stale / foreign id
 * resolves as a NOT_FOUND failure, never as a fake success (the previous
 * version ignored the engine's null and reported `ok: true` when nothing
 * was restored).
 */
export async function bewRestoreApplication(
  formData: FormData,
): Promise<{ ok: true; restored: boolean }> {
  const { userId } = await requireUser(); // redirect propagates when signed out
  const applicationId = readString(formData, "applicationId");
  const restored = await withStableError("bewRestoreApplication", "SAVE_FAILED", async () => {
    const row = await restoreBewApplication(userId, applicationId);
    if (!row) return false; // NOT_FOUND — surfaced below, never a fake success
    return true;
  });
  if (!restored) throw new Error("NOT_FOUND");
  return { ok: true, restored: true };
}

/* ------------------------------ Step 5 ------------------------------ */

/** Explicit, quota-aware send start (the ONLY enqueue entry point).
 *  Optional schedule fields (from the reused ScheduleForm) turn this into a
 *  SCHEDULED send; without them the argument shape is unchanged (immediate). */
export async function bewStartSend(
  formData: FormData,
): Promise<StartSendResult> {
  const { userId } = await requireUser(); // redirect propagates when signed out
  const campaignId = readString(formData, "campaignId");
  const selectedSeqs = readJson<number[]>(formData, "selectedSeqs", []);
  const scheduling = readScheduling(formData); // stable schedule codes
  return withStableError("bewStartSend", "QUEUE_FAILED", () =>
    startBewSend(userId, campaignId, {
      selectedSeqs,
      ...(scheduling ? { scheduling } : {}),
    }),
  );
}

/** Reschedule a PENDING scheduled batch to a new future instant. */
export async function bewRescheduleSend(
  formData: FormData,
): Promise<{ ok: true }> {
  const { userId } = await requireUser(); // redirect propagates when signed out
  const campaignId = readString(formData, "campaignId");
  const scheduling = readScheduling(formData);
  if (!scheduling) throw new Error("INVALID_SCHEDULE");
  return withStableError("bewRescheduleSend", "SAVE_FAILED", () =>
    rescheduleBewSend(userId, campaignId, scheduling),
  );
}

/** Cancel all queued (not-yet-sent) applications; releases their quota. */
export async function bewCancelSend(
  formData: FormData,
): Promise<{ cancelled: number }> {
  const { userId } = await requireUser(); // redirect propagates when signed out
  const campaignId = readString(formData, "campaignId");
  return withStableError("bewCancelSend", "SAVE_FAILED", () =>
    cancelBewSend(userId, campaignId),
  );
}

/* ------------------------------ Read (poll) ------------------------------ */

/** Fresh campaign view (used by the client to poll progress). */
export async function bewGetView(
  campaignId: string,
): Promise<BewCampaignView | null> {
  const { userId } = await requireUser();
  return await getBewCampaignView(userId, campaignId);
}

/**
 * Refresh the campaign status AND continue any send whose time has come.
 *
 * Server action behind the step-5 Refresh button and the live send poll. It
 * re-authenticates, then:
 *
 *   1. runs ONE bounded drain of THIS campaign through the SAME atomic claim
 *      core the cron tick uses (processBewSendBatch): queued rows are only
 *      claimable at/after their due instant, so a still-pending scheduled
 *      batch sends NOTHING, a due batch drains ≤ BEW_MAX_BATCH messages, and
 *      overlapping drivers (browser + cron + worker) can never double-send
 *      (FOR UPDATE SKIP LOCKED);
 *   2. returns the FRESH persisted view (status, queued/sent/failed counts,
 *      current schedule) — the UI renders server truth only.
 *
 * This is the browser's continuation driver (the docs' "second, idempotent
 * driver"): with the Actions cron running at an irregular cadence, a due
 * scheduled batch is released at the due instant as soon as the user's page
 * is active, instead of waiting for the next tick. It is NOT a scheduler —
 * no timer fires it; the existing 3 s poll (while a send is in flight) and
 * the explicit Refresh click do.
 *
 * A drain failure is NEVER fatal: it is logged (message only — no
 * recipients, no secrets) and the fresh view is returned anyway, so a
 * transient provider hiccup cannot freeze the status panel. Ownership is
 * enforced by processBewSendBatch AND getBewCampaignView (both scope on the
 * authenticated user_id): a foreign campaign id drains nothing and yields no
 * view (null).
 */
export async function bewRefreshSend(
  campaignId: string,
): Promise<BewCampaignView | null> {
  const { userId } = await requireUser();
  try {
    await processBewSendBatch(userId, campaignId, BEW_MAX_BATCH);
  } catch (err) {
    console.error(
      "[bew] bewRefreshSend: drain failed (view still refreshed)",
      err instanceof Error ? err.message : "unknown error",
    );
  }
  return await getBewCampaignView(userId, campaignId);
}
