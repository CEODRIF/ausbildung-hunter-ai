"use server";

import { getCurrentUserAndProfile } from "@/lib/auth";
import { initiateBookDownload, type BookDownloadResult } from "@/lib/book-library";

/**
 * Deutsch Bibliothek — public download-initiation server action.
 *
 * AUTHORIZATION: the actor is ALWAYS the session user
 * (getCurrentUserAndProfile). The action accepts only the book id —
 * a client cannot target another user's quota, supply plan names,
 * trial flags, or quota counters (all resolved server-side from the
 * subscription data + the atomic quota RPC).
 *
 * A success result carries the external source URL ONLY AFTER the
 * server authorized + recorded the initiation; the UI opens it in a
 * fresh, unassociated tab. The platform never downloads, scrapes, or
 * hosts the PDF itself.
 *
 * FAILURE CONTRACT: every outcome is a STABLE code (the UI maps codes to
 * translated messages). Unexpected failures are logged server-side —
 * scrubbed of JWT-shaped fragments — and reduced to `db_error`; no stack
 * trace, message body, or URL ever reaches the browser. A broken session
 * contract is a server defect (logged), never a grant and never a
 * rejected promise.
 */

const REDACT_JWT =
  /\beyJ[A-Za-z0-9._-]{8,}\.[A-Za-z0-9._-]{8,}\.[A-Za-z0-9._-]{8,}/g;

function scrubLog(value: unknown): string {
  return (typeof value === "string" ? value : String(value ?? "")).replace(
    REDACT_JWT,
    "[redacted-jwt]",
  );
}

export async function initiateBookDownloadAction(
  bookId: string,
): Promise<BookDownloadResult> {
  let session;
  try {
    session = await getCurrentUserAndProfile();
  } catch (error) {
    console.error(
      `[books] session resolution failed — "${scrubLog(
        error instanceof Error ? error.message : error,
      )}"`,
    );
    return { ok: false, error: "db_error", remaining: 0, tier: "none" };
  }
  const { user } = session;
  if (!user) {
    return { ok: false, error: "not_signed_in", remaining: 0, tier: "none" };
  }
  try {
    return await initiateBookDownload(user.id, bookId);
  } catch (error) {
    console.error(
      `[books] initiateBookDownload threw — "${scrubLog(
        error instanceof Error ? error.message : error,
      )}"`,
    );
    return { ok: false, error: "db_error", remaining: 0, tier: "none" };
  }
}
