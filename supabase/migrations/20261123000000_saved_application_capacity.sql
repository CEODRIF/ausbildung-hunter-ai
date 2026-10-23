-- ============================================================================
-- 20261123000000 — saved_applications capacity (items quota) enforcement
--
-- Closes F1 of the security review of ec350c0: `saved_applications` is
-- advertised per plan (trial 3 / premium_10d 200 / premium_monthly 500,
-- mirrored in the billing_plans seeds and in commercial-plans.ts) but had
-- ZERO enforcement.
--
-- Definition of a "saved application" (the metered unit):
--   a public.bew_applications row whose btrim(company_name) <> ''.
--   Empty seed/growth rows (company_name = '') consume NO capacity.
--   The legacy public.applications table is dead and is no longer counted.
--
-- Run order: AFTER 20261112000000 (bew_campaigns / bew_applications),
-- 20261120000000 (subscriptions v2) and 20261121000000 (plan_feature_limit,
-- feature_capacity_status). RERUN-SAFE: every object uses
-- `create or replace` / `if not exists` / `drop trigger if exists`.
--
-- Design (hard guarantee in the DB, advisory pre-check on top):
--   1. `user_capacity_locks` — one row per user; the row lock serializes
--      ALL capacity decisions for a user (lock → limit → count → decide in
--      one critical section). A plain count-before-insert is NOT atomic:
--      two concurrent inserts at the limit would both pass the count.
--   2. `enforce_saved_application_capacity` — BEFORE INSERT OR UPDATE
--      trigger on bew_applications. It is the ONLY thing that can stop an
--      over-limit state from committing; it fires for every writer
--      (engine paths included) regardless of app-layer pre-checks.
--   3. `check_saved_application_capacity` — read-only advisory RPC used by
--      the app layer for a clean UX message BEFORE a destructive replace
--      (its p_replace_campaign_id accounts for the rows the same operation
--      deletes first).
--   4. `feature_capacity_status` — the items read side of
--      `readMeter`/`checkFeature` (entitlement-service) remapped from the
--      DEAD public.applications table to the bew_applications content rows,
--      so the billing page and the remaining-count display are correct.
--
-- Rollback (reverse order):
--   drop trigger if exists bew_applications_enforce_saved_capacity
--     on public.bew_applications;
--   drop function if exists public.check_saved_application_capacity(uuid, integer, uuid);
--   drop function if exists public.enforce_saved_application_capacity();
--   re-apply the ORIGINAL feature_capacity_status (20261121000000, lines
--     556–582);
--   drop table if exists public.user_capacity_locks;
-- ============================================================================

-- 1. Per-user capacity lock rows ---------------------------------------------
-- RLS is enabled with NO policies: service_role and SECURITY DEFINER
-- functions (owner = postgres) bypass RLS; anon/authenticated get nothing.
-- The FK mirrors 20261016000000_search_credits (user rows cascade-delete).

create table if not exists public.user_capacity_locks (
  user_id uuid primary key references auth.users(id) on delete cascade,
  locked_at timestamptz not null default now()
);

alter table public.user_capacity_locks enable row level security;

-- 2. The hard enforcement trigger ---------------------------------------------

create or replace function public.enforce_saved_application_capacity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_limit integer;
  v_used  integer;
begin
  -- Only transitions that ADD a content row consume capacity:
  --   INSERT with a non-empty company name, or
  --   UPDATE empty → non-empty.
  -- Renames (non-empty → non-empty) and frees (→ empty) always pass.
  if (tg_op = 'INSERT' or (tg_op = 'UPDATE' and btrim(coalesce(old.company_name, '')) = ''))
     and btrim(coalesce(new.company_name, '')) <> ''
  then
    -- Serialize per user: take (and lock) this user's lock row. Concurrent
    -- capacity decisions for the same user queue here; other users are
    -- unaffected.
    insert into public.user_capacity_locks (user_id)
    values (new.user_id)
    on conflict (user_id) do nothing;
    perform 1
      from public.user_capacity_locks
     where user_id = new.user_id
     for update;

    -- The plan's limit, read exactly like the read side (NULL = no plan
    -- quota / unmetered legacy state — those keep today's behavior).
    v_limit := public.plan_feature_limit(new.user_id, 'saved_applications');
    if v_limit is null then
      return new;
    end if;
    if v_limit <= 0 then
      -- Explicitly disabled on this plan.
      raise exception 'saved_application_capacity_exceeded (limit disabled)'
        using errcode = 'P0001';
    end if;

    -- The BEFORE trigger sees the table in its PRE-STATE: for INSERT the new
    -- row is not in the table yet; for UPDATE the row being updated is still
    -- in its old (empty) form — it is NOT yet a content row as far as the
    -- count is concerned. In both cases the projected total is v_used + 1.
    -- (An off-by-one here would let an empty→content UPDATE land at
    -- limit + 1; the INSERT branch and the advisory RPC use the same
    -- v_used + 1 > v_limit rule.)
    v_used := (select count(*)
                 from public.bew_applications
                where user_id = new.user_id
                  and btrim(coalesce(company_name, '')) <> '')::integer;
    if v_used + 1 > v_limit then
      raise exception 'saved_application_capacity_exceeded'
        using errcode = 'P0001';
    end if;
  end if;

  return new;
end;
$$;

revoke all on function public.enforce_saved_application_capacity() from public, anon, authenticated;
grant execute on function public.enforce_saved_application_capacity() to service_role;

drop trigger if exists bew_applications_enforce_saved_capacity on public.bew_applications;
create trigger bew_applications_enforce_saved_capacity
  before insert or update on public.bew_applications
  for each row
  execute function public.enforce_saved_application_capacity();

-- 3. Advisory capacity check (read-only; used for pre-UX, never a gate) -------
-- `limit` is reserved in SQL → the column is `plan_limit`.
-- p_replace_campaign_id: the campaign whose rows the SAME operation deletes
-- first (saveBewCompanies replace) — its content rows' slots are free.

create or replace function public.check_saved_application_capacity(
  p_user_id uuid,
  p_new_count integer default 0,
  p_replace_campaign_id uuid default null
)
returns table (status text, plan_limit integer, used integer, remaining integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_limit integer;
  v_used  integer;
begin
  if p_user_id is null then
    raise exception 'missing_args';
  end if;

  v_used := (select count(*)
               from public.bew_applications ba
              where ba.user_id = p_user_id
                and btrim(coalesce(ba.company_name, '')) <> ''
                and (p_replace_campaign_id is null
                     or ba.campaign_id <> p_replace_campaign_id))::integer;

  v_limit := public.plan_feature_limit(p_user_id, 'saved_applications');

  if v_limit is null then
    return query select 'unmetered'::text, null::integer, v_used, null::integer;
    return;
  end if;

  if v_limit <= 0 then
    return query select 'disabled'::text, v_limit, v_used, 0::integer;
    return;
  end if;

  if v_used + greatest(coalesce(p_new_count, 0), 0) > v_limit then
    return query select 'exceeded'::text, v_limit, v_used, 0::integer;
    return;
  end if;

  return query select 'ok'::text, v_limit, v_used,
                      greatest(v_limit - v_used - greatest(coalesce(p_new_count, 0), 0), 0)::integer;
end;
$$;

revoke all on function public.check_saved_application_capacity(uuid, integer, uuid) from public, anon, authenticated;
grant execute on function public.check_saved_application_capacity(uuid, integer, uuid) to service_role;

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
