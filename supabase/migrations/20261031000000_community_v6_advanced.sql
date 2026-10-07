-- ============================================================================
-- Community Phase 5 — advanced community: search / Q&A / pins / reports /
-- moderation / roles / reputation.
--
-- EXTENDS the v1–v5 community schema in place (no earlier migration file is
-- modified). Every new object is introduced here, idempotently where it
-- matters (add column if not exists / add value if not exists).
--
-- NEW TABLES
--   community_memberships         — the ONE community-role source (member /
--                                   helper / moderator / admin / owner).
--                                   Distinct from the Supabase auth role by
--                                   design; auto-created (role 'member') for
--                                   every community profile.
--   community_questions           — Q&A questions in qna_enabled rooms.
--   community_answers             — answers to questions (soft-deleteable).
--   community_pins                — pinned room messages (1 row per message).
--   community_reports             — user reports (reporter sees own only).
--   community_moderation_actions  — APPEND-ONLY moderation audit log.
--   community_reputation_events   — idempotent, server-determined points.
--
-- EXISTING TABLES (additive columns only)
--   community_rooms               — + qna_enabled
--   community_messages            — + hidden_by / hidden_at (moderation),
--                                   + search_vector (generated FTS)
--   community_profiles            — + community_suspended,
--                                   + community_muted_until (moderation)
--   notifications                 — + question_id / answer_id refs,
--                                   + types 'answer', 'answer_accepted',
--                                   + 'moderation' (the v4 CHECK constraint
--                                   is re-created with the added branches)
--
-- SEARCH
--   PostgreSQL full-text search (tsvector + GIN + websearch_to_tsquery) on
--   messages / questions / answers / profiles / rooms. ONE SECURITY DEFINER
--   entry point (community_search) with pinned search_path, fully qualified
--   objects and a hard auth.uid() = p_user check. DIRECT MESSAGES ARE NOT
--   SEARCHED — the function never references any DM table. Room access,
--   hidden (moderated) rows, deleted answers and blocks in EITHER direction
--   are all enforced inside the function. Keyset pagination
--   ((created_at, id) cursor), bounded page size, no offset.
--
-- REALTIME
--   community_questions + community_answers join the publication so the
--   question page updates live (status / accepted / new answers). The Phase
--   3 notifications channel and the Phase 4 voice metadata channel are
--   untouched. Pins/reports use client broadcasts (no new publication).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Roles — community_memberships (the single community-role source)
-- ---------------------------------------------------------------------------

create table if not exists public.community_memberships (
  user_id uuid primary key references auth.users(id) on delete cascade,
  role text not null default 'member'
    check (role in ('member', 'helper', 'moderator', 'admin', 'owner')),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

-- Seed: every existing community member starts as 'member'.
insert into public.community_memberships (user_id, role)
select user_id, 'member'
from public.community_profiles
on conflict (user_id) do nothing;

-- New profiles get a membership row automatically (onboarding upsert →
-- insert path). 'member' is the only role a user can ever self-receive.
create or replace function public.handle_community_membership()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.community_memberships (user_id, role)
  values (new.user_id, 'member')
  on conflict (user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists community_profiles_membership on public.community_profiles;
create trigger community_profiles_membership
  after insert on public.community_profiles
  for each row
  execute function public.handle_community_membership();

alter table public.community_memberships enable row level security;

-- Community roles are visible to members (the UI badges moderators); NO
-- user write policy — role changes are service-role only (admin actions).
create policy "Members can read community roles"
  on public.community_memberships for select
  to authenticated
  using (true);

-- The session user's role (default 'member' when no row exists yet — the
-- trigger only covers new rows; a row-less user is a plain member).
create or replace function public.community_user_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select m.role from public.community_memberships m where m.user_id = auth.uid()),
    'member'
  );
$$;

create or replace function public.community_is_moderator()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.community_user_role() in ('moderator', 'admin', 'owner');
$$;

create or replace function public.community_is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.community_user_role() in ('admin', 'owner');
$$;

