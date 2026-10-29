/**
 * AI Bewerbung Studio — batch completion model (pure, isomorphic).
 *
 * "Complete" is an EXPLICIT, server-visible state — never inferred from a
 * single field: the application package is prepared, reviewed, validated
 * and saved. Completion does NOT require a send (the next slot unlocks on
 * completion, not on delivery).
 *
 * The seven requirements (batch spec):
 *   ad       — advertisement analyzed AND extracted details confirmed
 *   profile  — candidate profile data confirmed
 *   cv       — CV generated AND reviewed
 *   letter   — cover letter generated AND reviewed
 *   docs     — required document checklist resolved OR explicitly acknowledged
 *   email    — recipient, subject and body completed (recipient valid)
 *   quality  — final validation passed (no blocking deterministic issues)
 */

import { cvHasContent } from "@/lib/templates/cv";
import type {
  AdExtract,
  StudioApplicationRow,
  StudioAttachmentRow,
  StudioDocumentRow,
} from "./schema";
import { isValidEmail } from "./schema";
import type { QualityIssue } from "./schema";
import { parseStoredCv, parseStoredLetter, parseStoredEmail } from "./stored-docs";

export type StudioCompletionKey =
  | "ad"
  | "profile"
  | "cv"
  | "letter"
  | "docs"
  | "email"
  | "quality";

export const STUDIO_COMPLETION_KEYS: StudioCompletionKey[] = [
  "ad",
  "profile",
  "cv",
  "letter",
  "docs",
  "email",
  "quality",
];

/** Max applications per user batch (batch spec: up to 10). */
export const STUDIO_BATCH_LIMIT = 10;
/** Slots shown initially; expandable up to the limit. */
export const STUDIO_BATCH_INITIAL_SLOTS = 5;

export interface StudioCompletionInput {
  app: StudioApplicationRow;
  /** Latest stored document per type (cv / cover_letter / email). */
  docs: { cv: StudioDocumentRow | null; letter: StudioDocumentRow | null; email: StudioDocumentRow | null };
  attachments: StudioAttachmentRow[];
  /** Blocking deterministic quality issues only (advisory ones never block). */
  blockingIssues: QualityIssue[];
}

export interface StudioCompletion {
  /** key -> satisfied? */
  done: Record<StudioCompletionKey, boolean>;
  /** Unmet requirements, in presentation order. */
  missing: StudioCompletionKey[];
  complete: boolean;
  /** 0..1, over the seven requirements. */
  progress: number;
}

/** The document categories the advertisement requests (normalized). */
export function requestedDocCategories(extract: AdExtract | null | undefined): string[] {
  const wanted = new Set<string>();
  for (const r of extract?.requestedDocuments ?? []) {
    const s = r.trim().toLowerCase();
    if (s) wanted.add(s);
  }
  return [...wanted];
}

/**
 * Does the attachment set cover every requested category? A requested item
 * counts as covered when any uploaded attachment's display name or category
 * contains the requested word stem (simple, honest substring match — no
 * NLP, no false confidence). Empty request list = trivially covered.
 */
export function docsChecklistCovered(
  extract: AdExtract | null | undefined,
  attachments: StudioAttachmentRow[],
): boolean {
  const requested = requestedDocCategories(extract);
  if (requested.length === 0) return true;
  const haystack = attachments
    .map((a) => `${a.display_name} ${a.doc_category}`)
    .join(" ")
    .toLowerCase();
  return requested.every((r) => haystack.includes(r.split(" ")[0]));
}

/** Compute the seven-requirement completion state (pure). */
export function computeStudioCompletion(input: StudioCompletionInput): StudioCompletion {
  const { app, docs, attachments, blockingIssues } = input;
  const extract = app.ad_extracted as AdExtract | null | undefined;

  const cv = parseStoredCv(docs.cv);
  const letter = parseStoredLetter(docs.letter);
  const email = parseStoredEmail(docs.email);

  const done: Record<StudioCompletionKey, boolean> = {
    ad: Boolean(extract?.company?.trim() && extract?.jobTitle?.trim() && app.ad_confirmed_at),
    profile: Boolean(app.profile_confirmed_at),
    cv: Boolean(cv && cvHasContent(cv) && app.cv_reviewed_at),
    letter: Boolean(letter?.text?.trim() && app.letter_reviewed_at),
    docs: Boolean(app.checklist_ack_at) || docsChecklistCovered(extract, attachments),
    email: Boolean(
      email?.subject?.trim() &&
        email?.body?.trim() &&
        app.recipient_email &&
        isValidEmail(app.recipient_email),
    ),
    quality: blockingIssues.length === 0,
  };

  // A sent/scheduled application is by definition past "complete" (its
  // package was validated before dispatch); do not re-open it after the fact.
  if (app.status === "sent" || app.status === "scheduled" || app.status === "sending") {
    for (const k of STUDIO_COMPLETION_KEYS) done[k] = true;
  }

  const missing = STUDIO_COMPLETION_KEYS.filter((k) => !done[k]);
  const metCount = STUDIO_COMPLETION_KEYS.length - missing.length;
  return {
    done,
    missing,
    complete: missing.length === 0,
    progress: metCount / STUDIO_COMPLETION_KEYS.length,
  };
}

export interface StudioSlotState {
  unlocked: boolean;
  complete: boolean;
  missing: StudioCompletionKey[];
}

/**
 * Strict sequential unlocking over the slot list (ORDER MATTERS — pass
 * applications sorted by created_at ASC):
 *   slot 0 is always unlocked; slot N unlocks only when slot N-1 is
 *   COMPLETE. Deleting an earlier application re-orders the remaining slots;
 *   edits that invalidate completion re-lock downstream slots (the caller
 *   re-derives this on every refresh).
 */
export function studioUnlockStates(
  completions: StudioCompletion[],
): StudioSlotState[] {
  const out: StudioSlotState[] = [];
  let prevComplete = true; // nothing before slot 0
  for (const c of completions) {
    out.push({
      unlocked: prevComplete,
      complete: c.complete,
      missing: c.missing,
    });
    prevComplete = c.complete;
  }
  return out;
}
