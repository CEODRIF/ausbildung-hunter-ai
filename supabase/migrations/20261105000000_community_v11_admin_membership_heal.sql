-- ============================================================================
-- Community Phase 11 — idempotent heal of the designated platform admin
-- membership (contact@ausbildungsweg.net).
--
-- Production incident (2026-10-08): /admin redirected the designated admin
-- to the normal user dashboard. The /admin layout gate is
-- `public.admins` membership for the session user, and the ONLY code path
-- that ever creates that row for the designated admin is the v10 seed —
-- which is a ONE-SHOT, EMAIL-CONDITIONAL insert that ran exclusively at
-- the moment v10 was applied:
--
--   * v10 applied before the account existed in production   → no-op
--   * v10 applied while the account had a different email    → no-op
--   * v10 never applied to production (pending migrations)   → no row
--
-- Supabase never re-runs an already-applied migration, so once the seed
-- was a no-op, no later deploy could repair the membership — the bounce
-- to /dashboard persisted forever.
--
-- This migration re-asserts the v10 seed with the IDENTICAL guard (same
-- UUID, same email, service-role, single row), so it self-heals on apply:
--
--   * if the UUID is the production account's real id  → the row is
--     created exactly once (idempotent; safe to re-apply);
--   * if the UUID does NOT belong to that email        → no-op again
--     (fail-safe: the guard can never grant an unintended account).
--
-- Design unchanged from v10: the id + email double check, service-role
-- execution at migration time, and exactly one membership row. No RLS is
-- touched, no policy is granted, no other account is affected.
-- ============================================================================

-- /admin layout gate (requireAdmin): the admins membership row.
insert into public.admins (user_id, created_by)
select '6fa45036-1b86-427a-a7d0-54a3a3904767', null
from auth.users u
where u.id = '6fa45036-1b86-427a-a7d0-54a3a3904767'
  and lower(u.email) = 'contact@ausbildungsweg.net'
on conflict (user_id) do nothing;

-- Community role 'owner' (community_is_admin/moderator RLS recognition).
insert into public.community_memberships (user_id, role)
select '6fa45036-1b86-427a-a7d0-54a3a3904767', 'owner'
from auth.users u
where u.id = '6fa45036-1b86-427a-a7d0-54a3a3904767'
  and lower(u.email) = 'contact@ausbildungsweg.net'
on conflict (user_id)
do update set role = 'owner', updated_at = timezone('utc', now());
