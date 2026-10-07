-- Community Phase 2 — the social layer: profiles, friends, blocks, DMs.
--
-- Builds on 20261014000000_community.sql + 20261027000000_community_v2.sql
-- (both kept intact).
--
-- Design notes:
--   * FRIENDSHIPS are stored as ONE canonical row per UNORDERED PAIR
--     (unique index on (least(), greatest())): there can never be two
--     pending requests between the same two users (A→B and B→A), and a
--     pair has at most one friendship in any state. State transitions:
--       pending --accept--> accepted   (requestee)
--       pending --decline/cancel--> row deleted
--       accepted --remove--> row deleted (either friend)
--     Deleting the row is the "terminal" state — a fresh request after a
--     removal creates a fresh row. The pair index makes "already friends /
--     request already pending" a single, race-safe check.
--   * BLOCKS are a separate small table (blocker → blocked, unique).
--     Blocking is NOT a friendship state: it composes with every state
--     (you can block a friend or a stranger) and it is checked by every
--     social write in the API layer AND in the RLS of the DM message
--     table (defense in depth).
--   * DMs: a conversation exists per accepted-friend pair (one row,
--     canonical member_a/member_b ordering at insert time by the API).
--     Membership (not current friendship) keeps the HISTORY readable
--     after a friendship is removed — the conversation never becomes
--     public, but new messages REQUIRE an accepted friendship plus no
--     active block in either direction (enforced in RLS and in the API).
--   * PRESENCE is a heartbeat: the client touches community_profiles.
--     last_seen_at every 30 s while the community is open (and the tab is
--     visible). "Online" = last_seen_at within 2 minutes. No realtime
--     presence table, no extra subscriptions — the friends list is
--     refreshed on navigation.
--   * NOTIFICATIONS: the existing platform table (Phase 11) gains ONE new
--     type value 'social'. Social notifications are written by the API
--     layer with the service role (same rule as platform notifications:
--     the UI never writes notifications directly). send_key is a
--     deterministic uuid derived from the triggering row so retries of
--     the same social event cannot duplicate the notification.
--   * STORAGE: DM images live in the SAME private community-images bucket
--     under a distinct top-level segment:  dm/{conversation_id}/{user_id}/{message_id}/image.{ext}
--     The member-folder room policy is tightened to NON-dm paths, and the
--     new dm policies scope every operation to conversation MEMBERSHIP
--     (plus authorship for writes/deletes).

-- ---------------------------------------------------------------------------
-- 1. Profiles: optional short bio + presence heartbeat
-- ---------------------------------------------------------------------------

alter table public.community_profiles
  add column if not exists bio text
  check (bio is null or char_length(bio) between 1 and 200);

alter table public.community_profiles
  add column if not exists last_seen_at timestamptz;

-- ---------------------------------------------------------------------------
-- 2. Friendships (one canonical row per unordered pair)
-- ---------------------------------------------------------------------------

create table public.community_friendships (
  id uuid primary key default gen_random_uuid(),
  requester_id uuid not null references auth.users(id) on delete cascade,
  requestee_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'accepted')),
  created_at timestamptz not null default timezone('utc', now()),
  status_changed_at timestamptz not null default timezone('utc', now()),
  constraint community_friendships_self_request check (requester_id <> requestee_id)
);

-- One request in flight per ordered pair (A→B cannot be pending twice).
create unique index community_friendships_request_uq
  on public.community_friendships (requester_id, requestee_id);

-- …and at most ONE row per UNORDERED pair, in any state: no duplicate
-- friendships, no A→B + B→A double requests.
create unique index community_friendships_pair_uq
  on public.community_friendships (least(requester_id, requestee_id),
                                   greatest(requester_id, requestee_id));

create index community_friendships_requestee_pending_idx
  on public.community_friendships (requestee_id, status);

-- (set_updated_at() already exists from the auth foundation migration.)
create or replace function public.set_status_changed_at()
returns trigger
language plpgsql
as $$
begin
  if new.status is distinct from old.status then
    new.status_changed_at := timezone('utc', now());
  end if;
  return new;
end;
$$;

create trigger community_friendships_set_status_changed_at
  before update on public.community_friendships
  for each row
  execute function public.set_status_changed_at();

alter table public.community_friendships enable row level security;

