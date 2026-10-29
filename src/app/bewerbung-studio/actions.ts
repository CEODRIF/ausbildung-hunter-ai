"use server";

import { getCurrentUserAndProfile } from "@/lib/auth";
import {
  approveApplication,
  cancelStudioSend,
  createStudioApplication,
  deleteStudioApplication,
  getStudioApplication,
  getStudioBatchView,
  hasStudioSchema,
  markStudioStepConfirmed,
  prepareStudioSend,
  processDueStudioAttemptsForUser,
  saveStudioDocument,
  updateStudioApplication,
  type StudioAppPatch,
  type StudioBatchView,
  type StudioConfirmField,
  type StudioDocType,
  type StudioSendInput,
} from "@/lib/studio";
import type { AdAnalysis, AdExtract, StudioApplicationRow } from "@/lib/studio/schema";

/**
 * AI Bewerbung Studio — server actions.
 *
 * Every action re-resolves the authenticated user from the session
 * (never from arguments) and works through the ownership-checked lib
 * layer. AI generation (paid ops) lives in the /api/bewerbung-studio/*
 * routes (client fetch + quota/rate responses); these actions cover the
 * durable state transitions: create, save documents, approve, send,
 * schedule, cancel.
 */

type ActionResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: string; message: string };

function unauthorized(): ActionResult<never> {
  return { ok: false, code: "unauthorized", message: "Bitte anmelden." };
}

function toResult(op: { ok: boolean; value?: unknown; code?: string; message?: string }, fallbackValue?: unknown): ActionResult<unknown> {
  if (op.ok) return { ok: true, value: (op.value ?? fallbackValue) as never };
  return { ok: false, code: op.code ?? "error", message: op.message ?? "Operation fehlgeschlagen." };
}

export async function createApplicationAction(input: {
  adRaw: string;
  extract?: AdExtract | null;
  analysis?: AdAnalysis | null;
  profileSnapshot?: unknown;
}): Promise<ActionResult<StudioApplicationRow>> {
  const { user } = await getCurrentUserAndProfile();
  if (!user) return unauthorized();
  if (!input.adRaw || input.adRaw.trim().length < 40)
    return { ok: false, code: "invalid_ad_text", message: "Die Stellenanzeige ist zu kurz." };
  return toResult(
    await createStudioApplication(user.id, {
      adRaw: input.adRaw,
      extract: input.extract ?? null,
      analysis: input.analysis ?? null,
      profileSnapshot: input.profileSnapshot ?? null,
    }),
  ) as ActionResult<StudioApplicationRow>;
}

export async function updateApplicationAction(
  applicationId: string,
  patch: {
    extract?: AdExtract | null;
    analysis?: AdAnalysis | null;
    profileSnapshot?: unknown;
    recipientEmail?: string | null;
  },
): Promise<ActionResult<StudioApplicationRow>> {
  const { user } = await getCurrentUserAndProfile();
  if (!user) return unauthorized();
  const dbPatch: StudioAppPatch = {};
  if (patch.extract !== undefined) dbPatch.ad_extracted = patch.extract;
  if (patch.analysis !== undefined) dbPatch.ad_analysis = patch.analysis;
  if (patch.profileSnapshot !== undefined) dbPatch.profile_snapshot = patch.profileSnapshot;
  if (patch.recipientEmail !== undefined) dbPatch.recipient_email = patch.recipientEmail;
  return toResult(await updateStudioApplication(user.id, applicationId, dbPatch)) as ActionResult<StudioApplicationRow>;
}

export async function saveDocumentAction(
  applicationId: string,
  docType: StudioDocType,
  content: unknown,
): Promise<ActionResult<{ id: string; version: number }>> {
  const { user } = await getCurrentUserAndProfile();
  if (!user) return unauthorized();
  const res = await saveStudioDocument(user.id, applicationId, docType, content);
  if (!res.ok || !res.value)
    return {
      ok: false,
      code: res.ok ? "error" : res.code,
      message: res.ok ? "Dokument konnte nicht gespeichert werden." : res.message,
    };
  return { ok: true, value: { id: res.value.id, version: res.value.version } };
}

export async function approveApplicationAction(applicationId: string): Promise<ActionResult<StudioApplicationRow>> {
  const { user } = await getCurrentUserAndProfile();
  if (!user) return unauthorized();
  return toResult(await approveApplication(user.id, applicationId)) as ActionResult<StudioApplicationRow>;
}

export interface StudioSendActionInput {
  applicationId: string;
  recipientEmail: string;
  emailAccountId: string;
  subject: string;
  body: string;
  attachmentIds: string[];
  schedule: {
    timeZone: string;
    year: number;
    month: number;
    day: number;
    hour: number;
    minute: number;
  } | null;
  /** Explicit user confirmation (the UI requires a typed/checked consent). */
  confirmed: boolean;
}

