-- ============================================================================
-- Community Phase 3 — advanced presence + notification system.
--
-- UPDATES the Phase 1/2 infrastructure in place (no second notification
-- system, no second presence table):
--
--   * notifications gain the typed social-event model: one enum value per
--     event kind + the actor and the entity references needed to navigate
--     safely (room + message / conversation + message / friend request).
--   * community_profiles gains presence + preference columns:
--       presence_mode ('online' | 'away' | 'dnd') — the DECLARED mode.
--       show_presence (bool) — "show my online status" privacy toggle.
--       notify_* (bools) — per-type notification preferences.
--       notify_sound (bool) — client chime preference.
--       muted_room_ids (uuid[]) — muted rooms (mentions override mute).
--     "Online" vs "offline" is derived server-side from last_seen_at
--     (heartbeat freshness) — the client never asserts its own state.
--   * community_notify(): ONE SECURITY DEFINER entry point for server
--     generated social notifications. The actor is always auth.uid() (no
--     forged senders), self-notification is impossible, a block in either
--     direction silences the event (no interaction leaks to a blocked
--     party), and the deterministic send_key makes creation idempotent.
--   * community_notifications_page(): SECURITY INVOKER cursor-paginated feed
--     (RLS-scoped: own + global rows only), read state joined in.
--
-- Idempotent where it matters (add column if not exists / add value if not
-- exists), so re-applying on a partially migrated instance is safe.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Notification type model — one value per social event kind.
--    (PG 15: ADD VALUE may run inside a transaction; a new value is simply
--    unusable until this migration commits — the app writes it from later
--    requests, the same pattern as the 'social' value in v3.)
-- ---------------------------------------------------------------------------

alter type public.notification_type add value if not exists 'friend_request';
alter type public.notification_type add value if not exists 'friend_accepted';
alter type public.notification_type add value if not exists 'mention';
alter type public.notification_type add value if not exists 'reply';
alter type public.notification_type add value if not exists 'reaction';
alter type public.notification_type add value if not exists 'direct_message';

-- ---------------------------------------------------------------------------
-- 2. notifications: actor + entity references (typed rows are rendered
--    client-side per viewer language; the stored title/content stay the
--    fallback text for legacy clients).
-- ---------------------------------------------------------------------------

alter table public.notifications
  add column if not exists actor_id uuid
    references auth.users(id) on delete set null,
  add column if not exists room_id uuid
    references public.community_rooms(id) on delete cascade,
  add column if not exists room_message_id uuid
    references public.community_messages(id) on delete cascade,
  add column if not exists conversation_id uuid
    references public.community_conversations(id) on delete cascade,
  add column if not exists dm_message_id uuid
    references public.community_direct_messages(id) on delete cascade,
  add column if not exists reaction_emoji text
    check (reaction_emoji is null or char_length(reaction_emoji) <= 16);

-- Every row's references must match its kind — a malformed or forged shape
-- (e.g. a "mention" without a message) is rejected by the constraint, not
-- just by the (re-written) helper. Platform rows + legacy 'social' rows
-- carry no references at all.
alter table public.notifications
  add constraint notifications_social_refs check (
    (type = 'friend_request'
      and actor_id is not null and room_id is null and room_message_id is null
      and conversation_id is null and dm_message_id is null)
    or (type = 'friend_accepted'
      and actor_id is not null and room_id is null and room_message_id is null
      and conversation_id is null and dm_message_id is null)
    or (type = 'mention'
      and actor_id is not null and room_id is not null and room_message_id is not null
      and conversation_id is null and dm_message_id is null)
    or (type = 'reply'
      and actor_id is not null and room_id is not null and room_message_id is not null
      and conversation_id is null and dm_message_id is null)
    or (type = 'reaction'
      and actor_id is not null
      and (
        (room_id is not null and room_message_id is not null
          and conversation_id is null and dm_message_id is null)
        or
        (conversation_id is not null and dm_message_id is not null
          and room_id is null and room_message_id is null)
      ))
    or (type = 'direct_message'
      and actor_id is not null and conversation_id is not null
      and room_id is null and room_message_id is null)
    or (type in ('info', 'important', 'maintenance', 'improvement', 'social')
      and room_id is null and room_message_id is null
      and conversation_id is null and dm_message_id is null)
  );

-- The per-user social feed (cursor-paginated, newest first).
create index if not exists notifications_actor_feed_idx
  on public.notifications (target_user_id, created_at desc, id desc)
  where actor_id is not null;

-- ---------------------------------------------------------------------------
-- 3. community_profiles: presence + notification preferences.
--    Defaults are the "sensible on" state; every column is only ever
--    writable through the owner-only UPDATE RLS policy (existing) and the
--    field-whitelisted server actions.
-- ---------------------------------------------------------------------------

