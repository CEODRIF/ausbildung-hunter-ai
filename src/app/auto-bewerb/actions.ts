"use server";

import { getCurrentUserAndProfile } from "@/lib/auth";
import type { CandidateProfile } from "@/lib/bewerbung-schema";
import {
  approveAutoBewerbCompany,
  cancelAutoBewerbSend,
  createAutoBewerbCompany,
  deleteAutoBewerbCompany,
  deleteAutoBewerbProfile,
  getAutoBewerbWorkspace,
  markAutoBewerbAdConfirmed,
  prepareAutoBewerbSend,
  processDueAutoBewerbAttemptsForUser,
  saveAutoBewerbDocument,
  saveAutoBewerbEmailTemplate,
  saveAutoBewerbProfile,
  updateAutoBewerbCompany,
  updateAutoBewerbProfileExtract,
  type AutoBewerbCompanyPatch,
  type AutoBewerbDocType,
  type AutoBewerbScheduleInput,
  type AutoBewerbSendResult,
} from "@/lib/auto-bewerb/engine";
import type { AdAnalysis, AdExtract, AutoBewerbCompanyRow } from "@/lib/auto-bewerb/schema";

/**
 * AUTO BEWERB — server actions.
 *
 * Every action re-resolves the authenticated user from the session (never
 * from arguments) and works through the ownership-checked engine. Paid AI
 * operations live in the /api/auto-bewerb/* routes (client fetch + quota /
 * rate-limit responses); these actions cover the durable state transitions:
 * profile, companies, documents, template, approve,
 * send, cancel — plus the page-load catch-up for due scheduled sends.
 */

type ActionResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: string; message: string };

function unauthorized(): ActionResult<never> {
  return { ok: false, code: "unauthorized", message: "unauthorized" };
}

function toResult(
  op: { ok: boolean; value?: unknown; code?: string; message?: string },
): ActionResult<unknown> {
  if (ok(op)) return { ok: true, value: (op.value ?? null) as never };
  return { ok: false, code: op.code ?? "error", message: op.message ?? "Operation fehlgeschlagen." };
}

function ok(op: { ok: boolean }): op is { ok: true; value?: unknown } {
  return op.ok === true;
}

/** Re-read the whole workspace (single bounded server assembly). Used after
 *  any durable change so the client never drifts from the database. Runs the
 *  best-effort catch-up for DUE scheduled sends first (idempotent; never
 *  sends before a schedule). */
export async function refreshWorkspaceAction(): Promise<
  | { ok: true; value: Awaited<ReturnType<typeof getAutoBewerbWorkspace>> }
  | { ok: false; code: string; message: string }
> {
  const { user } = await getCurrentUserAndProfile();
  if (!user) return unauthorized();
  await processDueAutoBewerbAttemptsForUser(user.id, 1);
  const workspace = await getAutoBewerbWorkspace(user.id);
  return { ok: true, value: workspace };
}

// ---------------------------------------------------------------------------
// Step 1 — profile (extracted data review / correction)
// ---------------------------------------------------------------------------

/** Persist the user's CORRECTIONS of the analyzed profile (file untouched). */
export async function saveProfileExtractAction(
  extracted: CandidateProfile,
): Promise<ActionResult<{ ok: true }>> {
  const { user } = await getCurrentUserAndProfile();
  if (!user) return unauthorized();
  const res = await updateAutoBewerbProfileExtract(user.id, extracted);
  return toResult(res) as ActionResult<{ ok: true }>;
}

/** Remove the CV profile entirely (the user starts step 1 over). */
export async function deleteProfileAction(): Promise<ActionResult<{ ok: true }>> {
  const { user } = await getCurrentUserAndProfile();
  if (!user) return unauthorized();
  return toResult(await deleteAutoBewerbProfile(user.id)) as ActionResult<{ ok: true }>;
}

/** Persist a fresh analyzed profile + the uploaded CV file (the cv-analyze
 *  route calls the engine directly; this action exists for completeness and
 *  tests — the upload path is the normal one). */
export async function replaceProfileAction(input: {
  cvFileName: string;
  cvMime: string;
  cvSizeBytes: number;
  cvStoragePath: string;
  cvHash: string;
  extracted: CandidateProfile;
}): Promise<ActionResult<{ ok: true }>> {
  const { user } = await getCurrentUserAndProfile();
  if (!user) return unauthorized();
  return toResult(
    await saveAutoBewerbProfile(user.id, {
      cvFileName: input.cvFileName,
      cvMime: input.cvMime,
      cvSizeBytes: input.cvSizeBytes,
      cvStoragePath: input.cvStoragePath,
      cvHash: input.cvHash,
      extracted: input.extracted,
    }),
  ) as ActionResult<{ ok: true }>;
}

// ---------------------------------------------------------------------------
// Step 2 — companies
// ---------------------------------------------------------------------------

