-- ============================================================================
-- 20261124000000 — Production repair: bring a 20261120-only schema to the
-- full billing-v2 state in ONE rerun-safe pass, without the
-- feature_capacity_status regression.
--
-- WHY THIS FILE EXISTS
--   Production has 20261120 applied, 20261121/20261122 absent (the 20261121
--   apply failed at complete_feature_op and the editor rolled the whole
--   batch back), and 20261123 applied manually. Re-running 20261121 would
--   work EXCEPT its section 9 replaces the 20261123 feature_capacity_status
--   (bew_applications remap) with the legacy version (counts the dead
--   public.applications table). This file applies everything else
--   verbatim and swaps in the 20261123 version instead.
--
-- PROVENANCE (verbatim extractions — no invented SQL):
--   [A] 20261121000000_feature_quotas.sql, CORRECTED
--       (branch fix/20261121-complete-feature-op-begin, commit 97e4e07:
--       +begin/+end; in complete_feature_op) — all statements EXCEPT its
--       section 9 (feature_capacity_status + its 2 grants).
--   [B] 20261122000000_mock_checkout_complete.sql — all statements.
--   [C] 20261123000000_saved_application_capacity.sql — ONLY its
--       feature_capacity_status block (the bew_applications remap) + grants.
--
-- SAFE FROM ANY STATE WHERE 20261120 IS APPLIED, regardless of whether
-- 20261121/22/23 are present: every statement is create-if-not-exists /
-- create-or-replace / drop-guarded. The only data statement is the ai-files
-- bucket ceiling 10485760 -> 15728640 (idempotent, intended).
-- No user data (subscriptions, plans, usage rows, applications) is read,
-- written, or deleted at apply time.
--
-- Do NOT also re-run 20261121/20261122 after this file: redundant, and
-- 20261121's section 9 would clobber [C].
-- ============================================================================

-- [A] from corrected 20261121 (section 9 excluded)
create table if not exists public.feature_usage (
  user_id uuid not null references auth.users(id) on delete cascade,
  feature_id text not null check (feature_id in (
    'ai_assistant',
    'cover_letter',
    'resume_ai',
    'scanner',
    'deckblatt',
    'email_drafts',
    'opportunity_search',
    'saved_opportunities',
    'saved_applications',
    'salary_calculator',
    'automation',
    'upload'
  )),
  period_key text not null,
  used integer not null default 0
    check (used >= 0 and used <= 1000000),
  updated_at timestamptz not null default timezone('utc', now()),
  primary key (user_id, feature_id, period_key)
);



create index if not exists feature_usage_user_feature_idx
  on public.feature_usage(user_id, feature_id);



create index if not exists feature_usage_user_period_idx
  on public.feature_usage(user_id, period_key);



drop trigger if exists feature_usage_set_updated_at on public.feature_usage;


create trigger feature_usage_set_updated_at
  before update on public.feature_usage
  for each row execute function public.set_updated_at();



alter table public.feature_usage enable row level security;



-- Read own rows only; all writes are RPC-only (security definer).
drop policy if exists "Users can read their own feature usage" on public.feature_usage;


create policy "Users can read their own feature usage"
  on public.feature_usage for select
  to authenticated
  using (user_id = auth.uid());



-- 2. feature_usage_runs: idempotency + audit ledger -----------------------

create table if not exists public.feature_usage_runs (
  run_id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  feature_id text not null check (feature_id in (
    'ai_assistant',
    'cover_letter',
    'resume_ai',
    'scanner',
    'deckblatt',
    'email_drafts',
    'opportunity_search',
    'saved_opportunities',
    'saved_applications',
    'salary_calculator',
    'automation',
    'upload'
  )),
  period_key text not null,
  status text not null default 'reserved'
    check (status in ('reserved', 'succeeded', 'failed', 'released')),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint feature_usage_runs_user_feature_run_unique
    unique (user_id, feature_id, run_id)
);



create index if not exists feature_usage_runs_user_status_idx
  on public.feature_usage_runs(user_id, status, created_at desc);



drop trigger if exists feature_usage_runs_set_updated_at on public.feature_usage_runs;


create trigger feature_usage_runs_set_updated_at
  before update on public.feature_usage_runs
  for each row execute function public.set_updated_at();



