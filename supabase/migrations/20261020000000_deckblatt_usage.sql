-- AI Deckblatt Generator — daily usage quota (2 designs per user per UTC day).
--
-- Extends the EXISTING quota architecture (same pattern as the search
-- credits migration): a per-user counter table + security-definer RPCs
-- with auth.uid() checks. The browser can only SELECT its own rows;
-- every write goes through the RPCs, so client-side state can never
-- bypass the quota.
--
-- Daily reset: usage_date is a calendar day (UTC). A new day is a new
-- row — nothing has to be deleted or reset.
--
-- Atomicity: reserve_deckblatt_generation() upserts today's row with a
-- conditional WHERE generations_used < 2 and an idempotency key
-- (run_id). Two racing tabs both call reserve: the first upsert inserts
-- 0 -> 1; the second sees the existing ledger row for that run_id
-- (already_reserved) or, with a different run_id, the conditional
-- update finds generations_used = 2 and rejects (quota_exhausted).
-- Concurrency can therefore never exceed the limit.
--
-- Failure refund: release_deckblatt_generation(run_id) decrements ONE
-- unit for a run that was reserved and then FAILED (provider error,
-- timeout, invalid image). Successes are never released. Idempotent by
-- run_id (a double release cannot refund twice).

create table if not exists public.ai_deckblatt_usage (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  usage_date date not null,
  generations_used integer not null default 0
    check (generations_used >= 0 and generations_used <= 2),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint ai_deckblatt_usage_user_date_unique
    unique (user_id, usage_date)
);

create index if not exists ai_deckblatt_usage_user_date_idx
  on public.ai_deckblatt_usage(user_id, usage_date desc);

drop trigger if exists ai_deckblatt_usage_set_updated_at on public.ai_deckblatt_usage;
create trigger ai_deckblatt_usage_set_updated_at
  before update on public.ai_deckblatt_usage
  for each row execute function public.set_updated_at();

