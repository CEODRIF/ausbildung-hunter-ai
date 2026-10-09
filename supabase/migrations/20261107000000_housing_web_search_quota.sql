-- Housing web search — strict per-user DAILY quota (default 20 searches per
-- calendar day, Europe/Berlin).
--
-- Follows the established quota architecture (same pattern as
-- 20261020000000_deckblatt_usage.sql and 20261016000000_search_credits.sql):
-- a per-user counter table + an immutable run ledger + security-definer
-- RPCs with auth.uid() checks. The browser can only SELECT its own rows;
-- every write goes through the RPCs, so client-side state can never bypass
-- the quota and no code path can charge someone else's account.
--
-- Why this exists: each search run spends a paid Bing-grounded web search
-- (Azure AI Foundry web_search tool). The previous gate was a per-PROCESS
-- global budget (default 2000, in memory) — it was not per-user, not
-- persisted, and a serverless cold start could silently double-spend.
--
-- Daily reset: usage_date is a Europe/Berlin calendar day
-- ((now() at time zone 'Europe/Berlin')::date). A new day is a new row —
-- nothing has to be deleted or reset. Berlin is the audience's timezone;
-- all UI reset times are anchored to the same day key.
--
-- Atomicity (concurrency can never exceed the limit):
--   reserve_housing_web_search() upserts today's row with a conditional
--   WHERE searches_used < p_daily_limit and an idempotency key (run_id).
--   N racing requests each execute ONE atomic statement; exactly
--   (limit - already_used) of them can win, the rest get 'quota_exhausted'.
--
-- Idempotency: a retry with the same run_id returns 'already_reserved' —
-- a single logical search is never charged twice.
--
-- Failure refund: release_housing_web_search(run_id, limit) decrements ONE
-- unit for a run that was reserved and then FAILED (provider error,
-- timeout) or that turned out to be a result-cache hit (no paid call).
-- Successes are never released. Idempotent by run_id (a double release
-- cannot refund twice).
--
-- Stale recovery: expire_stale_housing_web_search_runs() refunds runs that
-- stayed 'reserved' beyond a window (platform kill of a long function,
-- browser navigated away, lost release call). Comfortably longer than any
-- search the function allows (maxDuration 60s), short enough that the
-- user's next attempt repairs the day.
--
-- The DAILY LIMIT IS NOT HARDCODED in SQL: the server passes it as
-- p_daily_limit on every call (env HOUSING_WEB_SEARCH_DAILY_MAX, default
-- 20). This keeps the limit a server-side setting without a migration per
-- change.

create table if not exists public.housing_web_search_usage (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  usage_date date not null,
  searches_used integer not null default 0 check (searches_used >= 0),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint housing_web_search_usage_user_date_unique
    unique (user_id, usage_date)
);

create index if not exists housing_web_search_usage_user_date_idx
  on public.housing_web_search_usage(user_id, usage_date desc);

drop trigger if exists housing_web_search_usage_set_updated_at on public.housing_web_search_usage;
create trigger housing_web_search_usage_set_updated_at
  before update on public.housing_web_search_usage
  for each row execute function public.set_updated_at();