alter table public.feature_usage_runs enable row level security;



drop policy if exists "Users can read their own feature usage runs" on public.feature_usage_runs;


create policy "Users can read their own feature usage runs"
  on public.feature_usage_runs for select
  to authenticated
  using (user_id = auth.uid());



-- 3. feature_quota_kind: SQL mirror of FEATURE_QUOTA_KIND -----------------

create or replace function public.feature_quota_kind(p_feature_id text)
returns text
language sql
immutable
security definer
set search_path = public
as $$
  select case p_feature_id
    when 'ai_assistant' then 'per_day'
    when 'cover_letter' then 'per_day'
    when 'deckblatt' then 'per_day'
    when 'email_drafts' then 'per_day'
    when 'opportunity_search' then 'per_day'
    when 'automation' then 'per_day'
    when 'resume_ai' then 'per_cycle'
    when 'scanner' then 'per_cycle'
    when 'saved_opportunities' then 'items'
    when 'saved_applications' then 'items'
    when 'salary_calculator' then 'none'
    when 'upload' then 'static_mb'
    else null
  end;
$$;



revoke all on function public.feature_quota_kind(text) from public, anon, authenticated;


grant execute on function public.feature_quota_kind(text) to service_role;



-- 4. plan_feature_limit: the user's effective limit for one feature ------
-- Returns NULL (not 0) when there is no active commercial subscription,
-- the plan row has no entry for the feature, or the entry is not numeric:
-- NULL means "no plan quota" (legacy / unmetered), which callers must
-- treat as their documented fallback.

create or replace function public.plan_feature_limit(p_user_id uuid, p_feature_id text)
returns integer
language sql
security definer
set search_path = public
as $$
  select (bp.feature_limits ->> p_feature_id)::integer
    from public.subscriptions s
    join public.billing_plans bp on bp.plan_id = s.plan
   where s.user_id = p_user_id
     and s.status = 'active'
     and (s.current_period_end is null or s.current_period_end > timezone('utc', now()))
     and bp.feature_limits ->> p_feature_id ~ '^-?[0-9]+$';
$$;



revoke all on function public.plan_feature_limit(uuid, text) from public, anon, authenticated;


grant execute on function public.plan_feature_limit(uuid, text) to service_role;



-- 5. reserve_feature_op: atomic reservation before executing an op -------
-- Concurrency: the counter row lock (insert ... on conflict do update)
-- guarantees exactly one of N racing reserves at the limit wins. The run
-- ledger (on conflict do nothing + FOUND) makes duplicate run ids
-- idempotent even when two requests race.

