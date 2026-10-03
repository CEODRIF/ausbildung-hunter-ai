-- ----------------------------------------------------------------------------
-- Deckblatt quota: recover reservations that were never settled.
--
-- PRODUCTION DEFECT THIS FIXES
-- A generation is charged at RESERVE time (reserve_deckblatt_generation inserts
-- a run row with status 'reserved' and increments generations_used) and refunded
-- only by release_deckblatt_generation, which the API route calls from its catch
-- block. When the serverless function never reaches that catch — the platform
-- killed it at the function time limit while a slow image model was still
-- running, the client navigated away, or the release RPC itself failed — the run
-- stayed 'reserved' forever and the user was charged for a Deckblatt they never
-- received. With a 2/day quota, two such attempts exhausted the day.
--
-- Nothing in the previous schema ever expired a reservation, so the lost quota
-- never came back.
--
-- WHAT THIS ADDS
-- expire_stale_deckblatt_runs(): refunds every run of a user that is still
-- 'reserved' after a grace window, using exactly the accounting of
-- release_deckblatt_generation (status → 'failed', generations_used - 1 clamped
-- at 0) and against the usage_date of the RUN'S OWN DAY, so a reservation made
-- at 23:59 that is recovered after midnight refunds the correct day.
--
-- It is ADDITIVE: no table, column, constraint, index or existing function is
-- modified, so the reserve / release / complete contract is unchanged. The
-- application calls it before reserving and when reporting quota, so a user's
-- next attempt self-heals the day without any background job (this deployment
-- has no scheduler).
--
-- Idempotent and concurrency-safe: rows are locked FOR UPDATE, only 'reserved'
-- rows are touched, and a run can never be refunded twice (the second pass finds
-- it 'failed').
-- ----------------------------------------------------------------------------

create or replace function public.expire_stale_deckblatt_runs(
  target_user_id uuid,
  p_max_age_minutes integer default 15
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  stale record;
  refunded integer := 0;
begin
  -- Same authorization guard as the other deckblatt RPCs: a caller may only
  -- settle its own runs (service_role keeps full control).
  if auth.uid() is not null and auth.uid() <> target_user_id then
    raise exception 'not_authorized';
  end if;
  -- Bounded window: never expire everything at once by accident, and never
  -- accept an unbounded/negative value.
  if p_max_age_minutes is null or p_max_age_minutes < 1 or p_max_age_minutes > 1440 then
    raise exception 'invalid_max_age';
  end if;

  for stale in
    select r.run_id,
           (r.created_at at time zone 'utc')::date as usage_date
      from public.ai_deckblatt_runs r
     where r.user_id = target_user_id
       and r.status = 'reserved'
       and r.created_at < timezone('utc', now()) - make_interval(mins => p_max_age_minutes)
     order by r.created_at
     for update
  loop
    update public.ai_deckblatt_runs
       set status = 'failed'
     where run_id = stale.run_id;

    update public.ai_deckblatt_usage u
       set generations_used = greatest(u.generations_used - 1, 0)
     where u.user_id = target_user_id
       and u.usage_date = stale.usage_date;

    refunded := refunded + 1;
  end loop;

  return refunded;
end;
$$;

revoke execute on function public.expire_stale_deckblatt_runs(uuid, integer) from public, anon;
grant execute on function public.expire_stale_deckblatt_runs(uuid, integer) to authenticated;
