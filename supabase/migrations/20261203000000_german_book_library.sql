-- ============================================================================
-- Deutsch Bibliothek — public German-language book library.
--
-- Isolated, ADDITIVE migration. Creates exactly one new table, one new
-- storage bucket, and their access policies. It touches NO existing table,
-- policy, function, or data:
--
--   * public.german_books  — book metadata (title, category, description,
--                            cover object path, external download URL,
--                            publication status). Books are LINKS: the app
--                            never downloads, stores, or mirrors PDFs — only
--                            the cover image lives in Supabase Storage.
--   * storage bucket "book-covers" — public read-only display (avatars
--                            model), 5 MB cap, image/jpeg|png|webp only,
--                            NO user policies (API routes default-deny).
--
-- AUTHORIZATION MODEL (no new role, no privilege growth):
--   * READ (public): the SELECT policy is the only user-facing policy and
--     restricts every row to `published = true`. It applies to BOTH anon and
--     authenticated — a logged-in ordinary user sees exactly what a visitor
--     sees: published books only. Drafts are invisible at the database level
--     for every non-service-role role, including through direct API calls.
--   * WRITE (admin): there is deliberately NO insert/update/delete policy
--     for any user role, and write privileges are explicitly revoked. The
--     app layer (src/app/admin/books/actions.ts) performs every mutation
--     with the service-role client AFTER the established admin gate
--     (requireAdmin — session user + public.admins membership + profile row,
--     see src/lib/billing/admin.ts). Hiding the UI is never the gate.
--   * STORAGE (admin): the bucket has NO user insert/update/delete policy —
--     cover uploads/replacements/deletions happen exclusively through the
--     service role in the app layer, gated the same way.
--
-- MANUAL MIGRATION — this repository applies Supabase migrations by hand
-- (no automatic migration step). Deploy order for a clean rollout:
--   1. apply this file to the target database,
--   2. deploy the application.
-- The application degrades gracefully if the table is absent (the public
-- page shows its error state; admin book management reports the missing
-- schema) — but the supported order is migration first.
--
-- Idempotent: every statement is re-apply-safe (if not exists / drop-if-
-- exists / on-conflict), so a partially applied instance converges.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Book metadata table
-- ---------------------------------------------------------------------------
-- Category is a canonical slug (e.g. 'lehrbuch', 'grammatik') — the
-- application allowlist lives in src/lib/book-categories.ts, and the display
-- label is localized per language via the i18n dictionary. The database keeps
-- it OPEN (length-constrained text, not an enum) so a new category is a code
-- change, not a schema change.
--
-- download_url is the administrator-provided EXTERNAL source URL (http/https
-- only; validated in the app layer). It is metadata, never fetched by this
-- application.
create table if not exists public.german_books (
  id uuid primary key default gen_random_uuid(),
  title text not null
    check (char_length(trim(title)) between 1 and 200),
  category text not null
    check (char_length(trim(category)) between 1 and 50),
  description text
    check (description is null or char_length(description) <= 2000),
  -- Full storage object path inside the 'book-covers' bucket
  -- ('covers/<uuid>.<ext>'); null = no cover uploaded yet.
  cover_path text
    check (cover_path is null or char_length(cover_path) between 1 and 500),
  -- Detected content type of the stored cover (content sniffing in the app
  -- layer, never the browser hint); mirrors the bucket allowlist.
  cover_mime text
    check (cover_mime is null
      or cover_mime in ('image/jpeg', 'image/png', 'image/webp')),
  download_url text not null
    check (char_length(download_url) between 10 and 2000),
  published boolean not null default false,
  -- The acting administrator (session-derived, never client-supplied);
  -- set null on account erasure so a GDPR deletion can never fail here.
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

-- ---------------------------------------------------------------------------
-- 2. Indexes (public listing query: published, filter, search, sort)
-- ---------------------------------------------------------------------------
-- The public page's hot path is "published rows, newest first, optionally
-- filtered by category" — one partial covering index serves that plus the
-- pagination count.
create index if not exists german_books_public_idx
  on public.german_books (category, created_at desc)
  where published = true;

-- Title search (current app search is ILIKE; this index is the forward-looking
-- full-text index for the same column — kept on the public half only).
create index if not exists german_books_title_ts_idx
  on public.german_books using gin (to_tsvector('simple', title))
  where published = true;

-- Admin listing (all rows, newest first; service-role reads bypass RLS but
-- still benefit from the sort order).
create index if not exists german_books_created_idx
  on public.german_books (created_at desc);

-- updated_at maintenance — reuses the existing canonical trigger function
-- (public.set_updated_at, migration 20250512000000_auth_foundation).
do $$
begin
  if not exists (
    select 1 from pg_trigger
    where tgname = 'german_books_set_updated_at'
      and tgrelid = 'public.german_books'::regclass
  ) then
    create trigger german_books_set_updated_at
      before update on public.german_books
      for each row execute function public.set_updated_at();
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 3. Row Level Security
-- ---------------------------------------------------------------------------
alter table public.german_books enable row level security;

-- EXPLICIT privilege boundary (defence in depth on top of RLS): the public
-- roles may SELECT only — every write verb is revoked, so even a policy
-- misconfiguration can never expose a write path to the browser.
grant select on public.german_books to anon, authenticated;
revoke insert, update, delete, truncate on public.german_books from anon, authenticated;

-- The single public read policy: PUBLISHED rows only, for both anonymous
-- visitors and logged-in ordinary users. There is NO admin read policy on
-- purpose — administrators read drafts through the service-role client in
-- the app layer (same pattern as the /admin users listing), so no extra
-- privilege is granted to any user role.
drop policy if exists "Anyone can read published books" on public.german_books;
create policy "Anyone can read published books"
  on public.german_books for select
  to anon, authenticated
  using (published = true);

-- Intentionally NO insert / update / delete policies for any user role:
-- all book management runs with the service role after the app-layer
-- requireAdmin() gate.

-- ---------------------------------------------------------------------------
-- 4. Storage bucket: book covers
-- ---------------------------------------------------------------------------
-- Public READ-ONLY bucket, mirroring the 'avatars' bucket shape
-- (20261013000000) — the repository's established model for public
-- image display:
--   * the bucket is public so the browser can display covers through the
--     plain public object URL (the same mechanism avatars use; the CSP
--     already whitelists the Supabase origin for exactly this),
--   * hard 5 MB file ceiling,
--   * image/jpeg | image/png | image/webp only (bucket-level allowlist —
--     the second line under the app-layer content sniffing),
--   * unique, collision-resistant object paths generated server-side
--     ('covers/<uuid>.<ext>').
--
-- PRIVACY MODEL (why no user SELECT policy is needed, and none is added):
--   * The repo's global security invariant (tests/security/authorization.
--     test.ts) requires every storage.objects SELECT policy to be
--     owner-folder scoped — a generic "anyone can read" policy would
--     weaken that contract, so public display relies on the public bucket
--     route exactly like avatars do.
--   * A cover URL only ever reaches a browser through the public library
--     listing, which RLS restricts to PUBLISHED books — unpublished cover
--     paths are never disclosed by any app surface or API response.
--   * The public object URL requires the EXACT object path, which is a
--     server-generated UUIDv4 (covers/<uuid>.<ext>): not enumerable and
--     not derivable from the book id (the DB row and the object name are
--     independently random).
--   * Every JWT/API route against this bucket is DENIED BY DEFAULT —
--     there is no user insert/update/delete/select policy at all, so
--     direct API requests cannot read, upload, replace, or delete covers.
--     Cover upload/replacement/deletion is performed exclusively by the
--     service-role client in the app layer, after the requireAdmin() gate
--     (same two-layer model as the admin user actions).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('book-covers', 'book-covers', true, 5242880,
        array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set
  public = true,
  file_size_limit = 5242880,
  allowed_mime_types = excluded.allowed_mime_types;

-- Intentionally NO policies on storage.objects for this bucket:
--   - no user select policy (public display via the public bucket route;
--     the owner-folder invariant of the global security tests stays
--     unweakened),
--   - no user insert/update/delete policy (admin-only storage operations
--     through the service role in the app layer).
