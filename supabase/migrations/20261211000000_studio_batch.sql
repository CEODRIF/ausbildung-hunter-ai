-- AI Bewerbung Studio — batch workspace (multi-application, sequential
-- unlocking). SECOND manual migration for the studio feature.
--
-- PREREQUISITE: 20261210000000_bewerbung_studio.sql must be applied first
-- (this only adds columns to studio_applications).
--
-- SAFETY CONTRACT (manual migration — applied by hand, like all migrations
-- in this repo):
--   * purely ADDITIVE: five nullable timestamp columns on
--     studio_applications. No table, enum, RPC, index or bucket is altered
--     or dropped; no column is NOT NULL, so existing rows keep working.
--   * safe to re-run: `add column if not exists` is a no-op per column.
--   * backward compatible: code that does not know these columns ignores
--     them (plain selects of other columns are unaffected); the studio UI
--     treats NULL confirmations as "not confirmed yet".
--
-- WHY: the batch workspace needs EXPLICIT, server-owned confirmation states
-- ("user confirmed the extraction", "user reviewed the CV", "user
-- acknowledged the document checklist") to drive sequential slot unlocking.
-- Derived data alone (a document exists) cannot distinguish "generated"
-- from "reviewed", so each confirmation is its own auditable timestamp.
--
-- REVERSIBILITY: drop the five columns (none of them is referenced by any
-- constraint, index or trigger).

do $$
begin
  if exists (
    select 1 from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'studio_applications'
  ) then
    alter table public.studio_applications add column if not exists ad_confirmed_at timestamptz;
    alter table public.studio_applications add column if not exists profile_confirmed_at timestamptz;
    alter table public.studio_applications add column if not exists cv_reviewed_at timestamptz;
    alter table public.studio_applications add column if not exists letter_reviewed_at timestamptz;
    alter table public.studio_applications add column if not exists checklist_ack_at timestamptz;
  else
    raise exception 'studio_applications missing — apply 20261210000000_bewerbung_studio.sql first';
  end if;
end
$$;
