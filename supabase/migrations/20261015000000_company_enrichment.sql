-- AI Search 2.0: per-company enrichment cache.
--
-- Stores the company-level enrichment result (official website, career /
-- Ausbildung pages, contact email/phone/person) WITH full provenance —
-- every fact carries the public page URL it was read from plus a
-- last_verified_at timestamp. Contact discovery is a company-level asset
-- (all vacancies of one company share one result), so it is cached per
-- company key, not per vacancy.
--
-- Posture matches opportunity_cache: service-role only (revoke from
-- anon/authenticated), RLS enabled with no public policies, and expired
-- rows are opportunistically pruned on every run (idempotent).
create table if not exists public.company_enrichment (
  id uuid primary key default gen_random_uuid(),
  company_key text not null unique,
  company_name text not null,
  data jsonb not null,
  fetched_at timestamptz not null default timezone('utc', now()),
  expires_at timestamptz not null
);

create index if not exists company_enrichment_expiry_idx
  on public.company_enrichment(expires_at);

alter table public.company_enrichment enable row level security;
revoke all on public.company_enrichment from anon, authenticated;

-- Opportunistic, idempotent cleanup of expired rows.
delete from public.company_enrichment
where expires_at < timezone('utc', now());
