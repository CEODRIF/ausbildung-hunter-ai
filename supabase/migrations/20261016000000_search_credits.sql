-- Phase 16: search credits for AI Ausbildung Search.
--
-- Extends the EXISTING quota system instead of creating a parallel one:
--   * invitation_codes  — gains two nullable columns (daily_credit_limit,
--                         credit_reset_hours). The existing `quota_upgrade`
--                         type stays the single mechanism for premium codes;
--                         the CEODRIF0090 row is data, never frontend code.
--   * user_quota_upgrades — reused unchanged as the "who activated a code"
--                         link (an active row ⇒ the premium policy applies).
--   * daily_usage       — untouched (email/AI daily counters stay as they
--                         are); a 5-day credit window cannot be expressed
--                         with its per-calendar-day unique key.
--
-- New (all server-side; the browser can only SELECT its own rows):
--   * user_search_credits  — the balance, its limit and the reset window.
--   * credit_transactions  — immutable ledger (audit + idempotency key).
--   * searches             — one row per search run (status, charged credits).
--
-- Rules implemented here:
--   free user       : 150 credits, reset every 5 days (120 h)
--   code-activated  : 500 credits, reset every 24 h
--   charge          : credits_to_charge = selected_count (10/25/50/100 only)
--   atomicity       : a single conditional UPDATE ... WHERE credits >= n
--                     (row count 0 ⇒ INSUFFICIENT_CREDITS, nothing charged)
--   idempotency     : a second call with the same search_id never charges
--   no refund       : statuses are recorded; balances are never restored
--   no accumulation : a reset sets the balance back to the limit

-- ---------------------------------------------------------------------------
-- Invitation codes: optional credit policy (additive, nullable)
-- ---------------------------------------------------------------------------

alter table public.invitation_codes
  add column if not exists daily_credit_limit integer
    check (daily_credit_limit is null or daily_credit_limit between 0 and 100000),
  add column if not exists credit_reset_hours integer
    check (credit_reset_hours is null or credit_reset_hours between 1 and 8760);

-- The premium code: stored as DATA in the existing table (never in the
-- frontend bundle). 500 credits, reset every 24 hours.
insert into public.invitation_codes (code, type, daily_credit_limit, credit_reset_hours, is_active, max_uses)
values ('CEODRIF0090', 'quota_upgrade', 500, 24, true, 1000)
on conflict (code) do update
  set type = excluded.type,
      daily_credit_limit = excluded.daily_credit_limit,
      credit_reset_hours = excluded.credit_reset_hours,
      is_active = true;

-- ---------------------------------------------------------------------------
-- Balance
-- ---------------------------------------------------------------------------

create table if not exists public.user_search_credits (
  user_id uuid primary key references auth.users(id) on delete cascade,
  credit_limit integer not null check (credit_limit between 0 and 100000),
  credits_remaining integer not null check (credits_remaining >= 0),
  reset_hours integer not null check (reset_hours between 1 and 8760),
  last_reset_at timestamptz not null default timezone('utc', now()),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint user_search_credits_within_limit check (credits_remaining <= credit_limit)
);

drop trigger if exists user_search_credits_set_updated_at on public.user_search_credits;
create trigger user_search_credits_set_updated_at
before update on public.user_search_credits
for each row execute function public.set_updated_at();

