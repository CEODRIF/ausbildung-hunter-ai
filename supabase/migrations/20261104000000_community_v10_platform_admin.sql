-- ============================================================================
-- Community Phase 10 — platform administrator (contact@ausbildungsweg.net).
--
-- Design (three lines of defense, no new parallel system):
--   1. The platform admin is a STABLE auth.id, not an email or a display
--      name. The TS layer (src/lib/community/platform-admin.ts) re-resolves
--      the session user on every privileged call and compares against that
--      id; nothing client-supplied is ever trusted.
--   2. Membership lives in the EXISTING platform tables: public.admins
--      (service-role only, no user policies — self-elevation is impossible
--      from the browser) and public.community_memberships role 'owner'
--      (the community role architecture's second line: community_is_admin()
--      in RLS policies).
--   3. Bans are data in public.community_bans (service-role only writes)
--      enforced by community_is_banned() inside the community RLS policies
--      (read AND write) — a banned user is cut off at the database level,
--      including realtime delivery (the postgres stream is RLS-scoped).
--
-- This migration:
--   * seeds the designated platform admin (CONDITIONAL on the auth row's
--     email — if the uid is ever rebound to another email, the seed is a
--     no-op and access fails safe),
--   * creates community_bans (one normalized table, no second ban system),
--   * creates community_is_banned() (SECURITY DEFINER, search_path pinned,
--     revoked from public/anon),
--   * adds announcement support to the EXISTING notification system
--     (notification_type 'announcement' + notifications.link_url — one row
--     with target_type='all' reaches every user; no per-user fan-out),
--   * hardens (never weakens) the community RLS policies: every community
--     read/write policy gains `not public.community_is_banned()`.
--
-- Idempotent: every statement is re-apply-safe (if not exists / drop-if-
-- exists / on-conflict), so a partially applied instance converges.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Platform admin membership — EXISTING structures, email-verified seed.
--    The platform_owner migration (20261012) established the pattern: the
--    designated account's membership is guaranteed in SQL, no-op otherwise.
--    Here the seed is CONDITIONAL on auth.users.email so the uid→email
--    binding is verified at apply time (and the seed never runs for a
--    re-bound account).
-- ---------------------------------------------------------------------------

insert into public.admins (user_id, created_by)
select '6fa45036-1b86-427a-a7d0-54a3a3904767', null
from auth.users u
where u.id = '6fa45036-1b86-427a-a7d0-54a3a3904767'
  and lower(u.email) = 'contact@ausbildungsweg.net'
on conflict (user_id) do nothing;

-- Community role: 'owner' (the top of the existing community role ladder —
-- community_is_admin() / community_is_moderator() already recognize it in
-- RLS). Idempotent: re-applying converges to role 'owner'.
insert into public.community_memberships (user_id, role)
select '6fa45036-1b86-427a-a7d0-54a3a3904767', 'owner'
from auth.users u
where u.id = '6fa45036-1b86-427a-a7d0-54a3a3904767'
  and lower(u.email) = 'contact@ausbildungsweg.net'
on conflict (user_id)
do update set role = 'owner', updated_at = timezone('utc', now());

-- ---------------------------------------------------------------------------
-- 2. community_bans — the smallest normalized ban structure (one row per
--    ban, revoke = timestamp, not delete: the trail is append-only).
--    RLS: the banned user may READ their own row (the banned screen shows
--    reason + expiry). There is NO insert/update/delete policy for any
--    user role — ban/unban runs exclusively with the service role.
-- ---------------------------------------------------------------------------

create table if not exists public.community_bans (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  -- set null (not cascade/restrict): the audit link survives an actor
  -- account erasure; a GDPR erasure can never fail on this table.
  banned_by uuid references auth.users(id) on delete set null,
  reason text check (reason is null or char_length(reason) <= 500),
  created_at timestamptz not null default timezone('utc', now()),
  -- null = permanent; otherwise the ban lifts automatically.
  expires_at timestamptz,
  -- null = active; set by the unban operation.
  revoked_at timestamptz,
  constraint community_bans_window
    check (expires_at is null or expires_at > created_at),
  constraint community_bans_state
    check (revoked_at is null or revoked_at >= created_at)
);

