create table public.opportunity_cache (
  id uuid primary key default gen_random_uuid(),
  cache_key text not null unique,
  provider text not null,
  normalized_query jsonb not null,
  results jsonb not null default '[]'::jsonb,
  result_count integer not null default 0,
  retrieved_at timestamptz not null default timezone('utc', now()),
  expires_at timestamptz not null
);

create index opportunity_cache_expiry_idx on public.opportunity_cache(expires_at);
create index opportunity_cache_provider_idx on public.opportunity_cache(provider);

create table public.saved_opportunities (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  opportunity_key text not null,
  provider text not null,
  source_url text not null,
  title text not null,
  company_name text,
  location text,
  goal text not null check (goal in ('ausbildung', 'arbeit')),
  saved_at timestamptz not null default timezone('utc', now()),
  notes text,
  unique (user_id, opportunity_key)
);

create index saved_opportunities_user_idx on public.saved_opportunities(user_id, saved_at desc);

alter table public.opportunity_cache enable row level security;
alter table public.saved_opportunities enable row level security;

revoke all on public.opportunity_cache from anon, authenticated;

create policy "Users can manage their own saved opportunities"
on public.saved_opportunities for all to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);
