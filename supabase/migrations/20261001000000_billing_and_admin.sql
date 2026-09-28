-- Phase 10: billing & admin foundation.
--
-- No external payment provider is configured. Plans, entitlements, and
-- subscriptions are data + server-side logic only:
--   * billing_plans      — canonical plan definitions (limits), read by the
--                          quota RPCs and the TS entitlement layer.
--   * subscriptions      — per-user plan state. Rows are created/updated
--                          ONLY by the admin foundation (service role);
--                          users get read-only RLS access to their own row.
--   * admins             — admin membership. RLS is enabled with NO
--                          policies, so users cannot read or write it;
--                          only the service-role admin layer can.
--   * admin_audit_log    — immutable audit trail of admin actions.
--                          No user policies; service-role only.
--   * effective_daily_email_limit — replaced: the plan base now floors the
--                          profile base (free users: identical to before;
--                          quota upgrades still apply as the max of both).

-- ---------------------------------------------------------------------------
-- Plan definitions (single source of truth for limit values; the TS layer
-- reads these rows and falls back to the documented free-plan defaults)
-- ---------------------------------------------------------------------------

create table public.billing_plans (
  plan_id text primary key check (plan_id in ('free', 'plus', 'pro')),
  label text not null,
  emails_per_day integer not null check (emails_per_day between 0 and 100000),
  ai_requests_per_day integer not null check (ai_requests_per_day between 0 and 1000000)
);

insert into public.billing_plans (plan_id, label, emails_per_day, ai_requests_per_day) values
  ('free', 'Free', 50, 100),
  ('plus', 'Plus', 150, 400),
  ('pro',  'Pro',  500, 1500);

alter table public.billing_plans enable row level security;
-- Read access for all authenticated users (public catalog, no secrets);
-- writes are service-role only (admin foundation).
create policy "Authenticated users can read the plan catalog"
  on public.billing_plans for select
  to authenticated
  using (true);

-- ---------------------------------------------------------------------------
-- Subscriptions (per-user plan state; user = read own row only)
-- ---------------------------------------------------------------------------

create type public.subscription_status as enum ('active', 'canceled', 'expired');

create table public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users(id) on delete cascade,
  plan text not null check (plan in ('plus', 'pro')),
  status public.subscription_status not null default 'active',
  provider text not null default 'manual' check (provider in ('manual')),
  current_period_start timestamptz,
  current_period_end timestamptz,
  canceled_at timestamptz,
  created_by uuid,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint subscription_period_valid check (
    current_period_start is null or current_period_end is null
    or current_period_end > current_period_start
  )
);

create index subscriptions_user_idx on public.subscriptions(user_id);

alter table public.subscriptions enable row level security;
create policy "Users can read their own subscription"
  on public.subscriptions for select
  to authenticated
  using (user_id = auth.uid());
-- No insert/update/delete policies: only the service-role admin layer
-- writes subscription state.

-- ---------------------------------------------------------------------------
-- Admins (membership; no user policies — service-role only)
-- ---------------------------------------------------------------------------

create table public.admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_by uuid,
  created_at timestamptz not null default timezone('utc', now())
);

alter table public.admins enable row level security;
-- Intentionally NO policies: users cannot list, read, or write admin
-- membership. Self-elevation is impossible from the browser.

-- ---------------------------------------------------------------------------
-- Admin audit log (immutable trail; service-role only)
-- ---------------------------------------------------------------------------

create table public.admin_audit_log (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid not null,
  target_user_id uuid not null,
  action text not null check (action in (
    'set_plan', 'cancel_subscription', 'reactivate_subscription',
    'grant_admin', 'revoke_admin'
  )),
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now())
);

create index admin_audit_log_target_idx on public.admin_audit_log(target_user_id);
create index admin_audit_log_actor_idx on public.admin_audit_log(actor_id);

alter table public.admin_audit_log enable row level security;
-- Intentionally NO policies: the audit trail is read/written only by the
-- service-role admin layer.

-- ---------------------------------------------------------------------------
-- Plan-aware email limit (replaces the Phase 4 function).
-- Free users are unchanged: no subscription row → plan base is null →
-- greatest(profile base, upgrade) exactly as before. For subscription
-- holders the plan base floors the profile base; invitation-code quota
-- upgrades still apply (max of both sources).
-- ---------------------------------------------------------------------------

create or replace function public.effective_daily_email_limit(target_user_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  base_limit integer;
  plan_limit integer;
  upgrade_limit integer;
begin
  select p.daily_email_limit into base_limit
  from public.profiles p
  where p.id = target_user_id;

  select bp.emails_per_day into plan_limit
  from public.subscriptions s
  join public.billing_plans bp on bp.plan_id = s.plan
  where s.user_id = target_user_id
    and s.status = 'active'
    and (s.current_period_end is null or s.current_period_end > timezone('utc', now()));

  select max(ic.daily_email_limit) into upgrade_limit
  from public.user_quota_upgrades uqu
  join public.invitation_codes ic on ic.id = uqu.code_id
  where uqu.user_id = target_user_id
    and uqu.active = true
    and ic.is_active = true;

  return greatest(
    coalesce(plan_limit, coalesce(base_limit, 50)),
    coalesce(upgrade_limit, 0)
  );
end;
$$;
