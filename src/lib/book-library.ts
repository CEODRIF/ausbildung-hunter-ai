import "server-only";

import { randomUUID } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { getSupabaseEnv } from "@/lib/supabase/config";
import { isBookCategorySlug } from "@/lib/book-categories";

/**
 * Deutsch Bibliothek — data + privileged operations for the public book
 * library.
 *
 * TWO strictly separated access paths (mirrors the repo's canonical model):
 *
 *  PUBLIC READ — `listPublishedBooks()` uses the session/anon server client
 *    (`createClient`), so the request executes as `anon` or `authenticated`
 *    and RLS is the boundary: the database only exposes rows with
 *    `published = true` (migration 20261203000000). The explicit
 *    `.eq("published", true)` filter is defence in depth on top of RLS —
 *    drafts are unreachable by ANY non-service-role path, including direct
 *    PostgREST requests.
 *
 *  ADMIN WRITE — every mutation here runs with the service-role client
 *    (`createAdminClient`) AFTER the caller has passed the established admin
 *    gate (`requireAdmin` / `diagnoseAdminAccess`, src/lib/billing/admin.ts:
 *    session user → public.admins membership → profile row). The actor id is
 *    always the SESSION-derived administrator — never a form field. The
 *    table has no user write policies and no user write privileges at all,
 *    so a spoofed or direct request cannot mutate books regardless of what
 *    this module did or did not check.
 *
 * BOOKS ARE LINKS: the app stores the cover image + metadata only. The
 * `download_url` is the administrator-provided external source URL; this
 * application never fetches, downloads, scrapes, or mirrors book files.
 */

export const BOOK_COVERS_BUCKET = "book-covers";
export const COVER_MAX_BYTES = 5 * 1024 * 1024; // 5 MB
export const LIBRARY_PAGE_SIZE = 12;

export type CoverImageType = "jpeg" | "png" | "webp";

const COVER_MIME: Record<CoverImageType, string> = {
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

const COVER_EXT: Record<CoverImageType, string> = {
  jpeg: "jpg",
  png: "png",
  webp: "webp",
};

// ---------------------------------------------------------------------------
// Validation (pure — exported for tests)
// ---------------------------------------------------------------------------

/**
 * Content-based cover detection (magic bytes). The browser's `File.type` is
 * only a hint (empty on many systems, freely spoofable) — the uploaded bytes
 * are the source of truth (same model as ai-service.detectFileType).
 */
export function detectCoverImage(buffer: Buffer): CoverImageType | null {
  if (buffer.length < 12) return null;
  // PNG signature: 89 50 4E 47 0D 0A 1A 0A
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  )
    return "png";
  // JPEG: FF D8 FF (SOI + first marker)
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff)
    return "jpeg";
  // WEBP: RIFF....WEBP
  if (
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x45 &&
    buffer[10] === 0x42 &&
    buffer[11] === 0x50
  )
    return "webp";
  return null;
}

/**
 * Validate an external download URL. Only http(s) is allowed — this is the
 * server-side twin of the client-side check and rejects `javascript:`,
 * `data:`, `file:`, `vbscript:` and everything else, plus embedded control
 * characters and credential-bearing URLs. Returns the canonical form on
 * success, null on rejection.
 */
export function validateDownloadUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length < 10 || trimmed.length > 2000) return null;
  if (/[\u0000-\u001F\u007F]/.test(trimmed)) return null; // control chars (incl. \n tricks)
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username !== "" || url.password !== "") return null;
  return url.toString();
}

export type BookFieldError =
  | "invalid_title"
  | "invalid_category"
  | "invalid_description"
  | "invalid_url";

export interface SanitizedBookFields {
  title: string;
  category: string;
  description: string | null;
  downloadUrl: string;
}

/**
 * Validate + sanitize the four text fields (server side; the client
 * validates too, but a direct POST is the threat model). Returns the first
 * violated rule as a stable code — never free-form server text.
 */
