-- Phase 1 of the Community v2 rebuild — Discord-like rooms + identity.
--
-- Builds on 20261014000000_community.sql (kept intact):
--   * data-driven room CATEGORIES and ROOMS (seeded, deterministic UUIDs;
--     room names are German on purpose — they are German topics)
--   * community_messages gains room_id + reply_to_message_id and becomes
--     EDITABLE / DELETABLE by the author (new RLS policies)
--   * reactions (fixed emoji set) + mentions (server-written)
--   * per-room read state (drives the per-room unread dots + nav badge)
--   * community identity: the display name becomes a UNIQUE generated
--     username (case-insensitive unique index; duplicates de-conflicted)
--   * avatars: exactly four (two feminine, two masculine); legacy avatar-5
--     rows are remapped before the constraint is tightened
--   * storage: members may delete their OWN uploaded images (so a deleted
--     message can clean up its file)
--
-- Design notes:
--   * Seed rows use DETERMINISTIC uuids so application code can rely on them
--     (notably the default room for pre-existing messages).
--   * Mentions are written by the API layer (service role) — members have no
--     insert policy on community_message_mentions.
--   * community_room_unread_summary() is called with the authenticated user's
--     id (never client input) via the admin client or an RLS session.

-- ---------------------------------------------------------------------------
-- 1. Room categories (fixed German names; data-driven, not hard-coded in UI)
-- ---------------------------------------------------------------------------

create table public.community_room_categories (
  id uuid primary key,
  slug text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  name text not null check (char_length(name) between 1 and 40),
  position integer not null default 0
);

alter table public.community_room_categories enable row level security;

create policy "Community members can read room categories"
  on public.community_room_categories for select
  to authenticated
  using (true);

insert into public.community_room_categories (id, slug, name, position) values
  ('b0000000-0000-4000-8000-000000000001', 'allgemein',             'ALLGEMEIN',           1),
  ('b0000000-0000-4000-8000-000000000002', 'ausbildung-und-arbeit', 'AUSBILDUNG & ARBEIT', 2),
  ('b0000000-0000-4000-8000-000000000003', 'deutschland',           'DEUTSCHLAND',         3),
  ('b0000000-0000-4000-8000-000000000004', 'studium',               'STUDIUM',             4),
  ('b0000000-0000-4000-8000-000000000005', 'deutsch-und-pruefungen','DEUTSCH & PRÜFUNGEN', 5);

-- ---------------------------------------------------------------------------
-- 2. Rooms
-- ---------------------------------------------------------------------------

create table public.community_rooms (
  id uuid primary key,
  slug text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  name text not null check (char_length(name) between 1 and 60),
  category_id uuid not null references public.community_room_categories(id) on delete cascade,
  description text check (description is null or char_length(description) between 1 and 300),
  icon text not null default 'hash',
  position integer not null default 0,
  enabled boolean not null default true,
  created_at timestamptz not null default timezone('utc', now())
);

create index community_rooms_category_idx
  on public.community_rooms (category_id, position);

alter table public.community_rooms enable row level security;

-- Members only ever see ENABLED rooms (admin/service-role can see all).
create policy "Community members can read enabled rooms"
  on public.community_rooms for select
  to authenticated
  using (enabled = true);

