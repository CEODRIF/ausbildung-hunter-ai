-- ============================================================================
-- Subscription & billing v2 — commercial plans, trial, audit, mock checkout.
--
-- Additive and rerun-safe: every statement uses if-not-exists / on-conflict /
-- drop-guarded constraints. NOTHING here deletes data or rewrites an already
-- applied migration. Run order: this file first, then
-- 20261121000000_feature_quotas.sql (the feature-quota RPCs reference the
-- billing_plans.feature_limits column added here).
--
-- What changes
--   1. billing_plans: +5 columns (price, duration, commercial flag,
--      per-feature limits) and the plan check widened to the full plan set.
--   2. billing_plans: 3 commercial seed rows (trial / premium_10d /
--      premium_monthly) — the values are mirrored 1:1 in
--      src/lib/billing/commercial-plans.ts; tests/subscription-migrations.
--      test.ts fails the build if either side drifts.
--   3. subscriptions: plan check widened (trial + the two paid plans),
--      provider check widened ('manual', 'mock'), + trial_activated_at.
--      Existing plus/pro rows are NOT updated: legacy plans keep resolving
--      through the entitlement service's legacy (unmetered-feature) path,
--      which is the documented backward-compatibility decision.
--   4. subscription_events: append-only audit log (service-role only, RLS on
--      with NO policies — authenticated users cannot read or write it).
--   5. mock_checkouts: mock-payment transaction ledger (service-role only,
--      RLS on with NO policies). is_mock is constrained to true by the
--      database itself — a row in this table can never look like a real
--      payment, and idempotency_key is unique (duplicate submits are safe).
--   6. subscription_period_end(): the single calendar-duration oracle
--      (fixed hours / fixed days / calendar month with end-of-month clamp),
--      service-role only.
--   7. activate_trial(): one-trial-per-account activation, service-role only,
--      concurrency-safe via the unique subscriptions.user_id row lock.
--
-- Why trial automation stays 0 and trial emails_per_day is 3: the feature
-- limit (automation = 0) is enforced by the quota RPCs in the next
-- migration; the 3 e-mails/day column feeds the legacy
-- effective_daily_email_limit() which FLOORS at the profile base (50), so a
-- trial user can still queue up to 50 campaign emails — that column is a
-- legacy capacity floor, not the metered spec item.
--
-- Duration semantics (mirrors src/lib/billing/duration.ts computePeriodEnd):
--   - fixed_hours   : start + N hours, end exclusive.
--   - fixed_days    : start + N days,  end exclusive.
--   - calendar_month: N calendar months; the day-of-month is CLAMPED DOWN to
--     the target month's last day (2026-01-31 -> 2026-02-28,
--     2026-10-31 -> 2026-11-30), time-of-day preserved, end exclusive.
--     One month is NEVER approximated as a fixed number of days.
--
-- Rollback guidance (manual, reverse order; do not rewrite applied history):
--   drop function public.activate_trial(uuid);
--   drop function public.subscription_period_end(timestamptz, text, integer);
--   drop table public.mock_checkouts;
--   drop table public.subscription_events;
--   alter table public.subscriptions drop column trial_activated_at;
--   alter table public.subscriptions drop constraint subscriptions_provider_check;
--   alter table public.subscriptions add constraint subscriptions_provider_check check (provider in ('manual'));
--   alter table public.subscriptions drop constraint subscriptions_plan_check;
--   alter table public.subscriptions add constraint subscriptions_plan_check check (plan in ('plus', 'pro'));
--   delete from public.billing_plans where plan_id in ('trial', 'premium_10d', 'premium_monthly');
--   (drop the five added billing_plans columns and restore the original
--    plan check in the same style)
-- No user data is ever deleted by this migration or its rollback.
-- ============================================================================

-- 1. billing_plans: commercial-plan columns ---------------------------------

alter table public.billing_plans
  add column if not exists price_cents integer not null default 0,
  add column if not exists duration_kind text not null default 'none'
    check (duration_kind in ('none', 'fixed_hours', 'fixed_days', 'calendar_month')),
  add column if not exists duration_value integer not null default 0,
  add column if not exists is_commercial boolean not null default false,
  add column if not exists feature_limits jsonb not null default '{}'::jsonb;

alter table public.billing_plans drop constraint if exists billing_plans_plan_id_check;
alter table public.billing_plans add constraint billing_plans_plan_id_check
  check (plan_id in ('free', 'plus', 'pro', 'trial', 'premium_10d', 'premium_monthly'));

-- 2. Commercial plan seeds (idempotent) --------------------------------------
-- The 12-key feature_limits maps mirror COMMERCIAL_PLANS in
-- src/lib/billing/commercial-plans.ts exactly (null = no plan quota).

insert into public.billing_plans
  (plan_id, label, emails_per_day, ai_requests_per_day,
   price_cents, duration_kind, duration_value, is_commercial, feature_limits)
