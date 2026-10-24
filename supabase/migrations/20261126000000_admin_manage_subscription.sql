-- =============================================================================
-- 20261126000000 — atomic, audited admin subscription management.
--
-- Replaces the former TypeScript multi-statement admin writes (select,
-- update, then fire-and-forget audit insert) with ONE security-definer RPC:
-- the subscription change and its audit records commit together or not at
-- all. See docs/subscription-system-design-2026-10-24.md §6.
--
-- Invariants enforced here:
--   * exactly ONE subscription row per user (subscriptions.user_id UNIQUE —
--     the upsert is the only writer path for admin grants);
--   * concurrent admin actions on the same target serialize on the row
--     lock (SELECT … FOR UPDATE) — no conflicting double-activation;
--   * plan / duration validation is server-side (plus|pro, 1|30|365 days);
--   * every successful mutation writes admin_audit_log with actor, target,
--     action, reason and BEFORE/AFTER state, plus a subscription_events
--     billing event — in the SAME transaction as the change;
--   * admin grants are provider='manual': they are audited ENTITLEMENT
--     GRANTS, never represented as verified customer payments.
--
-- The acting administrator is NOT verified inside this function (it runs as
-- service_role): the application layer MUST call requireAdmin() and pass the
-- SESSION-derived actor id. Browser-supplied actor/target ids are never
-- accepted by the route (strict body schema; target comes from the URL and
-- the actor from the server session).
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
    if p_period_days not in (1, 30, 365) then
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
