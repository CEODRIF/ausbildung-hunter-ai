-- ============================================================================
-- Community Phase 4 — voice conversations (WebRTC / SFU).
--
-- AUDIO TRANSPORT IS OUT OF DATABASE SCOPE BY DESIGN:
--   Voice media (RTP/WebRTC) flows Browser <-> SFU (LiveKit). Postgres stores
--   only DURABLE APPLICATION STATE: which room has an active voice
--   conversation, under which provider room name, and an AGGREGATE
--   participant count (the "Voice conversation · N" display).
--
--   Live participant state (join / leave / mute / speaking) lives in the SFU
--   and reaches clients through the SFU's own event stream. It is NEVER
--   written here — there is no participants table, no per-participant rows,
--   and no heartbeat writes of any kind.
--
-- MODEL:
--   * A room has 0 or 1 ACTIVE voice conversation (partial unique index).
--     The first join creates the row; the last leave ends it. Ended rows stay
--     as lightweight history and never block a new conversation.
--   * `provider_room_name` is ALWAYS server-derived (croom-<room id>) and
--     regex-constrained — a client can never inject an arbitrary SFU room
--     name (the token route derives it from the authorized room id).
--   * RLS: authenticated users may SELECT the aggregate metadata of enabled
--     rooms (the table carries NO participant identities — there is nothing
--     to leak). INSERT/UPDATE/DELETE are service-role only: the token route
--     (community_voice_join) and the count-sync action
--     (community_voice_sync_count), both re-authorizing the room server-side.
--   * NO realtime publication on this table: the aggregate count is pushed
--     over the Supabase Realtime BROADCAST channel community-voice-<roomId>
--     (metadata only — an integer count, never identities), and page loads
--     read the row directly.
--
-- COUNT CONSISTENCY (no heartbeats):
--   community_voice_sync_count is idempotent and convergent — every
--   SFU-connected participant observes the same participant set, and the
--   function only accepts "the truth did not jump": a decrease (someone
--   left) or exactly +1 (someone joined). 0 ends the conversation.
-- ============================================================================

create table public.community_voice_conversations (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.community_rooms(id) on delete cascade,
  provider text not null default 'livekit'
    check (provider in ('livekit')),
  provider_room_name text not null
    check (provider_room_name ~ '^croom-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  status text not null default 'active' check (status in ('active', 'ended')),
  participant_count integer not null default 0
    check (participant_count >= 0 and participant_count <= 50),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

-- 0 or 1 ACTIVE conversation per room (ended rows are history, not locks).
create unique index community_voice_conversations_room_active_uq
  on public.community_voice_conversations (room_id)
  where status = 'active';

create index community_voice_conversations_room_idx
  on public.community_voice_conversations (room_id, updated_at);

alter table public.community_voice_conversations enable row level security;

-- Aggregate metadata only (no identities exist on this table).
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
  );
-- Deliberately NO insert/update/delete policies for users.

-- Create-or-reuse the ACTIVE conversation of an authorized room (first join
-- creates the row; later joins are no-ops on the count — the clients
-- reconcile the count from the SFU participant set afterwards).
create or replace function public.community_voice_join(p_room uuid)
returns public.community_voice_conversations
language sql
security definer
set search_path = public
as $$
  insert into public.community_voice_conversations
    (room_id, provider, provider_room_name, status, participant_count)
  values (p_room, 'livekit', 'croom-' || p_room::text, 'active', 1)
  on conflict (room_id) where status = 'active'
  do update set
    participant_count = greatest(public.community_voice_conversations.participant_count, 1),
    updated_at = timezone('utc', now())
  returning *;
$$;

-- Reconcile the AGGREGATE count observed by an SFU-connected client.
-- Accepts only convergent moves (a decrease, or exactly +1); 0 ends the
-- conversation. Cosmetic worst case under a lying client: the count is
-- ping-pongable by 1 — it can never reveal or inject identities.
create or replace function public.community_voice_sync_count(
  p_room uuid,
  p_count integer
)
returns void
language sql
security definer
set search_path = public
as $$
  update public.community_voice_conversations
  set participant_count = least(greatest(coalesce(p_count, 0), 0), 50),
      status = case
                 when least(greatest(coalesce(p_count, 0), 0), 50) = 0
                   then 'ended'
                 else status
               end,
      updated_at = timezone('utc', now())
  where room_id = p_room
    and status = 'active'
    and (
      least(greatest(coalesce(p_count, 0), 0), 50) <= participant_count
      or least(greatest(coalesce(p_count, 0), 0), 50) = participant_count + 1
    );
$$;

revoke execute on function public.community_voice_join(uuid)
  from public, anon;
grant execute on function public.community_voice_join(uuid) to authenticated;

revoke execute on function public.community_voice_sync_count(uuid, integer)
  from public, anon;
grant execute on function public.community_voice_sync_count(uuid, integer)
  to authenticated;
