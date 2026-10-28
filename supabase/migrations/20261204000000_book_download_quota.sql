-- ============================================================================
-- Deutsch Bibliothek — daily book-download quotas.
--
-- Isolated, ADDITIVE migration: creates exactly ONE new table
-- (public.book_download_quota) and ONE new service-role-only RPC
-- (public.reserve_book_download). It touches NO existing table, policy,
-- function, or data — in particular the subscription system
-- (subscriptions, billing_plans, profiles) is read by the app layer and
-- never written here.
--
-- DESIGN — mirrors the repo's canonical daily-counter pattern
-- (public.daily_usage + reserve_ai_request / reserve_email_capacity,
-- migrations 20260927000000/03/04):
--
--   * one row per (user, DAY) — the day key IS the reset: a new UTC day
--     is a new row starting at used_count = 0 (no reset branch, no
--     cron). UTC is the application-wide day-boundary convention for
--     daily counters (`(timezone('utc', now()))::date` everywhere in
--     daily_usage);
--   * consumption is ONE atomic operation: upsert-then-`SELECT ... FOR
--     UPDATE` (row lock) then conditional increment — concurrent
--     requests for the same user serialize on the lock, so the limit
--     can never be exceeded by parallel clicks;
--   * dedup: the same book re-requested within 10 seconds is treated as
--     a retry / double-click — granted, NOT counted again;
--   * the LIMIT is passed by the app layer (server-resolved from the
--     trusted subscription data via getEntitlements) — the RPC never
--     reads plan state itself;
--   * EXECUTE is revoked from public/anon/authenticated and granted to
--     service_role ONLY (the house pattern of reserve_ai_request):
--     the browser cannot call the RPC, cannot consume another user's
--     quota, and cannot inflate p_limit.
--
-- RLS: enabled with NO user-facing policies (service-role reads/writes
-- only) — the same fail-closed shape as german_books' write side.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Table
-- ---------------------------------------------------------------------------
create table if not exists public.book_download_quota (
  user_id          uuid not null references auth.users(id) on delete cascade,
  quota_day        date not null default (timezone('utc', now()))::date,
  used_count       integer not null default 0
                   check (used_count >= 0 and used_count <= 10000),
  last_book_id     uuid,
  last_downloaded_at timestamptz,
  primary key (user_id, quota_day)
);

comment on table public.book_download_quota is
  'Deutsch Bibliothek: per-user per-UTC-day book-download counters (one row per day; a new day is a new row = the daily reset). Service-role only.';

alter table public.book_download_quota enable row level security;
-- No policies: reads/writes happen exclusively through the service-role
-- client (the app layer, after session + subscription resolution).

-- ---------------------------------------------------------------------------
-- 2. Atomic consumption RPC (service-role only)
-- ---------------------------------------------------------------------------
drop function if exists public.reserve_book_download(uuid, uuid, integer);

create function public.reserve_book_download(p_user_id uuid, p_book_id uuid, p_limit integer)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_today date := (timezone('utc', now()))::date;
  current_usage public.book_download_quota%rowtype;
begin
  -- The limit is SERVER-RESOLVED (getEntitlements → plan matrix); the
  -- bound below only prevents garbage from breaking the counter.
  if p_limit < 0 or p_limit > 10000 then
    raise exception 'invalid_quota_limit';
  end if;

  -- Day-scoped row: a new UTC day is a new key (the daily reset).
  insert into public.book_download_quota (user_id, quota_day, used_count)
  values (p_user_id, v_today, 0)
  on conflict (user_id, quota_day) do nothing;

  -- Row lock: concurrent consumes for the same user+day serialize here,
  -- so `used_count >= p_limit` can never be raced past.
  select * into current_usage
  from public.book_download_quota
  where user_id = p_user_id and quota_day = v_today
  for update;

  -- Dedup window: the same book re-requested within 10 s is a retry or
  -- double-click — grant it, do NOT count it a second time.
  if current_usage.last_book_id is not null
     and current_usage.last_book_id = p_book_id
     and current_usage.last_downloaded_at is not null
     and current_usage.last_downloaded_at > now() - interval '10 seconds' then
    return jsonb_build_object(
      'granted', true, 'deduplicated', true,
      'date', v_today,
      'used_count', current_usage.used_count,
      'limit', p_limit
    );
  end if;

  if current_usage.used_count >= p_limit then
    return jsonb_build_object(
      'granted', false, 'deduplicated', false,
      'date', v_today,
      'used_count', current_usage.used_count,
      'limit', p_limit
    );
  end if;

  update public.book_download_quota
     set used_count = used_count + 1,
         last_book_id = p_book_id,
         last_downloaded_at = now()
   where user_id = p_user_id and quota_day = v_today;

  return jsonb_build_object(
    'granted', true, 'deduplicated', false,
    'date', v_today,
    'used_count', current_usage.used_count + 1,
    'limit', p_limit
  );
end;
$$;

comment on function public.reserve_book_download(uuid, uuid, integer) is
  'Deutsch Bibliothek: atomic daily-quota consume (FOR UPDATE + UTC day key + 10 s same-book dedup). Service-role only.';

-- House grant pattern (reserve_ai_request / reserve_email_capacity):
-- callable ONLY by the service role — never by anon/authenticated
-- through PostgREST.
revoke all on function public.reserve_book_download(uuid, uuid, integer) from public, anon, authenticated;
grant execute on function public.reserve_book_download(uuid, uuid, integer) to service_role;