revoke execute on function public.community_user_role() from public, anon;
grant execute on function public.community_user_role() to authenticated, service_role;
revoke execute on function public.community_is_moderator() from public, anon;
grant execute on function public.community_is_moderator() to authenticated, service_role;
revoke execute on function public.community_is_admin() from public, anon;
grant execute on function public.community_is_admin() to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. Moderation flags on profiles (suspend / temporary mute)
-- ---------------------------------------------------------------------------

alter table public.community_profiles
  add column if not exists community_suspended boolean not null default false;

alter table public.community_profiles
  add column if not exists community_muted_until timestamptz;

-- ---------------------------------------------------------------------------
-- 3. Rooms — Q&A flag + the suggested category structure
-- ---------------------------------------------------------------------------

alter table public.community_rooms
  add column if not exists qna_enabled boolean not null default false;

-- The room directory is reorganized into the suggested categories. Room SLUGS
-- are unchanged (no broken links); only category names and membership move.
update public.community_room_categories set name = 'COMMUNITY',      position = 1 where id = 'b0000000-0000-4000-8000-000000000001';
update public.community_room_categories set name = 'AUSBILDUNG',     position = 2 where id = 'b0000000-0000-4000-8000-000000000002';
update public.community_room_categories set name = 'VISA & BEHÖRDEN', position = 7 where id = 'b0000000-0000-4000-8000-000000000003';
update public.community_room_categories set name = 'STUDIUM',        position = 4 where id = 'b0000000-0000-4000-8000-000000000004';
update public.community_room_categories set name = 'SPRACHE',        position = 5 where id = 'b0000000-0000-4000-8000-000000000005';
insert into public.community_room_categories (id, slug, name, position) values
  ('b0000000-0000-4000-8000-000000000006', 'arbeit',    'ARBEIT', 3),
  ('b0000000-0000-4000-8000-000000000007', 'dokumente', 'DOKUMENTE', 6)
on conflict (id) do nothing;

-- COMMUNITY
update public.community_rooms set category_id = 'b0000000-0000-4000-8000-000000000001', position = 1 where slug = 'public-chat';
update public.community_rooms set category_id = 'b0000000-0000-4000-8000-000000000001', position = 2 where slug = 'fragen-und-antworten';
update public.community_rooms set category_id = 'b0000000-0000-4000-8000-000000000001', position = 3 where slug = 'probleme';
update public.community_rooms set category_id = 'b0000000-0000-4000-8000-000000000001', position = 4 where slug = 'marokkaner-in-deutschland';
-- AUSBILDUNG
update public.community_rooms set category_id = 'b0000000-0000-4000-8000-000000000002', position = 1 where slug = 'ausbildung';
update public.community_rooms set category_id = 'b0000000-0000-4000-8000-000000000002', position = 2 where slug = 'praktikum';
update public.community_rooms set category_id = 'b0000000-0000-4000-8000-000000000002', position = 3 where slug = 'kuendigung';
-- ARBEIT
update public.community_rooms set category_id = 'b0000000-0000-4000-8000-000000000006', position = 1 where slug = 'arbeit';
-- STUDIUM
update public.community_rooms set category_id = 'b0000000-0000-4000-8000-000000000004', position = 1 where slug = 'studium';
-- SPRACHE
update public.community_rooms set category_id = 'b0000000-0000-4000-8000-000000000005', position = 1 where slug = 'a1';
update public.community_rooms set category_id = 'b0000000-0000-4000-8000-000000000005', position = 2 where slug = 'a2';
update public.community_rooms set category_id = 'b0000000-0000-4000-8000-000000000005', position = 3 where slug = 'b1';
update public.community_rooms set category_id = 'b0000000-0000-4000-8000-000000000005', position = 4 where slug = 'b2';
update public.community_rooms set category_id = 'b0000000-0000-4000-8000-000000000005', position = 5 where slug = 'goethe';
update public.community_rooms set category_id = 'b0000000-0000-4000-8000-000000000005', position = 6 where slug = 'oesd';
update public.community_rooms set category_id = 'b0000000-0000-4000-8000-000000000005', position = 7 where slug = 'telc';
update public.community_rooms set category_id = 'b0000000-0000-4000-8000-000000000005', position = 8 where slug = 'ecl';
-- DOKUMENTE
update public.community_rooms set category_id = 'b0000000-0000-4000-8000-000000000007', position = 1 where slug = 'bewerbungsunterlagen';
update public.community_rooms set category_id = 'b0000000-0000-4000-8000-000000000007', position = 2 where slug = 'anerkennung-von-abschluessen';
-- VISA & BEHÖRDEN
update public.community_rooms set category_id = 'b0000000-0000-4000-8000-000000000003', position = 1 where slug = 'visa';
update public.community_rooms set category_id = 'b0000000-0000-4000-8000-000000000003', position = 2 where slug = 'konsulat';