insert into public.community_rooms (id, slug, name, category_id, description, icon, position) values
  ('b1000000-0000-4000-8000-000000000001', 'public-chat', 'Public Chat',
   'b0000000-0000-4000-8000-000000000001', 'Allgemeiner Austausch für alle Mitglieder.', 'hash', 1),
  ('b1000000-0000-4000-8000-000000000002', 'fragen-und-antworten', 'Fragen & Antworten',
   'b0000000-0000-4000-8000-000000000001', 'Stelle deine Frage und erhalte Hilfe von der Community.', 'help', 2),
  ('b1000000-0000-4000-8000-000000000003', 'probleme', 'Probleme',
   'b0000000-0000-4000-8000-000000000001', 'Beschreibe ein Problem und findet gemeinsam eine Lösung.', 'alert', 3),
  ('b1000000-0000-4000-8000-000000000004', 'ausbildung', 'Ausbildung',
   'b0000000-0000-4000-8000-000000000002', 'Alles rund um die Ausbildung: Bewerbung, Probezeit, Gehalt.', 'briefcase', 4),
  ('b1000000-0000-4000-8000-000000000005', 'arbeit', 'Arbeit & Jobs',
   'b0000000-0000-4000-8000-000000000002', 'Jobs, Arbeitsverträge und Erfahrungen aus der Arbeitswelt.', 'target', 5),
  ('b1000000-0000-4000-8000-000000000006', 'praktikum', 'Praktikum',
   'b0000000-0000-4000-8000-000000000002', 'Praktika finden, bewerten und Tipps für den Alltag.', 'clock', 6),
  ('b1000000-0000-4000-8000-000000000007', 'kuendigung', 'Kündigung',
   'b0000000-0000-4000-8000-000000000002', 'Fristen, Formulare und Erfahrungen zu Kündigungen.', 'logout', 7),
  ('b1000000-0000-4000-8000-000000000008', 'bewerbungsunterlagen', 'Bewerbungsunterlagen',
   'b0000000-0000-4000-8000-000000000002', 'Lebenslauf, Anschreiben und Deckblatt — Feedback willkommen.', 'file', 8),
  ('b1000000-0000-4000-8000-000000000009', 'marokkaner-in-deutschland', 'Marokkaner in Deutschland',
   'b0000000-0000-4000-8000-000000000003', 'Community für Marokkaner in Deutschland: Kultur, Alltagsleben, Austausch.', 'globe', 9),
  ('b1000000-0000-4000-8000-00000000000a', 'konsulat', 'Konsulat',
   'b0000000-0000-4000-8000-000000000003', 'Fragen und Erfahrungen rund um das Konsulat: Termine, Ausweise, Urkunden.', 'mail', 10),
  ('b1000000-0000-4000-8000-00000000000b', 'anerkennung-von-abschluessen', 'Anerkennung von Abschlüssen',
   'b0000000-0000-4000-8000-000000000003', 'Anerkennung von marokkanischen Abschlüssen in Deutschland.', 'check', 11),
  ('b1000000-0000-4000-8000-00000000000c', 'visa', 'Visa',
   'b0000000-0000-4000-8000-000000000003', 'Visa, Aufenthaltstitel und Einreise nach Deutschland.', 'idCard', 12),
  ('b1000000-0000-4000-8000-00000000000d', 'studium', 'Studium',
   'b0000000-0000-4000-8000-000000000004', 'Studium in Deutschland: Auswahl, Finanzierung, Leben als Student.', 'book', 13),
  ('b1000000-0000-4000-8000-00000000000e', 'a1', 'A1',
   'b0000000-0000-4000-8000-000000000005', 'Deutsch lernen auf dem Niveau A1: erste Schritte und Prüfungstipps.', 'message', 14),
  ('b1000000-0000-4000-8000-00000000000f', 'a2', 'A2',
   'b0000000-0000-4000-8000-000000000005', 'Deutsch lernen auf dem Niveau A2: Grammatik, Wortschatz, Prüfungstipps.', 'message', 15),
  ('b1000000-0000-4000-8000-000000000010', 'b1', 'B1',
   'b0000000-0000-4000-8000-000000000005', 'Deutsch lernen auf dem Niveau B1: Vorbereitung und Erfahrungen.', 'message', 16),
  ('b1000000-0000-4000-8000-000000000011', 'b2', 'B2',
   'b0000000-0000-4000-8000-000000000005', 'Deutsch lernen auf dem Niveau B2: fortgeschrittene Themen und Prüfungstipps.', 'message', 17),
  ('b1000000-0000-4000-8000-000000000012', 'goethe', 'Goethe-Institut',
   'b0000000-0000-4000-8000-000000000005', 'Erfahrungen mit Kursen und Prüfungen des Goethe-Instituts.', 'spark', 18),
  ('b1000000-0000-4000-8000-000000000013', 'oesd', 'ÖSD',
   'b0000000-0000-4000-8000-000000000005', 'Erfahrungen mit ÖSD-Kursen und -Prüfungen.', 'spark', 19),
  ('b1000000-0000-4000-8000-000000000014', 'telc', 'TELC',
   'b0000000-0000-4000-8000-000000000005', 'Erfahrungen mit TELC-Kursen und -Prüfungen.', 'spark', 20),
  ('b1000000-0000-4000-8000-000000000015', 'ecl', 'ECL (Cambridge)',
   'b0000000-0000-4000-8000-000000000005', 'Erfahrungen mit Cambridge ECL-Prüfungen.', 'spark', 21);

-- ---------------------------------------------------------------------------
-- 3. Messages: room scope, replies, owner edit + delete
-- ---------------------------------------------------------------------------

-- Every message belongs to a room. Pre-existing rows (the old single global
-- chat) land in #public-chat via the DEFAULT.
alter table public.community_messages
  add column room_id uuid not null
  default 'b1000000-0000-4000-8000-000000000001'
  references public.community_rooms(id) on delete cascade;

-- Optional reply: deleting the parent keeps the child (set null), so a
-- message is never destroyed because someone replied to it.
alter table public.community_messages
  add column reply_to_message_id uuid
  references public.community_messages(id) on delete set null;

create index community_messages_room_idx
  on public.community_messages (room_id, created_at desc);

