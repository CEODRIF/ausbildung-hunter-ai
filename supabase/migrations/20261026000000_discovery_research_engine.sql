-- Company Discovery — research-engine execution stats
--
-- Additive, non-breaking: seven measured counters on discovery_runs that make
-- the agentic research loop's real work visible to the UI, the results API and
-- the Excel export (queries issued, pages inspected, URLs discovered, browser
-- pages + interactions, verified applications, documented beginn years).
--
-- Every value is MEASURED during the run (never estimated) and is written by
-- the same setRunCounters / finishDiscoveryRun path as the existing counters.
-- On a database WITHOUT this migration the application degrades gracefully
-- (the columns are in MIGRATION_DEPENDENT_KEYS — a drifted write is retried
-- without them and logged, exactly like the earlier counter migrations).
--
-- No RLS changes: discovery_runs already has RLS enabled with all grants
-- revoked from anon/authenticated (service-role only) — new columns inherit
-- the table's policy.

alter table public.discovery_runs
  add column if not exists queries_executed integer not null default 0,
  add column if not exists pages_inspected integer not null default 0,
  add column if not exists urls_discovered integer not null default 0,
  add column if not exists browser_pages integer not null default 0,
  add column if not exists browser_interactions integer not null default 0,
  add column if not exists applications_found integer not null default 0,
  add column if not exists beginn_confirmed integer not null default 0;

comment on column public.discovery_runs.queries_executed is
  'Provider (search-API) queries actually issued across the run (measured).';
comment on column public.discovery_runs.pages_inspected is
  'Pages successfully fetched and parsed (HTTP and browser-rendered, measured).';
comment on column public.discovery_runs.urls_discovered is
  'Distinct URLs the research discovered (search results + crawled links).';
comment on column public.discovery_runs.browser_pages is
  'Pages loaded in the anti-detection browser (Camofox), measured.';
comment on column public.discovery_runs.browser_interactions is
  'In-page browser interactions (clicks/scrolls for lazy content), measured.';
comment on column public.discovery_runs.applications_found is
  'Verified application URLs found for counted companies (never guessed).';
comment on column public.discovery_runs.beginn_confirmed is
  'Counted companies whose run''s beginn year is documented (never guessed).';