create index if not exists community_bans_user_idx
  on public.community_bans (user_id);
create index if not exists community_bans_active_idx
  on public.community_bans (user_id)
  where revoked_at is null;

-- At most ONE active ban per user: a second ban while one is active is a
-- client error (23505), not a data state — the UI surfaces it.
create unique index if not exists community_bans_active_uq
  on public.community_bans (user_id)
  where revoked_at is null;

alter table public.community_bans enable row level security;

drop policy if exists "Banned users can read their own ban" on public.community_bans;
create policy "Banned users can read their own ban"
  on public.community_bans for select
  to authenticated
  using (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- 3. community_is_banned() — the RLS-side ban check.
--    SECURITY DEFINER + pinned search_path (the established pattern);
--    reads community_bans (the definer role bypasses its RLS — no user
--    write policy exists on it anyway), so a banned user cannot hide their
--    ban from the policies by deleting anything.
--    STABLE: one scan per statement, safe inside row policies.
-- ---------------------------------------------------------------------------

create or replace function public.community_is_banned()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.community_bans b
    where b.user_id = auth.uid()
      and b.revoked_at is null
      and (b.expires_at is null or b.expires_at > now())
  );
$$;

revoke execute on function public.community_is_banned() from public, anon;
grant execute on function public.community_is_banned() to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. Announcements in the EXISTING notification system.
--    'announcement' is a platform-style row (target_type='all' + no entity
--    refs) — one row, read by every user through the existing SELECT
--    policy, delivered realtime through the existing supabase_realtime
--    publication (no fan-out, no second table, no new publication).
--    link_url: the optional action link of the announcement (≤ 500 chars).
-- ---------------------------------------------------------------------------

-- 'announcement' lives in the STANDALONE v10a migration (20261103235900):
-- a value added by ALTER TYPE ADD VALUE inside a transaction must NOT be
-- referenced by later statements of the SAME transaction (Supabase SQL
-- Editor 55P04; the migration runner is atomic per file). v10a commits the
-- value BEFORE this migration runs, so the constraint re-created below may
-- reference it. Do NOT move the ADD VALUE back into this file.

alter table public.notifications
  add column if not exists link_url text
    check (link_url is null or char_length(link_url) <= 500);

-- The v6 reference-shape constraint, re-created with 'announcement' added
-- to the platform branch (identical shape rule: no entity refs).
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
    or (type in ('info', 'important', 'maintenance', 'improvement', 'social', 'announcement')
      and room_id is null and room_message_id is null
      and conversation_id is null and dm_message_id is null
      and question_id is null and answer_id is null)
  );

-- ---------------------------------------------------------------------------
-- 5. Ban hardening of the community RLS (STRENGTHENING ONLY).
--    Every community read policy gains `not public.community_is_banned()`
--    on the READER side (a banned user sees nothing — including realtime,
--    which is scoped by the SELECT policies) and every community content
--    write policy on the WRITER side. Personal read-state cursors
--    (community_read_state / community_room_read_state /
--    community_dm_read_state / notification_reads) are intentionally
--    untouched: they are harmless per-user metadata with no content.
--    Service-role paths (moderation, presence heartbeats via the server
--    layer) are unaffected by RLS.
-- ---------------------------------------------------------------------------

-- Profiles: a banned user neither reads the community directory nor
-- updates presence/identity (the heartbeat fails → presence goes stale).
drop policy if exists "Community members can read community profiles" on public.community_profiles;
create policy "Community members can read community profiles"
on public.community_profiles for select to authenticated
using (not public.community_is_banned());

-- (v1 original + ban clause: a banned account may not mint its own profile
-- row either — the onboarding upsert takes the insert branch for a
-- genuinely missing row.)
drop policy if exists "Users can create their own community profile" on public.community_profiles;
create policy "Users can create their own community profile"
on public.community_profiles for insert to authenticated
with check (auth.uid() = user_id and not public.community_is_banned());

