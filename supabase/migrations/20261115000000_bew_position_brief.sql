-- ---------------------------------------------------------------------------
-- Position brief (the ACTUAL role) + verified employer facts + per-company
-- position overrides + letter quality/lease columns.
--
-- WHY: every generated Anschreiben must be written for the ACTUAL role and
-- employer, from the ACTUAL applicant. The previous prompt carried only the
-- company name and the raw CV text — no role title, no job description, no
-- employer facts, and no quality gate — so the model could only produce a
-- generic letter. This migration adds the data that makes a role-specific,
-- evidence-based letter possible.
--
-- Design (additive, rerunnable, migration-safe):
--   * campaign gains position_title / position_brief / employer_facts.
--     These are NOT NULL with an EMPTY default so existing campaigns keep
--     working (empty position => the prompt honestly says "role not
--     specified" instead of inventing one).
--   * application gains the SAME three fields, NULLABLE. A NULL value means
--     "inherit the campaign value"; a non-null value is a per-company
--     override (the same applicant applies to the same role at many
--     companies, but sometimes the role differs per employer).
--   * application gains quality_attempts (generation retries, capped at 2)
--     and generation_started_at (the lease used to reclaim a stale
--     'generating' row so a crash can no longer lock the letter forever).
--
-- No RLS changes (new columns inherit the existing bew_* policies).
-- No triggers. No backfill (existing campaigns stay ''; existing rows stay
-- NULL/0 — the prompt builder degrades truthfully).
-- Apply MANUALLY like every other migration in this repo.
-- ---------------------------------------------------------------------------

alter table public.bew_campaigns
  add column if not exists position_title text not null default '',
  add column if not exists position_brief text not null default '',
  add column if not exists employer_facts text not null default '';

alter table public.bew_applications
  add column if not exists position_title        text,
  add column if not exists position_brief        text,
  add column if not exists employer_facts        text,
  add column if not exists quality_attempts      integer not null default 0,
  add column if not exists generation_started_at timestamptz;

-- Length guards (drop+add so re-runs stay idempotent; every existing row is
-- '' / NULL / 0, which satisfies each constraint below).
alter table public.bew_campaigns
  drop constraint if exists bew_campaigns_position_title_length,
  drop constraint if exists bew_campaigns_position_brief_length,
  drop constraint if exists bew_campaigns_employer_facts_length;

alter table public.bew_campaigns
  add constraint bew_campaigns_position_title_length
    check (char_length(position_title) between 0 and 160),
  add constraint bew_campaigns_position_brief_length
    check (char_length(position_brief) between 0 and 4000),
  add constraint bew_campaigns_employer_facts_length
    check (char_length(employer_facts) between 0 and 4000);

alter table public.bew_applications
  drop constraint if exists bew_applications_position_title_length,
  drop constraint if exists bew_applications_position_brief_length,
  drop constraint if exists bew_applications_employer_facts_length,
  drop constraint if exists bew_applications_quality_attempts_check;

alter table public.bew_applications
  add constraint bew_applications_position_title_length
    check (position_title is null or char_length(position_title) between 1 and 160),
  add constraint bew_applications_position_brief_length
    check (position_brief is null or char_length(position_brief) between 1 and 4000),
  add constraint bew_applications_employer_facts_length
    check (employer_facts is null or char_length(employer_facts) between 1 and 4000),
  add constraint bew_applications_quality_attempts_check
    check (quality_attempts between 0 and 2);

-- Supports the stale-generation sweep (reclaim long-stuck 'generating' rows).
create index if not exists bew_applications_generating_started_idx
  on public.bew_applications (generation_started_at)
  where status = 'generating';