-- Q&A mode: enabled by default in the help-oriented rooms (admins can toggle
-- any room later via the room settings UI).
update public.community_rooms set qna_enabled = true where slug in (
  'fragen-und-antworten', 'probleme', 'ausbildung', 'studium',
  'visa', 'anerkennung-von-abschluessen', 'goethe'
);

-- ---------------------------------------------------------------------------
-- 4. Messages — moderation hiding + FTS
-- ---------------------------------------------------------------------------

alter table public.community_messages
  add column if not exists hidden_by uuid
    references auth.users(id) on delete set null;

alter table public.community_messages
  add column if not exists hidden_at timestamptz;

-- Hidden rows vanish from every member read path (session client + realtime
-- delivery, which filters by the SELECT policy). The service-role API layers
-- additionally filter explicitly (defense in depth).
drop policy if exists "Community members can read messages" on public.community_messages;
create policy "Community members can read messages"
  on public.community_messages for select
  to authenticated
  using (hidden_by is null);

-- Generated FTS vector over the message text (recomputed on edit — the
-- author's UPDATE path keeps it consistent for free). 'simple' config:
-- predictable, multilingual (the community is DE/EN/FR/AR), and the
-- websearch parser handles operators.
alter table public.community_messages
  add column if not exists search_vector tsvector
    generated always as (to_tsvector('simple', coalesce(message, ''))) stored;

create index if not exists community_messages_search_idx
  on public.community_messages using gin (search_vector);

create index if not exists community_messages_hidden_idx
  on public.community_messages (room_id, created_at desc)
  where hidden_by is not null;

-- ---------------------------------------------------------------------------
-- 5. Q&A — questions + answers
-- ---------------------------------------------------------------------------

create table if not exists public.community_questions (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.community_rooms(id) on delete cascade,
  author_id uuid not null references auth.users(id) on delete cascade,
  title text not null check (char_length(trim(title)) between 10 and 120),
  body text not null check (char_length(trim(body)) between 30 and 4000),
  tags text[] not null default '{}',
  image_path text,
  status text not null default 'open'
    check (status in ('open', 'solved', 'closed')),
  accepted_answer_id uuid,
  solved_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint community_questions_tags_bounded
    check (coalesce(array_length(tags, 1), 0) between 0 and 5
           and not exists (select 1 from unnest(coalesce(tags, '{}')) t
                            where char_length(t) not between 1 and 24))
);

create index community_questions_room_idx
  on public.community_questions (room_id, created_at desc);
create index community_questions_author_idx
  on public.community_questions (author_id);
create index community_questions_open_idx
  on public.community_questions (created_at desc)
  where status = 'open';
create index community_questions_solved_idx
  on public.community_questions (solved_at desc)
  where solved_at is not null;

create trigger community_questions_set_updated_at
  before update on public.community_questions
  for each row execute function public.set_updated_at();

alter table public.community_questions enable row level security;

-- Read: enabled rooms, no block in EITHER direction between viewer and
-- author. (DMs and private data have no presence in this table.)
create policy "Members can read questions"
  on public.community_questions for select
  to authenticated
  using (
    exists (
      select 1 from public.community_rooms r
      where r.id = community_questions.room_id and r.enabled
    )
    and not exists (
      select 1 from public.community_blocks b
      where (b.blocker_id = auth.uid() and b.blocked_id = community_questions.author_id)
         or (b.blocker_id = community_questions.author_id and b.blocked_id = auth.uid())
    )
  );

-- Create: as oneself, only in an ENABLED room with Q&A mode ON.
create policy "Members can ask in qna rooms"
  on public.community_questions for insert
  to authenticated
  with check (
    author_id = auth.uid()
    and exists (
      select 1 from public.community_rooms r
      where r.id = community_questions.room_id and r.enabled and r.qna_enabled
    )
  );

-- NO update/delete policies: accepted/solved/closed transitions are
-- server-authorized (actions + the partial-unique constraints below).

alter table public.community_questions
  add column if not exists search_vector tsvector
    generated always as (
      setweight(to_tsvector('simple', coalesce(title, '')), 'A')
      || setweight(to_tsvector('simple', coalesce(body, '')), 'B')
    ) stored;

create index if not exists community_questions_search_idx
  on public.community_questions using gin (search_vector);

create table if not exists public.community_answers (
  id uuid primary key default gen_random_uuid(),
  question_id uuid not null references public.community_questions(id) on delete cascade,
  author_id uuid not null references auth.users(id) on delete cascade,
  body text not null check (char_length(trim(body)) between 10 and 4000),
  accepted boolean not null default false,
  deleted_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index community_answers_question_idx
  on public.community_answers (question_id, created_at);
create index community_answers_author_idx
  on public.community_answers (author_id);

-- EXACTLY ONE accepted answer per question (the accept flow clears the
-- previous one first — a second true row is rejected at the DB level).
create unique index community_answers_question_accepted_uq
  on public.community_answers (question_id)
  where accepted = true;

create trigger community_answers_set_updated_at
  before update on public.community_answers
  for each row execute function public.set_updated_at();

alter table public.community_answers enable row level security;

-- Read: the question must exist in an enabled room, the answer must not be
-- removed by moderation, no block in either direction.
create policy "Members can read answers"
  on public.community_answers for select
  to authenticated
  using (
    deleted_at is null
    and exists (
      select 1 from public.community_questions q
      join public.community_rooms r on r.id = q.room_id
      where q.id = community_answers.question_id
        and r.enabled
        and not exists (
          select 1 from public.community_blocks b
          where (b.blocker_id = auth.uid() and b.blocked_id = q.author_id)
             or (b.blocker_id = q.author_id and b.blocked_id = auth.uid())
        )
    )
    and not exists (
      select 1 from public.community_blocks b
      where (b.blocker_id = auth.uid() and b.blocked_id = community_answers.author_id)
         or (b.blocker_id = community_answers.author_id and b.blocked_id = auth.uid())
    )
  );

-- Create: as oneself, only for an existing, not-closed question in an
-- enabled qna room.
create policy "Members can answer open questions"
  on public.community_answers for insert
  to authenticated
  with check (
    author_id = auth.uid()
    and exists (
      select 1 from public.community_questions q
      join public.community_rooms r on r.id = q.room_id
      where q.id = community_answers.question_id
        and r.enabled and r.qna_enabled
        and q.status <> 'closed'
    )
  );

-- NO user update/delete: acceptance is server-authorized; moderation
-- removal (deleted_at) runs with the service role.

alter table public.community_answers
  add column if not exists search_vector tsvector
    generated always as (to_tsvector('simple', coalesce(body, ''))) stored;

create index if not exists community_answers_search_idx
  on public.community_answers using gin (search_vector);

-- The question points at its accepted answer (circular FK, added after both
-- tables exist).
alter table public.community_questions
  drop constraint if exists community_questions_accepted_answer_fk;
alter table public.community_questions
  add constraint community_questions_accepted_answer_fk
  foreign key (accepted_answer_id)
  references public.community_answers(id) on delete set null;

-- ---------------------------------------------------------------------------
-- 6. Pins — one row per pinned message
-- ---------------------------------------------------------------------------

create table if not exists public.community_pins (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.community_rooms(id) on delete cascade,
  message_id uuid not null unique
    references public.community_messages(id) on delete cascade,
  pinned_by uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default timezone('utc', now()),
  constraint community_pins_room_matches_message
    check (exists (
      select 1 from public.community_messages m where m.id = message_id and m.room_id = room_id
    ))
);

create index community_pins_room_idx on public.community_pins (room_id, created_at);

alter table public.community_pins enable row level security;

-- Pins are PUBLIC room content: any member can read them; only the enabled-
-- room join keeps a disabled room's pins out of reach. NO user write
-- policies — pin/unpin are server-authorized (moderator+).
create policy "Members can read pins of enabled rooms"
  on public.community_pins for select
  to authenticated
  using (
    exists (
      select 1 from public.community_rooms r
      where r.id = community_pins.room_id and r.enabled
    )
  );

-- ---------------------------------------------------------------------------
-- 7. Reports — the reporter sees ONLY their own rows
-- ---------------------------------------------------------------------------

create table if not exists public.community_reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid not null references auth.users(id) on delete cascade,
  target_type text not null
    check (target_type in ('message', 'question', 'answer', 'profile')),
  target_id uuid not null,
  reason text not null
    check (reason in (
      'spam', 'harassment', 'hate', 'scam', 'misinformation',
      'sexual_content', 'illegal_content', 'impersonation', 'other'
    )),
  details text check (details is null or char_length(details) <= 500),
  status text not null default 'open'
    check (status in ('open', 'reviewing', 'resolved', 'dismissed')),
  assigned_to uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default timezone('utc', now()),
  resolved_at timestamptz
);

-- Anti-duplicate: while a report is pending (open/reviewing) the same
-- reporter cannot open a second one against the same target. After
-- resolved/dismissed a fresh report is allowed (the situation may recur).
create unique index community_reports_pending_uq
  on public.community_reports (reporter_id, target_type, target_id)
  where status in ('open', 'reviewing');

create index community_reports_status_idx
  on public.community_reports (status, created_at desc);
create index community_reports_assigned_idx
  on public.community_reports (assigned_to, status)
  where assigned_to is not null;

alter table public.community_reports enable row level security;

-- The reporter reads and creates their OWN reports only. Moderator/admin
-- queue access runs with the service role (the moderation page) — a crafted
-- raw query can never fetch someone else's reports.
create policy "Reporters can read their own reports"
  on public.community_reports for select
  to authenticated
  using (reporter_id = auth.uid());

create policy "Reporters can file reports as themselves"
  on public.community_reports for insert
  to authenticated
  with check (reporter_id = auth.uid());

-- NO update/delete policies for users: status/assignment are service-role.

-- ---------------------------------------------------------------------------
-- 8. Moderation audit log — APPEND-ONLY
-- ---------------------------------------------------------------------------

create table if not exists public.community_moderation_actions (
  id uuid primary key default gen_random_uuid(),
  moderator_id uuid not null references auth.users(id) on delete cascade,
  action text not null,
  target_type text not null,
  target_id uuid not null,
  reason text check (reason is null or char_length(reason) <= 500),
  created_at timestamptz not null default timezone('utc', now())
);

create index community_moderation_actions_created_idx
  on public.community_moderation_actions (created_at desc);
create index community_moderation_actions_target_idx
  on public.community_moderation_actions (target_type, target_id);

alter table public.community_moderation_actions enable row level security;

-- READ-only, and only for moderator+: the queue + the audit trail are
-- moderation-private. There is deliberately NO insert/update/delete policy
-- for any role — rows are written exclusively by the service role, so the
-- log is append-only at the database level.
create policy "Moderators can read moderation actions"
  on public.community_moderation_actions for select
  to authenticated
  using (public.community_is_moderator());

-- ---------------------------------------------------------------------------
-- 9. Reputation — idempotent, server-determined events
-- ---------------------------------------------------------------------------

create table if not exists public.community_reputation_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  actor_id uuid references auth.users(id) on delete set null,
  event_type text not null
    check (event_type in ('answer_accepted', 'question_solved')),
  entity_type text not null
    check (entity_type in ('answer', 'question')),
  entity_id uuid not null,
  points integer not null check (points between 1 and 10),
  created_at timestamptz not null default timezone('utc', now()),
  -- One award per (event, entity, recipient): re-runs, retries and
  -- accept/unsolve cycles can never double-count.
  constraint community_reputation_events_uq
    unique (event_type, entity_type, entity_id, user_id)
);

