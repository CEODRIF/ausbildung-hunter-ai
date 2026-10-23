-- ============================================================================
-- Mock checkout — atomic create + simulate RPCs (service-role only).
--
-- Additive and rerun-safe: two create-or-replace functions and nothing else.
-- No table changes: mock_checkouts and subscription_events already exist
-- from 20261120000000_subscription_billing_v2.sql (which must run first;
-- 20261121000000_feature_quotas.sql is independent and runs in between).
--
-- What changes
--   1. create_mock_checkout(p_user_id, p_plan_id, p_idempotency_key)
--      opens a pending mock checkout. The amount is ALWAYS read from
--      billing_plans.price_cents (server-side catalogue); the client never
--      sets the price. Only commercial paid plans are accepted: the trial
--      has is_commercial = false and cannot be "purchased", and the legacy
--      free/plus/pro rows are not commercial either. The idempotency key is
--      unique — a duplicate call returns the existing transaction
--      (status 'existing') instead of creating a second one. A pending
--      checkout expires after 15 minutes (server-enforced inside
--      complete_mock_checkout; a client cannot extend it).
--   2. complete_mock_checkout(p_checkout_id, p_user_id, p_outcome)
--      simulates the payment result, outcome in ('success','failed',
--      'canceled'). One locked transaction per checkout:
--        success   -> upserts the user's subscription (provider 'mock',
--                     period end from subscription_period_end), stamps the
--                     checkout 'succeeded' + subscription_id, writes
--                     mock_checkout_succeeded + subscription_activated
--                     audit events, returns the new period window.
--        failed    -> checkout 'failed' + mock_checkout_failed event.
--        canceled  -> checkout 'canceled' + mock_checkout_canceled event.
--        (pending past expires_at) -> 'expired' + mock_checkout_expired
--                     event; a success on an expired checkout is impossible.
--        second completion of a succeeded checkout -> 'already_succeeded'
--                     no-op: no double activation, no duplicate events.
--        foreign or unknown checkout id -> 'not_found' (user-scoped: a
--                     foreign id never leaks existence).
--      mock_checkouts.is_mock is forced to true by a database constraint, so
--      a row here can never be mistaken for a real payment, and no code path
--      accepts mock_checkouts as a payment-provider webhook. Entitlements
--      resolve from the subscriptions table (provider 'mock'), so these
--      functions grant nothing by themselves — only the subscription upsert
--      on a verified success changes access.
--
-- Rollback guidance (manual; no data is deleted by this migration):
--   drop function public.complete_mock_checkout(uuid, uuid, text);
--   drop function public.create_mock_checkout(uuid, text, text);
-- Subscription and checkout rows created through these functions are left
-- intact and remain valid (labeled mock) state.
-- ============================================================================

-- 1. create_mock_checkout ----------------------------------------------------

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
