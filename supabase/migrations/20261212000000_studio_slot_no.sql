-- AI Bewerbung Studio — race-proof batch capacity (additive). THIRD manual
-- migration for the studio feature.
--
-- PREREQUISITE: 20261210000000_bewerbung_studio.sql must be applied first
-- (this only adds a column + index to studio_applications).
--
-- SAFETY CONTRACT (manual migration — applied by hand, like all migrations
-- in this repo):
--   * purely ADDITIVE: one smallint column (NOT NULL DEFAULT 0, so existing
--     rows keep working) and one PARTIAL unique index. Nothing else is
--     altered, no data is touched, no constraint on existing rows.
--   * safe to re-run: `add column if not exists` / `create index if not
--     exists` are no-ops.
--   * backward compatible: code that does not know slot_no ignores it
--     (plain selects of other columns are unaffected); pre-existing rows
--     keep slot_no = 0 and are excluded from the index.
--
-- WHY: "10 active applications" must hold even under CONCURRENT create
-- requests. The application layer checks the count before inserting, but
-- two requests that both see 9 active applications could otherwise both
-- insert. Each new application is assigned the SMALLEST FREE slot in
-- 1..10 (deleting one frees its slot again), and the partial unique index
-- on (user_id, slot_no) makes the database the final arbiter: two
-- concurrent creates that both compute the same last free slot can never
-- both succeed — the second hits the unique violation and is mapped to a
-- safe "batch full" error.
--
-- REVERSIBILITY: drop the index, then the column (neither is referenced by
-- any other constraint or trigger).

do $$
begin
  if exists (
    select 1 from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'studio_applications'
  ) then
    alter table public.studio_applications add column if not exists slot_no smallint not null default 0;
    create unique index if not exists studio_applications_user_slot_unique
      on public.studio_applications (user_id, slot_no)
      where slot_no > 0;
  else
    raise exception 'studio_applications missing — apply 20261210000000_bewerbung_studio.sql first';
  end if;
end
$$;
