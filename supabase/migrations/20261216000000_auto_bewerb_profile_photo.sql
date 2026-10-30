-- AUTO BEWERB — professional profile photo (Bewerbungsfoto) for Step 1.
--
-- WHY A SEPARATE TABLE (and not columns on auto_bewerb_profiles):
--   * The photo is an INDEPENDENT asset of the workflow: it has its own
--     upload / replace / remove actions, it must survive a CV-file
--     replacement (deleteAutoBewerbProfile wipes the CV row) and it may
--     legitimately exist BEFORE the CV file is analyzed. Coupling it to the
--     CV row would lose the photo whenever the CV row is recreated.
--   * The 7-table setup probe (AUTO_BEWERB_TABLES) intentionally stays
--     untouched: a deployment of this code BEFORE this migration is applied
--     must NOT degrade the whole workflow to "setup pending". The photo
--     feature degrades on its OWN probe (engine: getAutoBewerbPhotoProbe)
--     and the UI hides the photo card until this migration is applied.
--
-- THE PHOTO ITSELF lives in the EXISTING private bucket
-- `application-attachments` (10 MB cap, RLS-locked to `${auth.uid()}/...`
-- folders) under `${user_id}/auto-bewerb/photo/<sha256>.<ext>` — the object
-- name is the sha256 of the PROCESSED bytes, so identical re-uploads are
-- idempotent (same path, no second object) and the path is unguessable.
-- Generated CVs freeze the photo by reference: `personal.photo` stores the
-- opaque server token `abphoto:v1:<sha256>:<ext>` (NOT a URL), and the PDF
-- renderer resolves it through the ownership-scoped engine function
-- resolveAutoBewerbPhotoDataUrl (path built from the verified owner id).
--
-- STORAGE LIFECYCLE (deliberate): replaced and removed photo objects are
-- KEPT in storage (private, owner-scoped, ≤ 5 MB each). Previously saved
-- company CVs hold the frozen reference and must never silently change;
-- the profile row alone is the "current photo" source of truth.
--
-- SAFETY CONTRACT (manual migration — applied by hand, like every other
-- migration in this repository; NOT applied to production by this change):
--   * purely ADDITIVE: one new table, index, updated_at trigger, one RLS
--     policy, one storage bucket row UPDATE (adds `image/webp` to the
--     allowed MIME types — every previously allowed type is preserved).
--     NO existing table, column, enum value, RPC or bucket is dropped.
--   * owner-scoped (user_id PK → auth.users) and RLS-locked to SELECT-only
--     for the owner; all writes run with the service role after an
--     app-layer ownership check (identical contract to auto_bewerb_*).
--   * safe to re-run: `if not exists` table/index/policy, replaceable
--     trigger, idempotent bucket upsert.
--
-- REVERSIBILITY: drop the trigger, policy, index and table; restore the
-- bucket's previous allowed_mime_types (the four original types).

create table if not exists public.auto_bewerb_profile_photos (
  user_id uuid primary key references auth.users(id) on delete cascade,
  -- Magic-byte-validated (image/png | image/jpeg | image/webp).
  photo_mime_type text not null check (photo_mime_type in ('image/png', 'image/jpeg', 'image/webp')),
  -- Processed (optimized) bytes, hard-capped at 5 MB by the CHECK below and
  -- re-validated in the engine before the storage write.
  photo_size_bytes integer not null check (photo_size_bytes between 1 and 5242880),
  -- sha256 of the stored bytes (dedupe + the frozen CV-reference token).
  photo_hash text not null check (char_length(photo_hash) = 64),
  -- `${user_id}/auto-bewerb/photo/${photo_hash}.<jpg|png|webp>` (private bucket).
  photo_storage_path text not null,
  uploaded_at timestamptz not null default timezone('utc', now()),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists auto_bewerb_profile_photos_user_id_idx
  on public.auto_bewerb_profile_photos(user_id);

drop trigger if exists auto_bewerb_profile_photos_set_updated_at on public.auto_bewerb_profile_photos;
create trigger auto_bewerb_profile_photos_set_updated_at
  before update on public.auto_bewerb_profile_photos
  for each row execute function public.set_updated_at();

-- RLS: owner SELECT-only; all writes via the service role (app-layer
-- ownership check first — same contract as every auto_bewerb_* table).
alter table public.auto_bewerb_profile_photos enable row level security;

drop policy if exists "auto_bewerb_profile_photos_owner_select" on public.auto_bewerb_profile_photos;
create policy "auto_bewerb_profile_photos_owner_select"
  on public.auto_bewerb_profile_photos for select to authenticated
  using (auth.uid() = user_id);

revoke insert, update, delete on public.auto_bewerb_profile_photos from anon, authenticated;

-- The bucket's allowed_mime_types currently lists only pdf/doc/docx/png/
-- jpeg; a WEBP photo would be rejected by Supabase Storage BEFORE the app
-- ever sees it. Add image/webp (idempotent upsert, original types kept).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('application-attachments', 'application-attachments', false, 10485760,
        array['application/pdf', 'application/msword',
              'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
              'image/png', 'image/jpeg', 'image/webp'])
on conflict (id) do update
  set public = false,
      file_size_limit = 10485760,
      allowed_mime_types = excluded.allowed_mime_types;