drop policy if exists "Users can update their own community profile" on public.community_profiles;
create policy "Users can update their own community profile"
on public.community_profiles for update to authenticated
using (auth.uid() = user_id and not public.community_is_banned())
with check (auth.uid() = user_id and not public.community_is_banned());

-- Room directory.
drop policy if exists "Community members can read room categories" on public.community_room_categories;
create policy "Community members can read room categories"
  on public.community_room_categories for select
  to authenticated
  using (not public.community_is_banned());

drop policy if exists "Community members can read enabled rooms" on public.community_rooms;
create policy "Community members can read enabled rooms"
  on public.community_rooms for select
  to authenticated
  using (enabled = true and not public.community_is_banned());

-- Messages (read + all three own-content write ops).
drop policy if exists "Community members can read messages" on public.community_messages;
create policy "Community members can read messages"
  on public.community_messages for select
  to authenticated
  using (hidden_by is null and not public.community_is_banned());

drop policy if exists "Users can create their own messages" on public.community_messages;
create policy "Users can create their own messages"
on public.community_messages for insert to authenticated
with check (auth.uid() = user_id and not public.community_is_banned());

drop policy if exists "Community members can update their own messages" on public.community_messages;
create policy "Community members can update their own messages"
  on public.community_messages for update
  to authenticated
  using (user_id = auth.uid() and not public.community_is_banned())
  with check (user_id = auth.uid() and not public.community_is_banned());

drop policy if exists "Community members can delete their own messages" on public.community_messages;
create policy "Community members can delete their own messages"
  on public.community_messages for delete
  to authenticated
  using (user_id = auth.uid() and not public.community_is_banned());

-- Reactions.
drop policy if exists "Community members can read reactions" on public.community_message_reactions;
create policy "Community members can read reactions"
  on public.community_message_reactions for select
  to authenticated
  using (not public.community_is_banned());

drop policy if exists "Members can add their own reaction" on public.community_message_reactions;
create policy "Members can add their own reaction"
  on public.community_message_reactions for insert
  to authenticated
  with check (user_id = auth.uid() and not public.community_is_banned());

drop policy if exists "Members can remove their own reaction" on public.community_message_reactions;
create policy "Members can remove their own reaction"
  on public.community_message_reactions for delete
  to authenticated
  using (user_id = auth.uid() and not public.community_is_banned());

