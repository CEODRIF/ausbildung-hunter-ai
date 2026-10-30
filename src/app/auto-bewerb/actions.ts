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
  prepareAutoBewerbSend,
  processDueAutoBewerbAttemptsForUser,
  saveAutoBewerbDocument,
  saveAutoBewerbEmailSettings,
  saveAutoBewerbEmailTemplate,
  saveAutoBewerbProfile,
  updateAutoBewerbCompany,
  updateAutoBewerbProfileExtract,
  type AutoBewerbCompanyPatch,
  type AutoBewerbDocType,
  type AutoBewerbScheduleInput,
  type AutoBewerbSendResult,
} from "@/lib/auto-bewerb/engine";
import {
  autoBewerbEmailSettingsSchema,
  type AdAnalysis,
  type AdExtract,
  type AutoBewerbCompanyRow,
  type AutoBewerbEmailSettings,
} from "@/lib/auto-bewerb/schema";
import { sanitizeEmailHtml } from "@/lib/application-drafts";

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
  },
): Promise<ActionResult<AutoBewerbCompanyRow>> {
  const { user } = await getCurrentUserAndProfile();
  if (!user) return unauthorized();
  const dbPatch: AutoBewerbCompanyPatch = {};
  if (patch.company !== undefined) dbPatch.company = patch.company;
  if (patch.adRaw !== undefined) dbPatch.ad_raw = patch.adRaw;
  if (patch.extract !== undefined) dbPatch.ad_extracted = patch.extract;
  if (patch.analysis !== undefined) dbPatch.ad_analysis = patch.analysis;
  return toResult(await updateAutoBewerbCompany(user.id, companyId, dbPatch)) as ActionResult<AutoBewerbCompanyRow>;
}

export async function deleteCompanyAction(companyId: string): Promise<ActionResult<{ ok: true }>> {
  const { user } = await getCurrentUserAndProfile();
  if (!user) return unauthorized();
  return toResult(await deleteAutoBewerbCompany(user.id, companyId)) as ActionResult<{ ok: true }>;
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
  // Sanitize the rich-text HTML before persisting (the engine re-sanitizes at
  // send time as defense in depth).
  return toResult(await saveAutoBewerbEmailTemplate(user.id, sanitizeEmailHtml(body))) as ActionResult<{ ok: true }>;
}

/** Persist the ONE global e-mail configuration (Step 6): body + recipient +
 *  subject + account + attachment flags in a single upsert. The input is
 *  zod-validated; the engine re-checks schema support + ownership. */
export async function saveEmailSettingsAction(
  input: unknown,
): Promise<ActionResult<{ ok: true }>> {
  const { user } = await getCurrentUserAndProfile();
  if (!user) return unauthorized();
  const parsed = autoBewerbEmailSettingsSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: "invalid_document", message: parsed.error.issues[0]?.message ?? "invalid" };
  const settings = parsed.data as AutoBewerbEmailSettings;
  // Sanitize the rich-text body HTML before persisting (defense in depth: the
  // engine sanitizes again at send time).
  return toResult(
    await saveAutoBewerbEmailSettings(user.id, { ...settings, body: sanitizeEmailHtml(settings.body) }),
  ) as ActionResult<{ ok: true }>;
}

// ---------------------------------------------------------------------------
// Step 7 — sending (explicit confirmation required)
// ---------------------------------------------------------------------------

/**
 * The client passes ONLY the company id + explicit confirmation. Every
 * e-mail setting (recipient, subject, account, attachments, body) is read
 * server-side from the ONE global configuration (or the legacy per-company
 * values on databases without the settings migration) — a client-supplied
 * override is impossible by construction.
 */
export interface SendCompanyInput {
  companyId: string;
  schedule?: AutoBewerbScheduleInput | null;
  /** Explicit user confirmation (the UI shows the exact config + destinations). */
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
    // Same global-configuration resolution as the immediate send path —
    // scheduled sends and retries can never carry different e-mail settings.
    const res = await prepareAutoBewerbSend(user.id, {
      companyId: r.id,
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
