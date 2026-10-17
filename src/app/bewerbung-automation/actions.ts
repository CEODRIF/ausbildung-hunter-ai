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
  attachBewDocument,
  cancelBewSend,
  createBewCampaign,
  detachBewDocument,
  excludeBewApplication,
  generateBewLetters,
  getBewCampaignView,
  listBewDocuments,
  restoreBewApplication,
  saveBewCompanies,
  setCampaignSender,
  startBewSend,
  updateBewApplicationFields,
  updateBewCampaignEmail,
  updateBewLetter,
} from "@/lib/bewerbung-engine";
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

type CompanyRecord = {
  companyName: string;
  companyEmail: string;
  contactName: string | null;
  companyAddress: string | null;
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
  const campaign = await createBewCampaign({ userId, count, purpose });
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
  });
  return await updateBewApplicationFields(userId, applicationId, {
    companyName: payload.companyName ?? "",
    companyEmail: payload.companyEmail ?? "",
    contactName: payload.contactName || null,
    companyAddress: payload.companyAddress || null,
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

/** Explicit, quota-aware send start (the ONLY enqueue entry point). */
export async function bewStartSend(
  formData: FormData,
): Promise<StartSendResult> {
  const { userId } = await requireUser();
  const campaignId = readString(formData, "campaignId");
  const selectedSeqs = readJson<number[]>(formData, "selectedSeqs", []);
  return await startBewSend(userId, campaignId, { selectedSeqs });
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