-- Mention rows (a banned user's mention index is community data).
drop policy if exists "Users can see mentions of themselves" on public.community_message_mentions;
create policy "Users can see mentions of themselves"
  on public.community_message_mentions for select
  to authenticated
  using (user_id = auth.uid() and not public.community_is_banned());

-- Friendships.
drop policy if exists "Friends can read their own friendship" on public.community_friendships;
create policy "Friends can read their own friendship"
  on public.community_friendships for select
  to authenticated
  using (auth.uid() in (requester_id, requestee_id) and not public.community_is_banned());

drop policy if exists "Users can send friend requests as themselves" on public.community_friendships;
create policy "Users can send friend requests as themselves"
  on public.community_friendships for insert
  to authenticated
  with check (requester_id = auth.uid() and not public.community_is_banned());

drop policy if exists "Participants can update the friendship status" on public.community_friendships;
create policy "Participants can update the friendship status"
  on public.community_friendships for update
  to authenticated
  using (auth.uid() in (requester_id, requestee_id) and not public.community_is_banned())
  with check (auth.uid() in (requester_id, requestee_id) and not public.community_is_banned());

drop policy if exists "Participants can delete their friendship row" on public.community_friendships;
create policy "Participants can delete their friendship row"
  on public.community_friendships for delete
  to authenticated
  using (auth.uid() in (requester_id, requestee_id) and not public.community_is_banned());

-- Blocks.
drop policy if exists "Participants can read block rows" on public.community_blocks;
create policy "Participants can read block rows"
  on public.community_blocks for select
  to authenticated
  using (auth.uid() in (blocker_id, blocked_id) and not public.community_is_banned());

drop policy if exists "Users can block as themselves" on public.community_blocks;
create policy "Users can block as themselves"
  on public.community_blocks for insert
  to authenticated
  with check (blocker_id = auth.uid() and not public.community_is_banned());

drop policy if exists "The blocker can unblock" on public.community_blocks;
create policy "The blocker can unblock"
  on public.community_blocks for delete
  to authenticated
  using (blocker_id = auth.uid() and not public.community_is_banned());

-- Direct messages: conversations + messages + reactions.
drop policy if exists "Members can read their conversations" on public.community_conversations;
create policy "Members can read their conversations"
  on public.community_conversations for select
  to authenticated
  using (auth.uid() in (member_a, member_b) and not public.community_is_banned());

drop policy if exists "Members can create a conversation with each other" on public.community_conversations;
create policy "Members can create a conversation with each other"
  on public.community_conversations for insert
  to authenticated
  with check (auth.uid() in (member_a, member_b) and not public.community_is_banned());

drop policy if exists "Conversation members can read direct messages" on public.community_direct_messages;
create policy "Conversation members can read direct messages"
  on public.community_direct_messages for select
  to authenticated
  using (exists (
    select 1 from public.community_conversations c
    where c.id = conversation_id
      and auth.uid() in (c.member_a, c.member_b)
  ) and not public.community_is_banned());

drop policy if exists "Friends can send direct messages to each other" on public.community_direct_messages;
create policy "Friends can send direct messages to each other"
  on public.community_direct_messages for insert
  to authenticated
  with check (
    user_id = auth.uid()
    and not public.community_is_banned()
    and exists (
      select 1 from public.community_conversations c
      where c.id = conversation_id
        and auth.uid() in (c.member_a, c.member_b)
        and exists (
          select 1 from public.community_friendships f
          where f.status = 'accepted'
            and ((f.requester_id = c.member_a and f.requestee_id = c.member_b)
              or (f.requester_id = c.member_b and f.requestee_id = c.member_a))
        )
        and not exists (
          select 1 from public.community_blocks b
          where (b.blocker_id = c.member_a and b.blocked_id = c.member_b)
             or (b.blocker_id = c.member_b and b.blocked_id = c.member_a)
        )
    )
  );

drop policy if exists "Authors can edit their own direct messages" on public.community_direct_messages;
create policy "Authors can edit their own direct messages"
  on public.community_direct_messages for update
  to authenticated
  using (user_id = auth.uid() and not public.community_is_banned())
  with check (user_id = auth.uid() and not public.community_is_banned());

drop policy if exists "Authors can delete their own direct messages" on public.community_direct_messages;
create policy "Authors can delete their own direct messages"
  on public.community_direct_messages for delete
  to authenticated
  using (user_id = auth.uid() and not public.community_is_banned());

drop policy if exists "Conversation members can read dm reactions" on public.community_dm_reactions;
create policy "Conversation members can read dm reactions"
  on public.community_dm_reactions for select
  to authenticated
  using (exists (
    select 1 from public.community_conversations c
    join public.community_direct_messages m on m.id = message_id
    where c.id = m.conversation_id
      and auth.uid() in (c.member_a, c.member_b)
  ) and not public.community_is_banned());

drop policy if exists "Conversation members can react" on public.community_dm_reactions;
create policy "Conversation members can react"
  on public.community_dm_reactions for insert
  to authenticated
  with check (
    user_id = auth.uid()
    and not public.community_is_banned()
    and exists (
      select 1 from public.community_conversations c
      join public.community_direct_messages m on m.id = message_id
      where c.id = m.conversation_id
        and auth.uid() in (c.member_a, c.member_b)
    )
  );

drop policy if exists "Conversation members can unreact" on public.community_dm_reactions;
create policy "Conversation members can unreact"
  on public.community_dm_reactions for delete
  to authenticated
  using (
    user_id = auth.uid()
    and not public.community_is_banned()
    and exists (
      select 1 from public.community_conversations c
      join public.community_direct_messages m on m.id = message_id
      where c.id = m.conversation_id
        and auth.uid() in (c.member_a, c.member_b)
    )
  );

-- Notification feed (the community notification center).
drop policy if exists "Users can read their own notifications" on public.notifications;
create policy "Users can read their own notifications"
  on public.notifications for select
  to authenticated
  using (
    (target_type = 'all' or target_user_id = auth.uid())
    and not public.community_is_banned()
  );

-- Voice metadata.
drop policy if exists community_voice_conversations_select on public.community_voice_conversations;
create policy community_voice_conversations_select
  on public.community_voice_conversations for select
  to authenticated
  using (
    exists (
      select 1
      from public.community_rooms r
      where r.id = community_voice_conversations.room_id
        and r.enabled = true
    )
    and not public.community_is_banned()
  );

-- Community role directory (the banned user no longer reads community
-- state; the platform admin — never bannable — is unaffected).
drop policy if exists "Members can read community roles" on public.community_memberships;
create policy "Members can read community roles"
  on public.community_memberships for select
  to authenticated
  using (not public.community_is_banned());

-- Q&A.
drop policy if exists "Members can read questions" on public.community_questions;
create policy "Members can read questions"
  on public.community_questions for select
  to authenticated
  using (
    not public.community_is_banned()
    and exists (
      select 1 from public.community_rooms r
      where r.id = community_questions.room_id and r.enabled
    )
    and not exists (
      select 1 from public.community_blocks b
      where (b.blocker_id = auth.uid() and b.blocked_id = community_questions.author_id)
         or (b.blocker_id = community_questions.author_id and b.blocked_id = auth.uid())
    )
  );

drop policy if exists "Members can ask in qna rooms" on public.community_questions;
create policy "Members can ask in qna rooms"
  on public.community_questions for insert
  to authenticated
  with check (
    author_id = auth.uid()
    and not public.community_is_banned()
    and exists (
      select 1 from public.community_rooms r
      where r.id = community_questions.room_id and r.enabled and r.qna_enabled
    )
  );

drop policy if exists "Members can read answers" on public.community_answers;
create policy "Members can read answers"
  on public.community_answers for select
  to authenticated
  using (
    not public.community_is_banned()
    and deleted_at is null
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

drop policy if exists "Members can answer open questions" on public.community_answers;
create policy "Members can answer open questions"
  on public.community_answers for insert
  to authenticated
  with check (
    author_id = auth.uid()
    and not public.community_is_banned()
    and exists (
      select 1 from public.community_questions q
      join public.community_rooms r on r.id = q.room_id
      where q.id = community_answers.question_id
        and r.enabled and r.qna_enabled
        and q.status <> 'closed'
    )
  );

-- Pins (room content).
drop policy if exists "Members can read pins of enabled rooms" on public.community_pins;
create policy "Members can read pins of enabled rooms"
  on public.community_pins for select
  to authenticated
  using (
    exists (
      select 1 from public.community_rooms r
      where r.id = community_pins.room_id and r.enabled
    )
    and not public.community_is_banned()
  );

-- Reports (a banned user neither files nor reads reports).
drop policy if exists "Reporters can read their own reports" on public.community_reports;
create policy "Reporters can read their own reports"
  on public.community_reports for select
  to authenticated
  using (reporter_id = auth.uid() and not public.community_is_banned());

drop policy if exists "Reporters can file reports as themselves" on public.community_reports;
create policy "Reporters can file reports as themselves"
  on public.community_reports for insert
  to authenticated
  with check (reporter_id = auth.uid() and not public.community_is_banned());

-- Moderation queue (a sanctioned moderator loses queue access too).
drop policy if exists "Moderators can read moderation actions" on public.community_moderation_actions;
create policy "Moderators can read moderation actions"
  on public.community_moderation_actions for select
  to authenticated
  using (public.community_is_moderator() and not public.community_is_banned());

-- Public reputation (community profile data).
drop policy if exists "Members can read reputation" on public.community_reputation_events;
create policy "Members can read reputation"
  on public.community_reputation_events for select
  to authenticated
  using (not public.community_is_banned());

-- Room-scoped image reads (storage policies reference community tables).
drop policy if exists "Room-scoped members can read message images" on storage.objects;
create policy "Room-scoped members can read message images"
on storage.objects for select to authenticated
using (
  bucket_id = 'community-images'
  and (storage.foldername(name))[1] <> 'dm'
  and not public.community_is_banned()
  and exists (
    select 1
    from public.community_messages m
    where m.image_path = name
      and m.id::text = lower((storage.foldername(name))[2])
      and m.user_id::text = lower((storage.foldername(name))[1])
      and m.hidden_by is null
      and exists (
        select 1 from public.community_rooms r
        where r.id = m.room_id and r.enabled
      )
  )
);

drop policy if exists "Room-scoped members can read question images" on storage.objects;
create policy "Room-scoped members can read question images"
on storage.objects for select to authenticated
using (
  bucket_id = 'community-images'
  and (storage.foldername(name))[1] <> 'dm'
  and not public.community_is_banned()
  and exists (
    select 1
    from public.community_questions q
    where q.image_path = name
      and q.id::text = lower((storage.foldername(name))[2])
      and q.author_id::text = lower((storage.foldername(name))[1])
      and exists (
        select 1 from public.community_rooms r
        where r.id = q.room_id and r.enabled
      )
      and not exists (
        select 1 from public.community_blocks b
        where (b.blocker_id = auth.uid() and b.blocked_id = q.author_id)
           or (b.blocker_id = q.author_id and b.blocked_id = auth.uid())
      )
  )
);

-- The remaining v2/v3 storage policies, re-created with the ban clause
-- (STRENGTHENING ONLY — every original condition preserved verbatim). The
-- browser talks to storage STRAIGHT with the session token, so the API
-- write-gate alone cannot cut a banned user's open tab off from uploading
-- or from reading DM images through already-known object URLs.
drop policy if exists "Users can upload community images to their own folder" on storage.objects;
create policy "Users can upload community images to their own folder"
on storage.objects for insert to authenticated
with check (bucket_id = 'community-images'
            and (storage.foldername(name))[1] <> 'dm'
            and (storage.foldername(name))[1] = auth.uid()::text
            and not public.community_is_banned());

drop policy if exists "Members can upload dm images to their own dm folder" on storage.objects;
create policy "Members can upload dm images to their own dm folder"
on storage.objects for insert to authenticated
with check (bucket_id = 'community-images'
            and (storage.foldername(name))[1] = 'dm'
            and (storage.foldername(name))[3] = auth.uid()::text
            and exists (
              select 1 from public.community_conversations c
              where c.id = (storage.foldername(name))[2]::uuid
                and auth.uid() in (c.member_a, c.member_b)
            )
            and not public.community_is_banned());

drop policy if exists "Members can read dm images of their conversations" on storage.objects;
create policy "Members can read dm images of their conversations"
on storage.objects for select to authenticated
using (bucket_id = 'community-images'
       and (storage.foldername(name))[1] = 'dm'
       and exists (
         select 1 from public.community_conversations c
         where c.id = (storage.foldername(name))[2]::uuid
           and auth.uid() in (c.member_a, c.member_b)
       )
       and not public.community_is_banned());

drop policy if exists "Members can delete their own community images" on storage.objects;
create policy "Members can delete their own community images"
  on storage.objects for delete
  to authenticated
  using (bucket_id = 'community-images'
         and (storage.foldername(name))[1] = auth.uid()::text
         and not public.community_is_banned());

drop policy if exists "Members can delete their own dm images" on storage.objects;
create policy "Members can delete their own dm images"
on storage.objects for delete to authenticated
using (bucket_id = 'community-images'
       and (storage.foldername(name))[1] = 'dm'
       and (storage.foldername(name))[3] = auth.uid()::text
       and exists (
         select 1 from public.community_conversations c
         where c.id = (storage.foldername(name))[2]::uuid
           and auth.uid() in (c.member_a, c.member_b)
       )
       and not public.community_is_banned());