export async function sendApplicationAction(
  input: StudioSendActionInput,
): Promise<ActionResult<{ attemptId: string; scheduledAt: string | null; dispatchStatus?: string; failureCode?: string | null }>> {
  const { user } = await getCurrentUserAndProfile();
  if (!user) return unauthorized();
  if (!input.confirmed)
    return { ok: false, code: "not_confirmed", message: "Bitte den Versand ausdrücklich bestätigen." };
  const payload: StudioSendInput = {
    applicationId: input.applicationId,
    recipientEmail: input.recipientEmail,
    emailAccountId: input.emailAccountId,
    subject: input.subject,
    body: input.body,
    attachmentIds: input.attachmentIds,
    schedule: input.schedule,
  };
  const res = await prepareStudioSend(user.id, payload);
  if (!res.ok) return { ok: false, code: res.code ?? "error", message: res.message ?? "Versand fehlgeschlagen." };
  return {
    ok: true,
    value: {
      attemptId: res.attemptId ?? "",
      scheduledAt: res.scheduledAt ?? null,
      dispatchStatus: res.dispatchStatus,
      failureCode: res.failureCode ?? null,
    },
  };
}

export async function cancelSendAction(attemptId: string): Promise<ActionResult<{ ok: true }>> {
  const { user } = await getCurrentUserAndProfile();
  if (!user) return unauthorized();
  return toResult(await cancelStudioSend(user.id, attemptId), { ok: true as const }) as ActionResult<{ ok: true }>;
}

/** Delete a whole application (UI shows the confirmation dialog first).
 *  Cancels pending scheduled attempts first — never sends after deletion. */
export async function deleteApplicationAction(applicationId: string): Promise<ActionResult<{ ok: true }>> {
  const { user } = await getCurrentUserAndProfile();
  if (!user) return unauthorized();
  return toResult(await deleteStudioApplication(user.id, applicationId), { ok: true as const }) as ActionResult<{ ok: true }>;
}

/** Explicit user confirmation of one completion requirement
 *  (ad / profile / cv / letter / checklist). Server-owned timestamp. */
export async function confirmStepAction(
  applicationId: string,
  field: string,
): Promise<ActionResult<StudioApplicationRow>> {
  const { user } = await getCurrentUserAndProfile();
  if (!user) return unauthorized();
  const allowed: StudioConfirmField[] = ["ad", "profile", "cv", "letter", "checklist"];
  if (!allowed.includes(field as StudioConfirmField))
    return { ok: false, code: "invalid_field", message: "Ungültige Bestätigung." };
  return toResult(await markStudioStepConfirmed(user.id, applicationId, field as StudioConfirmField)) as ActionResult<StudioApplicationRow>;
}

/** Re-read the batch workspace view (navigator state: slots, completion,
 *  sequential unlock). Returns value=null when the schema is pending. */
export async function refreshBatchAction(): Promise<ActionResult<StudioBatchView | null>> {
  const { user } = await getCurrentUserAndProfile();
  if (!user) return unauthorized();
  const view = await getStudioBatchView(user.id);
  return { ok: true, value: view };
}

export interface StudioRefreshPayload {
  available: boolean;
  applicationId: string | null;
  app: StudioApplicationRow | null;
  sendStatus: {
    status: string;
    scheduledAt: string | null;
    failureCode: string | null;
    providerMessageId: string | null;
  } | null;
}

/** Re-read the application state + best-effort catch-up for DUE scheduled
 *  sends of the visiting user (server-side dispatch, idempotent). */
export async function refreshApplicationAction(applicationId: string): Promise<ActionResult<StudioRefreshPayload>> {
  const { user } = await getCurrentUserAndProfile();
  if (!user) return unauthorized();
  const available = await hasStudioSchema();
  if (!available)
    return {
      ok: true,
      value: { available: false, applicationId: null, app: null, sendStatus: null },
    };
  // Catch-up first (only DUE attempts; never sends before schedule).
  await processDueStudioAttemptsForUser(user.id, 1);
  const bundle = await getStudioApplication(user.id, applicationId);
  if (!bundle)
    return { ok: false, code: "not_found", message: "Anwendung nicht gefunden." };
  const latestAttempt = bundle.attempts[0] ?? null;
  return {
    ok: true,
    value: {
      available: true,
      applicationId: bundle.app.id,
      app: bundle.app,
      sendStatus: latestAttempt
        ? {
            status: latestAttempt.status,
            scheduledAt: latestAttempt.scheduled_at,
            failureCode: latestAttempt.failure_code,
            providerMessageId: latestAttempt.provider_message_id,
          }
        : null,
    },
  };
}
