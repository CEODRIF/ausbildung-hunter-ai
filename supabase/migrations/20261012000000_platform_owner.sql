-- Phase 12: guarantee the platform owner's admin membership.
--
-- Root cause of "owner account not recognized": the Platform Updates
-- feature (and /admin itself) requires a row in public.admins for the
-- session user, and the previous owner check additionally demanded an
-- exact email match on the profile row. The owner account
-- (adsium.business@gmail.com, auth.uid 99a30c47-ebb6-47f1-a38f-3e2594c09e79)
-- was not reliably present in public.admins, so it was denied.
--
-- This migration uses the EXISTING structure (no new system): it inserts
-- the owner's membership if missing and is a no-op otherwise. It does not
-- touch Supabase Auth, RLS, or the notifications tables.

insert into public.admins (user_id, created_by)
values ('99a30c47-ebb6-47f1-a38f-3e2594c09e79', null)
on conflict (user_id) do nothing;
