-- Phase 17c: multi-source email provenance + the three-outcome model.
--
-- WHY THIS MIGRATION EXISTS (and why nothing smaller is enough):
--   * §4.5 requires the FULL source-type vocabulary (`job_listing`,
--     `official_site_*`, `trusted_public_page`, …) and requires that the same
--     address found on several pages is stored ONCE with ALL source URLs
--     preserved. `discovery_company_emails` has one `email_source_url` and a
--     `unique (company_id, email)` key, so a second page cannot be recorded
--     anywhere. The additive `discovery_company_email_sources` table fixes
--     exactly that.
--   * §4.5 also requires `verification_status`, `verification_method`,
--     `domain_match`, `evidence_snippet` and `discovered_at` per address.
--   * §4.4 needs `source_blocked` stored distinctly from `no_public_email`
--     (they must never be merged); `discovery_companies.email_status` carries
--     the outcome literal next to the existing `status`/`reject_reason` audit
--     pair.
--   * §4.8 adds the counters `emails_found`, `no_public_email`,
--     `sources_blocked` and `companies_processed` so the invariant
--     `emails_found + no_public_email + sources_blocked = companies_processed`
--     is checkable on the stored run, not only in memory.
--
-- Everything here is ADDITIVE and IDEMPOTENT: nullable columns, a new table,
-- and one WIDENED check constraint (a superset of the previous vocabulary, so
-- every existing row stays valid). No column is dropped, renamed or rewritten,
-- no existing migration is edited, and the file is safe to run repeatedly, on
-- a fresh database and on a partially migrated one.
--
-- Rollback: `drop table public.discovery_company_email_sources;` plus
-- `alter table … drop column …` for the five added columns (and the counter
-- columns). Existing data is untouched by the rollback.
--
-- Posture matches 20261017000000 / 20261018000000: service-role only (RLS
-- enabled, no public policies, revoked from anon/authenticated).

-- ---------------------------------------------------------------------------
-- Public emails: the full source vocabulary
-- ---------------------------------------------------------------------------

alter table public.discovery_company_emails
  add column if not exists verification_status text,
  add column if not exists verification_method text,
  add column if not exists domain_match boolean,
  add column if not exists evidence_snippet text,
  add column if not exists discovered_at timestamptz not null
    default timezone('utc', now());

-- Widening the vocabulary: the new values are a SUPERSET, so no existing row
-- can violate the constraint. `drop … if exists` makes this re-runnable.
alter table public.discovery_company_emails
  drop constraint if exists discovery_company_emails_email_source_type_check;

alter table public.discovery_company_emails
  add constraint discovery_company_emails_email_source_type_check
  check (email_source_type in (
    -- §4.5 vocabulary
    'job_listing',
    'official_site_impressum',
    'official_site_contact',
    'official_site_career',
    'official_site_jobs',
    'official_site_ausbildung',
    'official_site_contact_person',
    'official_site_other',
    'search_result',
    'trusted_public_page',
    -- values shipped by the first release (kept: existing rows, legacy reads)
    'offer',
    'company_website',
    'impressum',
    'kontakt',
    'karriere',
    'ausbildung',
    'bewerbungen'
  ));

-- ---------------------------------------------------------------------------
-- Every page an address was literally found on (one row per page)
-- ---------------------------------------------------------------------------

create table if not exists public.discovery_company_email_sources (
  id uuid primary key default gen_random_uuid(),
  email_id uuid not null references public.discovery_company_emails(id) on delete cascade,
  -- The exact public page the address appears on.
  source_url text not null check (char_length(source_url) between 4 and 500),
  -- The source type as it was on THAT page (a listing vs. an Impressum page).
  source_type text not null,
  discovered_at timestamptz not null default timezone('utc', now()),
  -- The same page is never recorded twice for one address.
  unique (email_id, source_url)
);

create index if not exists discovery_company_email_sources_email_idx
  on public.discovery_company_email_sources(email_id);

alter table public.discovery_company_email_sources enable row level security;
revoke all on public.discovery_company_email_sources from anon, authenticated;

-- ---------------------------------------------------------------------------
-- The company-level outcome (three literals, never merged)
-- ---------------------------------------------------------------------------

alter table public.discovery_companies
  add column if not exists email_status text;

alter table public.discovery_companies
  drop constraint if exists discovery_companies_email_status_check;

alter table public.discovery_companies
  add constraint discovery_companies_email_status_check
  check (email_status is null
    or email_status in ('email_found', 'no_public_email', 'source_blocked'));

-- ---------------------------------------------------------------------------
-- The outcome counters of a run (§4.8)
-- ---------------------------------------------------------------------------

alter table public.discovery_runs
  add column if not exists emails_found integer not null default 0
    check (emails_found >= 0),
  add column if not exists no_public_email integer not null default 0
    check (no_public_email >= 0),
  add column if not exists sources_blocked integer not null default 0
    check (sources_blocked >= 0),
  add column if not exists companies_processed integer not null default 0
    check (companies_processed >= 0);
