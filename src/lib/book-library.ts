import "server-only";

import { randomUUID } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { getSupabaseEnv } from "@/lib/supabase/config";
import { isBookCategorySlug } from "@/lib/book-categories";
import { getEntitlements } from "@/lib/billing/entitlements";
import { isUuidShape } from "@/lib/billing/trial";
import type { PlanId } from "@/lib/billing/plans";

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
 * Filter criteria for the public library — the EXACT parameter names the
 * data layer reads (`search` / `category` / `page`).
 *
 * The browser URL uses the shorter `q` / `cat` names (deep-linkable).
 * `parseLibraryQuery` is the single, tested join point between the two
 * shapes. History: the page once passed its own `{ q, cat, page }` object
 * straight into `listPublishedBooks`, which read `params.search` /
 * `params.category` — both `undefined`, so title + category filtering was
 * silently ignored and every search rendered the unfiltered catalog
 * (all-optional param types made the mismatch invisible to tsc).
 */
export interface LibraryFilters {
  search: string | null;
  category: string | null;
  page: number;
}

/**
 * Map the raw `searchParams` record (URL shape: `q`, `cat`, `page`) to the
 * data-layer shape. Trims, treats whitespace-only as empty, clamps the page
 * index to [1, 10000], and ignores non-string values (repeated params).
 */
export function parseLibraryQuery(
  raw: Record<string, string | string[] | undefined>,
): LibraryFilters {
  const first = (key: string): string | null => {
    const value = raw[key];
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  };
  const pageRaw = first("page");
  const page = pageRaw
    ? Math.max(1, Math.min(10_000, Number.parseInt(pageRaw, 10) || 1))
    : 1;
  return { search: first("q"), category: first("cat"), page };
}

/**
 * Escape LIKE/ILIKE wildcards in a user-supplied fragment (Postgres'
 * default escape character is the backslash) so a search for "100%" or
 * "a_b" matches those literal characters instead of acting as wildcards.
 */