export function sanitizeBookFields(raw: {
  title: unknown;
  category: unknown;
  description: unknown;
  downloadUrl: unknown;
}): { ok: true; value: SanitizedBookFields } | { ok: false; error: BookFieldError } {
  const title = typeof raw.title === "string" ? raw.title.trim() : "";
  if (title.length < 1 || title.length > 200) return { ok: false, error: "invalid_title" };

  const category = typeof raw.category === "string" ? raw.category.trim() : "";
  if (!isBookCategorySlug(category))
    return { ok: false, error: "invalid_category" };

  const descriptionRaw =
    typeof raw.description === "string" ? raw.description.trim() : "";
  if (descriptionRaw.length > 2000)
    return { ok: false, error: "invalid_description" };

  const downloadUrl = validateDownloadUrl(raw.downloadUrl);
  if (!downloadUrl) return { ok: false, error: "invalid_url" };

  return {
    ok: true,
    value: {
      title,
      category,
      description: descriptionRaw.length > 0 ? descriptionRaw : null,
      downloadUrl,
    },
  };
}

/**
 * Validate a cover upload: non-empty, within the 5 MB ceiling, a genuine
 * JPEG/PNG/WebP by content. A non-empty browser MIME hint that contradicts
 * the detected content rejects the file (same contract as
 * ai-service.validateAIFile, restricted to the three cover types).
 */
export function validateCoverFile(
  file: File,
  buffer: Buffer,
): CoverImageType | null {
  if (buffer.length <= 0 || buffer.length > COVER_MAX_BYTES) return null;
  const detected = detectCoverImage(buffer);
  if (!detected) return null;
  const hint = (file.type || "").toLowerCase();
  if (
    hint &&
    hint !== "application/octet-stream" &&
    hint !== COVER_MIME[detected]
  )
    return null;
  return detected;
}

/**
 * Collision-resistant object path for a cover (server-generated):
 * `covers/<uuid>.<ext>` — a UUIDv4 makes overwrites and guessing
 * infeasible; the sanitized extension comes from CONTENT detection.
 */
export function coverObjectPath(imageType: CoverImageType): string {
  return `covers/${randomUUID()}.${COVER_EXT[imageType]}`;
}

/** MIME for a detected cover type (stored + sent as the object content type). */
export function coverMimeType(imageType: CoverImageType): string {
  return COVER_MIME[imageType];
}

// ---------------------------------------------------------------------------
// Public read path (anon/auth client — RLS is the boundary)
// ---------------------------------------------------------------------------

export interface PublishedBook {
  id: string;
  title: string;
  category: string;
  description: string | null;
  cover_path: string | null;
  cover_mime: string | null;
  download_url: string;
  created_at: string;
}

export interface PublishedBookPage {
  books: PublishedBook[];
  total: number;
  page: number;
  pageCount: number;
}

/**
 * Public listing: PUBLISHED books only, with title search, category filter
 * and cursor-free offset pagination (adequate for a curated book catalog).
 *
 * Throws on database failure — the page renders its error state from that;
 * the raw error never reaches the browser.
 */
export async function listPublishedBooks(params: {
  search?: string | null;
  category?: string | null;
  page?: number | null;
}): Promise<PublishedBookPage> {
  const supabase = await createClient();
  const search = (params.search ?? "").trim().slice(0, 100);
  const category = (params.category ?? "").trim().slice(0, 50);
  const page = Math.max(1, Math.floor(params.page ?? 1));

  let query = supabase
    .from("german_books")
    .select(
      "id, title, category, description, cover_path, cover_mime, download_url, created_at",
      { count: "exact" },
    )
    .eq("published", true); // defence in depth on top of the RLS policy
  if (search) query = query.ilike("title", `%${search}%`);
  if (category) query = query.eq("category", category);
  query = query
    .order("created_at", { ascending: false })
    .range((page - 1) * LIBRARY_PAGE_SIZE, page * LIBRARY_PAGE_SIZE - 1);

  const { data, error, count } = await query;
  if (error) throw new Error(error.message);

  const total = count ?? 0;
  return {
    books: (data ?? []) as PublishedBook[],
    total,
    page,
    pageCount: Math.max(1, Math.ceil(total / LIBRARY_PAGE_SIZE)),
  };
}

