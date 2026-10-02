-- Phase 17b: public-email storage + campaign provenance for Company Discovery.
--
-- `20261017000000_company_discovery.sql` ships the run model and already
-- defines `public.discovery_company_emails`. This file does NOT redefine that
-- design — it (a) guarantees the table exists in the shape the code writes
-- even when the earlier file was only PARTIALLY applied (the production
-- observation: runs/candidates/companies present, emails table missing),
-- (b) adds the `updated_at` column the code maintains, and (c) links the
-- email composer and campaigns to the discovery run they were built from.
--
-- Every statement is idempotent and additive: safe to run repeatedly, on a
-- fresh database and on a partially migrated one.

-- ---------------------------------------------------------------------------
-- Public emails (same design as 20261017000000, plus updated_at)
-- ---------------------------------------------------------------------------

create table if not exists public.discovery_company_emails (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.discovery_companies(id) on delete cascade,
  -- The address exactly as published (never derived from the name).
  email text not null check (char_length(email) between 3 and 254),
  -- The public page the address was read from (provenance).
  email_source_url text check (email_source_url is null or char_length(email_source_url) <= 500),
  -- offer / search_result / company_website / impressum / kontakt / karriere
  -- / ausbildung / bewerbungen.
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

-- Added by this migration: the row is only ever upserted, never rewritten
-- blindly — the timestamp tells an operator when a re-check touched it.
alter table public.discovery_company_emails
  add column if not exists updated_at timestamptz not null default timezone('utc', now());

create index if not exists discovery_company_emails_company_idx
  on public.discovery_company_emails(company_id);

create index if not exists discovery_company_emails_source_idx
  on public.discovery_company_emails(email_source_type);

alter table public.discovery_company_emails enable row level security;

-- Server-only feature: the admin client does the writing, no browser role
-- may read addresses of another tenant.
revoke all on public.discovery_company_emails from anon, authenticated;

drop trigger if exists discovery_company_emails_set_updated_at
  on public.discovery_company_emails;
create trigger discovery_company_emails_set_updated_at
  before update on public.discovery_company_emails
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Provenance: which discovery run a draft / campaign was built from
-- ---------------------------------------------------------------------------

alter table public.application_drafts
  add column if not exists discovery_run_id uuid
    references public.discovery_runs(run_id) on delete set null;

alter table public.email_campaigns
  add column if not exists discovery_run_id uuid
    references public.discovery_runs(run_id) on delete set null;

create index if not exists application_drafts_discovery_run_idx
  on public.application_drafts(discovery_run_id);

create index if not exists email_campaigns_discovery_run_idx
  on public.email_campaigns(discovery_run_id);