-- One immutable ledger row per search attempt (audit + idempotency).
create table if not exists public.housing_web_search_runs (
  run_id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'reserved'
    check (status in ('reserved', 'succeeded', 'failed')),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists housing_web_search_runs_user_created_idx
  on public.housing_web_search_runs(user_id, created_at desc);

drop trigger if exists housing_web_search_runs_set_updated_at on public.housing_web_search_runs;
create trigger housing_web_search_runs_set_updated_at
  before update on public.housing_web_search_runs
  for each row execute function public.set_updated_at();

alter table public.housing_web_search_usage enable row level security;
alter table public.housing_web_search_runs enable row level security;

-- Read own rows only; all writes are RPC-only (security definer).
drop policy if exists "Users can read their own housing web search usage" on public.housing_web_search_usage;
create policy "Users can read their own housing web search usage"
  on public.housing_web_search_usage for select
  to authenticated
  using (user_id = auth.uid());

drop policy if exists "Users can read their own housing web search runs" on public.housing_web_search_runs;
create policy "Users can read their own housing web search runs"
  on public.housing_web_search_runs for select
  to authenticated
  using (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- Read today's status (p_daily_limit - used = remaining)
-- ---------------------------------------------------------------------------

create or replace function public.get_housing_web_search_status(
  target_user_id uuid,
  p_daily_limit integer
)
returns table (
  -- "limit" is a fully reserved PostgreSQL word and cannot be a
  -- RETURNS TABLE field name (syntax error 42601) — hence daily_limit.
  daily_limit integer,
  used integer,
  remaining integer,
  usage_date date
)
language sql
security definer
set search_path = public
as $$
  select p_daily_limit,
         coalesce(u.searches_used, 0),
         greatest(p_daily_limit - coalesce(u.searches_used, 0), 0),
         (now() at time zone 'Europe/Berlin')::date
    from public.housing_web_search_usage u
   where u.user_id = target_user_id
     and u.usage_date = (now() at time zone 'Europe/Berlin')::date
   union all
   select p_daily_limit, 0, p_daily_limit, (now() at time zone 'Europe/Berlin')::date
   where not exists (
     select 1 from public.housing_web_search_usage u
      where u.user_id = target_user_id
        and u.usage_date = (now() at time zone 'Europe/Berlin')::date
   );
$$;

revoke execute on function public.get_housing_web_search_status(uuid, integer) from public, anon;
grant execute on function public.get_housing_web_search_status(uuid, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- Reserve ONE search atomically BEFORE calling the provider.
-- Idempotent per run_id: a retry with the same run_id returns
-- 'already_reserved' instead of charging a second time.
-- ---------------------------------------------------------------------------

create or replace function public.reserve_housing_web_search(
  target_user_id uuid,
  p_run_id uuid,
  p_daily_limit integer
)
returns table (status text, used integer, remaining integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  today date := (now() at time zone 'Europe/Berlin')::date;
  before_row public.housing_web_search_usage;
  new_used integer;
begin
  if auth.uid() is not null and auth.uid() <> target_user_id then
    raise exception 'not_authorized';
  end if;
  if p_run_id is null then
    raise exception 'missing_run_id';
  end if;
  if p_daily_limit is null or p_daily_limit < 1 then
    raise exception 'invalid_daily_limit';
  end if;

  select * into before_row
    from public.housing_web_search_usage
   where user_id = target_user_id and usage_date = today
   for update;

  -- Idempotency: this run was already reserved (double click, replayed
  -- request, refreshed browser) — never charge twice.
  if exists (
    select 1 from public.housing_web_search_runs r
     where r.run_id = p_run_id and r.user_id = target_user_id
  ) then
    new_used := coalesce(before_row.searches_used, 0);
    return query
      select 'already_reserved'::text, new_used,
             greatest(p_daily_limit - new_used, 0);
    return;
  end if;

  insert into public.housing_web_search_runs (run_id, user_id, status)
  values (p_run_id, target_user_id, 'reserved');

  insert into public.housing_web_search_usage (user_id, usage_date, searches_used)
  values (target_user_id, today, 1)
  on conflict (user_id, usage_date) do update
    set searches_used = housing_web_search_usage.searches_used + 1
   where housing_web_search_usage.searches_used < p_daily_limit
   returning searches_used into new_used;

  if new_used is null then
    -- Row existed at the limit: the conditional upsert updated nothing.
    -- Concurrency-safe: exactly one of N racing reserves wins per slot.
    delete from public.housing_web_search_runs where run_id = p_run_id;
    return query
      select 'quota_exhausted'::text, p_daily_limit, 0;
    return;
  end if;

  return query
    select 'reserved'::text, new_used, greatest(p_daily_limit - new_used, 0);
end;
$$;

revoke execute on function public.reserve_housing_web_search(uuid, uuid, integer) from public, anon;
grant execute on function public.reserve_housing_web_search(uuid, uuid, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- Release a reserved (but FAILED or cache-served) search. Only reserved rows
-- count; a run that already succeeded is never refunded. Idempotent per
-- run_id (a double release cannot refund twice).
-- ---------------------------------------------------------------------------

create or replace function public.release_housing_web_search(
  target_user_id uuid,
  p_run_id uuid,
  p_daily_limit integer
)
returns table (status text, used integer, remaining integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  today date := (now() at time zone 'Europe/Berlin')::date;
  run_row public.housing_web_search_runs;
  cur_used integer;
begin
  if auth.uid() is not null and auth.uid() <> target_user_id then
    raise exception 'not_authorized';
  end if;
  if p_run_id is null then
    raise exception 'missing_run_id';
  end if;
  if p_daily_limit is null or p_daily_limit < 1 then
    raise exception 'invalid_daily_limit';
  end if;

  select * into run_row
    from public.housing_web_search_runs
   where run_id = p_run_id and user_id = target_user_id;

  -- Unknown run, or a run that SUCCEEDED: nothing to refund.
  if run_row is null or run_row.status <> 'reserved' then
    select coalesce(u.searches_used, 0) into cur_used
      from public.housing_web_search_usage u
     where u.user_id = target_user_id and u.usage_date = today;
    return query
      select 'no_op'::text, cur_used,
             greatest(p_daily_limit - cur_used, 0);
    return;
  end if;

  update public.housing_web_search_runs
     set status = 'failed'
   where run_id = p_run_id;

  update public.housing_web_search_usage u
     set searches_used = greatest(u.searches_used - 1, 0)
   where u.user_id = target_user_id and u.usage_date = today
   returning searches_used into cur_used;

  return query
    select 'released'::text, coalesce(cur_used, 0),
           greatest(p_daily_limit - coalesce(cur_used, 0), 0);
end;
$$;

revoke execute on function public.release_housing_web_search(uuid, uuid, integer) from public, anon;
grant execute on function public.release_housing_web_search(uuid, uuid, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- Record a SUCCESS (keeps the ledger honest; quota is NOT changed).
-- ---------------------------------------------------------------------------

create or replace function public.complete_housing_web_search(
  target_user_id uuid,
  p_run_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is not null and auth.uid() <> target_user_id then
    raise exception 'not_authorized';
  end if;
  update public.housing_web_search_runs
     set status = 'succeeded'
   where run_id = p_run_id and user_id = target_user_id;
end;
$$;

revoke execute on function public.complete_housing_web_search(uuid, uuid) from public, anon;
grant execute on function public.complete_housing_web_search(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Stale reservation recovery: refund runs still 'reserved' after the window
-- (the route settles every run in a finally block; this covers platform
-- kills and lost settlement calls). Best effort, called before every
-- reserve and status read.
-- ---------------------------------------------------------------------------

create or replace function public.expire_stale_housing_web_search_runs(
  target_user_id uuid,
  p_max_age_minutes integer
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  today date := (now() at time zone 'Europe/Berlin')::date;
  stale record;
  refunded integer := 0;
begin
  if auth.uid() is not null and auth.uid() <> target_user_id then
    raise exception 'not_authorized';
  end if;
  if p_max_age_minutes is null or p_max_age_minutes < 1 then
    raise exception 'invalid_max_age';
  end if;

  for stale in
    select r.run_id
      from public.housing_web_search_runs r
     where r.user_id = target_user_id
       and r.status = 'reserved'
       and r.created_at < now() - make_interval(mins => p_max_age_minutes)
  loop
    update public.housing_web_search_runs
       set status = 'failed'
     where run_id = stale.run_id;

    update public.housing_web_search_usage u
       set searches_used = greatest(u.searches_used - 1, 0)
     where u.user_id = target_user_id
       and u.usage_date = today;

    refunded := refunded + 1;
  end loop;

  return refunded;
end;
$$;

revoke execute on function public.expire_stale_housing_web_search_runs(uuid, integer) from public, anon;
grant execute on function public.expire_stale_housing_web_search_runs(uuid, integer) to authenticated;