/**
 * Public read URL for a stored cover. The bucket is public, but the storage
 * SELECT policy (migration 20261203000000) only resolves objects whose
 * `german_books.cover_path` reference is PUBLISHED — unpublished covers are
 * a 404 even with a known URL. Uses the public (anon-key) project URL —
 * no privileged material, pure URL construction.
 */
export function bookCoverPublicUrl(coverPath: string): string {
  const { supabaseUrl } = getSupabaseEnv();
  const base = supabaseUrl.replace(/\/+$/, "");
  const encoded = coverPath
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `${base}/storage/v1/object/public/${BOOK_COVERS_BUCKET}/${encoded}`;
}

// ---------------------------------------------------------------------------
// Admin write path (service role; the CALLER has already run requireAdmin)
// ---------------------------------------------------------------------------

export interface BookAdminRow extends PublishedBook {
  published: boolean;
  updated_at: string;
}

export type BookAdminErrorCode =
  | "unauthorized"
  | "forbidden"
  | "rate_limited"
  | BookFieldError
  | "invalid_cover"
  | "cover_required"
  | "book_not_found"
  | "storage_error"
  | "db_error";

export type BookAdminResult =
  | { ok: true; id?: string }
  | { ok: false; error: BookAdminErrorCode };

/**
 * List ALL books (published + drafts) for the admin panel. Service role by
 * construction — only reachable from the gated /admin surface.
 */
export async function listAdminBooks(): Promise<BookAdminRow[]> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("german_books")
    .select(
      "id, title, category, description, cover_path, cover_mime, download_url, published, created_at, updated_at",
    )
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []) as BookAdminRow[];
}

/**
 * Create a book (optionally with a cover). Order matters for orphan
 * avoidance: the storage object is uploaded FIRST and removed again if the
 * metadata insert fails, so a failed create never leaves a public object
 * without a row. Returns the new book id on success.
 */
export async function createBook(
  actorId: string,
  input: {
    fields: SanitizedBookFields;
    published: boolean;
    cover: { buffer: Buffer; imageType: CoverImageType } | null;
  },
): Promise<BookAdminResult> {
  const admin = createAdminClient();

  let coverPath: string | null = null;
  let coverMime: string | null = null;
  if (input.cover) {
    coverPath = coverObjectPath(input.cover.imageType);
    coverMime = coverMimeType(input.cover.imageType);
    const { error } = await admin.storage
      .from(BOOK_COVERS_BUCKET)
      .upload(coverPath, input.cover.buffer, {
        contentType: coverMime,
        upsert: false,
      });
    if (error) return { ok: false, error: "storage_error" };
  }

  const { error } = await admin.from("german_books").insert({
    title: input.fields.title,
    category: input.fields.category,
    description: input.fields.description,
    cover_path: coverPath,
    cover_mime: coverMime,
    download_url: input.fields.downloadUrl,
    published: input.published,
    created_by: actorId,
  });
  if (error) {
    // Orphan cleanup (best effort, logged): the row did not land, so the
    // object must not stay.
    if (coverPath) {
      const cleanup = await admin
        .storage.from(BOOK_COVERS_BUCKET)
        .remove([coverPath]);
      if (cleanup.error)
        console.error(
          `[books] ORPHANED COVER after failed insert — object="${coverPath}" error="${cleanup.error.message}"`,
        );
    }
    return { ok: false, error: "db_error" };
  }

  return { ok: true };
}

/**
 * Update a book's fields and/or replace its cover. A replacement uploads
 * the NEW object first (fail → nothing changed, no orphan), then updates
 * the row, then deletes the OLD object (best effort — a lingering old cover
 * is unreadable: the storage policy only resolves the row's current
 * published cover_path, and it is at most 5 MB).
 */
