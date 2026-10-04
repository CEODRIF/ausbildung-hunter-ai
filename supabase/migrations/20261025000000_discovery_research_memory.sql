-- Agentic research memory + company-level evidence ledger.
--
-- WHY THIS MIGRATION EXISTS:
--   * A Continue Research batch must NOT re-issue the queries the previous
--     batches already paid for. The run row keeps the planner's research
--     memory (research_memory jsonb): every issued query, the discovered
--     roles/cities/states, the companies that became query subjects, and the
--     planner's measured counters. On continue the engine restores the
--     planner from this snapshot and continues the strategy where it stopped.
--   * The Live Research UI shows the CURRENT STRATEGY as its own value
--     (current_strategy) instead of hiding it inside a source string.
--   * Each stored company carries its full evidence ledger (evidence jsonb:
--     which pages were actually opened, what each documented, when) and the
--     human-readable reasons behind its confidence score
--     (confidence_reasons jsonb). A contradiction between documented facts
--     (e.g. an offer documenting a start year different from the run's year)
--     is recorded as conflict = true and lowers the score — it is never
--     silently dropped.
--
-- Everything here is ADDITIVE and IDEMPOTENT: nullable/defaulted columns
-- only, no column dropped/renamed/rewritten, no existing migration edited,
-- safe to run repeatedly on a fresh or a partially migrated database.
--
-- Rollback: `alter table public.discovery_runs drop column if exists …` for
-- `research_memory`/`current_strategy`; the same for the three
-- `discovery_companies` columns. Existing data is untouched.
--
-- Posture matches 20261017000000 / 20261019000000 / 20261024000000: the
-- tables already have RLS enabled, service-role only — no policies, grants
-- or triggers change here.

-- ---------------------------------------------------------------------------
-- Research memory on the run (Continue = new batch, SAME strategy space)
-- ---------------------------------------------------------------------------

alter table public.discovery_runs
  add column if not exists research_memory jsonb,
  add column if not exists current_strategy text;

-- ---------------------------------------------------------------------------
-- Company-level evidence ledger (stored facts only — never guessed)
-- ---------------------------------------------------------------------------

alter table public.discovery_companies
  add column if not exists evidence jsonb,
  add column if not exists confidence_reasons jsonb,
  add column if not exists conflict boolean not null default false;
