-- Phase 25 — Smart Sending: per-sender atomic rate-limit slots.
--
-- WHY A DATABASE SLOT (and not an in-process timer):
--   Vercel runs the worker / server actions on separate instances — an
--   in-memory "last send" map cannot be shared across workers, tabs, or
--   reloads. The slot lives in Postgres as ONE row per sender account, and
--   the reservation is a single conditional UPDATE: exactly one concurrent
--   caller can win per interval window (Postgres serialises row updates),
--   which is the atomic check-and-set the engine needs.
--
-- Semantics:
--   - One row per email_accounts row (ON DELETE CASCADE with the account).
--   - next_allowed_at: the earliest instant the account may send again.
--   - reserve_sender_slot: atomically reserves the slot when it is free
--     (next_allowed_at <= now()); otherwise reports how long to wait.
--   - A 5000ms floor is enforced HERE, in the database, in addition to the
--     TypeScript clamp — no code path can ever pace below 5 seconds.

create table if not exists public.email_sender_slots (
  account_id uuid primary key references public.email_accounts(id) on delete cascade,
  next_allowed_at timestamptz not null default now()
);

create or replace function public.reserve_sender_slot(
  target_account_id uuid,
  min_interval_ms integer default 6000
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_wait_ms bigint;
begin
  -- DB-level floor: the interval can never be applied below 5 seconds.
  if min_interval_ms is null or min_interval_ms < 5000 then
    min_interval_ms := 5000;
  end if;

  insert into public.email_sender_slots (account_id)
  values (target_account_id)
  on conflict (account_id) do nothing;

  -- The atomic core: one conditional update, one winner per window.
  update public.email_sender_slots
     set next_allowed_at = now() + (min_interval_ms * interval '1 millisecond')
   where account_id = target_account_id
     and next_allowed_at <= now();

  if found then
    return jsonb_build_object('reserved', true, 'wait_ms', 0);
  end if;

  select greatest(0, (extract(epoch from (next_allowed_at - now())) * 1000)::bigint)
    into v_wait_ms
    from public.email_sender_slots
   where account_id = target_account_id;

  return jsonb_build_object('reserved', false, 'wait_ms', coalesce(v_wait_ms, min_interval_ms));
end;
$$;

-- Read-only companion (UI state + observability): how long the account's
-- slot is busy right now. 0 (or null) = free.
create or replace function public.get_sender_slot_wait_ms(target_account_id uuid)
returns bigint
language sql
stable
security definer
set search_path = public
as $$
  select greatest(0, (extract(epoch from (next_allowed_at - now())) * 1000)::bigint)
    from public.email_sender_slots
   where account_id = target_account_id;
$$;

grant execute on function public.reserve_sender_slot(uuid, integer) to service_role;
grant execute on function public.get_sender_slot_wait_ms(uuid) to service_role;
