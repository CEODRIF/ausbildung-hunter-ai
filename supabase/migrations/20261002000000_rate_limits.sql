-- Phase 12 — API abuse protection: Postgres-backed fixed-window rate limiter.
-- No external service (no Redis): one small self-cleaning table + an atomic
-- RPC. The app's most abuse-sensitive surfaces call it server-side:
-- the shared upstream BA jobs API (public client id — overuse can get the
-- whole app banned upstream), the paid AI chat, sensitive account
-- operations, and admin actions.

create table if not exists public.rate_limits (
  key text not null,
  window_start timestamptz not null,
  count integer not null default 1 check (count >= 0),
  primary key (key, window_start)
);

-- System table: RLS enabled with NO policies → every role without
-- BYPASSRLS (public, anon, authenticated, service_role clients) sees
-- zero rows. Only the security-definer RPC below (running as postgres)
-- and the service_role API key (BYPASSRLS) can touch it.
alter table public.rate_limits enable row level security;

create or replace function public.check_rate_limit(
  max_requests integer,
  window_seconds integer,
  limit_key text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  now_ts timestamptz := timezone('utc', now());
  window_start timestamptz;
  window_end timestamptz;
  row_count integer;
  retry_after bigint;
begin
  if max_requests is null or max_requests < 1 then
    raise exception 'check_rate_limit: max_requests must be >= 1';
  end if;
  if window_seconds is null or window_seconds < 1
     or window_seconds > 86400 then
    raise exception 'check_rate_limit: window_seconds must be 1..86400';
  end if;
  if limit_key is null or length(limit_key) = 0
     or length(limit_key) > 200 then
    raise exception 'check_rate_limit: limit_key must be 1..200 chars';
  end if;

  -- Wall-clock aligned fixed window (deterministic across app instances;
  -- no per-client clock drift).
  window_start := to_timestamp(
    floor(extract(epoch from now_ts) / window_seconds) * window_seconds
  );
  window_end := window_start + make_interval(secs => window_seconds);

  -- Atomic increment-or-insert: concurrent requests can never
  -- undercount (the race that breaks application-level counters).
  insert into public.rate_limits as rl (key, window_start, count)
  values (limit_key, window_start, 1)
  on conflict (key, window_start)
  do update set count = rl.count + 1
  returning count into row_count;

  -- Opportunistic self-cleanup: the largest window the app configures is
  -- 1 hour, so windows older than 2 hours can never be read again.
  delete from public.rate_limits
  where window_start < now_ts - interval '2 hours';

  if row_count <= max_requests then
    return jsonb_build_object(
      'allowed', true,
      'count', row_count,
      'limit', max_requests,
      'retry_after', 0
    );
  end if;

  retry_after := greatest(1, extract(epoch from (window_end - now_ts))::bigint);
  return jsonb_build_object(
    'allowed', false,
    'count', row_count,
    'limit', max_requests,
    'retry_after', retry_after
  );
end;
$$;

-- Execute rights: service role only. Public/anon/authenticated cannot
-- call the RPC (and RLS blocks direct table access) — the limiter can
-- neither be read nor be inflated/deflated from the browser.
revoke execute on function public.check_rate_limit(integer, integer, text)
  from public, anon, authenticated;
grant execute on function public.check_rate_limit(integer, integer, text)
  to service_role;
