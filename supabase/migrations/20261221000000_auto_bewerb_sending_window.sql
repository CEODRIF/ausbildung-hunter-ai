-- ============================================================================
-- AUTO BEWERB — EXACT DAILY SENDING WINDOW (Germany): 07:30–10:30 Europe/Berlin.
--
-- The window gates BATCH STARTS (scheduled/waiting → sending) — everywhere:
--   * public.auto_bewerb_sending_window_open() — the single DB predicate:
--     IANA 'Europe/Berlin' via AT TIME ZONE (daylight saving is respected
--     automatically — NEVER a hardcoded UTC offset), [07:30, 10:30) local,
--     every day. STABLE ⇒ a tick sees one consistent window state.
--   * claim_startable_auto_bewerb_batches (recreated below — identical rules
--     from 20261218000000_auto_bewerb_batches.sql, ONE new condition): while
--     the window is closed it returns no rows — the CRON path can never start
--     a new batch outside the window, no matter how late the tick actually
--     runs (delayed/throttled GitHub Actions executions are safe).
--
-- SAFE BATCH-BOUNDARY POLICY (behavior preserved outside the window):
--   * claim_due_auto_bewerb_attempts is deliberately NOT window-gated:
--     attempts of ALREADY-STARTED ('sending') batches keep draining to
--     completion — an in-flight batch is never interrupted, and an
--     individual provider send is atomic anyway.
--   * recover_stale_auto_bewerb_attempts / _batches are NOT window-gated
--     (safe un-sticking of crashed rows, any time of day).
--   * Due-but-not-started batches simply stay scheduled/waiting in Postgres
--     and start at the next eligible window — nothing is lost, nothing is
--     moved or deleted.
--
-- MIRROR (keep in sync): the Node side enforces the SAME window in
-- src/lib/auto-bewerb/sending-window.ts (isSendingWindowOpen), gating
-- startAutoBewerbBatchesForUser (immediate 'send now' + page-load catch-up)
-- and the cron TS path (claimAndDispatchDueAutoBewerbAttempts skips the
-- claim_startable RPC while closed). The app-level gate is authoritative
-- even before this migration is applied (graceful degradation: pre-migration
-- DBs are still protected by the Node gate).
--
-- FORWARD-ONLY + IDEMPOTENT: create or replace + explicit grants; safe to
-- re-run. No schema changes, no RLS changes, no data changes.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- The window predicate: [07:30, 10:30) local Berlin time, every day.
-- ----------------------------------------------------------------------------
create or replace function public.auto_bewerb_sending_window_open()
returns boolean
language sql
stable
as $$
  with local as (
    select (extract(hour from (now() at time zone 'Europe/Berlin'))::integer * 60
            + extract(minute from (now() at time zone 'Europe/Berlin'))::integer) as m
  )
  select m >= 7 * 60 + 30 and m < 10 * 60 + 30
    from local;
$$;

revoke execute on function public.auto_bewerb_sending_window_open() from anon, authenticated;
grant execute on function public.auto_bewerb_sending_window_open() to service_role;

-- ----------------------------------------------------------------------------
-- Atomic batch start WITH the sending-window gate (recreated; the 3:30
-- per-account inter-batch gate and the conditional flip are UNCHANGED — the
-- only addition is the window check at the top).
-- ----------------------------------------------------------------------------
create or replace function public.claim_startable_auto_bewerb_batches(p_limit integer default 5)
returns setof public.auto_bewerb_batches
language plpgsql
security definer
set search_path = public
as $$
declare
  rec record;
  v_account uuid;
  v_last_start timestamptz;
begin
  -- SENDING WINDOW (07:30–10:30 Europe/Berlin, IANA, DST-aware): closed ⇒
  -- start NOTHING. Due batches stay scheduled/waiting for the next eligible
  -- window; in-flight 'sending' batches are unaffected (their attempts drain
  -- via the ungated claim_due_auto_bewerb_attempts — safe batch boundary).
  if not public.auto_bewerb_sending_window_open() then
    return;
  end if;

  for rec in
    select b.id
      from public.auto_bewerb_batches b
     where b.status in ('scheduled', 'waiting')
       and (b.scheduled_at is null or b.scheduled_at <= now())
     order by coalesce(b.scheduled_at, b.created_at) asc
     limit greatest(1, least(p_limit, 10))
     for update skip locked
  loop
    select account_id into v_account
      from public.auto_bewerb_batches where id = rec.id;

    select max(started_at) into v_last_start
      from public.auto_bewerb_batches
     where account_id = v_account
       and started_at is not null
       and id <> rec.id;

    if v_last_start is not null
       and v_last_start + interval '3 minutes 30 seconds' > now() then
      -- Gate not clear: an already-DUE scheduled batch becomes 'waiting'
      -- (immediate batches are already 'waiting'); re-checked next tick.
      if (select status from public.auto_bewerb_batches where id = rec.id) = 'scheduled' then
        update public.auto_bewerb_batches
           set status = 'waiting', updated_at = now()
         where id = rec.id;
      end if;
      continue;
    end if;

    update public.auto_bewerb_batches
       set status = 'sending', started_at = now(), updated_at = now()
     where id = rec.id
       and status in ('scheduled', 'waiting')
       and (scheduled_at is null or scheduled_at <= now())
     returning * into rec;
    return next rec;
  end loop;
  return;
end;
$$;

revoke execute on function public.claim_startable_auto_bewerb_batches(integer) from anon, authenticated;
grant execute on function public.claim_startable_auto_bewerb_batches(integer) to service_role;