create or replace function public.reserve_feature_op(p_user_id uuid, p_feature_id text, p_run_id uuid)
returns table (status text, used integer, remaining integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  kind text := public.feature_quota_kind(p_feature_id);
  plan_limit integer := public.plan_feature_limit(p_user_id, p_feature_id);
  period_key text;
  sub_start timestamptz;
  cur_used integer;
begin
  if p_user_id is null or p_feature_id is null or p_run_id is null then
    raise exception 'missing_args';
  end if;

  -- Unmetered kinds (none / static_mb / items) and unknown features: the
  -- caller checks these before insert/update; nothing to reserve here.
  if kind is null or kind in ('none', 'static_mb', 'items') then
    return query select 'unmetered'::text, null::integer, null::integer;
    return;
  end if;

  -- No active commercial plan with a numeric limit: legacy behavior is
  -- unmetered for these features. A database failure upstream already
  -- denied the call in the entitlement service; this only covers
  -- genuinely unmetered legacy rows.
  if plan_limit is null then
    return query select 'unmetered'::text, null::integer, null::integer;
    return;
  end if;

  -- A zero (or negative) limit means the feature is disabled for this
  -- plan (e.g. trial automation). Report exhaustion BEFORE any insert so
  -- a disabled feature never creates usage rows.
  if plan_limit <= 0 then
    return query select 'quota_exhausted'::text, plan_limit, 0;
    return;
  end if;

  if kind = 'per_day' then
    period_key := (timezone('utc', now()))::date::text;
  else
    -- per_cycle: the current subscription period is the cycle.
    select s.current_period_start into sub_start
      from public.subscriptions s
     where s.user_id = p_user_id;
    if sub_start is null then
      sub_start := timezone('utc', now());
    end if;
    period_key := (timezone('utc', sub_start))::date::text;
  end if;

  -- Idempotency: this run is already on the ledger (double click,
  -- replayed request, refreshed browser) — never charge twice.
  if exists (
    select 1 from public.feature_usage_runs r
     where r.run_id = p_run_id and r.user_id = p_user_id
  ) then
    select f.used into cur_used
      from public.feature_usage f
     where f.user_id = p_user_id
       and f.feature_id = p_feature_id
       and f.period_key = period_key;
    return query select 'already_reserved'::text,
                        coalesce(cur_used, 0),
                        greatest(plan_limit - coalesce(cur_used, 0), 0);
    return;
  end if;

  insert into public.feature_usage_runs (run_id, user_id, feature_id, period_key, status)
  values (p_run_id, p_user_id, p_feature_id, period_key, 'reserved')
  on conflict (run_id) do nothing;

  if not found then
    -- Lost a duplicate-submit race: the run id belongs to this user and
    -- is already reserved.
    select f.used into cur_used
      from public.feature_usage f
     where f.user_id = p_user_id
       and f.feature_id = p_feature_id
       and f.period_key = period_key;
    return query select 'already_reserved'::text,
                        coalesce(cur_used, 0),
                        greatest(plan_limit - coalesce(cur_used, 0), 0);
    return;
  end if;

  -- Atomic increment; the WHERE clause makes it impossible to exceed the
  -- limit, even under concurrent racers.
  insert into public.feature_usage (user_id, feature_id, period_key, used)
  values (p_user_id, p_feature_id, period_key, 1)
  on conflict (user_id, feature_id, period_key)
  do update set used = public.feature_usage.used + 1
  where public.feature_usage.used < plan_limit
  returning public.feature_usage.used into cur_used;

  if cur_used is null then
    -- The counter row already sat at the limit: undo the ledger row.
    delete from public.feature_usage_runs
     where run_id = p_run_id and user_id = p_user_id;
    return query select 'quota_exhausted'::text, plan_limit, 0;
    return;
  end if;

  return query select 'reserved'::text, cur_used, greatest(plan_limit - cur_used, 0);
end;
$$;



revoke all on function public.reserve_feature_op(uuid, text, uuid) from public, anon, authenticated;


grant execute on function public.reserve_feature_op(uuid, text, uuid) to service_role;



-- 6. complete_feature_op: mark a reserved op as succeeded ----------------
-- A completed op keeps its quota unit (the operation executed). Repeats,
-- unknown run ids, and already released/failed rows are no-ops.

create or replace function public.complete_feature_op(p_user_id uuid, p_run_id uuid)
returns table (status text)
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_user_id is null or p_run_id is null then
    raise exception 'missing_args';
  end if;

  update public.feature_usage_runs
     set status = 'succeeded'
   where run_id = p_run_id
     and user_id = p_user_id
     and status = 'reserved';

  if found then
    return query select 'completed'::text;
  end if;

  return query select 'no_op'::text;
end;
$$;



revoke all on function public.complete_feature_op(uuid, uuid) from public, anon, authenticated;


grant execute on function public.complete_feature_op(uuid, uuid) to service_role;



-- 7. release_feature_op: refund a reserved op that FAILED ----------------
-- A failed operation must not consume quota. Only reserved rows are
-- refunded; a run that already succeeded is never released. Idempotent
-- per run id (a double release cannot refund twice).

create or replace function public.release_feature_op(p_user_id uuid, p_run_id uuid)
returns table (status text)
language plpgsql
security definer
set search_path = public
as $$
declare
  run_row public.feature_usage_runs;
begin
  if p_user_id is null or p_run_id is null then
    raise exception 'missing_args';
  end if;

  select r.* into run_row
    from public.feature_usage_runs r
   where r.run_id = p_run_id and r.user_id = p_user_id
   for update;

  -- Unknown run, or a run that already succeeded: nothing to refund.
  if run_row is null or run_row.status <> 'reserved' then
    return query select 'no_op'::text;
  end if;

  update public.feature_usage_runs
     set status = 'released'
   where run_id = p_run_id and user_id = p_user_id;

  update public.feature_usage u
     set used = greatest(u.used - 1, 0)
   where u.user_id = p_user_id
     and u.feature_id = run_row.feature_id
     and u.period_key = run_row.period_key;

  return query select 'released'::text;
end;
$$;



revoke all on function public.release_feature_op(uuid, uuid) from public, anon, authenticated;


grant execute on function public.release_feature_op(uuid, uuid) to service_role;



-- 8. expire_stale_feature_runs: rerun-safe safety net --------------------
-- Reserved rows older than the age threshold are released and their units
-- refunded. The count is snapshotted BEFORE the modifying statement
-- (a data-modifying CTE chain cannot be re-read afterwards); it is a
-- best-effort metric, not a billing fact. Rerunning is safe: a second
-- invocation finds nothing and returns 0.

create or replace function public.expire_stale_feature_runs(p_age_minutes integer default 15)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  age_minutes integer := coalesce(nullif(p_age_minutes, 0), 15);
  stale_count integer;
begin
  if age_minutes <= 0 then
    age_minutes := 15;
  end if;

  select count(*)::integer into stale_count
    from public.feature_usage_runs
   where status = 'reserved'
     and created_at < timezone('utc', now()) - make_interval(mins => age_minutes);

  if stale_count > 0 then
    with stale_runs as (
      select r.run_id, r.user_id, r.feature_id, r.period_key
        from public.feature_usage_runs r
       where r.status = 'reserved'
         and r.created_at < timezone('utc', now()) - make_interval(mins => age_minutes)
    ), marked as (
      update public.feature_usage_runs r
         set status = 'released'
        from stale_runs s
       where r.run_id = s.run_id
       returning r.user_id, r.feature_id, r.period_key
    ), decrements as (
      select m.user_id, m.feature_id, m.period_key, count(*)::integer as n
        from marked m
       group by m.user_id, m.feature_id, m.period_key
    )
    update public.feature_usage u
       set used = greatest(u.used - d.n, 0)
      from decrements d
     where u.user_id = d.user_id
       and u.feature_id = d.feature_id
       and u.period_key = d.period_key;
  end if;

  return coalesce(stale_count, 0);
end;
$$;



revoke all on function public.expire_stale_feature_runs(integer) from public, anon, authenticated;


grant execute on function public.expire_stale_feature_runs(integer) to service_role;



-- 9. feature_quota_status: read side for per_day / per_cycle features ----
-- Scalar subqueries (never SELECT INTO): a missing counter row must read
-- as 0, not NULL, so a first use of the day is allowed, not denied.
-- resets_at is epoch milliseconds (or null), matching the entitlement
-- service's readMeter contract.

create or replace function public.feature_quota_status(p_user_id uuid, p_feature_id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  kind text := public.feature_quota_kind(p_feature_id);
  sub_start timestamptz;
  resets_at timestamptz;
  period_key text;
  used_value integer;
begin
  if p_user_id is null or p_feature_id is null then
    raise exception 'missing_args';
  end if;

  -- Non-metered kinds have no counter to report.
  if kind is null or kind in ('none', 'static_mb', 'items') then
    return null;
  end if;

  if kind = 'per_day' then
    period_key := (timezone('utc', now()))::date::text;
    resets_at := (period_key::date + 1) at time zone 'utc';
  else
    -- per_cycle: the counter and the reset instant follow the
    -- subscription period.
    select s.current_period_start, s.current_period_end
      into sub_start, resets_at
      from public.subscriptions s
     where s.user_id = p_user_id;
    if sub_start is null then
      sub_start := timezone('utc', now());
    end if;
    period_key := (timezone('utc', sub_start))::date::text;
  end if;

  if p_feature_id = 'ai_assistant' then
    used_value := coalesce(
      (select d.ai_requests
         from public.daily_usage d
        where d.user_id = p_user_id
          and d.date = (timezone('utc', now()))::date), 0);
  elsif p_feature_id = 'deckblatt' then
    used_value := coalesce(
      (select u.generations_used
         from public.ai_deckblatt_usage u
        where u.user_id = p_user_id
          and u.usage_date = (timezone('utc', now()))::date), 0);
  else
    used_value := coalesce(
      (select f.used
         from public.feature_usage f
        where f.user_id = p_user_id
          and f.feature_id = p_feature_id
          and f.period_key = period_key), 0);
  end if;

  return jsonb_build_object(
    'used', used_value,
    'resets_at', case
      when resets_at is null then null::bigint
      else (extract(epoch from resets_at) * 1000)::bigint
    end
  );
end;
$$;



revoke all on function public.feature_quota_status(uuid, text) from public, anon, authenticated;


grant execute on function public.feature_quota_status(uuid, text) to service_role;



-- 11. release_ai_request: refund one failed AI request of the UTC day ----
-- Plain-text contract (consumed by the entitlement service): 'no_op' when
-- nothing was decremented, 'released' otherwise.

create or replace function public.release_ai_request(target_user_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  refunded integer;
begin
  if target_user_id is null then
    raise exception 'missing_user_id';
  end if;

  -- Refund exactly one request; a missing row or a counter already at 0
  -- is a no-op, never an error.
  update public.daily_usage d
     set ai_requests = greatest(d.ai_requests - 1, 0)
   where d.user_id = target_user_id
     and d.date = (now() at time zone 'utc')::date
     and d.ai_requests > 0
   returning d.ai_requests into refunded;

  if refunded is null then
    return 'no_op';
  end if;

  return 'released';
end;
$$;



revoke all on function public.release_ai_request(uuid) from public, anon, authenticated;


grant execute on function public.release_ai_request(uuid) to service_role;



-- 12. Deckblatt: plan-aware rewrites (identical signatures/return shapes) -

-- Widen the storage cap to 60: headroom above the largest commercial
-- deckblatt cap (30/day on Premium Monthly). Legacy users stay at 2
-- because the RPCs below fall back to 2 when no plan limit resolves.
alter table public.ai_deckblatt_usage
  drop constraint if exists ai_deckblatt_usage_generations_used_check;


alter table public.ai_deckblatt_usage
  add constraint ai_deckblatt_usage_generations_used_check
  check (generations_used >= 0 and generations_used <= 60);



create or replace function public.get_deckblatt_usage_status(target_user_id uuid)
returns table (
  -- "limit" is a fully reserved PostgreSQL word and cannot be a
  -- RETURNS TABLE field name (syntax error 42601) — hence daily_limit.
  daily_limit integer,
  used integer,
  remaining integer,
  usage_date date
)
language plpgsql
security definer
set search_path = public
as $$
declare
  today date := (now() at time zone 'utc')::date;
  plan_limit integer := coalesce(public.plan_feature_limit(target_user_id, 'deckblatt'), 2);
  cur_used integer := 0;
begin
  select u.generations_used into cur_used
    from public.ai_deckblatt_usage u
   where u.user_id = target_user_id and u.usage_date = today;

  return query
    select plan_limit,
           coalesce(cur_used, 0),
           greatest(plan_limit - coalesce(cur_used, 0), 0),
           today;
end;
$$;



revoke execute on function public.get_deckblatt_usage_status(uuid) from public, anon;


grant execute on function public.get_deckblatt_usage_status(uuid) to authenticated;



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
  plan_limit integer := coalesce(public.plan_feature_limit(target_user_id, 'deckblatt'), 2);
  before_row public.ai_deckblatt_usage;
  new_used integer;
begin
  if auth.uid() is not null and auth.uid() <> target_user_id then
    raise exception 'not_authorized';
  end if;
  if p_run_id is null then
    raise exception 'missing_run_id';
  end if;

  -- A plan with a zero deckblatt limit disables the feature before any
  -- row is written (mirrors the generic reserve_feature_op contract).
  if plan_limit <= 0 then
    return query
      select 'quota_exhausted'::text, plan_limit, 0;
    return;
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
      select 'already_reserved'::text, new_used, greatest(plan_limit - new_used, 0);
    return;
  end if;

  insert into public.ai_deckblatt_runs (run_id, user_id, status)
  values (p_run_id, target_user_id, 'reserved');

  insert into public.ai_deckblatt_usage (user_id, usage_date, generations_used)
  values (target_user_id, today, 1)
  on conflict (user_id, usage_date) do update
    set generations_used = ai_deckblatt_usage.generations_used + 1
   where ai_deckblatt_usage.generations_used < plan_limit
  returning generations_used into new_used;

  if new_used is null then
    -- Row existed at the limit: the conditional upsert updated nothing.
    -- Concurrency-safe: exactly one of N racing reserves wins.
    delete from public.ai_deckblatt_runs where run_id = p_run_id;
    return query
      select 'quota_exhausted'::text, plan_limit, 0;
    return;
  end if;

  return query
    select 'reserved'::text, new_used, greatest(plan_limit - new_used, 0);
end;
$$;



revoke execute on function public.reserve_deckblatt_generation(uuid, uuid) from public, anon;


grant execute on function public.reserve_deckblatt_generation(uuid, uuid) to authenticated;



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
  plan_limit integer := coalesce(public.plan_feature_limit(target_user_id, 'deckblatt'), 2);
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
    select u.generations_used into cur_used
      from public.ai_deckblatt_usage u
     where u.user_id = target_user_id and u.usage_date = today;
    return query
      select 'no_op'::text, coalesce(cur_used, 0),
             greatest(plan_limit - coalesce(cur_used, 0), 0);
    return;
  end if;

  update public.ai_deckblatt_runs
     set status = 'failed'
   where run_id = p_run_id and user_id = target_user_id;

  update public.ai_deckblatt_usage u
     set generations_used = greatest(u.generations_used - 1, 0)
   where u.user_id = target_user_id and u.usage_date = today
   returning generations_used into cur_used;

  return query
    select 'released'::text, coalesce(cur_used, 0),
           greatest(plan_limit - coalesce(cur_used, 0), 0);
end;
$$;



revoke execute on function public.release_deckblatt_generation(uuid, uuid) from public, anon;


grant execute on function public.release_deckblatt_generation(uuid, uuid) to authenticated;



-- 13. ai-files bucket: raise the hard ceiling to the largest plan cap ----

update storage.buckets set file_size_limit = 15728640 where id = 'ai-files';


-- [B] from 20261122 (all statements)
create or replace function public.create_mock_checkout(
  p_user_id uuid,
  p_plan_id text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  bp_price integer;
  bp_label text;
  row_id uuid;
  row_plan text;
  row_status text;
  row_amount integer;
  row_currency text;
  row_label text;
  row_expires timestamptz;
  now_ts timestamptz := timezone('utc', now());
  expires_ts timestamptz := now_ts + interval '15 minutes';
begin
  if p_user_id is null then
    raise exception 'missing_user_id';
  end if;
  if p_idempotency_key is null or p_idempotency_key = '' then
    raise exception 'missing_idempotency_key';
  end if;

  -- Plan validity and price come from the server-side catalogue only.
  select bp.price_cents, bp.label
    into bp_price, bp_label
    from public.billing_plans bp
   where bp.plan_id = p_plan_id
     and bp.is_commercial = true
     and bp.price_cents > 0;

  if bp_price is null then
    raise exception 'invalid_plan';
  end if;

  insert into public.mock_checkouts
    (user_id, plan_id, amount_cents, currency, status, idempotency_key, is_mock, expires_at)
  values
    (p_user_id, p_plan_id, bp_price, 'USD', 'pending', p_idempotency_key, true, expires_ts)
  on conflict (idempotency_key) do nothing
  returning id into row_id;

  if row_id is not null then
    insert into public.subscription_events (user_id, action, plan_id, provider, details)
    values (
      p_user_id,
      'mock_checkout_created',
      p_plan_id,
      'mock',
      jsonb_build_object(
        'checkout_id', row_id,
        'plan_id', p_plan_id,
        'amount_cents', bp_price,
        'currency', 'USD',
        'mock', true
      )
    );

    return jsonb_build_object(
      'status', 'created',
      'checkout', jsonb_build_object(
        'id', row_id,
        'plan_id', p_plan_id,
        'plan_label', bp_label,
        'amount_cents', bp_price,
        'currency', 'USD',
        'status', 'pending',
        'expires_at', to_char(expires_ts at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
        'is_mock', true
      )
    );
  end if;

  -- Lost the idempotency race: report the existing transaction, scoped to
  -- this user (a foreign key collision must not leak another account's
  -- checkout).
  select mc.id, mc.plan_id, mc.status, mc.amount_cents, mc.currency, mc.expires_at, bp.label
    into row_id, row_plan, row_status, row_amount, row_currency, row_expires, row_label
    from public.mock_checkouts mc
    left join public.billing_plans bp on bp.plan_id = mc.plan_id
   where mc.idempotency_key = p_idempotency_key
     and mc.user_id = p_user_id;

  if row_id is null then
    raise exception 'idempotency_conflict';
  end if;

  return jsonb_build_object(
    'status', 'existing',
    'checkout', jsonb_build_object(
      'id', row_id,
      'plan_id', row_plan,
      'plan_label', row_label,
      'amount_cents', row_amount,
      'currency', row_currency,
      'status', row_status,
      'expires_at', to_char(row_expires at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
      'is_mock', true
    )
  );
end;
$$;



revoke all on function public.create_mock_checkout(uuid, text, text) from public, anon, authenticated;


grant execute on function public.create_mock_checkout(uuid, text, text) to service_role;



-- 2. complete_mock_checkout --------------------------------------------------

create or replace function public.complete_mock_checkout(
  p_checkout_id uuid,
  p_user_id uuid,
  p_outcome text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  mc_id uuid;
  mc_plan text;
  mc_status text;
  mc_amount integer;
  mc_expires timestamptz;
  bp_kind text;
  bp_value integer;
  period_end timestamptz;
  sub_id uuid;
  now_ts timestamptz := timezone('utc', now());
begin
  if p_checkout_id is null or p_user_id is null then
    raise exception 'missing_user_id';
  end if;
  if p_outcome is null or p_outcome not in ('success', 'failed', 'canceled') then
    raise exception 'invalid_outcome';
  end if;

  -- Row lock scoped to the owning user: a foreign checkout id is
  -- indistinguishable from a missing one (no existence leak), and two
  -- parallel completions of the same checkout serialize here.
  select mc.id, mc.plan_id, mc.status, mc.amount_cents, mc.expires_at
    into mc_id, mc_plan, mc_status, mc_amount, mc_expires
    from public.mock_checkouts mc
   where mc.id = p_checkout_id
     and mc.user_id = p_user_id
   for update;

  if mc_id is null then
    return jsonb_build_object('status', 'not_found');
  end if;

  if mc_status = 'succeeded' then
    -- A duplicate completion is a no-op: the entitlement is already active
    -- and must not be re-activated or double-audited.
    return jsonb_build_object('status', 'already_succeeded');
  end if;

  if mc_status = 'failed' or mc_status = 'canceled' or mc_status = 'expired' then
    return jsonb_build_object('status', 'terminal');
  end if;

  if mc_expires <= now_ts then
    update public.mock_checkouts
       set status = 'expired', updated_at = now_ts
     where id = mc_id;

    insert into public.subscription_events (user_id, action, plan_id, provider, details)
    values (
      p_user_id, 'mock_checkout_expired', mc_plan, 'mock',
      jsonb_build_object('checkout_id', mc_id, 'amount_cents', mc_amount, 'mock', true)
    );

    return jsonb_build_object('status', 'expired');
  end if;

  if p_outcome = 'failed' then
    update public.mock_checkouts
       set status = 'failed', updated_at = now_ts
     where id = mc_id;

    insert into public.subscription_events (user_id, action, plan_id, provider, details)
    values (
      p_user_id, 'mock_checkout_failed', mc_plan, 'mock',
      jsonb_build_object('checkout_id', mc_id, 'amount_cents', mc_amount, 'mock', true)
    );

    return jsonb_build_object('status', 'failed');
  end if;

  if p_outcome = 'canceled' then
    update public.mock_checkouts
       set status = 'canceled', updated_at = now_ts
     where id = mc_id;

    insert into public.subscription_events (user_id, action, plan_id, provider, details)
    values (
      p_user_id, 'mock_checkout_canceled', mc_plan, 'mock',
      jsonb_build_object('checkout_id', mc_id, 'amount_cents', mc_amount, 'mock', true)
    );

    return jsonb_build_object('status', 'canceled');
  end if;

  -- p_outcome = 'success': activate only with a valid server-side plan row
  -- and a computable period end (fail closed otherwise).
  select bp.duration_kind, bp.duration_value
    into bp_kind, bp_value
    from public.billing_plans bp
   where bp.plan_id = mc_plan;

  if bp_kind is null then
    update public.mock_checkouts
       set status = 'failed', updated_at = now_ts
     where id = mc_id;

    insert into public.subscription_events (user_id, action, plan_id, provider, details)
    values (
      p_user_id, 'mock_checkout_failed', mc_plan, 'mock',
      jsonb_build_object('checkout_id', mc_id, 'amount_cents', mc_amount, 'reason', 'plan_row_missing', 'mock', true)
    );

    return jsonb_build_object('status', 'plan_error');
  end if;

  period_end := public.subscription_period_end(now_ts, bp_kind, bp_value);
  if period_end is null then
    update public.mock_checkouts
       set status = 'failed', updated_at = now_ts
     where id = mc_id;

    insert into public.subscription_events (user_id, action, plan_id, provider, details)
    values (
      p_user_id, 'mock_checkout_failed', mc_plan, 'mock',
      jsonb_build_object('checkout_id', mc_id, 'amount_cents', mc_amount, 'reason', 'duration_error', 'mock', true)
    );

    return jsonb_build_object('status', 'plan_error');
  end if;

  insert into public.subscriptions
    (user_id, plan, status, provider, current_period_start, current_period_end, updated_at)
  values
    (p_user_id, mc_plan, 'active', 'mock', now_ts, period_end, now_ts)
  on conflict (user_id) do update set
    plan = excluded.plan,
    status = 'active',
    provider = 'mock',
    current_period_start = excluded.current_period_start,
    current_period_end = excluded.current_period_end,
    canceled_at = null,
    updated_at = now_ts
  returning id into sub_id;

  update public.mock_checkouts
     set status = 'succeeded', subscription_id = sub_id, updated_at = now_ts
   where id = mc_id;

  insert into public.subscription_events (user_id, action, plan_id, provider, details)
  values (
    p_user_id, 'mock_checkout_succeeded', mc_plan, 'mock',
    jsonb_build_object(
      'checkout_id', mc_id,
      'amount_cents', mc_amount,
      'subscription_id', sub_id,
      'mock', true
    )
  );

  insert into public.subscription_events (user_id, action, plan_id, provider, details)
  values (
    p_user_id, 'subscription_activated', mc_plan, 'mock',
    jsonb_build_object(
      'current_period_start', to_char(now_ts at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
      'current_period_end', to_char(period_end at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
      'checkout_id', mc_id,
      'mock', true
    )
  );

  return jsonb_build_object(
    'status', 'succeeded',
    'subscription', jsonb_build_object(
      'plan_id', mc_plan,
      'provider', 'mock',
      'current_period_start', to_char(now_ts at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
      'current_period_end', to_char(period_end at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
      'mock', true
    )
  );
end;
$$;



revoke all on function public.complete_mock_checkout(uuid, uuid, text) from public, anon, authenticated;


grant execute on function public.complete_mock_checkout(uuid, uuid, text) to service_role;


-- [C] from 20261123 (feature_capacity_status block only)


-- 4. Read side: feature_capacity_status remap --------------------------------
-- ONLY the saved_applications branch changes: it pointed at the DEAD legacy
-- public.applications table. The saved_opportunities branch is preserved
-- byte-identical (20261121000000, lines 556–579).

create or replace function public.feature_capacity_status(p_user_id uuid, p_feature_id text)
returns jsonb
language sql
security definer
set search_path = public
as $$
  select case p_feature_id
    when 'saved_opportunities' then
      jsonb_build_object(
        'used', (select count(*)::integer
                   from public.saved_opportunities so
                  where so.user_id = p_user_id),
        'resets_at', null
      )
    when 'saved_applications' then
      jsonb_build_object(
        'used', (select count(*)::integer
                   from public.bew_applications ba
                  where ba.user_id = p_user_id
                    and btrim(coalesce(ba.company_name, '')) <> ''),
        'resets_at', null
      )
    else null
  end;
$$;



revoke all on function public.feature_capacity_status(uuid, text) from public, anon, authenticated;


grant execute on function public.feature_capacity_status(uuid, text) to service_role;

