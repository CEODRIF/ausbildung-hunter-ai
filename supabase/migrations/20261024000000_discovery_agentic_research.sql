-- Agentic web research: live-research state + per-company verification facts.
--
-- WHY THIS MIGRATION EXISTS:
--   * The Live Research UI (Continue/Stop Research) must show what the run is
--     doing RIGHT NOW: the current provider query and the current source.
--     Both live on the run row so `GET /api/company-discovery/[runId]` serves
--     them with every other counter — no new endpoint, no client guessing.
--   * Each stored company must carry the verification facts the owner asked
--     for, exported 1:1 to the Excel:
--       application_url       the public application/career page that was
--                             actually inspected (Karriere/Jobs/Ausbildung),
--                             or null when none could be verified;
--       beginn_year_confirmed true when the counted offer's DOCUMENTED start
--                             matches the run's concrete beginn year (e.g.
--                             2027), false when documented but different,
--                             null when the start is not documented (never
--                             guessed);
--       confidence_score      0–100, derived from the stored evidence (email
--                             confidence, domain match, number of independent
--                             source pages) — null when the company has no
--                             verified public email.
--
-- Everything here is ADDITIVE and IDEMPOTENT: nullable columns only, no
-- column dropped/renamed/rewritten, no existing migration edited, safe to run
-- repeatedly on a fresh or a partially migrated database.
--
-- Rollback: `alter table public.discovery_runs drop column if exists …` for
-- `current_query`/`current_source`; the same for the three
-- `discovery_companies` columns. Existing data is untouched.
--
-- Posture matches 20261017000000 / 20261019000000: the tables already have RLS
-- enabled, service-role only — no policies, grants or triggers change here.

-- ---------------------------------------------------------------------------
-- Live research state on the run (the "Current query / Current source" UI)
-- ---------------------------------------------------------------------------

alter table public.discovery_runs
  add column if not exists current_query text,
  add column if not exists current_source text;

-- ---------------------------------------------------------------------------
-- Per-company verification facts (exported to the Excel, null = not verifiable)
-- ---------------------------------------------------------------------------

alter table public.discovery_companies
  add column if not exists application_url text,
  add column if not exists beginn_year_confirmed boolean,
  add column if not exists confidence_score integer;
