-- ============================================================================
-- Community Phase 6C — stale voice-conversation TTL sweep (single RPC).
--
-- ADDITIVE ONLY: exactly one new function. No tables, columns, indexes,
-- policies, grants on data, or data statements. No B-1 storage changes,
-- no Phase 6A quota/GDPR surface, no 6D infrastructure, no 6F moderation.
--
-- WHAT IT CONVERGES (and what it deliberately does NOT know):
--   community_voice_conversations rows are DURABLE BADGE STATE only — the
--   SFU (LiveKit) is the authority on who is actually connected, and this
--   function NEVER talks to the SFU. It marks an `active` row as `ended`
--   when NO client has joined or observed a participant change for
--   p_stale_minutes (updated_at is refreshed by community_voice_join and
--   every convergent community_voice_sync_count). Dead WebRTC peers are
--   dropped by the SFU within ~15-30s, so any real leave/join would have
--   refreshed the row; a row silent for 15+ minutes is stale by definition
--   of this aggregate.
--
-- SAFE BY CONSTRUCTION:
--   * explicit criteria: status = 'active' AND updated_at < now() - p_stale_minutes
--     (malformed/incomplete records — any other status, missing timestamps
--     (impossible: NOT NULL), NULLs — simply do not match; fail closed),
--   * bounded: oldest first, LIMIT clamped to 1..100,
--   * idempotent: the sweep sets status = 'ended', which the WHERE clause
--     requires to be 'active' → a re-run matches nothing,
--   * no cross-room modification: each row is addressed by its own id;
--     room_id / provider / provider_room_name / participant_count are
--     never touched; rows are never deleted (history stays),
--   * no LiveKit claim: ending a DB record does not remove SFU
--     participants; the documented cosmetic worst case (a quiet-but-live
--     room whose badge flips to ended) self-heals on the next join
--     (community_voice_join inserts a fresh active row).
--
-- SECURED per project convention (Phase 4 v5 join/sync + Phase 6A v7):
-- security definer + pinned search_path, EXECUTE revoked from public/anon,
-- granted to service_role only. Phase 6D schedules the
-- /api/internal/voice-sweep endpoint (worker trust boundary) once real
-- LiveKit infrastructure exists.
--
-- Rollback: drop function if exists public.community_voice_sweep_stale(integer, integer);
-- ============================================================================

create or replace function public.community_voice_sweep_stale(
  p_stale_minutes integer default 15,
  p_max integer default 25
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  swept integer;
begin
  with victims as (
    update public.community_voice_conversations
    set status = 'ended',
        updated_at = timezone('utc', now())
    where id in (
      select c.id
      from public.community_voice_conversations c
      where c.status = 'active'
        and c.updated_at < timezone('utc', now()) - make_interval(mins => greatest(coalesce(p_stale_minutes, 15), 1))
      order by c.updated_at asc
      limit least(greatest(coalesce(p_max, 25), 1), 100)
    )
    returning id
  )
  select count(*) into swept from victims;
  return coalesce(swept, 0);
end;
$$;

revoke execute on function public.community_voice_sweep_stale(integer, integer) from public, anon;
grant execute on function public.community_voice_sweep_stale(integer, integer) to service_role;
