-- ============================================================================
-- AUTO BEWERB — Step 7 batch sending: the persistent batch queue.
--
-- Batches group up to 10 companies into ONE sending unit (immediate or
-- scheduled). The existing per-company attempt pipeline is unchanged —
-- batches reference attempts (`batch_id`) and own:
--   * an IMMUTABLE snapshot (resolved recipients, attachment references,
--     subject/account/flags) — data-retention guarantee: nothing a scheduled
--     batch needs is ever deleted before successful delivery;
--   * the scheduling state machine (scheduled → waiting → sending → terminal);
--   * the 3:30 INTER-BATCH gate per sending account (separate from the
--     per-email slot in email_sender_slots, which paces individual messages).
--
-- Apply manually in Supabase (SQL editor / dashboard), ordered by filename.
-- ============================================================================

-- CREATE TYPE has no IF NOT EXISTS (42601): guard with a pg_type probe, the
-- same idempotent pattern as 20261112000000_bewerbung_automation.sql.
do $$
begin
  if not exists (select 1 from pg_type where typname = 'auto_bewerb_batch_status') then
    create type public.auto_bewerb_batch_status as enum
      ('scheduled', 'waiting', 'sending', 'completed', 'partially_failed', 'failed', 'cancelled');
  end if;
end
$$;

create table if not exists public.auto_bewerb_batches (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  -- Per-user display sequence (Batch 1, Batch 2, …):
  batch_no integer not null check (batch_no >= 1),
  -- { items: [{ companyId, company, position, recipientEmail, cvPdfName,
  --     letterPdfName, sharedDocs[] }], subject, accountId, accountEmail,
  --     attachCv, attachLetter, sharedDocs: string[] }
  -- Frozen at creation; the attempts carry the full e-mail payloads.
  snapshot jsonb not null,
  account_id uuid not null,
  status public.auto_bewerb_batch_status not null default 'scheduled',
  -- NULL = immediate (starts as soon as the inter-batch gate allows).
  scheduled_at timestamptz,
  -- Set exactly once when the batch STARTS (first dispatch); feeds the
  -- 3:30 inter-batch gate for the same sending account.
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (user_id, batch_no)
);

-- Batches link to the existing attempts (the send unit stays per company):
alter table public.auto_bewerb_send_attempts
  add column if not exists batch_id uuid references public.auto_bewerb_batches(id) on delete set null;

create index if not exists auto_bewerb_batches_user_status_idx
  on public.auto_bewerb_batches (user_id, status);
create index if not exists auto_bewerb_batches_account_start_idx
  on public.auto_bewerb_batches (account_id, started_at);
create index if not exists auto_bewerb_send_attempts_batch_idx
  on public.auto_bewerb_send_attempts (batch_id);

-- ----------------------------------------------------------------------------
-- Claim RPC (recreated) — the batch gate:
-- an attempt that belongs to a batch is claimable only while its batch has
-- been STARTED (status 'sending'). The inter-batch gate below owns WHEN a
-- batch starts; until then its attempts wait in the queue no matter how far
-- in the past their scheduled_at is. Attempts without a batch (legacy /
-- pre-batch rows) are claimed exactly as before.
-- ----------------------------------------------------------------------------
create or replace function public.claim_due_auto_bewerb_attempts(p_limit integer default 5)
returns setof public.auto_bewerb_send_attempts
language plpgsql
security definer
set search_path = public
as $$
declare
  rec record;
begin
  for rec in
    select a.id
      from public.auto_bewerb_send_attempts a
     where a.status = 'queued'
       and (a.scheduled_at is null or a.scheduled_at <= now())
       and (a.next_attempt_at is null or a.next_attempt_at <= now())
       and (
         a.batch_id is null
         or exists (
           select 1 from public.auto_bewerb_batches b
            where b.id = a.batch_id and b.status = 'sending'
         )
       )
     order by coalesce(a.scheduled_at, a.created_at) asc
     limit greatest(1, least(p_limit, 10))
     for update skip locked
  loop
    update public.auto_bewerb_send_attempts
       set status = 'sending'
     where id = rec.id
     returning * into rec;
    return next rec;
  end loop;
  return;
end;
$$;

revoke execute on function public.claim_due_auto_bewerb_attempts(integer) from anon, authenticated;
grant execute on function public.claim_due_auto_bewerb_attempts(integer) to service_role;

-- ----------------------------------------------------------------------------
-- Stale batch recovery: a 'sending' batch stuck for > 15 minutes (crashed
-- worker) goes back to 'waiting' so the queue is never blocked. started_at is
-- KEPT on purpose: the batch really did start (some e-mails may have gone
-- out), so the 3:30 inter-batch gate must not be consumed again — keeping it
-- is the conservative (safe) choice.
-- ----------------------------------------------------------------------------
create or replace function public.recover_stale_auto_bewerb_batches()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  update public.auto_bewerb_batches
     set status = 'waiting', updated_at = now()
   where status = 'sending'
     and started_at <= now() - interval '15 minutes';
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke execute on function public.recover_stale_auto_bewerb_batches() from anon, authenticated;
grant execute on function public.recover_stale_auto_bewerb_batches() to service_role;

-- ----------------------------------------------------------------------------
-- Atomic batch start with the 3:30 INTER-BATCH gate PER SENDING ACCOUNT.
--
-- A batch may start when:
--   (a) it is due: status in ('scheduled','waiting') and
--       (scheduled_at is null or scheduled_at <= now()), and
--   (b) no OTHER batch of the SAME account started within the last
--       3 minutes 30 seconds (max(started_at) + 210s <= now()).
--
-- The due rows are locked (FOR UPDATE SKIP LOCKED) and the start is a
-- conditional UPDATE — overlapping ticks, workers, sessions and
-- multi-browser claims can never double-start a batch or violate the gate:
-- the first starter sets started_at, which immediately feeds the gate for
-- every later batch of that account.
-- A due batch whose gate is not clear yet is moved 'scheduled' → 'waiting'
-- (an honest state: it starts as soon as the gate clears) and re-checked on
-- every tick.
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

-- ----------------------------------------------------------------------------
-- RLS: owner-scoped read (defense in depth — the app reads via the service
-- role with explicit user_id scoping, exactly like every other AUTO BEWERB
-- table); writes happen exclusively through service-role server actions.
-- ----------------------------------------------------------------------------
alter table public.auto_bewerb_batches enable row level security;

drop policy if exists "auto_bewerb_batches_owner_select" on public.auto_bewerb_batches;
create policy "auto_bewerb_batches_owner_select"
  on public.auto_bewerb_batches
  for select to authenticated
  using (auth.uid() = user_id);