create index community_reputation_events_user_idx
  on public.community_reputation_events (user_id);

alter table public.community_reputation_events enable row level security;

-- Reputation is PUBLIC community stats (profile card): members may read;
-- NO user write policy — only the service-role accept flow inserts, and the
-- points value is fixed server-side (the table accepts no client input).
create policy "Members can read reputation"
  on public.community_reputation_events for select
  to authenticated
  using (true);

-- ---------------------------------------------------------------------------
-- 10. Notifications — Q&A + moderation kinds
-- ---------------------------------------------------------------------------

alter type public.notification_type add value if not exists 'answer';
alter type public.notification_type add value if not exists 'answer_accepted';
alter type public.notification_type add value if not exists 'moderation';

alter table public.notifications
  add column if not exists question_id uuid
    references public.community_questions(id) on delete cascade,
  add column if not exists answer_id uuid
    references public.community_answers(id) on delete cascade;

-- The v4 reference-shape constraint, re-created with the three added kinds.
-- Every pre-existing branch gains "question_id is null and answer_id is
-- null" so old rows + old writes stay valid; the Q&A kinds REQUIRE the
-- question + answer + room refs; 'moderation' is a platform-style row
-- (actor may be set, no entity refs).
alter table public.notifications
  drop constraint if exists notifications_social_refs;
