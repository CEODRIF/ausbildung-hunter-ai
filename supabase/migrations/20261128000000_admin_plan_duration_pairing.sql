-- =============================================================================
-- 20261128000000 — per-plan admin grant durations for manage_subscription.
--
-- Forward-only REPLACE of the public.manage_subscription RPC installed by
-- 20261126000000. The 20261126 file is NOT edited (it is an already-applied
-- migration — in production the RPC was installed manually from it). This
-- migration redefines the SAME function — identical signature, security
-- definer, search_path, service_role-only grant — with ONE validation change:
--
--   * 20261126 accepted ANY of 1|30|365 days for plus|pro.
--   * 20261128 enforces the per-plan pairing:
--       plus → EXACTLY 10 days (aligned with the canonical premium_10d
--              tier: duration_kind 'fixed_days', duration_value 10 —
--              commercial-plans.ts + seed in 20261120000000),
--       pro  → EXACTLY 30 days (Pro's intended duration, preserved).
--     Every other plan/duration pairing (plus+30, pro+10, plus+1, pro+365,
--     NULL period, …) is rejected with 'invalid_period' BEFORE any row
--     read or write — `is distinct from` also rejects an explicit NULL.
--
--   The 1-day and 365-day grants were never exposed in the admin UI and
--   are retired. Reactivation reuses the previous plan with its canonical
--   duration (plus → 10, pro → 30) — enforced here and in the app layer.
--
-- Defense in depth: the application enforces the same pairing at three
-- points (admin UI button values, the route's zod schema, and
-- executeAdminAction in src/lib/billing/admin.ts); THIS function is the
-- authoritative last gate, because it is the only writer path.
--
-- Production safety:
--   * DDL ONLY: create or replace + revoke/grant. Rerun-safe (idempotent):
--     running it twice yields the same end state; no dependency on
--     schema_migrations rows.
--   * NO data changes: no UPDATE/INSERT/DELETE on any table. Existing
--     subscription rows keep their recorded current_period_start/end
--     (a previously granted plus+30 row keeps its 30-day end date — no
--     retroactive truncation; pro rows are untouched).
--   * Does NOT touch billing_plans rows, plan feature limits,
--     plan_feature_limit, or any other function — the production plus/pro
--     feature-limit update (20261125-equivalent) stays intact.
--   * Rollback (documented, NOT included): rerun the 20261126 body verbatim.
-- =============================================================================

create or replace function public.manage_subscription(
  p_actor_id uuid,
  p_target_id uuid,
  p_action text,
  p_plan text default null,
  p_period_days integer default null,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  sub_rec record;
  before_json jsonb := '{}'::jsonb;
  after_json jsonb := '{}'::jsonb;
  now_ts timestamptz := (timezone('utc', now()))::timestamptz;
  ev_action text;
  ev_plan text;
begin
  if p_actor_id is null or p_target_id is null or p_action is null then
    return jsonb_build_object('status', 'invalid_args');
  end if;
  if p_action not in ('set_plan', 'cancel_subscription', 'reactivate_subscription') then
    return jsonb_build_object('status', 'invalid_action');
  end if;
  if p_action in ('set_plan', 'reactivate_subscription') then
    if p_plan not in ('plus', 'pro') then
      return jsonb_build_object('status', 'invalid_plan');
    end if;
    -- Per-plan durations (20261128, replaces the flat 1|30|365 list):
    -- plus = 10 days (canonical premium_10d tier), pro = 30 days.
    if p_plan = 'plus' and p_period_days is distinct from 10 then
      return jsonb_build_object('status', 'invalid_period');
    end if;
    if p_plan = 'pro' and p_period_days is distinct from 30 then
      return jsonb_build_object('status', 'invalid_period');
    end if;
  end if;

  -- Serialize concurrent admin actions on this target.
  select * into sub_rec
    from public.subscriptions
   where user_id = p_target_id
   for update;

  if found then
    before_json := jsonb_build_object(
      'plan', sub_rec.plan,
      'status', sub_rec.status,
      'provider', sub_rec.provider,
      'current_period_start', sub_rec.current_period_start,
      'current_period_end', sub_rec.current_period_end,
      'canceled_at', sub_rec.canceled_at,
      'trial_activated_at', sub_rec.trial_activated_at);
  end if;

  if p_action = 'cancel_subscription' then
    if not found then
      return jsonb_build_object('status', 'no_subscription');
    end if;
    -- Documented rule (Phase 12): entitlements END AT CANCELLATION;
    -- current_period_end is preserved for display only.
    update public.subscriptions
       set status = 'canceled',
           canceled_at = now_ts,
           updated_at = now_ts
     where user_id = p_target_id;
    ev_action := 'subscription_canceled';
    ev_plan := sub_rec.plan;
  else
    insert into public.subscriptions (
      user_id, plan, status, provider,
      current_period_start, current_period_end,
      canceled_at, created_by, created_at, updated_at
    ) values (
      p_target_id, p_plan, 'active', 'manual',
      now_ts, public.subscription_period_end(now_ts, 'fixed_days', p_period_days),
      null, p_actor_id, now_ts, now_ts
    )
    on conflict (user_id) do update
      set plan = excluded.plan,
          status = 'active',
          provider = 'manual',
          current_period_start = excluded.current_period_start,
          current_period_end = excluded.current_period_end,
          canceled_at = null,
          updated_at = now_ts;
    ev_action := 'subscription_activated';
    ev_plan := p_plan;
  end if;

  select * into sub_rec
    from public.subscriptions
   where user_id = p_target_id;
  after_json := jsonb_build_object(
    'plan', sub_rec.plan,
    'status', sub_rec.status,
    'provider', sub_rec.provider,
    'current_period_start', sub_rec.current_period_start,
    'current_period_end', sub_rec.current_period_end,
    'canceled_at', sub_rec.canceled_at,
    'trial_activated_at', sub_rec.trial_activated_at);

  -- Audit: actor, target, action, reason and full before/after state.
  insert into public.admin_audit_log (actor_id, target_user_id, action, details)
  values (
    p_actor_id,
    p_target_id,
    p_action,
    jsonb_build_object(
      'plan', p_plan,
      'period_days', p_period_days,
      'reason', coalesce(p_reason, 'admin_ui'),
      'before', before_json,
      'after', after_json));

  -- Billing event stream (same transaction).
  insert into public.subscription_events (user_id, action, plan_id, provider, details)
  values (
    p_target_id,
    ev_action,
    ev_plan,
    'manual',
    jsonb_build_object(
      'actor_id', p_actor_id,
      'period_days', p_period_days,
      'reason', coalesce(p_reason, 'admin_ui')));

  return jsonb_build_object('status', 'ok', 'before', before_json, 'after', after_json);

exception
  when others then
    -- The plpgsql exception handler rolls back this function's
    -- subtransaction: no partial state, no audit without the change and
    -- no change without the audit.
    return jsonb_build_object('status', 'db_error',
                              'message', 'admin subscription change failed');
end;
$$;

revoke all on function public.manage_subscription(uuid, uuid, text, text, integer, text)
  from public, anon, authenticated;
grant execute on function public.manage_subscription(uuid, uuid, text, text, integer, text)
  to service_role;
