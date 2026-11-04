-- ============================================================================
-- AUTO BEWERB — ADMIN WINDOW BYPASS (administrators start/send at any time).
--
-- NORMAL USERS: the 07:30–10:30 Europe/Berlin sending window is UNCHANGED.
-- The predicate auto_bewerb_sending_window_open() is NOT touched and still
-- gates every non-admin batch start — the per-batch rule is now
-- `window open OR batch owner is admin`.
--
-- ADMINISTRATORS (members of public.admins — RLS enabled, NO user policies,
-- service-role only; self-elevation from the browser is impossible):
--   * their batches may be STARTED at any time of day, so scheduled
--     campaigns are never delayed to the next normal-user window, and
--   * the Node side applies the SAME window-OR-admin rule (engine:
--     isUserAdmin on session-derived user ids; cron: the
--     startAdminBatchesOutsideWindow mirror in src/lib/auto-bewerb/engine.ts).
--
-- The check is DATA-DRIVEN (batch.user_id ∈ public.admins) inside this
-- security-definer function, which only service_role may execute — no
-- client-controlled flag can influence it.
--
-- SAFE BATCH-BOUNDARY POLICY PRESERVED (behavior unchanged):
--   * claim_due_auto_bewerb_attempts is NOT window-gated: attempts of
--     ALREADY-STARTED ('sending') batches keep draining to completion, any
--     time of day — in-flight batches are never interrupted.
--   * recover_stale_auto_bewerb_attempts / _batches remain NOT window-gated.
--   * Due-but-not-started NORMAL batches stay scheduled/waiting and start at
--     the next eligible window — nothing is lost, moved or deleted.
--   * The 3:30 per-account inter-batch gate and the conditional flip are
--     UNCHANGED (an admin batch must still respect the account spacing).
--
-- MIRROR (keep in sync): src/lib/auto-bewerb/engine.ts +
-- src/lib/auto-bewerb/sending-window.ts (header). The Node cron path calls
-- this RPC only while the window is OPEN; while CLOSED it starts
-- admin-owned batches through a service-role mirror instead (so databases
-- predating the window gate can never start normal batches fail-open).
--
-- FORWARD-ONLY + IDEMPOTENT: create or replace + explicit grants; safe to
-- re-run. No schema changes, no RLS changes, no data changes.
-- ============================================================================

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
  for rec in
    select b.id
      from public.auto_bewerb_batches b
     where b.status in ('scheduled', 'waiting')
       and (b.scheduled_at is null or b.scheduled_at <= now())
       and (
         -- NORMAL USERS: only while the sending window (07:30–10:30
         -- Europe/Berlin, IANA, DST-aware) is open.
         -- ADMINISTRATORS: at any time of day (admin window bypass — the
         -- batch's OWN user is a public.admins member; trusted, service-
         -- role-only table, no client input involved).
         public.auto_bewerb_sending_window_open()
         or exists (select 1 from public.admins a where a.user_id = b.user_id)
       )
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
