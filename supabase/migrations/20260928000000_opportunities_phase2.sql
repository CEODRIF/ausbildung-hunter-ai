-- Phase 2: opportunity data model hardening.
-- Idempotent + backwards compatible. No existing data is altered; old cache rows
-- keep schema_version 1 and are ignored (and eventually pruned) by the app,
-- which currently writes/reads schema_version 2.

-- 1) opportunity_cache: version the normalized payload format.
alter table public.opportunity_cache
  add column if not exists schema_version integer not null default 1;

create index if not exists opportunity_cache_schema_version_idx
  on public.opportunity_cache (schema_version);

-- 2) saved_opportunities: server-derived snapshot fields.
--    These are populated exclusively by the service-role save flow
--    (never from browser input) so the saved list can render real data
--    and drive the application-preparation workflow.
alter table public.saved_opportunities add column if not exists source_name text;
alter table public.saved_opportunities add column if not exists posted_at text;
alter table public.saved_opportunities add column if not exists salary_label text;
alter table public.saved_opportunities add column if not exists training_type text;
alter table public.saved_opportunities add column if not exists education_requirement text;
alter table public.saved_opportunities add column if not exists contact_email text;
alter table public.saved_opportunities add column if not exists match_score integer;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'saved_opportunities_match_score_range'
  ) then
    alter table public.saved_opportunities
      add constraint saved_opportunities_match_score_range
      check (match_score is null or (match_score >= 0 and match_score <= 100));
  end if;
end
$$;

create index if not exists saved_opportunities_user_saved_at_idx
  on public.saved_opportunities (user_id, saved_at desc);

-- 3) RLS: already enabled with owner-only policies in
--    20260927060000_opportunities.sql — no changes required here.
