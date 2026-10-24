-- ============================================================================
-- Remove the permanent Free plan — DB-level deckblatt fallback (PR #72).
--
-- Product decision (2026-10-24): the subscription system has exactly THREE
-- plan states — the one-shot 72 h trial, paid Plus, and paid Pro. The
-- permanent Free tier is removed from ALL application logic, including the
-- database.
--
-- What changes
--   Migration 20261121000000_feature_quotas.sql made the three deckblatt
--   RPCs plan-aware with a LEGACY FALLBACK of 2 generations/day:
--       plan_limit := coalesce(public.plan_feature_limit(uid, 'deckblatt'), 2)
--   plan_feature_limit() returns NULL whenever the user has no ACTIVE
--   subscription row whose plan matrix carries a deckblatt value — i.e. for
--   users without a plan. The fallback of 2 therefore GRANTED 2 Deckblatt
--   generations/day to every no-plan user (the Free plan at DB level).
--
--   This migration replaces the three functions with the SAME logic,
--   signatures, return shapes, security settings, and grants — except the
--   fallback is now 0:
--       plan_limit := coalesce(public.plan_feature_limit(uid, 'deckblatt'), 0)
--   A no-plan user (no row, historical 'free' row, expired trial, canceled,
--   unknown plan) gets daily_limit 0, remaining 0, and
--   reserve_deckblatt_generation() denies with 'quota_exhausted' before any
--   row is written (the existing plan_limit <= 0 guard — already present
--   for zero-cap matrix plans — now also covers the no-plan state).
--
-- Why this shape (additive, rerun-safe, non-destructive)
--   - create-or-replace functions ONLY: no table DDL, no data changes, no
--     grant changes. Rerunning this file is a no-op semantically (it just
--     re-installs the same bodies).
--   - Migration 20261121000000 is NOT rewritten (already applied in
--     production; rewriting applied migrations is forbidden).
--   - The 'free' value in subscriptions.plan stays in the CHECK constraint:
--     historical rows exist in production and must keep reading; the
--     constraint is history, not an offer.
--   - Reversible: restoring the old behavior = re-applying the three
--     function bodies from migration 20261121000000 (fallback 2). No data
--     is affected by either direction.
--
-- Deployment order (see docs/subscription-system-design-2026-10-24 §9)
--   1. Apply this migration FIRST (app code on the previous version is
--      unaffected: the app-level engine already denied no-plan users, so
--      the DB only becomes stricter).
--   2. Then deploy the application (PR #72 revision) that removes the
--      free grants from the entitlement engine, the plan gate, the legacy
--      counter resolver, and the UI text.
--   Both orders are safe — whichever lands first denies first; no window
--   exists in which a no-plan user is granted by the new code.
--
-- Nothing in this file deletes user data, deactivates accounts, or writes
-- subscription rows.
-- ============================================================================

-- 1. get_deckblatt_usage_status: fallback 2 → 0 (display + read side). ----

-- "limit" is a fully reserved PostgreSQL word and cannot be a
-- RETURNS TABLE field name (syntax error 42601) — hence daily_limit.
create or replace function public.get_deckblatt_usage_status(target_user_id uuid)
returns table (
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
  -- NO PERMANENT FREE PLAN (2026-10-24, PR #72): a user whose active plan
  -- does not define a deckblatt limit (i.e. any no-plan state) gets 0 —
  -- the feature is denied, not granted a legacy 2/day.
  plan_limit integer := coalesce(public.plan_feature_limit(target_user_id, 'deckblatt'), 0);
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

-- 2. reserve_deckblatt_generation: fallback 2 → 0 (write side, the real
--    enforcement point for user-session calls). --------------------------

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
  plan_limit integer := coalesce(public.plan_feature_limit(target_user_id, 'deckblatt'), 0);
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
  -- Since 2026-11-27 (PR #72) the no-plan fallback is 0, so this guard
  -- also denies every user without an active entitled plan.
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

-- 3. release_deckblatt_generation: fallback 2 → 0 (refund side — the
--    reported remaining now matches the real cap, not a phantom one). ----

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
  plan_limit integer := coalesce(public.plan_feature_limit(target_user_id, 'deckblatt'), 0);
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