-- Both participants see the row (they need it for the profile card + the
-- requests UI). Nobody else — friendship is private between the pair.
create policy "Friends can read their own friendship"
  on public.community_friendships for select
  to authenticated
  using (auth.uid() in (requester_id, requestee_id));

-- A user may only REQUEST as themselves.
create policy "Users can send friend requests as themselves"
  on public.community_friendships for insert
  to authenticated
  with check (requester_id = auth.uid());

-- Status changes (accept/decline) touch the status of a row the user is
-- part of; the API enforces WHICH participant may transition it (only the
-- requestee may accept/decline).
create policy "Participants can update the friendship status"
  on public.community_friendships for update
  to authenticated
  using (auth.uid() in (requester_id, requestee_id))
  with check (auth.uid() in (requester_id, requestee_id));

-- Cancellation (requester) and friend-removal (either friend) delete the
-- row. The API enforces the state precondition (cancel=pending, remove=accepted).
create policy "Participants can delete their friendship row"
  on public.community_friendships for delete
  to authenticated
  using (auth.uid() in (requester_id, requestee_id));

-- ---------------------------------------------------------------------------
-- 3. Blocks
-- ---------------------------------------------------------------------------

create table public.community_blocks (
  id uuid primary key default gen_random_uuid(),
  blocker_id uuid not null references auth.users(id) on delete cascade,
  blocked_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default timezone('utc', now()),
  constraint community_blocks_self check (blocker_id <> blocked_id),
  constraint community_blocks_unique unique (blocker_id, blocked_id)
);

create index community_blocks_blocked_idx
  on public.community_blocks (blocked_id);

alter table public.community_blocks enable row level security;

-- Both directions matter to the participants: I need to know "I blocked X"
-- (to offer Unblock) and "X blocked me" (to explain rejected actions).
-- Learning that you are blocked is not sensitive data.
create policy "Participants can read block rows"
  on public.community_blocks for select
  to authenticated
  using (auth.uid() in (blocker_id, blocked_id));

create policy "Users can block as themselves"
  on public.community_blocks for insert
  to authenticated
  with check (blocker_id = auth.uid());

-- Only the blocker unblocks. No update path: a block is immutable until
-- removed.
create policy "The blocker can unblock"
  on public.community_blocks for delete
  to authenticated
  using (blocker_id = auth.uid());

-- ---------------------------------------------------------------------------
-- 4. DM conversations (one per friend pair)
-- ---------------------------------------------------------------------------

create table public.community_conversations (
  id uuid primary key default gen_random_uuid(),
  member_a uuid not null references auth.users(id) on delete cascade,
  member_b uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint community_conversations_self check (member_a <> member_b),
  constraint community_conversations_unique_pair unique (least(member_a, member_b),
                                                         greatest(member_a, member_b))
);

create index community_conversations_member_idx
  on public.community_conversations (member_a);
create index community_conversations_member_b_idx
  on public.community_conversations (member_b);

create trigger community_conversations_set_updated_at
  before update on public.community_conversations
  for each row execute function public.set_updated_at();

alter table public.community_conversations enable row level security;

create policy "Members can read their conversations"
  on public.community_conversations for select
  to authenticated
  using (auth.uid() in (member_a, member_b));

-- Conversation creation is allowed from either member's session; the API
-- layer is the one that REQUIRES an accepted friendship + no block before
-- inserting (and the unique-pair constraint makes races idempotent).
create policy "Members can create a conversation with each other"
  on public.community_conversations for insert
  to authenticated
  with check (auth.uid() in (member_a, member_b));

-- No user update/delete policy: conversations are never removed by users
-- (history stays private to the two members; account deletion cascades).
-- The service role (moderation, Phase 3+) may bypass RLS explicitly.

-- ---------------------------------------------------------------------------
-- 5. Direct messages
-- ---------------------------------------------------------------------------

create table public.community_direct_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.community_conversations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  message text,
  image_path text,
  reply_to_message_id uuid references public.community_direct_messages(id) on delete set null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint community_dm_text_length
    check (message is null or char_length(message) <= 2000),
  constraint community_dm_has_content
    check ((message is not null and char_length(btrim(message)) > 0)
           or (image_path is not null))
);

create index community_dm_conversation_idx
  on public.community_direct_messages (conversation_id, created_at desc);
create index community_dm_user_idx
  on public.community_direct_messages (user_id);