values
  ('trial', 'Trial', 3, 5, 0, 'fixed_hours', 72, false,
   '{"ai_assistant": 5, "cover_letter": 1, "resume_ai": 1, "scanner": 1, "deckblatt": 1, "email_drafts": 3, "opportunity_search": 5, "saved_opportunities": 3, "saved_applications": 3, "salary_calculator": null, "automation": 0, "upload": 2}'::jsonb),
  ('premium_10d', 'Premium 10 Days', 100, 100, 1000, 'fixed_days', 10, true,
   '{"ai_assistant": 100, "cover_letter": 25, "resume_ai": 20, "scanner": 20, "deckblatt": 15, "email_drafts": 60, "opportunity_search": 150, "saved_opportunities": 200, "saved_applications": 200, "salary_calculator": null, "automation": 100, "upload": 15}'::jsonb),
  ('premium_monthly', 'Premium Monthly', 250, 200, 2000, 'calendar_month', 1, true,
   '{"ai_assistant": 200, "cover_letter": 50, "resume_ai": 60, "scanner": 60, "deckblatt": 30, "email_drafts": 120, "opportunity_search": 300, "saved_opportunities": 500, "saved_applications": 500, "salary_calculator": null, "automation": 250, "upload": 15}'::jsonb)
on conflict (plan_id) do update set
  label = excluded.label,
  emails_per_day = excluded.emails_per_day,
  ai_requests_per_day = excluded.ai_requests_per_day,
  price_cents = excluded.price_cents,
  duration_kind = excluded.duration_kind,
  duration_value = excluded.duration_value,
  is_commercial = excluded.is_commercial,
  feature_limits = excluded.feature_limits;

-- 3. subscriptions: widen constraints, add the trial stamp -------------------

alter table public.subscriptions drop constraint if exists subscriptions_plan_check;
alter table public.subscriptions add constraint subscriptions_plan_check
  check (plan in ('free', 'plus', 'pro', 'trial', 'premium_10d', 'premium_monthly'));

alter table public.subscriptions drop constraint if exists subscriptions_provider_check;
alter table public.subscriptions add constraint subscriptions_provider_check
  check (provider in ('manual', 'mock'));

-- Set exactly once, ever: the single-trial-per-account stamp. The
-- entitlement service treats a non-null value as "trial used" regardless of
-- what the client says.
alter table public.subscriptions
  add column if not exists trial_activated_at timestamptz;

-- 4. subscription_events: append-only audit log (service-role only) ---------

create table if not exists public.subscription_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  action text not null check (action in (
    'trial_activated',
    'subscription_activated',
    'subscription_canceled',
    'subscription_expired',
    'mock_checkout_created',
    'mock_checkout_succeeded',
    'mock_checkout_failed',
    'mock_checkout_canceled',
    'mock_checkout_expired'
  )),
  plan_id text,
  provider text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists subscription_events_user_created_idx
  on public.subscription_events(user_id, created_at desc);

alter table public.subscription_events enable row level security;
-- Intentionally NO policies: only service_role (bypassing RLS) can read or
-- write audit events. Authenticated users see nothing (fail closed).

-- 5. mock_checkouts: labeled mock-payment transactions (service-role only) ---

create table if not exists public.mock_checkouts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  plan_id text not null check (plan_id in ('premium_10d', 'premium_monthly')),
  amount_cents integer not null check (amount_cents > 0),
  currency text not null default 'USD' check (currency = 'USD'),
  status text not null default 'pending'
    check (status in ('pending', 'succeeded', 'failed', 'canceled', 'expired')),
  idempotency_key text not null unique,
  is_mock boolean not null default true
    constraint mock_checkouts_is_mock_check check (is_mock = true),
  expires_at timestamptz not null,
  subscription_id uuid,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists mock_checkouts_user_created_idx
  on public.mock_checkouts(user_id, created_at desc);

alter table public.mock_checkouts enable row level security;
-- Intentionally NO policies: service_role only. No real payment data is ever
-- stored here (fictional demo transactions; is_mock is forced to true).

drop trigger if exists mock_checkouts_set_updated_at on public.mock_checkouts;
create trigger mock_checkouts_set_updated_at
  before update on public.mock_checkouts
  for each row execute function public.set_updated_at();

-- 6. subscription_period_end: the single calendar-duration oracle -----------

create or replace function public.subscription_period_end(
  p_start timestamptz,
  p_kind text,
  p_value integer
)
returns timestamptz
language sql
immutable
set search_path = public
as $$
  -- Calendar months clamp the day down to the target month's last day:
  --   2026-01-31 + 1 month -> 2026-02-28 (Feb has 28 days in 2026)
  --   2026-10-31 + 1 month -> 2026-11-30
  -- Time-of-day is preserved; the result is the EXCLUSIVE end instant.
  -- All arithmetic is pinned to UTC (timezone('utc', ...)), so the answer
  -- never depends on the session TimeZone.
  with base as (
    select (timezone('utc', p_start))::timestamp as ts
  ), shifted as (
    select b.ts,
           date_trunc('month', b.ts) + make_interval(months => p_value) as target_month,
           (extract(day from b.ts)::integer) as src_day
      from base b
  ), clamped as (
    select s.ts,
           s.target_month,
           least(s.src_day, (extract(day from s.target_month + make_interval(months => 1) - interval '1 day')::integer)) as day_of_month
      from shifted s
  )
  select case
    when p_kind = 'fixed_hours' and p_value > 0
      then p_start + make_interval(hours => p_value)
    when p_kind = 'fixed_days' and p_value > 0
      then p_start + make_interval(days => p_value)
    when p_kind = 'calendar_month' and p_value > 0
      then (select (c.target_month + make_interval(days => c.day_of_month - 1) + (c.ts - date_trunc('day', c.ts)))
                  at time zone 'utc'
               from clamped c)::timestamptz
    else null
  end;
