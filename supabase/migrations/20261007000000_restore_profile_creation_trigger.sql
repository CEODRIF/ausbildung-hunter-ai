-- ----------------------------------------------------------------------------
-- Restore the profile-creation trigger (handle_new_user / on_auth_user_created).
--
-- Production evidence: auth.users rows exist and email confirmation works, but
-- public.profiles has no row for new sign-ups, `handle_new_user` is absent
-- from pg_proc, and the only trigger on auth.users is
-- on_auth_user_email_confirmed.
--
-- Cause: the production database was never built from the full migration
-- chain — it was missing other objects from the same 20250512000000
-- migration as well (e.g. public.invitation_code_type, restored by a
-- targeted alignment script). The earlier registration flow created profiles
-- explicitly via the service-role upsert_profile RPC, which masked the
-- missing trigger. After the switch to standard Supabase Auth sign-up,
-- profile creation depends solely on this trigger.
--
-- This migration restores the function and trigger EXACTLY as defined in
-- 20250512000000_auth_foundation.sql (same body, same AFTER INSERT timing,
-- same SECURITY DEFINER / search_path). It is additive and idempotent:
--   - create or replace function (no existing object is dropped or altered);
--   - drop trigger IF EXISTS guard + recreate (no-op when already present);
--   - it does NOT consume the invitation code — consumption stays in
--     on_auth_user_email_confirmed / activate_confirmed_user();
--   - it does NOT touch profiles' RLS, the verification_codes objects, or
--     any existing data.
-- ----------------------------------------------------------------------------

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, full_name, email)
  values (new.id, coalesce(new.raw_user_meta_data->>'full_name', ''), new.email)
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();