-- One immutable ledger row per generation attempt (audit + idempotency).
create table if not exists public.ai_deckblatt_runs (
  run_id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'reserved'
    check (status in ('reserved', 'succeeded', 'failed')),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists ai_deckblatt_runs_user_created_idx
  on public.ai_deckblatt_runs(user_id, created_at desc);

drop trigger if exists ai_deckblatt_runs_set_updated_at on public.ai_deckblatt_runs;
create trigger ai_deckblatt_runs_set_updated_at
  before update on public.ai_deckblatt_runs
  for each row execute function public.set_updated_at();

alter table public.ai_deckblatt_usage enable row level security;
alter table public.ai_deckblatt_runs enable row level security;

-- Read own rows only; all writes are RPC-only (security definer).
drop policy if exists "Users can read their own deckblatt usage" on public.ai_deckblatt_usage;
create policy "Users can read their own deckblatt usage"
  on public.ai_deckblatt_usage for select
  to authenticated
  using (user_id = auth.uid());

drop policy if exists "Users can read their own deckblatt runs" on public.ai_deckblatt_runs;
create policy "Users can read their own deckblatt runs"
  on public.ai_deckblatt_runs for select
  to authenticated
  using (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- Read today's status (2 - used = remaining)
-- ---------------------------------------------------------------------------

create or replace function public.get_deckblatt_usage_status(target_user_id uuid)
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
  select 2,
         coalesce(u.generations_used, 0),
         2 - coalesce(u.generations_used, 0),
         (now() at time zone 'utc')::date
    from public.ai_deckblatt_usage u
   where u.user_id = target_user_id
     and u.usage_date = (now() at time zone 'utc')::date
   union all
   select 2, 0, 2, (now() at time zone 'utc')::date
   where not exists (
     select 1 from public.ai_deckblatt_usage u
      where u.user_id = target_user_id
        and u.usage_date = (now() at time zone 'utc')::date
   );
$$;

revoke execute on function public.get_deckblatt_usage_status(uuid) from public, anon;
grant execute on function public.get_deckblatt_usage_status(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Reserve ONE generation atomically BEFORE calling the provider.
-- Idempotent per run_id: a retry with the same run_id returns
-- 'already_reserved' instead of charging a second time.
-- ---------------------------------------------------------------------------

create or replace function public.reserve_deckblatt_generation(
  target_user_id uuid,
  p_run_id uuid
)
returns table (status text, used integer, remaining integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  today date := (now() at time zone 'utc')::date;
  before_row public.ai_deckblatt_usage;
  new_used integer;
begin
  if auth.uid() is not null and auth.uid() <> target_user_id then
    raise exception 'not_authorized';
  end if;
  if p_run_id is null then
    raise exception 'missing_run_id';
  end if;

  select * into before_row
    from public.ai_deckblatt_usage
   where user_id = target_user_id and usage_date = today
   for update;

  -- Idempotency: this run was already reserved (double click, replayed
  -- request, refreshed browser) — never charge twice.
  if exists (
    select 1 from public.ai_deckblatt_runs r
     where r.run_id = p_run_id and r.user_id = target_user_id
  ) then
    new_used := coalesce(before_row.generations_used, 0);
    return query
      select 'already_reserved'::text, new_used, 2 - new_used;
    return;
  end if;

  insert into public.ai_deckblatt_runs (run_id, user_id, status)
  values (p_run_id, target_user_id, 'reserved');

  insert into public.ai_deckblatt_usage (user_id, usage_date, generations_used)
  values (target_user_id, today, 1)
  on conflict (user_id, usage_date) do update
    set generations_used = ai_deckblatt_usage.generations_used + 1
   where ai_deckblatt_usage.generations_used < 2
  returning generations_used into new_used;

  if new_used is null then
    -- Row existed at the limit (2): the conditional upsert updated
    -- nothing. Concurrency-safe: exactly one of N racing reserves wins.
    delete from public.ai_deckblatt_runs where run_id = p_run_id;
    return query
      select 'quota_exhausted'::text, 2, 0;
    return;
  end if;

  return query
    select 'reserved'::text, new_used, 2 - new_used;
end;
$$;

revoke execute on function public.reserve_deckblatt_generation(uuid, uuid) from public, anon;
grant execute on function public.reserve_deckblatt_generation(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Release a reserved (but FAILED) generation. Only reserved rows count;
-- a run that already succeeded is never refunded. Idempotent per run_id.
-- ---------------------------------------------------------------------------

create or replace function public.release_deckblatt_generation(
  target_user_id uuid,
  p_run_id uuid
)
returns table (status text, used integer, remaining integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  today date := (now() at time zone 'utc')::date;
  run_row public.ai_deckblatt_runs;
  cur_used integer;
begin
  if auth.uid() is not null and auth.uid() <> target_user_id then
    raise exception 'not_authorized';
  end if;
  if p_run_id is null then
    raise exception 'missing_run_id';
  end if;

  select * into run_row
    from public.ai_deckblatt_runs
   where run_id = p_run_id and user_id = target_user_id;

  -- Unknown run, or a run that SUCCEEDED: nothing to refund.
  if run_row is null or run_row.status <> 'reserved' then
    select coalesce(u.generations_used, 0) into cur_used
      from public.ai_deckblatt_usage u
     where u.user_id = target_user_id and u.usage_date = today;
    return query
      select 'no_op'::text, cur_used, 2 - cur_used;
    return;
  end if;

  update public.ai_deckblatt_runs
     set status = 'failed'
   where run_id = p_run_id;

  update public.ai_deckblatt_usage u
     set generations_used = greatest(u.generations_used - 1, 0)
   where u.user_id = target_user_id and u.usage_date = today
   returning generations_used into cur_used;

  return query
    select 'released'::text, coalesce(cur_used, 0), 2 - coalesce(cur_used, 0);
end;
$$;

revoke execute on function public.release_deckblatt_generation(uuid, uuid) from public, anon;
grant execute on function public.release_deckblatt_generation(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Record a SUCCESS (keeps the ledger honest; quota is NOT changed).
-- ---------------------------------------------------------------------------

create or replace function public.complete_deckblatt_generation(
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
  update public.ai_deckblatt_runs
     set status = 'succeeded'
   where run_id = p_run_id and user_id = target_user_id;
end;
$$;

revoke execute on function public.complete_deckblatt_generation(uuid, uuid) from public, anon;
grant execute on function public.complete_deckblatt_generation(uuid, uuid) to authenticated;
