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
 */
export async function initiateBookDownloadAction(
  bookId: string,
): Promise<BookDownloadResult> {
  const { user } = await getCurrentUserAndProfile();
  if (!user) {
    return { ok: false, error: "not_signed_in", remaining: 0, tier: "none" };
  }
  try {
    return await initiateBookDownload(user.id, bookId);
  } catch {
    return { ok: false, error: "db_error", remaining: 0, tier: "none" };
  }
}