alter table public.notifications
  add constraint notifications_social_refs check (
    (type = 'friend_request'
      and actor_id is not null and room_id is null and room_message_id is null
      and conversation_id is null and dm_message_id is null
      and question_id is null and answer_id is null)
    or (type = 'friend_accepted'
      and actor_id is not null and room_id is null and room_message_id is null
      and conversation_id is null and dm_message_id is null
      and question_id is null and answer_id is null)
    or (type = 'mention'
      and actor_id is not null and room_id is not null and room_message_id is not null
      and conversation_id is null and dm_message_id is null
      and question_id is null and answer_id is null)
    or (type = 'reply'
      and actor_id is not null and room_id is not null and room_message_id is not null
      and conversation_id is null and dm_message_id is null
      and question_id is null and answer_id is null)
    or (type = 'reaction'
      and actor_id is not null
      and (
        (room_id is not null and room_message_id is not null
          and conversation_id is null and dm_message_id is null)
        or
        (conversation_id is not null and dm_message_id is not null
          and room_id is null and room_message_id is null)
      )
      and question_id is null and answer_id is null)
    or (type = 'direct_message'
      and actor_id is not null and conversation_id is not null
      and room_id is null and room_message_id is null
      and question_id is null and answer_id is null)
    or (type = 'answer'
      and actor_id is not null and room_id is not null
      and question_id is not null and answer_id is not null
      and room_message_id is null and conversation_id is null and dm_message_id is null)
    or (type = 'answer_accepted'
      and actor_id is not null and room_id is not null
      and question_id is not null and answer_id is not null
      and room_message_id is null and conversation_id is null and dm_message_id is null)
    or (type = 'moderation'
      and room_id is null and room_message_id is null
      and conversation_id is null and dm_message_id is null
      and question_id is null and answer_id is null)
    or (type in ('info', 'important', 'maintenance', 'improvement', 'social')
      and room_id is null and room_message_id is null
      and conversation_id is null and dm_message_id is null
      and question_id is null and answer_id is null)
  );

