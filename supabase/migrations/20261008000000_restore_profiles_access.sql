-- ----------------------------------------------------------------------------
-- Restore the profiles access contract (RLS policies + grants).
--
-- Production evidence: auth.users.email_confirmed_at is set, the profile row
-- exists with account_status = 'active', the session is valid after login
-- (the layout's `!user` guard did NOT fire), yet the app's authenticated
-- SELECT on public.profiles returns no row — which is the only remaining
-- code path to the erroneous /verify redirect.
--
-- The base migration 20250512000000 defines the RLS policies but relies on
-- Supabase's default privileges for table grants; the production database
-- was not built from the full chain (it was also missing
-- invitation_code_type and handle_new_user), so the policy/grant contract
-- for profiles may be incomplete there.
--
-- This migration restores the ORIGINAL definitions (byte-identical policy
-- bodies), idempotently and additively:
--   - GRANT is a no-op when already present;
--   - policies are created only when missing (checked via pg_policies);
--   - no drops, no revokes, no data changes, no behavior change when the
--     contract is already intact.
-- ----------------------------------------------------------------------------

alter table public.profiles enable row level security;

grant select, update on public.profiles to authenticated;
grant select, insert, update on public.profiles to service_role;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'profiles'
      and policyname = 'Users can read their own profile'
  ) then
    execute 'create policy "Users can read their own profile"
      on public.profiles for select to authenticated
      using (auth.uid() = id)';
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'profiles'
      and policyname = 'Users can update their own onboarding fields'
  ) then
    execute 'create policy "Users can update their own onboarding fields"
      on public.profiles for update to authenticated
      using (auth.uid() = id) with check (auth.uid() = id)';
  end if;
end
$$;
