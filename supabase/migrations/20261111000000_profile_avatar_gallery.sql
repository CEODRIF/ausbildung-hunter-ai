-- ============================================================================
-- 20261111000000_profile_avatar_gallery.sql
--
-- Profile avatar gallery — minimal ADDITIVE migration.
--
-- Reuses the Phase 19 foundation (20261013000000_profile_settings.sql,
-- which already added profiles.first_name / last_name / avatar_url and the
-- public `avatars` storage bucket) and adds exactly ONE new column:
--
--   profiles.avatar — identifier of a built-in gallery avatar
--                     (avatar-01 … avatar-10), enforced by CHECK.
--
-- The application persists IDENTIFIERS, never URLs: the single canonical
-- id → asset mapping lives in src/lib/profile-avatars.ts and points at the
-- 10 hand-authored SVGs under /public/profile-avatars/. No user-supplied
-- URLs, no new tables, no new storage bucket, no data movement.
--
-- MANUAL MIGRATION — this repository applies Supabase migrations by hand
-- (there is no automatic migration step). The code can be deployed BEFORE
-- this migration: the hasProfileAvatarColumn() probe in
-- src/lib/contact-name-support.ts resolves to false while the column is
-- missing, so the avatar gallery simply stays hidden (display-name
-- editing and the initials fallback keep working on the existing schema).
--
-- Idempotent: ADD COLUMN IF NOT EXISTS + a guarded constraint creation,
-- so re-running the file is a no-op.
-- ============================================================================

alter table public.profiles
  add column if not exists avatar text;

-- Allowlist CHECK: only the 10 canonical identifiers (or NULL) — the
-- database-level twin of the application allowlist, so even a direct
-- service-role write can never store an arbitrary value.
do $$
begin
  if not exists (
    select 1
    from pg_constraint c
    where c.conname = 'profiles_avatar_allowlist'
      and c.conrelid = 'public.profiles'::regclass
  ) then
    alter table public.profiles
      add constraint profiles_avatar_allowlist
      check (
        avatar is null
        or avatar in (
          'avatar-01', 'avatar-02', 'avatar-03', 'avatar-04', 'avatar-05',
          'avatar-06', 'avatar-07', 'avatar-08', 'avatar-09', 'avatar-10'
        )
      );
  end if;
end
$$;

comment on column public.profiles.avatar is
  'Built-in avatar-gallery identifier (avatar-01 … avatar-10); canonical mapping to the local /public/profile-avatars/ assets lives in the app (src/lib/profile-avatars.ts).';