-- ---------------------------------------------------------------------------
-- 11. Global community search — ONE SECURITY DEFINER entry point.
--
--     * auth.uid() must equal p_user (no arbitrary viewer ids).
--     * search_path pinned, every object schema-qualified.
--     * Direct messages are NEVER searched (no DM table is referenced).
--     * hidden messages, removed answers, disabled rooms and blocked
--       authors (either direction) are excluded inside the function.
--     * keyset pagination: (created_at, id) cursor, bounded page, no offset.
--     * 'simple' text config + websearch_to_tsquery (no ILIKE '%q%').
-- ---------------------------------------------------------------------------

create or replace function public.community_search(
  p_user uuid,
  p_query text,
  p_kind text default 'all',
  p_room uuid default null,
  p_author uuid default null,
  p_since timestamptz default null,
  p_before_at timestamptz default null,
  p_before_id uuid default null,
  p_limit integer default 20
)
returns table (
  kind text,
  id uuid,
  room_id uuid,
  room_slug text,
  room_name text,
  author_id uuid,
  author_name text,
  content text,
  created_at timestamptz,
  -- Deep-link target for answer rows (the question that owns the answer).
  -- null for every other kind.
  question_id uuid
 )
 language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_query text;
  v_kind text;
  v_limit integer;
begin
  if p_user is null then
    return;
  end if;
  if auth.uid() is null or auth.uid() <> p_user then
    raise exception 'community_search: p_user must be the session user';
  end if;
  v_query := trim(coalesce(p_query, ''));
  if v_query = '' then
    return;
  end if;
  if char_length(v_query) > 200 then
    v_query := left(v_query, 200);
  end if;
  v_kind := coalesce(nullif(p_kind, ''), 'all');
  if v_kind not in ('all', 'message', 'question', 'answer', 'user', 'room') then
    v_kind := 'all';
  end if;
  v_limit := greatest(coalesce(p_limit, 20), 1);
  if v_limit > 50 then
    v_limit := 50;
  end if;

  return query
   select s.kind, s.id, s.room_id, s.room_slug, s.room_name,
          s.author_id, s.author_name, s.content, s.created_at, s.question_id
   from (
    -- messages (FTS; hidden rows excluded; blocks both directions)
    select 'message'::text as kind, m.id, m.room_id, r.slug as room_slug,
           r.name as room_name, m.user_id as author_id,
           p.display_name as author_name,
            left(coalesce(m.message, ''), 240) as content, m.created_at,
            null
     from public.community_messages m
    join public.community_rooms r on r.id = m.room_id and r.enabled = true
    left join public.community_profiles p on p.user_id = m.user_id
    where (v_kind = 'all' or v_kind = 'message')
      and m.hidden_by is null
      and m.search_vector @@ public.websearch_to_tsquery('simple', v_query)
      and (p_room is null or m.room_id = p_room)
      and (p_author is null or m.user_id = p_author)
      and (p_since is null or m.created_at >= p_since)
      and not exists (
        select 1 from public.community_blocks b
        where (b.blocker_id = p_user and b.blocked_id = m.user_id)
           or (b.blocker_id = m.user_id and b.blocked_id = p_user)
      )
      and (p_before_at is null or (m.created_at, m.id) < (p_before_at, p_before_id))

    union all

    -- questions (FTS over title+body)
    select 'question'::text, q.id, q.room_id, r.slug, r.name,
           q.author_id, p.display_name,
            left(q.title, 240), q.created_at,
            q.id
     from public.community_questions q
    join public.community_rooms r on r.id = q.room_id and r.enabled = true
    left join public.community_profiles p on p.user_id = q.author_id
    where (v_kind = 'all' or v_kind = 'question')
      and q.search_vector @@ public.websearch_to_tsquery('simple', v_query)
      and (p_room is null or q.room_id = p_room)
      and (p_author is null or q.author_id = p_author)
      and (p_since is null or q.created_at >= p_since)
      and not exists (
        select 1 from public.community_blocks b
        where (b.blocker_id = p_user and b.blocked_id = q.author_id)
           or (b.blocker_id = q.author_id and b.blocked_id = p_user)
      )
      and (p_before_at is null or (q.created_at, q.id) < (p_before_at, p_before_id))

    union all

    -- answers (FTS; removed answers excluded)
    select 'answer'::text, a.id, q.room_id, r.slug, r.name,
           a.author_id, p.display_name,
            left(a.body, 240), a.created_at,
            q.id
     from public.community_answers a
    join public.community_questions q on q.id = a.question_id
    join public.community_rooms r on r.id = q.room_id and r.enabled = true
    left join public.community_profiles p on p.user_id = a.author_id
    where (v_kind = 'all' or v_kind = 'answer')
      and a.deleted_at is null
      and a.search_vector @@ public.websearch_to_tsquery('simple', v_query)
      and (p_room is null or q.room_id = p_room)
      and (p_author is null or a.author_id = p_author)
      and (p_since is null or a.created_at >= p_since)
      and not exists (
        select 1 from public.community_blocks b
        where (b.blocker_id = p_user and b.blocked_id = a.author_id)
           or (b.blocker_id = a.author_id and b.blocked_id = p_user)
      )
      and (p_before_at is null or (a.created_at, a.id) < (p_before_at, p_before_id))

    union all

    -- members (username FTS; blocked users excluded both directions)
    select 'user'::text, p.id, null, null, null,
           p.user_id, p.display_name,
            coalesce(p.bio, ''), p.created_at,
            null
     from public.community_profiles p
    where (v_kind = 'all' or v_kind = 'user')
      and p_room is null
      and to_tsvector('simple', lower(p.display_name))
          @@ public.websearch_to_tsquery('simple', v_query)
      and (p_author is null or p.user_id = p_author)
      and not exists (
        select 1 from public.community_blocks b
        where (b.blocker_id = p_user and b.blocked_id = p.user_id)
           or (b.blocker_id = p.user_id and b.blocked_id = p_user)
      )
      and (p_before_at is null or (p.created_at, p.id) < (p_before_at, p_before_id))

    union all

    -- rooms (name + description FTS; enabled rooms only)
    select 'room'::text, r.id, r.id, r.slug, r.name,
           null, null,
            coalesce(r.description, ''), r.created_at,
            null
     from public.community_rooms r
    where (v_kind = 'all' or v_kind = 'room')
      and r.enabled = true
      and (to_tsvector('simple', r.name) || to_tsvector('simple', coalesce(r.description, '')))
          @@ public.websearch_to_tsquery('simple', v_query)
  ) s
  order by s.created_at desc, s.id desc
  limit v_limit;