$$;

revoke all on function public.subscription_period_end(timestamptz, text, integer) from public, anon, authenticated;
grant execute on function public.subscription_period_end(timestamptz, text, integer) to service_role;

-- 7. activate_trial: one trial per account, server-side ---------------------
--
-- Contract (consumed by src/lib/billing/trial.ts):
--   returns jsonb:
--     { status: 'activated',            plan_id, current_period_start,
--                                           current_period_end, trial_activated_at }
--     { status: 'trial_already_used',   plan_id: null, ..., trial_activated_at }
--     { status: 'paid_active',          plan_id, current_period_end, ... }
--   Timestamps are ISO-8601 UTC strings. Raises on a null user id.
--
-- Concurrency: the initial SELECT ... FOR UPDATE locks the row when it
-- exists; when it does not, the unique subscriptions.user_id constraint
-- serializes inserts (on conflict do nothing), and the loser re-reads the
-- winner's committed row and reports trial_already_used. A trial can never
-- be activated twice.

create or replace function public.activate_trial(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  now_ts timestamptz := timezone('utc', now());
  row_id uuid;
  row_plan text;
  row_status text;
  row_end timestamptz;
  row_trial timestamptz;
  trial_end timestamptz;
  fresh_row boolean := false;
begin
  if p_user_id is null then
    raise exception 'missing_user_id';
  end if;

  select s.id, s.plan, s.status, s.current_period_end, s.trial_activated_at
    into row_id, row_plan, row_status, row_end, row_trial
    from public.subscriptions s
   where s.user_id = p_user_id
   for update;

  -- One trial per account, ever (server-stored stamp; client state is
  -- irrelevant).
  if row_trial is not null then
    return jsonb_build_object(
      'status', 'trial_already_used',
      'plan_id', null,
      'current_period_start', null,
      'current_period_end', null,
      'trial_activated_at', to_char(row_trial at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
    );
  end if;

  -- A valid paid subscription exists: the trial must not downgrade it.
  if row_id is not null
     and row_plan not in ('free', 'trial')
     and row_status = 'active'
     and (row_end is null or row_end > now_ts) then
    return jsonb_build_object(
      'status', 'paid_active',
      'plan_id', row_plan,
      'current_period_start', null,
      'current_period_end', to_char(row_end at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
      'trial_activated_at', null
    );
  end if;

  trial_end := public.subscription_period_end(now_ts, 'fixed_hours', 72);

  if row_id is null then
    insert into public.subscriptions
      (user_id, plan, status, provider, current_period_start, current_period_end, trial_activated_at)
    values
      (p_user_id, 'trial', 'active', 'manual', now_ts, trial_end, now_ts)
    on conflict (user_id) do nothing
    returning id into row_id;
    fresh_row := (row_id is not null);
  end if;

  if not fresh_row then
    -- Either an existing row (legacy free/plus/pro, expired, or canceled) or
    -- a lost create race. Re-read with the row lock and converge.
    select s.id, s.trial_activated_at
      into row_id, row_trial
      from public.subscriptions s
     where s.user_id = p_user_id
     for update;

    if row_trial is not null then
      return jsonb_build_object(
        'status', 'trial_already_used',
        'plan_id', null,
        'current_period_start', null,
        'current_period_end', null,
        'trial_activated_at', to_char(row_trial at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
      );
    end if;

    if row_id is null then
      -- Cannot happen (the re-read is locked); fail closed regardless.
      raise exception 'subscription_race';
    end if;

    -- Convert the existing row to a fresh 72 h trial window. Historical
    -- usage rows are preserved untouched.
    update public.subscriptions
       set plan = 'trial',
           status = 'active',
           provider = 'manual',
           current_period_start = now_ts,
           current_period_end = trial_end,
           canceled_at = null,
           trial_activated_at = now_ts,
           updated_at = now_ts
     where id = row_id;
  end if;

  insert into public.subscription_events (user_id, action, plan_id, provider, details)
  values (
    p_user_id,
    'trial_activated',
    'trial',
    'manual',
    jsonb_build_object(
      'current_period_start', to_char(now_ts at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
      'current_period_end', to_char(trial_end at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
      'mock', false
    )
  );

  return jsonb_build_object(
    'status', 'activated',
    'plan_id', 'trial',
    'current_period_start', to_char(now_ts at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'current_period_end', to_char(trial_end at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'trial_activated_at', to_char(now_ts at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
  );
end;
$$;

revoke all on function public.activate_trial(uuid) from public, anon, authenticated;
grant execute on function public.activate_trial(uuid) to service_role;