export async function addCompanyAction(input: {
  adRaw: string;
  company?: string | null;
  extract?: AdExtract | null;
  analysis?: AdAnalysis | null;
  profileHash?: string | null;
}): Promise<ActionResult<AutoBewerbCompanyRow>> {
  const { user } = await getCurrentUserAndProfile();
  if (!user) return unauthorized();
  if (!input.adRaw || input.adRaw.trim().length < 40) {
    return { ok: false, code: "invalid_ad_text", message: "invalid_ad_text" };
  }
  const res = await createAutoBewerbCompany(user.id, {
    adRaw: input.adRaw,
    company: input.company ?? null,
    extract: input.extract ?? null,
    analysis: input.analysis ?? null,
    profileSnapshot: input.profileHash ? { cvHash: input.profileHash } : null,
  });
  return toResult(res) as ActionResult<AutoBewerbCompanyRow>;
}

export async function updateCompanyAction(
  companyId: string,
  patch: {
    company?: string;
    adRaw?: string;
    extract?: AdExtract | null;
    analysis?: AdAnalysis | null;
    recipientEmail?: string | null;
    emailSubject?: string | null;
    emailBody?: string | null;
    emailAttachCv?: boolean;
    emailAttachLetter?: boolean;
    emailAccountId?: string | null;
  },
): Promise<ActionResult<AutoBewerbCompanyRow>> {
  const { user } = await getCurrentUserAndProfile();
  if (!user) return unauthorized();
  const dbPatch: AutoBewerbCompanyPatch = {};
  if (patch.company !== undefined) dbPatch.company = patch.company;
  if (patch.adRaw !== undefined) dbPatch.ad_raw = patch.adRaw;
  if (patch.extract !== undefined) dbPatch.ad_extracted = patch.extract;
  if (patch.analysis !== undefined) dbPatch.ad_analysis = patch.analysis;
  if (patch.recipientEmail !== undefined) dbPatch.recipient_email = patch.recipientEmail;
  if (patch.emailSubject !== undefined) dbPatch.email_subject = patch.emailSubject;
  if (patch.emailBody !== undefined) dbPatch.email_body = patch.emailBody;
  if (patch.emailAttachCv !== undefined) dbPatch.email_attach_cv = patch.emailAttachCv;
  if (patch.emailAttachLetter !== undefined) dbPatch.email_attach_letter = patch.emailAttachLetter;
  if (patch.emailAccountId !== undefined) dbPatch.email_account_id = patch.emailAccountId;
  return toResult(await updateAutoBewerbCompany(user.id, companyId, dbPatch)) as ActionResult<AutoBewerbCompanyRow>;
}

export async function deleteCompanyAction(companyId: string): Promise<ActionResult<{ ok: true }>> {
  const { user } = await getCurrentUserAndProfile();
  if (!user) return unauthorized();
  return toResult(await deleteAutoBewerbCompany(user.id, companyId)) as ActionResult<{ ok: true }>;
}

export async function confirmAdAction(companyId: string): Promise<ActionResult<AutoBewerbCompanyRow>> {
  const { user } = await getCurrentUserAndProfile();
  if (!user) return unauthorized();
  return toResult(await markAutoBewerbAdConfirmed(user.id, companyId)) as ActionResult<AutoBewerbCompanyRow>;
}

export async function approveCompanyAction(companyId: string): Promise<ActionResult<AutoBewerbCompanyRow>> {
  const { user } = await getCurrentUserAndProfile();
  if (!user) return unauthorized();
  return toResult(await approveAutoBewerbCompany(user.id, companyId)) as ActionResult<AutoBewerbCompanyRow>;
}

// ---------------------------------------------------------------------------
// Steps 4–5 — generated documents (per company, versioned)
// ---------------------------------------------------------------------------

export async function saveCompanyDocumentAction(
  companyId: string,
  docType: AutoBewerbDocType,
  content: unknown,
): Promise<ActionResult<{ version: number }>> {
  const { user } = await getCurrentUserAndProfile();
  if (!user) return unauthorized();
  const res = await saveAutoBewerbDocument(user.id, companyId, docType, content);
  if (!ok(res) || !res.value) return toResult(res) as ActionResult<{ version: number }>;
  return { ok: true, value: { version: (res.value as { version: number }).version } };
}

/** Mark a generated document as reviewed by the user (clears on re-gen). */
export async function markDocumentReviewedAction(
  companyId: string,
  docType: AutoBewerbDocType,
): Promise<ActionResult<{ ok: true }>> {
  const { user } = await getCurrentUserAndProfile();
  if (!user) return unauthorized();
  const res = await updateAutoBewerbCompany(user.id, companyId, {
    cv_reviewed_at: docType === "cv" ? new Date().toISOString() : undefined,
    letter_reviewed_at: docType === "cover_letter" ? new Date().toISOString() : undefined,
  } as AutoBewerbCompanyPatch);
  return toResult(res) as ActionResult<{ ok: true }>;
}

// ---------------------------------------------------------------------------
// Step 6 — shared email template
// ---------------------------------------------------------------------------