end;
$$;

revoke execute on function public.community_search(
  uuid, text, text, uuid, uuid, timestamptz, timestamptz, uuid, integer
) from public, anon;
grant execute on function public.community_search(
  uuid, text, text, uuid, uuid, timestamptz, timestamptz, uuid, integer
) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 11b. Home "popular rooms" — per-room 7-day activity in ONE SQL call
--      (O(rooms), never a per-room N+1 count from the app).
-- ---------------------------------------------------------------------------

create or replace function public.community_home_activity()
returns table (
  room_id uuid,
  room_slug text,
  room_name text,
  message_count bigint,
  question_count bigint
)
language sql
stable
security definer
set search_path = public
as $$
  select r.id, r.slug, r.name,
    (
      select count(*)
      from public.community_messages m
      where m.room_id = r.id
        and m.hidden_by is null
        and m.created_at >= timezone('utc', now()) - interval '7 days'
    ) as message_count,
    (
      select count(*)
      from public.community_questions q
      where q.room_id = r.id
        and q.created_at >= timezone('utc', now()) - interval '7 days'
    ) as question_count
  from public.community_rooms r
  where r.enabled = true;
$$;

revoke execute on function public.community_home_activity() from public, anon;
grant execute on function public.community_home_activity() to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 12. Realtime — live question pages (status / acceptance / new answers).
--     Idempotent publication additions, like every earlier phase.
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'community_questions'
  ) then
    alter publication supabase_realtime add table public.community_questions;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'community_answers'
  ) then
    alter publication supabase_realtime add table public.community_answers;
  end if;
end
$$;

-- NOTE (deliberate non-choices, audited):
--   * community_pins: pin/unpin events travel over the EXISTING per-room
--     broadcast channel (metadata only) — no publication, no polling.
--   * community_reports / community_moderation_actions: moderation-private.
--     A postgres stream would be RLS-filtered (reporters see only their own
--     rows), so "new report" signals use a client broadcast WITHOUT ids —
--     nothing sensitive travels with the signal.
--   * community_reputation_events: derived stats, read on demand (profile
--     card) — no stream needed.