-- The original policies (select all, insert own) stay untouched; the two new
-- ones make messages editable/deletable BY THE AUTHOR ONLY. Moderation
-- deletion (Phase 4) runs through the service role and bypasses RLS.
create policy "Community members can update their own messages"
  on public.community_messages for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy "Community members can delete their own messages"
  on public.community_messages for delete
  to authenticated
  using (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- 4. Reactions (fixed emoji set; 👍 doubles as the "helpful" signal that
--    later feeds reputation — no free-text emoji = no DB bloat)
-- ---------------------------------------------------------------------------

create table public.community_message_reactions (
  message_id uuid not null references public.community_messages(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  emoji text not null check (emoji in ('👍', '❤️', '😂', '😮', '😢', '🔥', '✅')),
  created_at timestamptz not null default timezone('utc', now()),
  primary key (message_id, user_id, emoji)
);

create index community_message_reactions_message_idx
  on public.community_message_reactions (message_id);

alter table public.community_message_reactions enable row level security;

create policy "Community members can read reactions"
  on public.community_message_reactions for select
  to authenticated
  using (true);

create policy "Members can add their own reaction"
  on public.community_message_reactions for insert
  to authenticated
  with check (user_id = auth.uid());

create policy "Members can remove their own reaction"
  on public.community_message_reactions for delete
  to authenticated
  using (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- 5. Mentions — written by the API layer (service role) when a message is
--    sent/edited. Members have NO write policy here.
-- ---------------------------------------------------------------------------

create table public.community_message_mentions (
  message_id uuid not null references public.community_messages(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default timezone('utc', now()),
  primary key (message_id, user_id)
);

create index community_message_mentions_user_idx
  on public.community_message_mentions (user_id);

alter table public.community_message_mentions enable row level security;

-- A user may read the fact that THEY were mentioned (used by notifications).
create policy "Users can see mentions of themselves"
  on public.community_message_mentions for select
  to authenticated
  using (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- 6. Per-room read state (drives the per-room unread dots + the nav badge)
-- ---------------------------------------------------------------------------

create table public.community_room_read_state (
  user_id uuid not null references auth.users(id) on delete cascade,
  room_id uuid not null references public.community_rooms(id) on delete cascade,
  last_read_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  primary key (user_id, room_id)
);

create trigger community_room_read_state_set_updated_at
  before update on public.community_room_read_state
  for each row execute function public.set_updated_at();

alter table public.community_room_read_state enable row level security;

create policy "Users can manage their own room read state"
  on public.community_room_read_state for all
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- One-shot summary for the sidebar: per enabled room, how many messages
-- arrived after this user's last read (no state → all count as unread).
create or replace function public.community_room_unread_summary(p_user uuid)
returns table (room_id uuid, unread bigint)
language sql
stable
as $$
  select r.id,
         (
           select count(*)
           from public.community_messages m
           where m.room_id = r.id
             and (rrs.last_read_at is null or m.created_at > rrs.last_read_at)
         )
  from public.community_rooms r
  left join (
    select s.room_id, s.last_read_at
    from public.community_room_read_state s
    where s.user_id = p_user
  ) rrs on rrs.room_id = r.id
  where r.enabled = true;
$$;

revoke execute on function public.community_room_unread_summary(uuid) from public, anon;
grant execute on function public.community_room_unread_summary(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 7. Community identity: unique (case-insensitive) generated usernames
-- ---------------------------------------------------------------------------

-- (a) Legacy rows that used the retired fifth avatar get the first one.
update public.community_profiles
   set avatar_id = 'avatar-1'
 where avatar_id = 'avatar-5';

-- (b) Tighten the avatar set to exactly four (2 feminine, 2 masculine).
alter table public.community_profiles
  drop constraint community_profiles_avatar_id;
alter table public.community_profiles
  add constraint community_profiles_avatar_id
  check (avatar_id in ('avatar-1', 'avatar-2', 'avatar-3', 'avatar-4'));

-- (c) De-conflict duplicate display names BEFORE the unique index exists.
--     Each conflicting row gets a short, stable user-id suffix (the name is
--     truncated so the 1–40 character check still holds).
do $$
declare
  p record;
begin
  for p in
    select p1.user_id
    from public.community_profiles p1
    where exists (
      select 1
      from public.community_profiles p2
      where p2.user_id <> p1.user_id
        and lower(p2.display_name) = lower(p1.display_name)
    )
  loop
    update public.community_profiles
       set display_name = left(display_name, 27) || '-' || substr(user_id::text, 1, 9)
     where user_id = p.user_id;
  end loop;
end
$$;

-- (d) Mention resolution is case-insensitive, so uniqueness is too.
create unique index community_profiles_username_uq
  on public.community_profiles (lower(display_name));

-- ---------------------------------------------------------------------------
-- 8. Storage: owner-based delete for community images
-- ---------------------------------------------------------------------------
-- A deleted message can clean up its own file through the session client
-- (the file always lives in {user_id}/…). Nothing else is exposed.

drop policy if exists "Members can delete their own community images" on storage.objects;
create policy "Members can delete their own community images"
  on storage.objects for delete
  to authenticated
  using (bucket_id = 'community-images'
         and (storage.foldername(name))[1] = auth.uid()::text);
