-- Phase: Scheduling for Bewerbung-Automation batches.
--
-- This mirrors 20261011000000_campaign_scheduling.sql (the protected engine's
-- scheduling) for the ISOLATED bew_* feature. It reuses the same design —
-- additive columns + one atomic reschedule RPC — and does NOT build a second
-- scheduler: a scheduled batch is claimed by the EXISTING
-- /api/cron/bew-scheduler tick through the EXISTING claim_next_bew_application
-- RPC, whose predicate already gates on
--   next_attempt_at is null or next_attempt_at <= now().
--
-- A scheduled bew batch is an ordinary campaign that starts in the `sending`
-- state (so claim_next_bew_application can drain it) with
--   * scheduled_at — the canonical UTC instant to send (server-computed,
--     never taken from the browser),
--   * timezone     — the IANA zone the user picked (display + audit only),
--   * usage_date   — the UTC date of scheduled_at (the daily quota the
--     reservation belongs to),
-- and every queued application carrying next_attempt_at = scheduled_at.
--
-- Because the claim predicate is date-gated, a future-scheduled batch is
-- invisible to every worker (browser drain, internal worker, cron) until the
-- instant passes. No new status, no new send path, no new provider code: at
-- scheduled_at the batch flows through the exact same durable drain, Smart
-- Sending slot, retries and quota logic as an immediate send.
--
-- Quota: a scheduled batch reserves against the SCHEDULED date via the
-- EXISTING public.reserve_email_capacity_on() (the date-parameterised twin of
-- reserve_email_capacity()). Cancellation (bew_cancel_queued) and
-- finalization (bew_record_email_sent) already key off usage_date, so they
-- work unchanged.
--
-- Reschedule: one atomic, service-role-only RPC. It locks the campaign row
-- (FOR UPDATE) — the same row claim_next_bew_application locks — so a
-- reschedule can never race a concurrent claim: once any application has
-- been claimed, started_at is set and the batch is in flight, and
-- rescheduling is refused. The quota move (release old date + reserve new
-- date) is atomic; a shortfall on the new date raises daily_quota_exceeded
-- and rolls back the whole move (including the release).
--
-- Additive: no enum changes, no RLS changes. NO trigger is added to
-- bew_campaigns — that table has no updated_at column (see 20261112000000).
-- Execute rights: service_role only, mirroring the rest of the engine.

alter table public.bew_campaigns
  add column if not exists scheduled_at timestamptz,
  add column if not exists timezone text
    check (timezone is null or char_length(timezone) between 1 and 64);

-- Lookup for the dashboard/scheduler of what is coming due. Partial:
-- immediate batches (the common case) never touch the index.
create index if not exists bew_campaigns_scheduled_at_idx
  on public.bew_campaigns (scheduled_at)
  where scheduled_at is not null;

create or replace function public.bew_reschedule(
  target_user_id uuid,
  target_campaign_id uuid,
  new_scheduled_at timestamptz,
  new_timezone text,
  new_usage_date date
)
returns boolean
language plpgsql
set search_path = public
as $$
declare
  campaign_row public.bew_campaigns%rowtype;
  reserved_count integer;
begin
  -- Future-only, server clock: a reschedule into the past is meaningless
  -- (the worker would have been racing it) and silently wrong.
  if new_scheduled_at is null or new_scheduled_at <= timezone('utc', now()) then return false; end if;
  if new_timezone is null or char_length(new_timezone) > 64 then return false; end if;
  if new_usage_date is null then return false; end if;

  -- Lock the campaign row (the same row claim_next_bew_application locks), so
  -- this and a concurrent send-attempt are serialized.
  select * into campaign_row from public.bew_campaigns
    where id = target_campaign_id and user_id = target_user_id
    for update;
  if campaign_row.id is null then return false; end if;

  -- Only a not-yet-started SENDING batch is movable: once any application has
  -- been claimed, started_at is set and the batch is in flight — it can never
  -- be rescheduled. A pre-send/draft campaign has no queued applications to
  -- move either.
  if campaign_row.status <> 'sending'::public.bew_campaign_status
     or campaign_row.started_at is not null then return false; end if;

  -- Reserved quota == the number of still-queued applications, EXACT at this
  -- point (nothing has been claimed yet, so none is sent, released or
  -- needs_attention — every selected app is queued).
  select count(*) into reserved_count
    from public.bew_applications
   where campaign_id = target_campaign_id and status = 'queued';
  if reserved_count = 0 then return false; end if;

  -- Atomic quota move (only when the scheduled DATE changes; a same-day time
  -- change leaves the existing reservation untouched). If the new date lacks
  -- capacity, reserve_email_capacity_on raises daily_quota_exceeded and the
  -- whole function (including the release) rolls back.
  if campaign_row.usage_date <> new_usage_date then
    update public.daily_usage
       set emails_reserved = greatest(emails_reserved - reserved_count, 0)
     where user_id = target_user_id and date = campaign_row.usage_date;
    perform public.reserve_email_capacity_on(target_user_id, reserved_count, new_usage_date);
  end if;

  update public.bew_campaigns
     set scheduled_at = new_scheduled_at,
         timezone = new_timezone,
         usage_date = new_usage_date
   where id = campaign_row.id;

  -- Re-gate the send: every queued application becomes due exactly at the new
  -- instant. (A never-started 'sending' batch has only queued applications.)
  update public.bew_applications
     set next_attempt_at = new_scheduled_at,
         updated_at = timezone('utc', now())
   where campaign_id = campaign_row.id and status = 'queued';

  return true;
end;
$$;

revoke execute on function public.bew_reschedule(uuid, uuid, timestamptz, text, date) from public, anon, authenticated;
grant execute on function public.bew_reschedule(uuid, uuid, timestamptz, text, date) to service_role;
