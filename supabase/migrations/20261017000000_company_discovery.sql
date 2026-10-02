-- Phase 17: Company & Email Discovery — run model.
--
-- Collects UNIQUE German companies (1 company = 1 result) with a publicly
-- published contact email for the user's field/role. The target count is a
-- number of COMPANIES, never a number of offers.
--
-- Relations:
--   discovery_runs        1 ──< discovery_candidates   (raw offers, pre-dedupe)
--   discovery_runs        1 ──< discovery_companies    (unique companies;
--                                                       1 row = 1 company)
--   discovery_companies   1 ──< discovery_company_emails (published addresses
--                                                       + provenance)
--
-- Company data is stored ONCE per run (discovery_companies) and referenced
-- by candidates — never duplicated per offer.
--
-- Posture matches company_enrichment / opportunity_cache: service-role only
-- (revoke from anon/authenticated, RLS enabled with no public policies).
-- All reads/writes go through the API routes with the admin client.
--
-- The per-company enrichment cache (public.company_enrichment, TTL
-- 30 d positive / 24 h negative) is REUSED as the cross-run company cache —
-- discovery never re-resolves a company that the shared cache covers.

-- ---------------------------------------------------------------------------
-- Runs
-- ---------------------------------------------------------------------------

create table if not exists public.discovery_runs (
  run_id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  -- Validated DiscoveryRunParams (field, role, beginn, goal, target, onlyPublicEmail).
  params jsonb not null,
  status text not null default 'pending'
    check (status in ('pending', 'running', 'completed', 'partial', 'cancelled', 'failed')),
  -- The requested target: UNIQUE companies with a public email (not offers).
  target_companies integer not null check (target_companies between 1 and 1000),
  -- Honest, real counters (updated by the orchestration; never faked).
  found_companies integer not null default 0 check (found_companies >= 0),
  offers_analyzed integer not null default 0 check (offers_analyzed >= 0),
  unique_companies integer not null default 0 check (unique_companies >= 0),
  duplicates_removed integer not null default 0 check (duplicates_removed >= 0),
  companies_rejected integer not null default 0 check (companies_rejected >= 0),
  -- Per-source live status: [{ "id", "status", "candidates"? }].
  sources jsonb not null default '[]'::jsonb,
  -- Credits charged for this run (wired to charge_search_credits later;
  -- recorded here so the ledger and the run stay auditable together).
  credits_charged integer not null default 0 check (credits_charged >= 0),
  -- Controlled, user-safe error message (never stack traces / secrets).
  error text,
  created_at timestamptz not null default timezone('utc', now()),
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists discovery_runs_user_created_idx
  on public.discovery_runs(user_id, created_at desc);
create index if not exists discovery_runs_status_idx
  on public.discovery_runs(status)
  where status in ('pending', 'running');

drop trigger if exists discovery_runs_set_updated_at on public.discovery_runs;
create trigger discovery_runs_set_updated_at
  before update on public.discovery_runs
  for each row execute function public.set_updated_at();

alter table public.discovery_runs enable row level security;
revoke all on public.discovery_runs from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Candidate offers (raw, pre-dedupe; compact facts, not full offer payloads)
-- ---------------------------------------------------------------------------

create table if not exists public.discovery_candidates (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.discovery_runs(run_id) on delete cascade,
  -- Stable offer identity (provider:external_id or a content hash).
  candidate_ref text not null check (char_length(candidate_ref) between 3 and 200),
  source text not null check (char_length(source) between 1 and 60),
  title text check (title is null or char_length(title) <= 400),
  -- Source-documented company name — null when the source names none.
  company_name text check (company_name is null or char_length(company_name) <= 200),
  city text check (city is null or char_length(city) <= 160),
  goal text not null check (goal in ('ausbildung', 'arbeit')),
  beginn text check (beginn is null or beginn ~ '^\d{4}-\d{2}-\d{2}$'),
  salary_label text check (salary_label is null or char_length(salary_label) <= 160),
  url text check (url is null or char_length(url) <= 500),
  discovered_at timestamptz not null default timezone('utc', now()),
  -- One candidate row per (run, offer identity) — retries never duplicate.
  unique (run_id, candidate_ref)
);

create index if not exists discovery_candidates_run_idx
  on public.discovery_candidates(run_id);

alter table public.discovery_candidates enable row level security;
revoke all on public.discovery_candidates from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Unique companies (THE result set: 1 row = 1 company)
-- ---------------------------------------------------------------------------

create table if not exists public.discovery_companies (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.discovery_runs(run_id) on delete cascade,
  -- Normalized identity key (shared normalizeIdentity) — unique per run,
  -- which is what makes "1 company = 1 result" structurally true.
  company_key text not null check (char_length(company_key) between 1 and 160),
  company_name text not null check (char_length(company_name) between 1 and 200),
  -- The company's OWN official website (portal/directory/social excluded by
  -- the existing domain guard), or null when not identified.
  website_url text check (website_url is null or char_length(website_url) <= 500),
  website_source_url text check (website_source_url is null or char_length(website_source_url) <= 500),
  role text check (role is null or char_length(role) <= 160),
  field text not null check (char_length(field) between 1 and 120),
  offer_type text not null check (offer_type in ('ausbildung', 'arbeit')),
  city text check (city is null or char_length(city) <= 160),
  state text check (state is null or char_length(state) <= 160),
  beginn text check (beginn is null or beginn ~ '^\d{4}-\d{2}-\d{2}$'),
  salary_label text check (salary_label is null or char_length(salary_label) <= 160),
  offer_source text check (offer_source is null or char_length(offer_source) <= 160),
  offer_url text check (offer_url is null or char_length(offer_url) <= 500),
  -- accepted = counted towards the target; rejected = failed the quality
  -- gate (reject_reason records WHY — auditability without inventing data).
  status text not null default 'accepted' check (status in ('accepted', 'rejected')),
  reject_reason text,
  discovered_at timestamptz not null default timezone('utc', now()),
  unique (run_id, company_key)
);

create index if not exists discovery_companies_run_idx
  on public.discovery_companies(run_id);

alter table public.discovery_companies enable row level security;
revoke all on public.discovery_companies from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Public emails (with mandatory provenance)
-- ---------------------------------------------------------------------------

create table if not exists public.discovery_company_emails (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.discovery_companies(id) on delete cascade,
  -- The address exactly as published (never derived from the name).
  email text not null check (char_length(email) between 3 and 254),
  -- The public page the address was read from (required for counted rows).
  email_source_url text check (email_source_url is null or char_length(email_source_url) <= 500),
  -- Where it was found: offer / search_result / company_website / impressum
  -- / kontakt / karriere / ausbildung / bewerbungen.
  email_source_type text not null
    check (email_source_type in (
      'offer', 'search_result', 'company_website',
      'impressum', 'kontakt', 'karriere', 'ausbildung', 'bewerbungen'
    )),
  confidence text check (confidence is null or confidence in ('high', 'medium', 'low')),
  created_at timestamptz not null default timezone('utc', now()),
  -- The same published address is never stored twice for one company.
  unique (company_id, email)
);

create index if not exists discovery_company_emails_company_idx
  on public.discovery_company_emails(company_id);

alter table public.discovery_company_emails enable row level security;
revoke all on public.discovery_company_emails from anon, authenticated;