function escapeIlikeFragment(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/**
 * Public listing: PUBLISHED books only, with title search, category filter
 * and cursor-free offset pagination (adequate for a curated book catalog).
 *
 * The title match is case-insensitive (ILIKE); `search` and `category`
 * narrow TOGETHER (SQL AND). Throws on database failure — the page renders
 * its error state from that; the raw error never reaches the browser.
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
  if (search) query = query.ilike("title", `%${escapeIlikeFragment(search)}%`);
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

// ======================================================================
// DAILY DOWNLOAD QUOTAS (migration 20261204000000)
// ======================================================================

/**
 * Daily book-download limits per plan (Deutsch Bibliothek).
 *
 * The map is EXHAUSTIVE over PlanId on purpose — the fail-closed
 * philosophy of the entitlement layer: a missing mapping can never
 * silently become a grant. Only trial/plus/pro are granted, per the
 * feature specification; `free` (historical sentinel) and the
 * premium_* commercial plans are 0 (premium_* = product decision to
 * confirm — they are not in the spec's plan list).
 */
export const BOOK_DOWNLOADS_PER_DAY: Record<PlanId, number> = {
  free: 0,
  trial: 1,
  plus: 10,
  pro: 30,
  premium_10d: 0,
  premium_monthly: 0,
};

export type BookQuotaTier = "trial" | "plus" | "pro" | "none";

export interface BookQuotaState {
  /** guest = no session; ready = downloads left today; exhausted = limit
   *  reached (or no eligible plan, which is a permanent 0 today). */
  state: "guest" | "ready" | "exhausted";
  tier: BookQuotaTier;
  limit: number;
  used: number;
  remaining: number;
}

/**
 * UTC day key — the application-wide daily-counter convention
 * (public.daily_usage uses `(timezone('utc', now()))::date` in every
 * counter RPC). The RPC and this helper must agree on the day.
 */
export function utcToday(): string {
  return new Date().toISOString().slice(0, 10);
}

function tierFor(
  planId: PlanId,
  source: "subscription" | "default",
): BookQuotaTier {
  if (source !== "subscription") return "none";
  switch (planId) {
    case "trial":
    case "plus":
    case "pro":
      return planId;
    default:
      return "none";
  }
}

/**
 * Quota state for display / pre-check. TRUSTED inputs only: the user id
 * comes from the server session; the plan from getEntitlements
 * (subscriptions + billing_plans via the service-role client). Nothing
 * plan-related is ever accepted from the browser.
 */
export async function getBookQuotaState(
  userId: string | null,
): Promise<BookQuotaState> {
  if (!userId) {
    return { state: "guest", tier: "none", limit: 0, used: 0, remaining: 0 };
  }

  const entitlements = await getEntitlements(userId);
  const tier = tierFor(entitlements.planId, entitlements.source);
  const limit = BOOK_DOWNLOADS_PER_DAY[entitlements.planId] ?? 0;

  if (limit === 0) {
    // Expired trial / no plan / premium_* → zero downloads today.
    return { state: "exhausted", tier, limit: 0, used: 0, remaining: 0 };
  }

  const admin = createAdminClient();
  const { data } = await admin
    .from("book_download_quota")
    .select("used_count")
    .eq("user_id", userId)
    .eq("quota_day", utcToday())
    .maybeSingle<{ used_count: number }>();
  const used = data?.used_count ?? 0;
  const remaining = Math.max(0, limit - used);
  return {
    state: remaining > 0 ? "ready" : "exhausted",
    tier,
    limit,
    used,
    remaining,
  };
}

export interface BookDownloadOk {
  ok: true;
  /** The external source URL — delivered ONLY after the server granted
   *  the initiation (the UI never sees it before quota authorization). */
  url: string;
  remaining: number;
  tier: BookQuotaTier;
  /** True when the RPC deduped a same-book retry (no extra count). */
  deduplicated: boolean;
}
export interface BookDownloadFail {
  ok: false;
  error:
    | "not_signed_in" // produced by the server action, never by this lib
    | "book_unavailable"
    | "no_eligible_plan"
    | "quota_exhausted"
    /** The quota schema (book_download_quota / reserve_book_download) is
     *  absent from the database — migration 20261204000000 not applied.
     *  A deployment gap, not a transient fault: retrying cannot fix it,
     *  so the UI gets its own honest message instead of "try again". */
    | "quota_unavailable"
    | "db_error";
  remaining: number;
  tier: BookQuotaTier;
}
export type BookDownloadResult = BookDownloadOk | BookDownloadFail;

/** Redact JWT-shaped fragments before anything error-shaped reaches a log. */
const REDACT_JWT =
  /\beyJ[A-Za-z0-9._-]{8,}\.[A-Za-z0-9._-]{8,}\.[A-Za-z0-9._-]{8,}/g;

function scrubLog(value: unknown): string {
  return (typeof value === "string" ? value : String(value ?? "")).replace(
    REDACT_JWT,
    "[redacted-jwt]",
  );
}

/**
 * Failure signature of the quota schema being ABSENT from the database
 * (migration 20261204000000 not applied): an unknown RPC (Postgres
 * 42883 undefined_function / a PostgREST 404-class PGRST2xx schema-cache
 * miss) or an unknown `book_download_quota` relation (42P01). These are
 * DEPLOYMENT GAPS, not transient faults — no retry can fix them, and the
 * user must not be told to "try again" forever. A runtime SQL fault inside
 * the RPC (e.g. its `invalid_quota_limit` guard, code P0001) is NOT a
 * schema miss and stays `db_error`. Exported for the regression tests.
 */
export function isQuotaSchemaMissing(
  error:
    | { message?: unknown; details?: unknown; code?: unknown }
    | null
    | undefined,
): boolean {
  if (!error) return false;
  const code =
    typeof error.code === "string" ? error.code.toUpperCase() : "";
  if (
    code === "42883" || // undefined_function
    code === "42P01" || // undefined_table
    code === "PGRST201" || // resource not found
    code === "PGRST202" || // schema cache miss
    code === "PGRST203" || // table not found
    code === "PGRST204" // schema cache error
  )
    return true;
  const text = `${error.message ?? ""} ${error.details ?? ""}`.toLowerCase();
  return (
    /does not exist/.test(text) ||
    /could not find/.test(text) ||
    /not found in the schema cache/.test(text)
  );
}

/**
 * Authorize + record ONE download initiation for the session user.
 *
 *   1. the book exists and is PUBLISHED — re-checked server-side (a book
 *      may have been unpublished since the page rendered);
 *   2. plan resolution via getEntitlements → the daily limit (fail-closed
 *      0 when nothing eligible resolves — absence of a profile/plan never
 *      grants a trial);
 *   3. the atomic service-role RPC `reserve_book_download` (row lock,
 *      UTC day key = daily reset, 10 s same-book dedup) decides
 *      granted/denied — the ONLY path that mutates the counter.
 */
export async function initiateBookDownload(
  userId: string,
  bookId: string,
): Promise<BookDownloadResult> {
  if (!isUuidShape(userId) || !isUuidShape(bookId)) {
    return { ok: false, error: "book_unavailable", remaining: 0, tier: "none" };
  }

  const admin = createAdminClient();

  const { data: book, error: bookError } = await admin
    .from("german_books")
    .select("id, download_url, published")
    .eq("id", bookId)
    .maybeSingle<{ id: string; download_url: string; published: boolean }>();
  if (bookError || !book || book.published !== true) {
    return { ok: false, error: "book_unavailable", remaining: 0, tier: "none" };
  }

  const entitlements = await getEntitlements(userId);
  const tier = tierFor(entitlements.planId, entitlements.source);
  const limit = BOOK_DOWNLOADS_PER_DAY[entitlements.planId] ?? 0;
  if (limit === 0) {
    return { ok: false, error: "no_eligible_plan", remaining: 0, tier };
  }

  const { data, error } = await admin.rpc("reserve_book_download", {
    p_user_id: userId,
    p_book_id: bookId,
    p_limit: limit,
  });
  if (error) {
    // Classify before responding: a MISSING schema (function/table) is an
    // unresolved deployment gap — the user message must not invite endless
    // retries, and the log must name the exact artifact to apply. The raw
    // (scrubbed) PostgREST error stays server-side; the user only sees the
    // stable code. No grant is ever issued on this branch.
    const missingSchema = isQuotaSchemaMissing(error);
    console.error(
      `[books] reserve_book_download RPC failed — code="${scrubLog(error.code ?? "?")}" message="${scrubLog(error.message)}" details="${scrubLog(error.details ?? "")}"` +
        (missingSchema
          ? " | ACTION REQUIRED: quota schema missing — apply supabase/migrations/20261204000000_book_download_quota.sql (table book_download_quota + function reserve_book_download)."
          : " | check that supabase/migrations/20261204000000_book_download_quota.sql is applied and the service-role client is reachable."),
    );
    return {
      ok: false,
      error: missingSchema ? "quota_unavailable" : "db_error",
      remaining: 0,
      tier,
    };
  }

  // House unwrap idiom: a scalar jsonb may arrive as an object or a 1-row array.
  const obj = (Array.isArray(data) ? data[0] : data) as
    | {
        granted?: boolean;
        deduplicated?: boolean;
        used_count?: number;
        limit?: number;
      }
    | null;
  if (!obj || typeof obj.granted !== "boolean") {
    return { ok: false, error: "db_error", remaining: 0, tier };
  }
  if (obj.granted !== true) {
    return { ok: false, error: "quota_exhausted", remaining: 0, tier };
  }

  const usedCount = typeof obj.used_count === "number" ? obj.used_count : 0;
  const effectiveLimit = typeof obj.limit === "number" ? obj.limit : limit;
  return {
    ok: true,
    url: book.download_url,
    remaining: Math.max(0, effectiveLimit - usedCount),
    tier,
    deduplicated: obj.deduplicated === true,
  };
}
