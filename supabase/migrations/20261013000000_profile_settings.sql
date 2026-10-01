-- ---------------------------------------------------------------------------
-- Phase 19 — Profile settings (name parts + avatar).
--
-- profiles gains first_name / last_name (editable in /settings/profile) and
-- avatar_url (public URL of the object in the `avatars` bucket). The existing
-- full_name column stays the display name used across the app (CV templates,
-- dashboard, notifications); the server action keeps it in sync as
-- "<first_name> <last_name>", so nothing else has to change and the
-- protect_profile_system_fields trigger keeps guarding it for authenticated
-- clients.
--
-- The `avatars` bucket follows the existing bucket conventions
-- (ai-files / application-attachments): a `{auth.uid()}/...` folder prefix is
-- the ownership boundary and every write policy is scoped to it. It is public
-- because the avatar is rendered in the header on every page — a public object
-- URL avoids signing on each render — while writes stay owner-only, so no user
-- can read-modify-write another user's folder.
-- ---------------------------------------------------------------------------

alter table public.profiles
  add column if not exists first_name text,
  add column if not exists last_name text,
  add column if not exists avatar_url text;

alter table public.profiles
  drop constraint if exists profiles_first_name_length,
  drop constraint if exists profiles_last_name_length;

alter table public.profiles
  add constraint profiles_first_name_length
    check (first_name is null or char_length(trim(first_name)) between 1 and 60),
  add constraint profiles_last_name_length
    check (last_name is null or char_length(trim(last_name)) between 1 and 60);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatars', 'avatars', true, 2097152, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set
  public = true,
  file_size_limit = 2097152,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Users can upload their own avatar" on storage.objects;
create policy "Users can upload their own avatar"
on storage.objects for insert to authenticated
with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "Users can update their own avatar" on storage.objects;
create policy "Users can update their own avatar"
on storage.objects for update to authenticated
using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text)
with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "Users can delete their own avatar" on storage.objects;
create policy "Users can delete their own avatar"
on storage.objects for delete to authenticated
using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