export async function saveEmailTemplateAction(body: string): Promise<ActionResult<{ ok: true }>> {
  const { user } = await getCurrentUserAndProfile();
  if (!user) return unauthorized();
  return toResult(await saveAutoBewerbEmailTemplate(user.id, body)) as ActionResult<{ ok: true }>;
}

// ---------------------------------------------------------------------------
// Step 7 — sending (explicit confirmation required)
// ---------------------------------------------------------------------------

export interface SendCompanyInput {
  companyId: string;
  recipientEmail: string;
  emailAccountId: string;
  subject: string;
  /** Per-company override; empty = the shared template. */
  bodyOverride?: string | null;
  attachCv?: boolean;
  attachLetter?: boolean;
  schedule?: AutoBewerbScheduleInput | null;
  /** Explicit user confirmation (the UI shows the exact recipients + attachments). */
  confirmed: boolean;
}

export interface SendCompanyResult {
  companyId: string;
  ok: boolean;
  code?: string;
  message?: string;
  dispatchStatus?: AutoBewerbSendResult["dispatchStatus"];
  failureCode?: string | null;
  scheduledAt?: string | null;
}

/** Send MULTIPLE companies with PER-COMPANY failure isolation: one company's
 *  rejection/failure never aborts or mislabels the others. Every send is
 *  individually approved (the caller verifies confirmed=true for each). */
export async function sendCompaniesAction(
  inputs: SendCompanyInput[],
): Promise<ActionResult<SendCompanyResult[]>> {
  const { user } = await getCurrentUserAndProfile();
  if (!user) return unauthorized();
  if (!Array.isArray(inputs) || inputs.length === 0) {
    return { ok: false, code: "empty_selection", message: "empty_selection" };
  }
  const results: SendCompanyResult[] = [];
  for (const input of inputs) {
    if (!input.confirmed) {
      results.push({ companyId: input.companyId, ok: false, code: "not_confirmed", message: "not_confirmed" });
      continue;
    }
    const res = await prepareAutoBewerbSend(user.id, {
      companyId: input.companyId,
      recipientEmail: input.recipientEmail,
      emailAccountId: input.emailAccountId,
      subject: input.subject,
      bodyOverride: input.bodyOverride ?? null,
      attachCv: input.attachCv ?? true,
      attachLetter: input.attachLetter ?? true,
      schedule: input.schedule ?? null,
    });
    results.push({
      companyId: input.companyId,
      ok: res.ok,
      code: res.code,
      message: res.message,
      dispatchStatus: res.dispatchStatus,
      failureCode: res.failureCode ?? null,
      scheduledAt: res.scheduledAt ?? null,
    });
  }
  return { ok: true, value: results };
}

export async function cancelSendAction(attemptId: string): Promise<ActionResult<{ ok: true }>> {
  const { user } = await getCurrentUserAndProfile();
  if (!user) return unauthorized();
  return toResult(await cancelAutoBewerbSend(user.id, attemptId)) as ActionResult<{ ok: true }>;
}

/** Schedule the selected companies at the given wall-clock time (the
 *  ScheduleForm's hidden inputs). Reads the stored rows AUTHORITATIVELY —
 *  the client passes only company ids — with per-company isolation, same
 *  semantics as the immediate send path. */
export async function scheduleCompaniesAction(
  companyIds: string[],
  formData: FormData,
): Promise<ActionResult<SendCompanyResult[]>> {
  const { user } = await getCurrentUserAndProfile();
  if (!user) return unauthorized();
  if (!Array.isArray(companyIds) || companyIds.length === 0) {
    return { ok: false, code: "empty_selection", message: "empty_selection" };
  }
  const num = (k: string) => Number(formData.get(k) ?? 0);
  const schedule: AutoBewerbScheduleInput = {
    timeZone: String(formData.get("scheduleTimezone") ?? "Europe/Berlin"),
    year: num("scheduleYear"),
    month: num("scheduleMonth"),
    day: num("scheduleDay"),
    hour: num("scheduleHour"),
    minute: num("scheduleMinute"),
  };
  const workspace = await getAutoBewerbWorkspace(user.id);
  const results: SendCompanyResult[] = [];
  for (const companyId of companyIds) {
    const view = workspace.companies.find((c) => c.company.id === companyId);
    if (!view) {
      results.push({ companyId, ok: false, code: "not_found", message: "not_found" });
      continue;
    }
    const r = view.company;
    const res = await prepareAutoBewerbSend(user.id, {
      companyId: r.id,
      recipientEmail: r.recipient_email ?? "",
      emailAccountId: r.email_account_id ?? "",
      subject: r.email_subject ?? "",
      bodyOverride: r.email_body,
      attachCv: r.email_attach_cv,
      attachLetter: r.email_attach_letter,
      schedule,
    });
    results.push({
      companyId: r.id,
      ok: res.ok,
      code: res.code,
      message: res.message,
      dispatchStatus: res.dispatchStatus,
      failureCode: res.failureCode ?? null,
      scheduledAt: res.scheduledAt ?? null,
    });
  }
  return { ok: true, value: results };
}
