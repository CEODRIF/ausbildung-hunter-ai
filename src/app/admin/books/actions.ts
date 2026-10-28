"use server";

import { checkRateLimit } from "@/lib/rate-limit";
import { diagnoseAdminAccess } from "@/lib/billing/admin";
import {
  createBook,
  updateBook,
  setBookPublished,
  deleteBook,
  sanitizeBookFields,
  validateCoverFile,
  type BookAdminErrorCode,
} from "@/lib/book-library";

/**
 * Deutsch Bibliothek — admin server actions.
 *
 * AUTHORIZATION (the only gate that matters, server-side, per request):
 *   1. `diagnoseAdminAccess()` — active session → `public.admins`
 *      membership (service-role read) → profile row. The EXISTING trusted
 *      admin gate from the /admin area; nothing client-supplied is trusted
 *      (no role flag, no user id, no email in the form data).
 *   2. The shared `admin_actions` rate limit (Postgres fixed window) caps
 *      bursts per administrator.
 *   3. The database itself has NO user write policy/privilege on
 *      german_books or the book-covers bucket — even a compromised action
 *      cannot reach them from the browser.
 *
 * The returned `error` values are STABLE CODES, never messages: the client
 * maps them to translated UI copy, and raw Supabase/Postgres text never
 * leaves the server.
 */

export type BookFormState = {
  /** Stable error code (admin.books.errors.<code> i18n key). */
  error?: string;
  /** "created" | "updated" — the form resets and the page re-renders. */
  success?: "created" | "updated";
};

type Gate =
  | { ok: true; adminId: string }
  | { ok: false; code: Extract<BookAdminErrorCode, "unauthorized" | "forbidden" | "rate_limited"> };

async function gatedAdmin(): Promise<Gate> {
  const access = await diagnoseAdminAccess();
  if (access.status === "unauthenticated") return { ok: false, code: "unauthorized" };
  if (access.status === "forbidden") return { ok: false, code: "forbidden" };

  const adminId = access.profile.id;
  const limited = await checkRateLimit("admin_actions", adminId);
  if (!limited.allowed) return { ok: false, code: "rate_limited" };
  return { ok: true, adminId };
}

function readString(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === "string" ? value : "";
}

type CoverRead =
  | { kind: "none" } // no file submitted (edit: keep current cover)
  | { kind: "invalid" } // submitted but failed validation
  | {
      kind: "ok";
      buffer: Buffer;
      imageType: "jpeg" | "png" | "webp";
    };

/**
 * Extract + validate the cover File from form data. The browser `accept`
 * and client-side size check are UX only — this is the authoritative
 * validation (content sniffing on the real bytes, size ceiling, MIME
 * agreement).
 */
async function readCover(formData: FormData): Promise<CoverRead> {
  const file = formData.get("cover");
  if (!(file instanceof File) || file.size === 0) return { kind: "none" };
  const buffer = Buffer.from(await file.arrayBuffer());
  const imageType = validateCoverFile(file, buffer);
  if (!imageType) return { kind: "invalid" };
  return { kind: "ok", buffer, imageType };
}

/**
 * Create a book. Cover is REQUIRED (the add-book contract); `published`
 * arrives as a checkbox ("on" = publish immediately, absent = draft).
 */
export async function createBookAction(
  _previousState: BookFormState,
  formData: FormData,
): Promise<BookFormState> {
  const gate = await gatedAdmin();
  if (!gate.ok) return { error: gate.code };

  try {
    // Validate the cheap text fields FIRST (avoids reading a multi-MB
    // buffer for a request that will fail on a title anyway).
    const sanitized = sanitizeBookFields({
      title: readString(formData, "title"),
      category: readString(formData, "category"),
      description: readString(formData, "description"),
      downloadUrl: readString(formData, "downloadUrl"),
    });
    if (!sanitized.ok) return { error: sanitized.error };

    const cover = await readCover(formData);
    if (cover.kind === "none") return { error: "cover_required" };
    if (cover.kind === "invalid") return { error: "invalid_cover" };

    const published = formData.get("published") === "on";
    const result = await createBook(gate.adminId, {
      fields: sanitized.value,
      published,
      cover: { buffer: cover.buffer, imageType: cover.imageType },
    });
    if (!result.ok) return { error: result.error };
    return { success: "created" };
  } catch (error) {
    // A thrown (non-code) failure is unexpected — log it, never leak it.
    console.error(
      `[books] createBook unexpected error — "${error instanceof Error ? error.message : String(error)}"`,
    );
    return { error: "db_error" };
  }
}

/**
 * Edit an existing book. Cover is OPTIONAL (no file = keep the current
 * cover); all four text fields are re-submitted and re-validated.
 */
export async function updateBookAction(
  _previousState: BookFormState,
  formData: FormData,
): Promise<BookFormState> {
  const gate = await gatedAdmin();
  if (!gate.ok) return { error: gate.code };

  const bookId = readString(formData, "bookId");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(bookId)) {
    return { error: "book_not_found" };
  }

  try {
    const sanitized = sanitizeBookFields({
      title: readString(formData, "title"),
      category: readString(formData, "category"),
      description: readString(formData, "description"),
      downloadUrl: readString(formData, "downloadUrl"),
    });
    if (!sanitized.ok) return { error: sanitized.error };

    const cover = await readCover(formData);
    if (cover.kind === "invalid") return { error: "invalid_cover" };

    const result = await updateBook(bookId, {
      fields: sanitized.value,
      cover:
        cover.kind === "ok"
          ? { buffer: cover.buffer, imageType: cover.imageType }
          : null,
    });
    if (!result.ok) return { error: result.error };
    return { success: "updated" };
  } catch (error) {
    console.error(
      `[books] updateBook unexpected error — "${error instanceof Error ? error.message : String(error)}"`,
    );
    return { error: "db_error" };
  }
}

/** Direct (non-form) action: publish or unpublish one book. */
export async function setBookPublishedAction(
  bookId: string,
  published: boolean,
): Promise<{ ok: true } | { ok: false; error: BookAdminErrorCode }> {
  const gate = await gatedAdmin();
  if (!gate.ok) return { ok: false, error: gate.code };
  const result = await setBookPublished(bookId, published);
  return result.ok ? { ok: true } : { ok: false, error: result.error };
}

/** Direct (non-form) action: delete a book (row + cover). */
export async function deleteBookAction(
  bookId: string,
): Promise<{ ok: true } | { ok: false; error: BookAdminErrorCode }> {
  const gate = await gatedAdmin();
  if (!gate.ok) return { ok: false, error: gate.code };
  const result = await deleteBook(bookId);
  return result.ok ? { ok: true } : { ok: false, error: result.error };
}
