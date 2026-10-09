-- Housing / "Wohnen" MVP — user-owned housing data + a provider-listing
-- snapshot cache for future licensed adapters.
--
-- Design follows the canonical pattern from
-- 20260927060000_opportunities.sql:
--   * every per-user table is keyed by user_id (FK to auth.users, cascade),
--     RLS-enabled, and guarded by a single `for all` policy that scopes reads
--     and writes to `auth.uid() = user_id`;
--   * server-owned caches are RLS-enabled with NO policy and access revoked
--     from anon/authenticated, so only the service_role client can touch them
--     (same shape as public.opportunity_cache).
--
-- The MVP ships ZERO live rental providers. All user-facing listings come
-- from labeled demo fixtures (data_status = 'demo') and link out to external
-- portals. The tables below are the forward-looking persistence surface that
-- a licensed adapter can fill in later without a schema change.

-- ---------------------------------------------------------------------------
-- 1. Listing snapshot cache (server-owned, future licensed adapters)
-- ---------------------------------------------------------------------------
-- Normalized listing rows keyed by provider identity. Dedupe is on
-- (provider, source_id). The `snapshot` column keeps the full normalized
-- payload so the app never has to re-fetch a provider to render a card.
create table if not exists public.housing_listings (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  source_id text not null,
  title text,
  listing_url text,
  city text,
  postal_code text,
  address text,
  latitude double precision,
  longitude double precision,
  rent_cold_eur numeric(10,2),
  additional_costs_eur numeric(10,2),
  rent_warm_eur numeric(10,2),
  deposit_eur numeric(10,2),
  rooms integer,
  living_area_sqm numeric(10,2),
  available_from date,
  furnished boolean,
  balcony boolean,
  pets_allowed boolean,
  wg_suitable boolean,
  verified boolean,
  accommodation_type text,
  snapshot jsonb not null default '{}'::jsonb,
  provider_updated_at timestamptz,
  last_checked_at timestamptz not null default timezone('utc', now()),
  source_terms_version text,
  data_status text not null default 'live' check (data_status in ('demo', 'live')),
  unique (provider, source_id)
);

create index if not exists housing_listings_identity_idx
  on public.housing_listings(provider, source_id);
create index if not exists housing_listings_city_idx
  on public.housing_listings(city);
create index if not exists housing_listings_warm_idx
  on public.housing_listings(rent_warm_eur);

-- Server-owned: no policy + revoked access (mirror of opportunity_cache).
alter table public.housing_listings enable row level security;
revoke all on public.housing_listings from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. Saved listings (per user)
-- ---------------------------------------------------------------------------
-- A saved listing stores a point-in-time `snapshot` (the normalized card data
-- the user saw) so the card stays correct even if the source listing changes
-- or disappears. Dedupe per user on provider identity.
create table if not exists public.housing_saved_listings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null,
  source_listing_id text not null,
  url text not null,
  snapshot jsonb not null default '{}'::jsonb,
  notes text,
  status text not null default 'saved'
    check (status in ('saved', 'applied', 'viewing', 'rejected', 'closed')),
  saved_at timestamptz not null default timezone('utc', now()),
  unique (user_id, provider, source_listing_id)
);

create index if not exists housing_saved_listings_user_idx
  on public.housing_saved_listings(user_id, saved_at desc);

alter table public.housing_saved_listings enable row level security;
create policy "Users can manage their own saved housing listings"
  on public.housing_saved_listings for all to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- 3. Saved searches (per user)
-- ---------------------------------------------------------------------------
-- A named search query (the normalized filter set) plus the last-run result
-- count, so "Meine Suchen" can show "last checked N results" without
-- re-running the search.
create table if not exists public.housing_saved_searches (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text,
  query jsonb not null default '{}'::jsonb,
  last_run_at timestamptz,
  last_count integer not null default 0,
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists housing_saved_searches_user_idx
  on public.housing_saved_searches(user_id, created_at desc);

alter table public.housing_saved_searches enable row level security;
create policy "Users can manage their own saved housing searches"
  on public.housing_saved_searches for all to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- 4. Applications (per user)
-- ---------------------------------------------------------------------------
-- Prepared landlord messages with a status lifecycle and an append-only
-- timeline. `listing_ref` is a small denormalized pointer to the listing the
-- application is about (provider + source id + title/url), not a FK, so an
-- application survives the source listing going away.
create table if not exists public.housing_applications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  listing_ref jsonb not null default '{}'::jsonb,
  title text,
  message_draft text,
  status text not null default 'draft'
    check (status in ('draft', 'prepared', 'contacted', 'viewing', 'accepted', 'declined')),
  timeline jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists housing_applications_user_idx
  on public.housing_applications(user_id, updated_at desc);

alter table public.housing_applications enable row level security;
create policy "Users can manage their own housing applications"
  on public.housing_applications for all to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