create trigger community_dm_set_updated_at
  before update on public.community_direct_messages
  for each row execute function public.set_updated_at();

alter table public.community_direct_messages enable row level security;

-- Read: conversation members only (membership is the privacy boundary —
-- it persists after a friendship is removed, by design).
create policy "Conversation members can read direct messages"
  on public.community_direct_messages for select
  to authenticated
  using (exists (
    select 1 from public.community_conversations c
    where c.id = conversation_id
      and auth.uid() in (c.member_a, c.member_b)
  ));

-- Write: the strictest rule in the app — authorship + membership + a
-- CURRENTLY ACCEPTED friendship + no active block in either direction.
-- The API performs the same check with better error messages; this policy
-- is the last line of defense (a crafted raw query cannot bypass it).
create policy "Friends can send direct messages to each other"
  on public.community_direct_messages for insert
  to authenticated
  with check (
    user_id = auth.uid()
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

-- Edit + delete: the author of their own message in a conversation they
-- are a member of (membership is inherited from the row's conversation).
create policy "Authors can edit their own direct messages"
  on public.community_direct_messages for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy "Authors can delete their own direct messages"
  on public.community_direct_messages for delete
  to authenticated
  using (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- 6. DM reactions (same fixed emoji set as room messages)
-- ---------------------------------------------------------------------------

create table public.community_dm_reactions (
  message_id uuid not null references public.community_direct_messages(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  emoji text not null check (emoji in ('👍', '❤️', '😂', '😮', '😢', '🔥', '✅')),
  created_at timestamptz not null default timezone('utc', now()),
  primary key (message_id, user_id, emoji)
);

create index community_dm_reactions_message_idx
  on public.community_dm_reactions (message_id);

alter table public.community_dm_reactions enable row level security;

-- Only conversation members see DM reactions (unlike room reactions, which
-- are public to all members by design).
create policy "Conversation members can read dm reactions"
  on public.community_dm_reactions for select
  to authenticated
  using (exists (
    select 1 from public.community_conversations c
    join public.community_direct_messages m on m.id = message_id
    where c.id = m.conversation_id
      and auth.uid() in (c.member_a, c.member_b)
  ));

create policy "Conversation members can react"
  on public.community_dm_reactions for insert
  to authenticated
  with check (
    user_id = auth.uid()
    and exists (
      select 1 from public.community_conversations c
      join public.community_direct_messages m on m.id = message_id
      where c.id = m.conversation_id
        and auth.uid() in (c.member_a, c.member_b)
    )
  );

create policy "Conversation members can unreact"
  on public.community_dm_reactions for delete
  to authenticated
  using (
    user_id = auth.uid()
    and exists (
      select 1 from public.community_conversations c
      join public.community_direct_messages m on m.id = message_id
      where c.id = m.conversation_id
        and auth.uid() in (c.member_a, c.member_b)
    )
  );

-- ---------------------------------------------------------------------------
-- 7. DM read state (per member, per conversation)
-- ---------------------------------------------------------------------------

create table public.community_dm_read_state (
  user_id uuid not null references auth.users(id) on delete cascade,
  conversation_id uuid not null references public.community_conversations(id) on delete cascade,
  last_read_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  primary key (user_id, conversation_id)
);

create trigger community_dm_read_state_set_updated_at
  before update on public.community_dm_read_state
  for each row execute function public.set_updated_at();

alter table public.community_dm_read_state enable row level security;

create policy "Users can manage their own dm read state"
  on public.community_dm_read_state for all
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- One-shot summary for the inbox: every conversation the user belongs to,
-- the OTHER member's id, the unread count (no state → all unread), and the
-- last message's shape (text preview / image flag / timestamp). Computed in
-- SQL so the client never downloads a message history to count unread.
create or replace function public.community_dm_summary(p_user uuid)
returns table (
  conversation_id uuid,
  other_user_id uuid,
  unread bigint,
  last_message_at timestamptz,
  last_message text,
  last_message_is_image boolean,
  last_message_mine boolean
)
language sql
stable
as $$
  select c.id,
         case when c.member_a = p_user then c.member_b else c.member_a end,
         (
           select count(*)
           from public.community_direct_messages m
           where m.conversation_id = c.id
             and m.user_id <> p_user
             and (r.last_read_at is null or m.created_at > r.last_read_at)
         ) as unread,
         lm.created_at,
         lm.message,
         (lm.message is null and lm.image_path is not null),
         (lm.user_id = p_user)
  from public.community_conversations c
  left join (
    select s.conversation_id, s.last_read_at
    from public.community_dm_read_state s
    where s.user_id = p_user
  ) r on r.conversation_id = c.id
  left join lateral (
    select m2.user_id, m2.created_at, m2.message, m2.image_path
    from public.community_direct_messages m2
    where m2.conversation_id = c.id
    order by m2.created_at desc, m2.id desc
    limit 1
  ) lm on true
  where p_user in (c.member_a, c.member_b)
  order by coalesce(lm.created_at, c.created_at) desc;
$$;

revoke execute on function public.community_dm_summary(uuid) from public, anon;
grant execute on function public.community_dm_summary(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 8. Notifications: one new type value for social events.
--    (PG 15: ADD VALUE may run inside a transaction; the new value simply
--    cannot be USED until this migration commits — the app only writes it
--    from later requests.)
-- ---------------------------------------------------------------------------

alter type public.notification_type add value if not exists 'social';

-- Stream new notifications to the recipient in realtime (RLS applies on the
-- postgres stream: a client only receives rows it can SELECT — its own +
-- global). Idempotent, like the Phase 1 publication block.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'notifications'
  ) then
    alter publication supabase_realtime add table public.notifications;
  end if;
end
$$;

-- Unread-count for the nav badge: ONE count in SQL (never download rows).
-- The function runs SECURITY INVOKER, so the notifications RLS policy
-- (own + global) applies inside the count automatically.
create or replace function public.community_notifications_unread(p_user uuid)
returns bigint
language sql
stable
as $$
  select count(*)
  from public.notifications n
  where not exists (
    select 1 from public.notification_reads r
    where r.notification_id = n.id and r.user_id = p_user
  );
$$;

revoke execute on function public.community_notifications_unread(uuid) from public, anon;
grant execute on function public.community_notifications_unread(uuid) to authenticated, service_role;

-- DM realtime: new messages + reaction changes stream to the conversation
-- MEMBERS (the RLS select policies above decide who receives what). The
-- edit/delete events are additionally re-broadcast by the actor on the
-- conversation channel (owner-only UPDATE/DELETE rows would otherwise reach
-- only the actor — same model as the room messages).
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'community_direct_messages'
  ) then
    alter publication supabase_realtime add table public.community_direct_messages;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'community_dm_reactions'
  ) then
    alter publication supabase_realtime add table public.community_dm_reactions;
  end if;
  -- Friend-relationship changes (requests arriving, acceptance) reach both
  -- participants so the friends list stays live without polling.
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'community_friendships'
  ) then
    alter publication supabase_realtime add table public.community_friendships;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 9. Storage: DM images under dm/{conversation}/{author}/{message}/image.ext
-- ---------------------------------------------------------------------------
-- The room image policies are tightened to NON-dm paths (room images keep
-- the member-folder layout {user_id}/{message_id}/image.{ext}), and the new
-- dm policies scope every operation to CONVERSATION MEMBERSHIP.

drop policy if exists "Community members can read community images" on storage.objects;
create policy "Community members can read community images"
on storage.objects for select to authenticated
using (bucket_id = 'community-images'
       and (storage.foldername(name))[1] <> 'dm');

drop policy if exists "Users can upload community images to their own folder" on storage.objects;
create policy "Users can upload community images to their own folder"
on storage.objects for insert to authenticated
with check (bucket_id = 'community-images'
            and (storage.foldername(name))[1] <> 'dm'
            and (storage.foldername(name))[1] = auth.uid()::text);

-- DM images: a conversation member may upload into dm/{conv}/{ME}/…
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
            ));

-- …read a dm image only when they are a member of that conversation.
drop policy if exists "Members can read dm images of their conversations" on storage.objects;
create policy "Members can read dm images of their conversations"
on storage.objects for select to authenticated
using (bucket_id = 'community-images'
       and (storage.foldername(name))[1] = 'dm'
       and exists (
         select 1 from public.community_conversations c
         where c.id = (storage.foldername(name))[2]::uuid
           and auth.uid() in (c.member_a, c.member_b)
       ));

-- …and clean up their OWN dm image when they delete the message.
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
       ));
