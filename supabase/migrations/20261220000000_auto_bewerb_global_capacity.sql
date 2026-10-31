-- ============================================================================
-- AUTO BEWERB — GLOBAL 100-company capacity + automatic slot release.
--
-- Replaces the per-workflow 10-company cap with a GLOBAL per-user cap of
-- 100 companies across ALL active / scheduled / queued / processing campaigns
-- (draft + ready + scheduled + sending + failed). The moment a company is
-- successfully SENT (or safely cancelled / deleted) it leaves the "reserved"
-- set and frees exactly ONE unit of capacity.
--
-- HOW THE CAP IS ENFORCED (atomic, race-proof, in Supabase — not just the UI):
--   The existing `slot_no` column is the finite CAPACITY TOKEN. Each RESERVED
--   company holds a distinct slot in 1..100; a released company holds slot 0.
--   The partial UNIQUE index already created in 20261215000000_auto_bewerb.sql
--
--     auto_bewerb_companies_user_slot_unique (user_id, slot_no) WHERE slot_no > 0
--
--   is the DATABASE ARBITER for concurrent reservations: it now effectively
--   offers 100 distinct slots, so two simultaneous requests can never both
--   claim the last one — the loser gets a unique violation that the app maps
--   to a clean "workflow full" (capacity) error. This migration makes the slot
--   STATUS-AWARE so released companies stop occupying a slot:
--
--     * reserved (draft/ready/scheduled/sending/failed)  → holds a slot 1..100
--     * released (sent/cancelled)                        → slot is freed (slot_no = 0)
--
--   The app frees the slot on the successful-send write; the trigger below is a
--   deterministic, idempotent BACKSTOP that frees the slot on ANY transition
--   into a released state (defense in depth + forward-compat). Both are
--   no-ops on an already-released row, so capacity is released EXACTLY ONCE.
--
-- HISTORY IS PRESERVED: a sent / cancelled company row is NEVER deleted — the
-- application layer simply filters it out of the ACTIVE working list. Its send
-- attempts, batch snapshot and generated documents stay intact (no cascade
-- delete), so every audit field (company name, recipient, position, delivery
-- result, sent timestamp, sending account, batch id, application metadata)
-- remains available through the sending history.
--
-- DEPLOY ORDER: apply AFTER 20261218000000_auto_bewerb_batches and BEFORE the
-- code that reads the new counters. Code deployed first degrades SAFELY: the
-- trigger is simply not present yet (a sent company would keep its slot — the
-- old "100 total including sent" behavior) and the app computes the counters
-- from the rows it already loads. The new columns/RPC add no schema the old
-- code requires.
--
-- RE-RUN SAFE: every statement is idempotent (guarded constraint, replaceable
-- function, drop-guarded trigger). No existing migration is edited.
--
-- MANUAL APPLICATION: Supabase Dashboard → SQL Editor → paste this file → run
-- (or `supabase db push` in a dev project). Verify with:
--   select * from public.ab_user_capacity(<some-user-uuid>);
--   \d public.auto_bewerb_companies   -- shows the new range check + trigger
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) Hard range guard: slot_no is a capacity token in 0..100 (0 = released /
--    legacy-unassigned). Prevents the app from ever assigning an out-of-range
--    slot, even under a bug; the finite 1..100 range is what makes the unique
--    index a 100-capacity arbiter.
-- ----------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'auto_bewerb_companies_slot_no_range'
      and conrelid = 'public.auto_bewerb_companies'::regclass
  ) then
    alter table public.auto_bewerb_companies
      add constraint auto_bewerb_companies_slot_no_range
      check (slot_no >= 0 and slot_no <= 100);
  end if;
end
$$;

-- ----------------------------------------------------------------------------
-- 2) Capacity counter RPC — the persisted, server-side source of truth for the
--    "reserved / 100 / available" counters. Counts ONLY the reserved set;
--    sent + cancelled companies are excluded (their capacity is released).
--    Owner-scoped: the app scopes by user_id and calls it through the service
--    role, exactly like every other AUTO BEWERB RPC (defense in depth — RLS
--    owner SELECT is already in place on the table).
-- ----------------------------------------------------------------------------
create or replace function public.ab_user_capacity(p_user uuid)
returns table (reserved int, capacity int, available int)
language sql
security definer
set search_path = public
stable
as $$
  select
    count(*)::int filter (where status in ('draft','ready','scheduled','sending','failed')),
    100,
    greatest(0, 100 - count(*)::int filter (where status in ('draft','ready','scheduled','sending','failed')))
  from public.auto_bewerb_companies
  where user_id = p_user;
$$;

revoke execute on function public.ab_user_capacity(uuid) from anon, authenticated;
grant execute on function public.ab_user_capacity(uuid) to service_role;

-- ----------------------------------------------------------------------------
-- 3) Slot RELEASE trigger — the deterministic, idempotent backstop. When a
--    company's status transitions OUT of the reserved set into a released
--    state (sent / cancelled), its slot is freed (slot_no = 0). A row that
--    never left the reserved set, or was already released, is left untouched —
--    so a repeated update can never "release" a second time. (Re-enters into
--    the reserved set — cancelled → ready — are reserved by the APPLICATION
--    layer, which picks a fresh free slot race-free under the unique index.)
-- ----------------------------------------------------------------------------
create or replace function public.ab_companies_release_slot()
returns trigger
language plpgsql
as $$
begin
  if old.slot_no > 0
     and (old.status in ('draft','ready','scheduled','sending','failed'))
     and (new.status in ('sent','cancelled')) then
    new.slot_no := 0;
  end if;
  return new;
end;
$$;

drop trigger if exists auto_bewerb_companies_release_slot on public.auto_bewerb_companies;
create trigger auto_bewerb_companies_release_slot
  before update on public.auto_bewerb_companies
  for each row execute function public.ab_companies_release_slot();
