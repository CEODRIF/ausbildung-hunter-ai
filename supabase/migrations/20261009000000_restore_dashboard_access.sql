-- ----------------------------------------------------------------------------
-- Restore the dashboard's database access contract (RLS policies + grants +
-- the daily-usage RPC) — same failure class as the profiles incident:
-- the production database was never built from the full migration chain, so
-- RLS-gated authenticated queries can fail with "permission denied" or
-- "does not exist" even though the tables may exist.
--
-- The dashboard (getDashboardData) runs seven strict queries with the
-- authenticated server client; any failure aborts the page render
-- ("Your dashboard could not load"):
--   profiles, get_or_create_daily_usage(), application_drafts, activity_logs,
--   email_accounts, bewerbung_scans, candidate_profiles
--
-- This migration restores the ORIGINAL policy/grant definitions (from
-- 20260927000000_dashboard_foundation, 20260927010000_email_accounts,
-- 20260927020000_application_composer, 20260927050000_bewerbung_scanner),
-- idempotently and additively:
--   - every statement is guarded by to_regclass / pg_policies — if a table
--     is entirely missing it is SKIPPED with a NOTICE (do not run
--     hand-crafted DDL for that case: apply the full chain via
--     `npx supabase db push`);
--   - grants are no-ops when already present;
--   - policies are created only when missing;
--   - no drops, no revokes, no table alterations, no data changes.
-- ----------------------------------------------------------------------------

do $do$
begin
  if to_regclass('public.daily_usage') is not null then
    execute 'alter table public.daily_usage enable row level security';
    if not exists (
      select 1 from pg_policies
      where schemaname = 'public' and tablename = 'daily_usage'
        and policyname = 'Users can read their own daily usage'
    ) then
      execute 'create policy "Users can read their own daily usage"
        on public.daily_usage for select to authenticated
        using (auth.uid() = user_id)';
    end if;
    execute 'grant select on public.daily_usage to authenticated';
  else
    raise notice 'restore_dashboard_access: public.daily_usage is missing — skipped; apply the full migration chain';
  end if;
end
$do$;

do $do$
begin
  if to_regclass('public.activity_logs') is not null then
    execute 'alter table public.activity_logs enable row level security';
    if not exists (
      select 1 from pg_policies
      where schemaname = 'public' and tablename = 'activity_logs'
        and policyname = 'Users can read their own activity logs'
    ) then
      execute 'create policy "Users can read their own activity logs"
        on public.activity_logs for select to authenticated
        using (auth.uid() = user_id)';
    end if;
    execute 'grant select on public.activity_logs to authenticated';
  else
    raise notice 'restore_dashboard_access: public.activity_logs is missing — skipped; apply the full migration chain';
  end if;
end
$do$;

do $do$
begin
  if to_regclass('public.application_drafts') is not null then
    execute 'alter table public.application_drafts enable row level security';
    if not exists (
      select 1 from pg_policies
      where schemaname = 'public' and tablename = 'application_drafts'
        and policyname = 'Users can manage their own drafts'
    ) then
      execute 'create policy "Users can manage their own drafts"
        on public.application_drafts for all to authenticated
        using (auth.uid() = user_id)
        with check (auth.uid() = user_id)';
    end if;
    execute 'grant select on public.application_drafts to authenticated';
  else
    raise notice 'restore_dashboard_access: public.application_drafts is missing — skipped; apply the full migration chain';
  end if;
end
$do$;

do $do$
begin
  if to_regclass('public.email_accounts') is not null then
    execute 'alter table public.email_accounts enable row level security';
    if not exists (
      select 1 from pg_policies
      where schemaname = 'public' and tablename = 'email_accounts'
        and policyname = 'Users can read safe fields from their email accounts'
    ) then
      execute 'create policy "Users can read safe fields from their email accounts"
        on public.email_accounts for select to authenticated
        using (auth.uid() = user_id)';
    end if;
    if not exists (
      select 1 from pg_policies
      where schemaname = 'public' and tablename = 'email_accounts'
        and policyname = 'Users can delete their own email accounts'
    ) then
      execute 'create policy "Users can delete their own email accounts"
        on public.email_accounts for delete to authenticated
        using (auth.uid() = user_id)';
    end if;
    execute 'grant select (id, user_id, provider, email, scopes, is_active, created_at, updated_at, last_used_at) on public.email_accounts to authenticated';
    execute 'grant delete on public.email_accounts to authenticated';
  else
    raise notice 'restore_dashboard_access: public.email_accounts is missing — skipped; apply the full migration chain';
  end if;
end
$do$;

do $do$
begin
  if to_regclass('public.bewerbung_scans') is not null then
    execute 'alter table public.bewerbung_scans enable row level security';
    if not exists (
      select 1 from pg_policies
      where schemaname = 'public' and tablename = 'bewerbung_scans'
        and policyname = 'Users can manage their own Bewerbung scans'
    ) then
      execute 'create policy "Users can manage their own Bewerbung scans"
        on public.bewerbung_scans for all to authenticated
        using (auth.uid() = user_id)
        with check (auth.uid() = user_id)';
    end if;
    execute 'grant select on public.bewerbung_scans to authenticated';
  else
    raise notice 'restore_dashboard_access: public.bewerbung_scans is missing — skipped; apply the full migration chain';
  end if;
end
$do$;

do $do$
begin
  if to_regclass('public.candidate_profiles') is not null then
    execute 'alter table public.candidate_profiles enable row level security';
    if not exists (
      select 1 from pg_policies
      where schemaname = 'public' and tablename = 'candidate_profiles'
        and policyname = 'Users can manage their own candidate profiles'
    ) then
      execute 'create policy "Users can manage their own candidate profiles"
        on public.candidate_profiles for all to authenticated
        using (auth.uid() = user_id and exists (select 1 from public.bewerbung_scans s where s.id = scan_id and s.user_id = auth.uid()))
        with check (auth.uid() = user_id and exists (select 1 from public.bewerbung_scans s where s.id = scan_id and s.user_id = auth.uid()))';
    end if;
    execute 'grant select on public.candidate_profiles to authenticated';
  else
    raise notice 'restore_dashboard_access: public.candidate_profiles is missing — skipped; apply the full migration chain';
  end if;
end
$do$;

-- The daily-usage RPC (referenced by the RPC body, so it requires the
-- table to exist). Canonical body from 20260927000000_dashboard_foundation.
do $do$
begin
  if to_regclass('public.daily_usage') is not null then
    execute $rpc$
      create or replace function public.get_or_create_daily_usage()
      returns public.daily_usage
      language plpgsql
      security definer
      set search_path = public
      as $$
      declare
        current_usage public.daily_usage;
        current_user_id uuid := auth.uid();
        current_date_utc date := (timezone('utc', now()))::date;
      begin
        if current_user_id is null then
          raise exception 'not_authenticated';
        end if;

        insert into public.daily_usage (user_id, date)
        values (current_user_id, current_date_utc)
        on conflict (user_id, date) do nothing;

        select * into current_usage
        from public.daily_usage
        where user_id = current_user_id and date = current_date_utc;

        return current_usage;
      end;
      $$
    $rpc$;
    execute 'grant execute on function public.get_or_create_daily_usage() to authenticated';
  else
    raise notice 'restore_dashboard_access: public.get_or_create_daily_usage skipped — public.daily_usage is missing; apply the full migration chain';
  end if;
end
$do$;
