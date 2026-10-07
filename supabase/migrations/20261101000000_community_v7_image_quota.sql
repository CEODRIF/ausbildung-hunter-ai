-- ============================================================================
-- Community Phase 6A — production hardening: per-user image storage quota.
--
-- ADDITIVE ONLY. This migration contains exactly ONE object:
--   public.community_image_storage_usage(uuid) → bigint
--
-- It reports how many bytes of `community-images` storage belong to a user,
-- counted from the storage catalog (`storage.objects`) — the same source
-- the GDPR deletion sweep and the storage janitor use.
--
-- SUPABASE STORAGE SCHEMA — `storage.objects` has NO `size` column. The
-- byte count lives in the `metadata` jsonb and must be read as
-- `(o.metadata->>'size')::bigint` (the jsonb value is text). The original
-- `sum(o.size)` compiled on generic PostgreSQL but failed on Supabase at
-- CALL time (42703, column o.size does not exist) — the production
-- function was corrected manually and this file now matches it. Guarded by
-- tests/community-phase6a.test.ts and tests/community-migrations-audit.test.ts.
--
-- The three Community image path shapes all resolve ownership from the
-- path itself:
--   * room message images:  {user_id}/{message_id}/image.{ext}
--   * question images:      {user_id}/{question_id}/image.{ext}
--   * DM images:            dm/{conversation_id}/{sender_id}/{message_id}/image.{ext}
-- (first segment = owner for the first two shapes; the THIRD path segment
--  = sender for DM images). User ids are UUIDs, so they can never contain
-- LIKE wildcards — the pattern match is injection-safe by construction.
--
-- NOT in this migration (later sub-phases, see docs/community-phase6-
-- discovery-report.md): room-scoped storage READ policies (6B), voice TTL
-- (6C), question moderation actions (6F).
--
-- Rollback: `drop function if exists public.community_image_storage_usage(uuid);`
-- (pure function — no data, no dependent objects.)
-- ============================================================================

create or replace function public.community_image_storage_usage(p_user uuid)
returns bigint
language sql
security definer
set search_path = public
stable
as $$
  select coalesce(sum(coalesce((o.metadata->>'size')::bigint, 0)), 0)::bigint
  from storage.objects o
  where o.bucket_id = 'community-images'
    and (
      -- {user_id}/... — room message + question images (owner = first
      -- path segment, anchored at position 1).
      strpos(o.name, p_user::text || '/') = 1
      -- dm/{conversation_id}/{sender_id}/... — DM images (owner = third
      -- segment). No other Community path shape can match both branches
      -- simultaneously (user-prefix names never start with 'dm/').
      or o.name like ('dm/%/' || p_user::text || '/%')
    );
$$;

comment on function public.community_image_storage_usage(uuid) is
  'Phase 6A: bytes of community-images storage owned by a user (room + question + DM images). Service role only.';

-- Server-side quota checks only — never callable by end users.
revoke execute on function public.community_image_storage_usage(uuid)
  from public, anon;
grant execute on function public.community_image_storage_usage(uuid)
  to service_role;
