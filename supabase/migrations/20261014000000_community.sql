-- ---------------------------------------------------------------------------
-- Community group chat.
--
-- A shared chat for all authenticated members:
--   * community_profiles   — display name + one of exactly 5 predefined
--                            project avatars (no user-uploaded profile pics)
--   * community_messages   — text and/or image messages
--   * community_read_state — per-user unread cursor (last read message id)
--
-- Conventions follow the existing schema: FKs to auth.users with cascade,
-- set_updated_at() trigger, named RLS policies, storage.foldername()
-- ownership boundaries for the private `community-images` bucket.
--
-- Realtime: INSERT events on community_messages are streamed to
-- authenticated clients via the default supabase_realtime publication
-- (RLS applies, so a client only receives rows it can SELECT).
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- community_profiles
-- ---------------------------------------------------------------------------

create table public.community_profiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users(id) on delete cascade,
  display_name text not null,
  avatar_id text not null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint community_profiles_display_name_length
    check (char_length(trim(display_name)) between 1 and 40),
  constraint community_profiles_avatar_id
    check (avatar_id in ('avatar-1', 'avatar-2', 'avatar-3', 'avatar-4', 'avatar-5'))
);

create index community_profiles_user_id_idx on public.community_profiles(user_id);

create trigger community_profiles_set_updated_at
before update on public.community_profiles
for each row execute function public.set_updated_at();

alter table public.community_profiles enable row level security;

-- Members see each other's display name/avatar (chat needs both); email and
-- every other auth field stay out of this table by design.
drop policy if exists "Community members can read community profiles" on public.community_profiles;
create policy "Community members can read community profiles"
on public.community_profiles for select to authenticated
using (true);

drop policy if exists "Users can create their own community profile" on public.community_profiles;
create policy "Users can create their own community profile"
on public.community_profiles for insert to authenticated
with check (auth.uid() = user_id);

-- Own profile only (upserts from the onboarding action). No other user's
-- profile row can be touched.
drop policy if exists "Users can update their own community profile" on public.community_profiles;
create policy "Users can update their own community profile"
on public.community_profiles for update to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

-- No delete policy: profile rows are cascade-managed by auth.users.

-- ---------------------------------------------------------------------------
-- community_messages
-- ---------------------------------------------------------------------------

create table public.community_messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  message text,
  image_path text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint community_messages_text_length
    check (message is null or char_length(message) <= 2000),
  constraint community_messages_has_content
    check ((message is not null and char_length(btrim(message)) > 0)
           or (image_path is not null))
);

create index community_messages_created_at_idx on public.community_messages(created_at);
create index community_messages_user_id_idx on public.community_messages(user_id);

create trigger community_messages_set_updated_at
before update on public.community_messages
for each row execute function public.set_updated_at();

alter table public.community_messages enable row level security;

drop policy if exists "Community members can read messages" on public.community_messages;
create policy "Community members can read messages"
on public.community_messages for select to authenticated
using (true);

-- A user can only author messages as themselves; user_id comes from the
-- authenticated session in the API route, and this policy makes any other
-- impersonation attempt fail at the database level as well.
drop policy if exists "Users can create their own messages" on public.community_messages;
create policy "Users can create their own messages"
on public.community_messages for insert to authenticated
with check (auth.uid() = user_id);

-- No update/delete policies: messages are immutable in this product version
-- (there is no edit/delete UI, so none of that surface is exposed).

-- ---------------------------------------------------------------------------
-- community_read_state (unread cursor)
-- ---------------------------------------------------------------------------

create table public.community_read_state (
  user_id uuid primary key references auth.users(id) on delete cascade,
  last_read_message_id uuid references public.community_messages(id) on delete set null,
  updated_at timestamptz not null default timezone('utc', now())
);

create trigger community_read_state_set_updated_at
before update on public.community_read_state
for each row execute function public.set_updated_at();

alter table public.community_read_state enable row level security;

drop policy if exists "Users can manage their own read state" on public.community_read_state;
create policy "Users can manage their own read state"
on public.community_read_state for all to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- Realtime — stream message inserts to authenticated clients.
-- Idempotent: only added when not already present in the publication.
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'community_messages'
  ) then
    alter publication supabase_realtime add table public.community_messages;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- Storage — private `community-images` bucket.
--
-- Paths are server-generated as {user_id}/{message_id}/image.{ext}; the
-- first path segment is the ownership boundary, exactly like the existing
-- avatars / ai-files buckets. The bucket is private: reads are authenticated
-- members only (the client fetches a short-lived signed URL), and writes are
-- strictly owner-folder, so no user can overwrite or read-modify-write
-- another user's files.
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('community-images', 'community-images', false, 2097152, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set
  public = false,
  file_size_limit = 2097152,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Community members can read community images" on storage.objects;
create policy "Community members can read community images"
on storage.objects for select to authenticated
using (bucket_id = 'community-images');

drop policy if exists "Users can upload community images to their own folder" on storage.objects;
create policy "Users can upload community images to their own folder"
on storage.objects for insert to authenticated
with check (bucket_id = 'community-images' and (storage.foldername(name))[1] = auth.uid()::text);

-- No update/delete storage policies: message images are immutable.