export async function updateBook(
  bookId: string,
  input: {
    fields: SanitizedBookFields;
    cover: { buffer: Buffer; imageType: CoverImageType } | null;
  },
): Promise<BookAdminResult> {
  const admin = createAdminClient();

  const { data: existing, error: findError } = await admin
    .from("german_books")
    .select("id, cover_path")
    .eq("id", bookId)
    .maybeSingle<{ id: string; cover_path: string | null }>();
  if (findError || !existing) return { ok: false, error: "book_not_found" };

  let coverPath: string | null = existing.cover_path;
  let coverMime: string | null = null;
  let newCoverPath: string | null = null;
  if (input.cover) {
    const path = coverObjectPath(input.cover.imageType);
    const mime = coverMimeType(input.cover.imageType);
    const { error } = await admin.storage
      .from(BOOK_COVERS_BUCKET)
      .upload(path, input.cover.buffer, { contentType: mime, upsert: false });
    if (error) return { ok: false, error: "storage_error" };
    coverPath = path;
    coverMime = mime;
    newCoverPath = path;
  }

  const patch: Record<string, unknown> = {
    title: input.fields.title,
    category: input.fields.category,
    description: input.fields.description,
    download_url: input.fields.downloadUrl,
  };
  if (input.cover) {
    patch.cover_path = coverPath;
    patch.cover_mime = coverMime;
  }

  const { error } = await admin
    .from("german_books")
    .update(patch)
    .eq("id", bookId);
  if (error) {
    // The row is unchanged: remove the freshly uploaded object (orphan).
    if (input.cover && newCoverPath) {
      const cleanup = await admin
        .storage.from(BOOK_COVERS_BUCKET)
        .remove([newCoverPath]);
      if (cleanup.error)
        console.error(
          `[books] ORPHANED COVER after failed update — object="${newCoverPath}" error="${cleanup.error.message}"`,
        );
    }
    return { ok: false, error: "db_error" };
  }

  // Success: retire the superseded cover (best effort; logged on failure).
  if (input.cover && existing.cover_path && existing.cover_path !== coverPath) {
    const cleanup = await admin
      .storage.from(BOOK_COVERS_BUCKET)
      .remove([existing.cover_path]);
    if (cleanup.error)
      console.error(
        `[books] SUPERSEDED COVER not removed — object="${existing.cover_path}" error="${cleanup.error.message}"`,
      );
  }

  return { ok: true };
}

/** Publish or unpublish (flip the public visibility of one row). */
export async function setBookPublished(
  bookId: string,
  published: boolean,
): Promise<BookAdminResult> {
  const admin = createAdminClient();

  // Verify the row first: a plain update would silently match zero rows for
  // an unknown id, which the UI must report as not-found, not success.
  const { data: existing, error: findError } = await admin
    .from("german_books")
    .select("id")
    .eq("id", bookId)
    .maybeSingle<{ id: string }>();
  if (findError || !existing) return { ok: false, error: "book_not_found" };

  const { error } = await admin
    .from("german_books")
    .update({ published })
    .eq("id", bookId);
  if (error) return { ok: false, error: "db_error" };
  return { ok: true };
}

/**
 * Delete a book: the metadata row goes FIRST (the book is immediately gone
 * from the public listing and the storage read policy), then the cover
 * object (best effort — an unreachable orphan is logged, never silent).
 */
export async function deleteBook(bookId: string): Promise<BookAdminResult> {
  const admin = createAdminClient();

  const { data: existing, error: findError } = await admin
    .from("german_books")
    .select("id, cover_path")
    .eq("id", bookId)
    .maybeSingle<{ id: string; cover_path: string | null }>();
  if (findError || !existing) return { ok: false, error: "book_not_found" };

  const { error } = await admin.from("german_books").delete().eq("id", bookId);
  if (error) return { ok: false, error: "db_error" };

  if (existing.cover_path) {
    const cleanup = await admin
      .storage.from(BOOK_COVERS_BUCKET)
      .remove([existing.cover_path]);
    if (cleanup.error)
      console.error(
        `[books] COVER NOT REMOVED after book deletion — object="${existing.cover_path}" error="${cleanup.error.message}"`,
      );
  }

  return { ok: true };
}
