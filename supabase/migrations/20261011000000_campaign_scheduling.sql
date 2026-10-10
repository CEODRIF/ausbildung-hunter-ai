-- Phase 17 — Scheduling for application campaigns.
--
-- Design (additive — no enum changes, no RLS policy changes):
--
-- A scheduled campaign is an ordinary `queued` campaign with
--   * `scheduled_at` — the canonical UTC instant to send (server-computed,
--     never taken from the browser),
--   * `timezone`     — the IANA zone the user picked (display + audit only),
--   * `usage_date`   — the UTC date of `scheduled_at` (the daily quota the
--     reservation belongs to),
-- and every message row carries `next_attempt_at = scheduled_at`.
--
-- The existing claim predicates already gate on
--   `next_attempt_at is null or next_attempt_at <= now()`
-- (claim_next_email_message AND claim_next_pending_campaign), so a
-- future-scheduled campaign is simply invisible to every worker until the
-- instant passes. No new status, no new send path, no new provider code:
-- at `scheduled_at` the campaign flows through the exact same durable
-- worker, Smart Sending slot, retries and finalize/capacity logic as an
-- immediate send.
--
-- Quota: a scheduled campaign reserves against the SCHEDULED date, not
-- "today" — otherwise a send reserved yesterday would fail the capacity
-- lifecycle (finalize/cancel release against usage_date). The new
-- reserve_email_capacity_on() is the date-parameterised twin of
-- reserve_email_capacity(); release/finalize/cancel already use
-- usage_date and therefore work unchanged.
--
-- Reschedule: one atomic, service-role-only RPC. It locks the campaign row
-- (FOR UPDATE) — the same row every message-claim CTE locks — so a
-- reschedule can never race a concurrent claim: either the worker started
-- (status -> 'sending', reschedule returns false) or the reschedule won
-- (claims now see the new next_attempt_at). The quota move
-- (release old date + reserve new date) happens in the same transaction;
-- if the new date lacks capacity, the raise exception rolls back
-- everything, including the release.
--
-- Execute rights: service_role only, mirroring the rest of the engine.

alter table public.email_campaigns
  add column if not exists scheduled_at timestamptz,
  add column if not exists timezone text
    check (timezone is null or char_length(timezone) between 1 and 64);

-- Lookup for the dashboard/scheduler of what is coming due. Partial:
-- immediate campaigns (the common case) never touch the index.
create index if not exists email_campaigns_scheduled_at_idx
  on public.email_campaigns (scheduled_at)
  where scheduled_at is not null;

create or replace function public.reserve_email_capacity_on(target_user_id uuid, requested integer, on_date date)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  target public.daily_usage%rowtype;
  limit_value integer;
  available integer;
begin
  if requested <= 0 or requested > 1000 then raise exception 'invalid_request_size'; end if;
  if on_date < (timezone('utc', now()))::date
     or on_date > ((timezone('utc', now()) + interval '400 day')::date)
  then raise exception 'invalid_schedule_date'; end if;
  limit_value := public.effective_daily_email_limit(target_user_id);
  insert into public.daily_usage (user_id, date) values (target_user_id, on_date) on conflict (user_id, date) do nothing;
  select * into target from public.daily_usage where user_id = target_user_id and date = on_date for update;
  available := limit_value - target.emails_sent - target.emails_reserved;
  if requested > available then raise exception 'daily_quota_exceeded'; end if;
  update public.daily_usage set emails_reserved = emails_reserved + requested where id = target.id;
  return jsonb_build_object('date', target.date, 'daily_limit', limit_value, 'emails_sent', target.emails_sent, 'emails_reserved', target.emails_reserved + requested, 'remaining', available - requested);
end;
$$;

create or replace function public.reschedule_campaign(
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
  campaign_row public.email_campaigns%rowtype;
begin
  -- Future-only, server clock: a reschedule into the past is meaningless
  -- (the worker would have been racing it) and silently wrong.
  if new_scheduled_at is null or new_scheduled_at <= timezone('utc', now()) then return false; end if;
  if new_timezone is null or char_length(new_timezone) > 64 then return false; end if;
  if new_usage_date is null then return false; end if;

  -- Lock the campaign row. Every claim path (claim_next_email_message's
  -- candidate CTE, claim_next_pending_campaign) locks the same row, so this
  -- and a concurrent send-attempt are serialized: once any message has
  -- been claimed the status flips to 'sending' and rescheduling is
  -- refused — already-started campaigns can never be moved.
  select * into campaign_row from public.email_campaigns
  where id = target_campaign_id and user_id = target_user_id
  for update;
  if campaign_row.id is null then return false; end if;
  if campaign_row.status <> 'queued'::public.email_campaign_status
     or campaign_row.started_at is not null then return false; end if;

  -- Atomic quota move (only when the scheduled DATE changes; a same-day
  -- time change leaves the existing reservation untouched). If the new
  -- date lacks capacity, reserve_email_capacity_on raises
  -- daily_quota_exceeded and the whole function (including the release)
  -- rolls back.
  if campaign_row.usage_date <> new_usage_date then
    update public.daily_usage
       set emails_reserved = greatest(emails_reserved - campaign_row.reserved_count, 0)
     where user_id = target_user_id and date = campaign_row.usage_date;
    perform public.reserve_email_capacity_on(target_user_id, campaign_row.reserved_count, new_usage_date);
  end if;

  update public.email_campaigns
     set scheduled_at = new_scheduled_at,
         timezone = new_timezone,
         usage_date = new_usage_date
   where id = campaign_row.id;

  -- Re-gate the send: every not-yet-claimed message becomes due exactly at
  -- the new instant. (A never-started 'queued' campaign has no other
  -- statuses — sent/sent-attempt rows cannot exist here.)
  update public.email_messages
     set next_attempt_at = new_scheduled_at
   where campaign_id = campaign_row.id and status = 'queued';

  return true;
end;
$$;

revoke execute on function public.reserve_email_capacity_on(uuid, integer, date) from public, anon, authenticated;
grant execute on function public.reserve_email_capacity_on(uuid, integer, date) to service_role;
revoke execute on function public.reschedule_campaign(uuid, uuid, timestamptz, text, date) from public, anon, authenticated;
grant execute on function public.reschedule_campaign(uuid, uuid, timestamptz, text, date) to service_role;