alter table public.community_profiles
  add column if not exists presence_mode text not null default 'online'
    check (presence_mode in ('online', 'away', 'dnd')),
  add column if not exists show_presence boolean not null default true,
  add column if not exists notify_friend_requests boolean not null default true,
  add column if not exists notify_mentions boolean not null default true,
  add column if not exists notify_replies boolean not null default true,
  add column if not exists notify_reactions boolean not null default true,
  add column if not exists notify_direct_messages boolean not null default true,
  add column if not exists notify_sound boolean not null default true,
  add column if not exists muted_room_ids uuid[] not null default '{}';

-- ---------------------------------------------------------------------------
-- 4. community_notify() — the ONLY server-generated notification path.
--
--    * SECURITY DEFINER + pinned search_path (same pattern as the
--      invitation-code RPCs — the definerFn audit covers it).
--    * actor = auth.uid(): a caller can never notify as someone else, and
--      the created_by/actor_id columns are stamped from the session.
--    * self-notify is impossible (mention yourself / react to yourself).
--    * a block in EITHER direction silences the event: no interaction may
--      leak to a blocked party ("was your request accepted?" is a leak).
--    * send_key is deterministic per (actor, kind, entity) — double
--      delivery, retries and toggle storms cannot duplicate a row.
--    * returns the row id, or null when suppressed/idempotent.
-- ---------------------------------------------------------------------------

create or replace function public.community_notify(
  p_type public.notification_type,
  p_recipient uuid,
  p_room_id uuid default null,
  p_room_message_id uuid default null,
  p_conversation_id uuid default null,
  p_dm_message_id uuid default null,
  p_reaction_emoji text default null,
  p_send_key uuid default null
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid := auth.uid();
  v_id uuid;
begin
  if v_actor is null then
    raise exception 'community_notify: requires an authenticated session';
  end if;
  if v_actor = p_recipient then
    return null;
  end if;
  if exists (
    select 1
    from public.community_blocks b
    where (b.blocker_id = v_actor and b.blocked_id = p_recipient)
       or (b.blocker_id = p_recipient and b.blocked_id = v_actor)
  ) then
    return null;
  end if;
  if p_send_key is null then
    p_send_key := (
      md5('community_notify:' || v_actor::text || ':' || p_type::text || ':' ||
        coalesce(p_room_message_id::text, p_dm_message_id::text,
                 p_conversation_id::text, p_recipient::text)
      )
    )::uuid;
  end if;
  insert into public.notifications (
    type, target_type, target_user_id, created_by, actor_id,
    room_id, room_message_id, conversation_id, dm_message_id, reaction_emoji,
    title, content, send_key
  ) values (
    p_type, 'user', p_recipient, v_actor, v_actor,
    p_room_id, p_room_message_id, p_conversation_id, p_dm_message_id, p_reaction_emoji,
    'Update', 'Update', p_send_key
  )
  on conflict (send_key) do nothing
  returning id into v_id;
  return v_id;
end;
$$;

revoke execute on function public.community_notify(
  public.notification_type, uuid, uuid, uuid, uuid, uuid, text, uuid
) from public, anon;
grant execute on function public.community_notify(
  public.notification_type, uuid, uuid, uuid, uuid, uuid, text, uuid
) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. community_notifications_page() — the notification center feed.
--    SECURITY INVOKER: the table's SELECT RLS policy (own + global) applies
--    inside the function, so p_user can never be used to read someone
--    else's feed (a foreign p_user simply changes the read-receipt join,
--    which RLS likewise scopes to the session user).
--    Cursor = (created_at, id) — stable under concurrent inserts, no
--    offset scans, no row re-delivery.
-- ---------------------------------------------------------------------------

create or replace function public.community_notifications_page(
  p_user uuid,
  p_before_at timestamptz default null,
  p_before_id uuid default null,
  p_limit int default 30
) returns table (
  id uuid,
  title text,
  content text,
  type public.notification_type,
  target_type public.notification_target_type,
  actor_id uuid,
  room_id uuid,
  room_message_id uuid,
  conversation_id uuid,
  dm_message_id uuid,
  reaction_emoji text,
  created_at timestamptz,
  is_read boolean
)
language sql
stable
as $$
  select n.id, n.title, n.content, n.type, n.target_type,
         n.actor_id, n.room_id, n.room_message_id,
         n.conversation_id, n.dm_message_id, n.reaction_emoji,
         n.created_at,
         exists (
           select 1 from public.notification_reads r
           where r.notification_id = n.id and r.user_id = p_user
         )
  from public.notifications n
  where (n.target_type = 'all' or n.target_user_id = p_user)
    and (p_before_at is null
         or (n.created_at, n.id) < (p_before_at, p_before_id))
  order by n.created_at desc, n.id desc
  limit greatest(coalesce(p_limit, 30), 1);
$$;

revoke execute on function public.community_notifications_page(uuid, timestamptz, uuid, int) from public, anon;
grant execute on function public.community_notifications_page(uuid, timestamptz, uuid, int) to authenticated, service_role;

-- NOTE (realtime): public.notifications is already in the supabase_realtime
-- publication (v3) — the RLS-scoped postgres stream delivers new social
-- events to the recipient only. No new publication needed.
