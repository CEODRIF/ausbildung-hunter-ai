-- Phase 14 — Durable email worker: provider-neutral work discovery.
--
-- The processing endpoint (/api/internal/email-worker) requires an
-- explicit (user_id, campaign_id). Nothing durable could discover work,
-- so a crash-looped or freshly-deployed worker had no way to start
-- processing on its own. This RPC closes that gap *inside Postgres* —
-- no external queue/scheduler product is introduced. Any poller
-- (cron job, container loop, queue consumer) can now run:
--   claim next campaign -> process batch -> repeat.
--
-- Safety properties (mirror the message-level claim in migration 10):
-- * `for update of c skip locked` — concurrent claimers never get the
--   same campaign in the same instant; they spread across campaigns.
--   Duplicate/overlapping claims are always safe because the real
--   work items (messages) are claimed atomically per message later.
-- * Non-terminal campaigns only; FIFO by created_at.
-- * A campaign is "ready" iff it has >= 1 message that is `queued` and
--   due (`next_attempt_at` null or <= now) — matches exactly the
--   predicate `claim_next_email_message` can satisfy.
-- * Execute rights: service_role only (revoked from public/anon/
--   authenticated) — the browser cannot enumerate campaign ids.

create or replace function public.claim_next_pending_campaign()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  ready record;
begin
  select c.user_id, c.id as campaign_id
  into ready
  from public.email_campaigns c
  where c.status in ('queued', 'sending')
    and exists (
      select 1
      from public.email_messages m
      where m.campaign_id = c.id
        and m.status = 'queued'
        and (m.next_attempt_at is null
             or m.next_attempt_at <= timezone('utc', now()))
    )
  order by c.created_at asc
  limit 1
  for update of c skip locked;

  if ready.campaign_id is null then
    return jsonb_build_object('user_id', null, 'campaign_id', null);
  end if;

  return jsonb_build_object(
    'user_id', ready.user_id,
    'campaign_id', ready.campaign_id
  );
end;
$$;

revoke execute on function public.claim_next_pending_campaign()
  from public, anon, authenticated;
grant execute on function public.claim_next_pending_campaign()
  to service_role;
