-- ============================================================================
-- AUTO BEWERB — status-aware slot arbiter + one-time stale-slot normalization.
--
-- PRODUCTION INCIDENT (2026-11-01, reproduced): a company already in status
-- 'sent' still held slot_no = 1. The capacity counter (reserved statuses
-- only) reported reserved = 0 / available = 100, the allocator picked slot 1,
-- and the partial unique index
--
--   auto_bewerb_companies_user_slot_unique (user_id, slot_no) WHERE slot_no > 0
--
-- rejected the INSERT (it counted the SENT row as occupying the slot). The
-- app mapped that unique violation to "workflow full" — a genuinely empty
-- account could never add a company again until the row was repaired by hand.
--
-- ROOT CAUSE: the index predicate was BLIND to status. It treated every row
-- with slot_no > 0 as occupying its slot — including rows whose status had
-- already RELEASED the capacity (sent / cancelled). The allocator and the
-- ab_user_capacity RPC count only the reserved set
--
--   draft, ready, scheduled, sending, failed
--
-- (AUTO_BEWERB_RESERVED_STATUSES in src/lib/auto-bewerb/schema.ts). Released
-- rows are supposed to carry slot_no = 0 (app write + release trigger), but
-- the old trigger only fired when OLD.status was inside the reserved set —
-- so rows that were ALREADY released when 20261220000000 landed (legacy
-- "sent keeps its slot" era, see the DEPLOY ORDER note there) were never
-- repaired: no later update could fix them, and the index kept poisoning
-- their slot number forever.
--
-- THIS MIGRATION (forward-only; no already-applied migration is edited):
--   1) REPLACES the release trigger so that ANY update whose NEW status is
--      'sent' or 'cancelled' forces slot_no = 0 — independent of OLD.status.
--      Stale released rows therefore repair themselves on their next update
--      (idempotent: already-released rows stay at 0).
--   2) NORMALIZES all legacy released rows to slot_no = 0 — the one-time
--      data repair. Deterministic and idempotent; it touches ONLY rows with
--      status IN ('sent','cancelled') AND slot_no > 0. No company record,
--      send attempt, batch, document or history row is modified or deleted.
--   3) REBUILDS auto_bewerb_companies_user_slot_unique with the SAME name
--      (the application's error classification matches on it) and a
--      predicate that EXACTLY matches the reserved set:
--
--        WHERE slot_no > 0
--          AND status IN ('draft','ready','scheduled','sending','failed')
--
--      A released row can therefore never block slot reuse again, even if
--      its slot_no were somehow still positive. Race safety is unchanged:
--      two concurrent RESERVED rows can never claim the same slot.
--
-- TRANSACTION / LOCKING: all statements run in ONE transaction (the Supabase
-- SQL Editor default) — the index swap is atomic and readers never see a
-- table without the arbiter. CREATE INDEX CONCURRENTLY is deliberately NOT
-- used because it cannot run inside a transaction; the non-concurrent build
-- holds a ShareLock only while the index is built, which for this small
-- table (bounded at 100 reserved rows per user) is sub-second. Statement
-- order matters: (1) trigger first, so concurrent writes during the
-- migration already repair released rows; (2) normalization second — with
-- the old index still in place, setting slot_no = 0 can only REMOVE index
-- entries, never create a collision; (3) index swap last — at that point
-- the old and the new index contain identical entries, so the rebuild is a
-- no-op content-wise and the new predicate takes effect atomically.
--
-- RE-RUN SAFE: replaceable function, drop-guarded trigger, idempotent UPDATE
-- (zero rows on the second run), drop-guarded index.
--
-- MANUAL APPLICATION: Supabase Dashboard → SQL Editor → paste this file → run.
-- VERIFY afterwards (read-only):
--   select pg_get_indexdef('public.auto_bewerb_companies_user_slot_unique'::regclass);
--     → the WHERE clause must contain slot_no > 0 AND the five reserved statuses
--   select count(*) from public.auto_bewerb_companies
--    where status in ('sent','cancelled') and slot_no > 0;
--     → must be 0
--   select * from public.ab_user_capacity(<some-user-uuid>);
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) Strengthened release trigger — BEFORE UPDATE, per row, idempotent.
--    Every update whose NEW status is a released state frees the slot,
--    regardless of OLD.status (repairs stale released rows on a later
--    update; a no-op when the row already holds slot 0).
-- ----------------------------------------------------------------------------
create or replace function public.ab_companies_release_slot()
returns trigger
language plpgsql
as $$
begin
  if new.status in ('sent','cancelled') then
    new.slot_no := 0;
  end if;
  return new;
end;
$$;

drop trigger if exists auto_bewerb_companies_release_slot on public.auto_bewerb_companies;
create trigger auto_bewerb_companies_release_slot
  before update on public.auto_bewerb_companies
  for each row execute function public.ab_companies_release_slot();

-- ----------------------------------------------------------------------------
-- 2) One-time normalization of legacy released rows (the stale slot holders).
--    Exactly the incident state: released status + still-held slot.
-- ----------------------------------------------------------------------------
update public.auto_bewerb_companies
   set slot_no = 0
 where status in ('sent','cancelled')
   and slot_no > 0;

-- ----------------------------------------------------------------------------
-- 3) Status-aware slot arbiter (same index name — the app's insert-error
--    classification matches on "auto_bewerb_companies_user_slot_unique").
-- ----------------------------------------------------------------------------
drop index if exists public.auto_bewerb_companies_user_slot_unique;
create unique index auto_bewerb_companies_user_slot_unique
  on public.auto_bewerb_companies (user_id, slot_no)
 where slot_no > 0
   and status in ('draft','ready','scheduled','sending','failed');
