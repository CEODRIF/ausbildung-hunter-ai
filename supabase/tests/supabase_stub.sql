-- ============================================================================
-- Minimal Supabase-compatible stub for running the migration chain against a
-- plain PostgreSQL instance (no Supabase project, no docker).
--
-- Supabase provides three things the migrations depend on; this file creates
-- the smallest faithful equivalent of each:
--   * the `auth` schema with `auth.users` (only the columns the auth triggers
--     read: id, email, raw_user_meta_data, email_confirmed_at);
--   * `auth.uid()` / `auth.role()` / `auth.email()` reading the same
--     `request.jwt.claim.*` GUCs PostgREST sets per request, so RLS policies
--     and the `protect_profile_system_fields` trigger behave exactly as in
--     production (`set role authenticated; select set_config(
--     'request.jwt.claim.sub', '<uuid>', false);` impersonates a user);
--   * the `anon` / `authenticated` / `service_role` roles the migrations grant
--     to and revoke from.
--
-- Idempotent: safe to run against an existing scratch database.
-- Used by supabase/tests/invitation_atomicity.sql — see its header for the
-- full run recipe.
-- ============================================================================

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
end
$$;

create schema if not exists auth;

create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text,
  raw_user_meta_data jsonb not null default '{}'::jsonb,
  email_confirmed_at timestamptz,
  created_at timestamptz not null default now()
);

create or replace function auth.uid() returns uuid
language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;

create or replace function auth.role() returns text
language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), 'anon')
$$;

create or replace function auth.email() returns text
language sql stable as $$
  select nullif(current_setting('request.jwt.claim.email', true), '')
$$;

grant usage on schema auth to anon, authenticated, service_role;

-- Faithful to the Supabase platform: every table a `postgres`-role user
-- creates in schema `public` is granted to all three API roles, and the
-- security contract then lives ENTIRELY in RLS (policies + per-table
-- revokes, e.g. on server-owned caches). Without these default privileges
-- the stub would fail queries that Supabase answers with "0 rows via RLS",
-- which masks a missing-policy regression.
alter default privileges for role postgres in schema public
  grant all on tables to postgres, anon, authenticated, service_role;