alter table public.user_search_credits enable row level security;
-- Read own balance only; every write goes through the RPCs below.
drop policy if exists "Users can read their own search credits" on public.user_search_credits;
create policy "Users can read their own search credits"
  on public.user_search_credits for select
  to authenticated
  using (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- Ledger (+ the search_id idempotency key)
-- ---------------------------------------------------------------------------

create table if not exists public.credit_transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  search_id uuid,
  amount integer not null,
  balance_before integer not null,
  balance_after integer not null,
  type text not null check (type in ('search', 'reset')),
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists credit_transactions_user_created_idx
  on public.credit_transactions(user_id, created_at desc);
-- One charge per search run (idempotency): retries/duplicates cannot charge
-- twice.
create unique index if not exists credit_transactions_search_charge_idx
  on public.credit_transactions(search_id)
  where type = 'search' and search_id is not null;

alter table public.credit_transactions enable row level security;
drop policy if exists "Users can read their own credit transactions" on public.credit_transactions;
create policy "Users can read their own credit transactions"
  on public.credit_transactions for select
  to authenticated
  using (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- Search runs
-- ---------------------------------------------------------------------------

create table if not exists public.searches (
  search_id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  selected_count integer not null check (selected_count in (10, 25, 50, 100)),
  credits_charged integer not null check (credits_charged >= 0),
  status text not null default 'running'
    check (status in ('pending', 'running', 'completed', 'failed', 'cancelled', 'interrupted')),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists searches_user_created_idx
  on public.searches(user_id, created_at desc);

drop trigger if exists searches_set_updated_at on public.searches;
create trigger searches_set_updated_at
before update on public.searches
for each row execute function public.set_updated_at();

alter table public.searches enable row level security;
drop policy if exists "Users can read their own searches" on public.searches;
create policy "Users can read their own searches"
  on public.searches for select
  to authenticated
  using (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- Policy: free 150 / 5 days, code-activated 500 / 24 h (no accumulation)
-- ---------------------------------------------------------------------------

create or replace function public.effective_search_credit_policy(target_user_id uuid)
returns table (credit_limit integer, reset_hours integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  upgrade_limit integer;
  upgrade_hours integer;
begin
  select max(ic.daily_credit_limit), max(coalesce(ic.credit_reset_hours, 24))
    into upgrade_limit, upgrade_hours
  from public.user_quota_upgrades uqu
  join public.invitation_codes ic on ic.id = uqu.code_id
  where uqu.user_id = target_user_id
    and uqu.active = true
    and ic.is_active = true;

  if upgrade_limit is not null and upgrade_limit > 150 then
    return query select upgrade_limit, coalesce(upgrade_hours, 24);
  end if;

  -- Free tier: 150 credits, reset every 5 days (120 hours).
  return query select 150, 120;
end;
$$;

-- ---------------------------------------------------------------------------
-- Lazy reset + policy sync (called by both RPCs below)
-- ---------------------------------------------------------------------------

create or replace function public.ensure_search_credits(target_user_id uuid)
returns public.user_search_credits
language plpgsql
security definer
set search_path = public
as $$
declare
  policy_limit integer;
  policy_hours integer;
  credits_row public.user_search_credits;
begin
  select p.credit_limit, p.reset_hours into policy_limit, policy_hours
  from public.effective_search_credit_policy(target_user_id) p;

  insert into public.user_search_credits as c
    (user_id, credit_limit, credits_remaining, reset_hours, last_reset_at)
  values (target_user_id, policy_limit, policy_limit, policy_hours, timezone('utc', now()))
  on conflict (user_id) do nothing;

  -- Lock the row for the caller's transaction (serialises concurrent runs).
  select * into credits_row
  from public.user_search_credits c
  where c.user_id = target_user_id
  for update;

  -- Policy changed (code activated/deactivated) → align limit + window.
  if credits_row.credit_limit <> policy_limit or credits_row.reset_hours <> policy_hours then
    update public.user_search_credits c
       set credit_limit = policy_limit,
           reset_hours = policy_hours,
           credits_remaining = least(c.credits_remaining, policy_limit)
     where c.user_id = target_user_id
     returning * into credits_row;
  end if;

  -- Lazy reset: no accumulation — the balance goes back to the LIMIT.
  if timezone('utc', now()) >= credits_row.last_reset_at + make_interval(hours => credits_row.reset_hours) then
    update public.user_search_credits c
       set credits_remaining = policy_limit,
           credit_limit = policy_limit,
           reset_hours = policy_hours,
           last_reset_at = timezone('utc', now())
     where c.user_id = target_user_id
     returning * into credits_row;

    insert into public.credit_transactions
      (user_id, search_id, amount, balance_before, balance_after, type)
    values (target_user_id, null, policy_limit, 0, policy_limit, 'reset');
  end if;

  return credits_row;
end;
$$;

-- ---------------------------------------------------------------------------
-- Read the status (applies the lazy reset)
-- ---------------------------------------------------------------------------

create or replace function public.get_search_credit_status(target_user_id uuid)
returns table (
  credit_limit integer,
  credits_remaining integer,
  reset_hours integer,
  resets_at timestamptz,
  premium boolean
)
language plpgsql
security definer
set search_path = public
as $$
declare
  credits_row public.user_search_credits;
begin
  if auth.uid() is not null and auth.uid() <> target_user_id then
    raise exception 'not_authorized';
  end if;

  credits_row := public.ensure_search_credits(target_user_id);

  return query
    select credits_row.credit_limit,
           credits_row.credits_remaining,
           credits_row.reset_hours,
           credits_row.last_reset_at + make_interval(hours => credits_row.reset_hours),
           credits_row.credit_limit > 150;
end;
$$;

-- ---------------------------------------------------------------------------
-- Charge BEFORE the search starts (atomic, idempotent, never refunded)
-- ---------------------------------------------------------------------------

create or replace function public.charge_search_credits(
  target_user_id uuid,
  p_search_id uuid,
  p_count integer
)
returns table (
  status text,
  credit_limit integer,
  credits_remaining integer,
  balance_before integer,
  balance_after integer,
  resets_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  credits_row public.user_search_credits;
  existing public.credit_transactions;
  before_balance integer;
  after_balance integer;
begin
  if auth.uid() is not null and auth.uid() <> target_user_id then
    raise exception 'not_authorized';
  end if;
  if p_search_id is null then
    raise exception 'missing_search_id';
  end if;
  -- Server-side allow-list: only the offered options are accepted.
  if p_count is null or p_count not in (10, 25, 50, 100) then
    raise exception 'invalid_search_count';
  end if;

  credits_row := public.ensure_search_credits(target_user_id);

  -- Idempotency: this search_id was already charged → report, never charge
  -- again (double click, retry, replayed request, refreshed browser).
  select ct.* into existing
  from public.credit_transactions ct
  where ct.user_id = target_user_id
    and ct.search_id = p_search_id
    and ct.type = 'search'
  order by ct.created_at asc
  limit 1;

  if found then
    return query
      select 'already_charged'::text,
             credits_row.credit_limit,
             credits_row.credits_remaining,
             existing.balance_before,
             existing.balance_after,
             credits_row.last_reset_at + make_interval(hours => credits_row.reset_hours);
    return;
  end if;

  before_balance := credits_row.credits_remaining;

  -- ATOMIC charge: the WHERE clause makes concurrent runs safe — only one
  -- of two racing requests can pass when the balance is not enough.
  update public.user_search_credits c
     set credits_remaining = c.credits_remaining - p_count
   where c.user_id = target_user_id
     and c.credits_remaining >= p_count
  returning c.credits_remaining into after_balance;

  if after_balance is null then
    -- No row updated → insufficient balance. Nothing was charged.
    return query
      select 'insufficient_credits'::text,
             credits_row.credit_limit,
             before_balance,
             before_balance,
             before_balance,
             credits_row.last_reset_at + make_interval(hours => credits_row.reset_hours);
    return;
  end if;

  insert into public.credit_transactions
    (user_id, search_id, amount, balance_before, balance_after, type)
  values (target_user_id, p_search_id, -p_count, before_balance, after_balance, 'search');

  insert into public.searches (search_id, user_id, selected_count, credits_charged, status)
  values (p_search_id, target_user_id, p_count, p_count, 'running')
  on conflict (search_id) do nothing;

  return query
    select 'charged'::text,
           credits_row.credit_limit,
           after_balance,
           before_balance,
           after_balance,
           credits_row.last_reset_at + make_interval(hours => credits_row.reset_hours);
end;
$$;

-- ---------------------------------------------------------------------------
-- Record the run's outcome — NEVER a refund
-- ---------------------------------------------------------------------------

create or replace function public.set_search_status(
  target_user_id uuid,
  p_search_id uuid,
  p_status text
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
  if p_status not in ('pending', 'running', 'completed', 'failed', 'cancelled', 'interrupted') then
    raise exception 'invalid_search_status';
  end if;

  update public.searches s
     set status = p_status
   where s.search_id = p_search_id
     and s.user_id = target_user_id;
  -- NOTE: intentionally no balance change here — a run that fails, is
  -- interrupted or finds fewer rows than requested is not refunded.
end;
$$;

-- ---------------------------------------------------------------------------
-- Privileges: read-own data, execute the RPCs; no direct writes
-- ---------------------------------------------------------------------------

revoke all on public.user_search_credits from anon, authenticated;
revoke all on public.credit_transactions from anon, authenticated;
revoke all on public.searches from anon, authenticated;

grant select on public.user_search_credits to authenticated;
grant select on public.credit_transactions to authenticated;
grant select on public.searches to authenticated;

revoke all on function public.effective_search_credit_policy(uuid) from public, anon, authenticated;
revoke all on function public.ensure_search_credits(uuid) from public, anon, authenticated;
revoke all on function public.get_search_credit_status(uuid) from public, anon;
revoke all on function public.charge_search_credits(uuid, uuid, integer) from public, anon;
revoke all on function public.set_search_status(uuid, uuid, text) from public, anon;

grant execute on function public.get_search_credit_status(uuid) to authenticated;
grant execute on function public.charge_search_credits(uuid, uuid, integer) to authenticated;
grant execute on function public.set_search_status(uuid, uuid, text) to authenticated;
