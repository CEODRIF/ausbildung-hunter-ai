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
  attachBewDocument,
  cancelBewSend,
  createBewCampaign,
  detachBewDocument,
  excludeBewApplication,
  generateBewLetters,
  getBewCampaignView,
  listBewDocuments,
  processBewSendBatch,
  rescheduleBewSend,
  restoreBewApplication,
  saveBewCompanies,
  setCampaignSender,
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
import type {
  BewApplicationRow,
  BewCampaignView,
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

/* ------------------------------ Step 0 ------------------------------ */

/** Create a new campaign (validates the 1..100 count server-side). */
export async function bewCreateCampaign(
  formData: FormData,
): Promise<{ campaignId: string; count: number }> {
  const { userId } = await requireUser();
  const count = Number(readString(formData, "count"));
  const purpose = readString(formData, "purpose") as BewPurpose;
  if (!isBewPurpose(purpose)) throw new Error("INVALID_PURPOSE");
  const campaign = await createBewCampaign({
    userId,
    count,
    purpose,
    positionTitle: readString(formData, "positionTitle"),
    positionBrief: readString(formData, "positionBrief"),
    employerFacts: readString(formData, "employerFacts"),
  });
  return { campaignId: campaign.id, count: campaign.requested_count };
}

/* ------------------------------ Step 1 ------------------------------ */

/** Save/replace the company records (manual entry or import). */
export async function bewSaveCompanies(
  formData: FormData,
): Promise<{ campaignId: string; total: number; valid: number; duplicates: string[] }> {
  const { userId } = await requireUser();
  const campaignId = readString(formData, "campaignId");
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
}

/** Edit a single company row (invalidates a stale generated letter). */
export async function bewUpdateCompany(
  formData: FormData,
): Promise<BewApplicationRow | null> {
  const { userId } = await requireUser();
  const applicationId = readString(formData, "applicationId");
  const payload = readJson<CompanyRecord>(formData, "payload", {
    companyName: "",
    companyEmail: "",
    contactName: null,
    companyAddress: null,
    positionTitle: "",
    positionBrief: "",
    employerFacts: "",
  });
  return await updateBewApplicationFields(userId, applicationId, {
    companyName: payload.companyName ?? "",
    companyEmail: payload.companyEmail ?? "",
    contactName: payload.contactName || null,
    companyAddress: payload.companyAddress || null,
    positionTitle: payload.positionTitle ?? "",
    positionBrief: payload.positionBrief ?? "",
    employerFacts: payload.employerFacts ?? "",
  });
}

/**
 * Save the campaign-level e-mail message (subject + HTML body) — the
 * message that actually goes out. The per-company Anschreiben (and its
 * PDF) is a separate attachment and is NOT touched by this action.
 * Locked while a send is in flight (EMAIL_LOCKED) and in terminal states
 * (CAMPAIGN_CLOSED); the body is server-sanitized.
 */
export async function bewSaveEmail(formData: FormData): Promise<{ ok: true }> {
  const { userId } = await requireUser();
  const campaignId = readString(formData, "campaignId");
  const subject = readString(formData, "subject");
  const bodyHtml = readString(formData, "bodyHtml");
  await updateBewCampaignEmail(userId, campaignId, { subject, bodyHtml });
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
  const { userId } = await requireUser();
  const campaignId = readString(formData, "campaignId");
  const documentId = readString(formData, "documentId");
  const kind = readString(formData, "kind") as DocumentKind;
  if (!isDocumentKind(kind)) throw new Error("INVALID_KIND");
  await attachBewDocument(userId, campaignId, documentId, kind);
  return { ok: true };
}

/** Detach a document from the campaign (the user's file is kept). */
export async function bewDetachDocument(
  formData: FormData,
): Promise<{ ok: true }> {
  const { userId } = await requireUser();
  const campaignId = readString(formData, "campaignId");
  const documentId = readString(formData, "documentId");
  await detachBewDocument(userId, campaignId, documentId);
  return { ok: true };
}

/** The user's document library (for the upload/attach picker). */
export async function bewListDocuments(): Promise<
  Array<{ id: string; filename: string; kind: string; sizeBytes: number }>
> {
  const { userId } = await requireUser();
  const docs = await listBewDocuments(userId);
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
  const { userId } = await requireUser();
  const campaignId = readString(formData, "campaignId");
  const accountId = readString(formData, "accountId");
  await setCampaignSender(userId, campaignId, accountId);
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
  const { userId, profile } = await requireUser();
  const campaignId = readString(formData, "campaignId");
  const onlyFailed = readString(formData, "onlyFailed") === "1";
  return await generateBewLetters(userId, campaignId, profile, { onlyFailed });
}

/* ------------------------------ Step 4 ------------------------------ */

/** Edit a letter (subject + HTML body) before sending. */
export async function bewUpdateLetter(
  formData: FormData,
): Promise<BewApplicationRow | null> {
  const { userId } = await requireUser();
  const applicationId = readString(formData, "applicationId");
  const subject = readString(formData, "subject");
  const bodyHtml = readString(formData, "bodyHtml");
  return await updateBewLetter(userId, applicationId, { subject, bodyHtml });
}

/** Exclude an application from the campaign. */
export async function bewExcludeApplication(
  formData: FormData,
): Promise<{ ok: true }> {
  const { userId } = await requireUser();
  const applicationId = readString(formData, "applicationId");
  await excludeBewApplication(userId, applicationId);
  return { ok: true };
}

/** Restore a previously excluded application (keeps its letter if complete). */
export async function bewRestoreApplication(
  formData: FormData,
): Promise<{ ok: true }> {
  const { userId } = await requireUser();
  const applicationId = readString(formData, "applicationId");
  await restoreBewApplication(userId, applicationId);
  return { ok: true };
}

/* ------------------------------ Step 5 ------------------------------ */

/** Explicit, quota-aware send start (the ONLY enqueue entry point).
 *  Optional schedule fields (from the reused ScheduleForm) turn this into a
 *  SCHEDULED send; without them the argument shape is unchanged (immediate). */
export async function bewStartSend(
  formData: FormData,
): Promise<StartSendResult> {
  const { userId } = await requireUser();
  const campaignId = readString(formData, "campaignId");
  const selectedSeqs = readJson<number[]>(formData, "selectedSeqs", []);
  const scheduling = readScheduling(formData);
  return await startBewSend(userId, campaignId, {
    selectedSeqs,
    ...(scheduling ? { scheduling } : {}),
  });
}

/** Reschedule a PENDING scheduled batch to a new future instant. */
export async function bewRescheduleSend(
  formData: FormData,
): Promise<{ ok: true }> {
  const { userId } = await requireUser();
  const campaignId = readString(formData, "campaignId");
  const scheduling = readScheduling(formData);
  if (!scheduling) throw new Error("INVALID_SCHEDULE");
  return await rescheduleBewSend(userId, campaignId, scheduling);
}

/** Cancel all queued (not-yet-sent) applications; releases their quota. */
export async function bewCancelSend(
  formData: FormData,
): Promise<{ cancelled: number }> {
  const { userId } = await requireUser();
  const campaignId = readString(formData, "campaignId");
  return await cancelBewSend(userId, campaignId);
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
