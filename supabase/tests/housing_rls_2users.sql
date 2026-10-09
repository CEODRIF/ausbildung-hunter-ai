-- ============================================================================
-- REAL-DATABASE verification of the Housing RLS contract (2-user isolation).
--
-- This is not a mock: it proves that the policies shipped in
-- supabase/migrations/20261106000000_housing_mvp.sql actually isolate two
-- users against a real PostgreSQL engine, and that the server-owned
-- housing_listings cache is unreachable from both anon and authenticated.
--
-- TARGET: a scratch/staging database or a NON-PRODUCTION Supabase project.
-- Do NOT point it at production. The script creates two throwaway auth.users
-- rows and one row per user in each per-user housing table (fixed test UUIDs
-- b001/b002) and deletes ALL of them at the end, so it is repeatable.
--
-- HOW TO RUN (option A — plain PostgreSQL, no Supabase project, no docker):
--   1. Create a scratch DB and apply the Supabase stub + the housing
--      migration (gen_random_uuid() requires PostgreSQL 13+, or pgcrypto):
--        initdb -D /tmp/pg && pg_ctl -D /tmp/pg start
--        createdb housingrls
--        psql -d housingrls -v ON_ERROR_STOP=1 -f supabase/tests/supabase_stub.sql
--        psql -d housingrls -v ON_ERROR_STOP=1 -f supabase/migrations/20261106000000_housing_mvp.sql
--   2. psql -d housingrls -f supabase/tests/housing_rls_2users.sql
--
-- HOW TO RUN (option B — non-production Supabase project):
--   Paste the body (everything after the \echo '### 1.' marker, without the
--   \echo/\pset psql meta-commands) into the project's SQL editor, or run it
--   via psql against the project's connection string (as a table owner /
--   postgres role). The `auth` schema and roles already exist there.
--
-- HOW TO READ THE OUTPUT: statements marked "EXPECTED ERROR" must fail —
-- they are the database REFUSING a cross-user or unauthenticated access.
-- The final VERDICT block prints one row per check with pass/fail.
-- A run in which any EXPECTED ERROR succeeds (or any VERDICT row is 'FAIL')
-- is a failed verification: stop and re-audit the migration.
-- ============================================================================

\pset pager off
\set ON_ERROR_STOP off

-- Test identities (hex-only, v4-shaped, obviously synthetic).
-- \gset does not work portably for this, so the UUIDs are repeated literally.
-- USER A = 00000000-0000-4000-8000-00000000b001
-- USER B = 00000000-0000-4000-8000-00000000b002

\echo '### 0. setup — reset throwaway rows from a previous run (safe re-run)'
-- NOTE (used at every boundary below): `RESET ALL` does NOT clear the role
-- GUC — after `SET ROLE x`, the current user is x and `role` is superuser-
-- only, so RESET ALL silently skips it. `RESET ROLE` therefore always follows
-- `RESET ALL` to return to the session user (postgres).
set role service_role;
delete from public.housing_applications    where user_id in ('00000000-0000-4000-8000-00000000b001','00000000-0000-4000-8000-00000000b002');
delete from public.housing_saved_searches  where user_id in ('00000000-0000-4000-8000-00000000b001','00000000-0000-4000-8000-00000000b002');
delete from public.housing_saved_listings  where user_id in ('00000000-0000-4000-8000-00000000b001','00000000-0000-4000-8000-00000000b002');
reset all;
reset role;

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-00000000b001', 'housing.verify.a@example.com'),
  ('00000000-0000-4000-8000-00000000b002', 'housing.verify.b@example.com');
select count(*) as two_test_users_exist
from auth.users
where id in ('00000000-0000-4000-8000-00000000b001','00000000-0000-4000-8000-00000000b002');

\echo ''
\echo '### 1. each user saves one row per table (impersonation = set role + jwt claim)'
-- ---- as USER A ----
set role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000b001', false);
select set_config('request.jwt.claim.role', 'authenticated', false);
insert into public.housing_saved_listings (user_id, provider, source_listing_id, url, snapshot)
values ('00000000-0000-4000-8000-00000000b001', 'demo', 'a-saved', 'https://example.com/a', '{}'::jsonb);
insert into public.housing_saved_searches (user_id, name, query)
values ('00000000-0000-4000-8000-00000000b001', 'search-a', '{"city":"Köln"}'::jsonb);
insert into public.housing_applications (user_id, title)
values ('00000000-0000-4000-8000-00000000b001', 'application-a');
-- ---- as USER B ----
reset all;
reset role;
set role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000b002', false);
select set_config('request.jwt.claim.role', 'authenticated', false);
insert into public.housing_saved_listings (user_id, provider, source_listing_id, url, snapshot)
values ('00000000-0000-4000-8000-00000000b002', 'demo', 'b-saved', 'https://example.com/b', '{}'::jsonb);
insert into public.housing_saved_searches (user_id, name, query)
values ('00000000-0000-4000-8000-00000000b002', 'search-b', '{"city":"Berlin"}'::jsonb);
insert into public.housing_applications (user_id, title)
values ('00000000-0000-4000-8000-00000000b002', 'application-b');
-- ground truth (superuser)
reset all;
reset role;
select (select count(*) from public.housing_saved_listings  where user_id in ('00000000-0000-4000-8000-00000000b001','00000000-0000-4000-8000-00000000b002')) as saved_listings_total,
       (select count(*) from public.housing_saved_searches  where user_id in ('00000000-0000-4000-8000-00000000b001','00000000-0000-4000-8000-00000000b002')) as saved_searches_total,
       (select count(*) from public.housing_applications    where user_id in ('00000000-0000-4000-8000-00000000b001','00000000-0000-4000-8000-00000000b002')) as applications_total;

\echo ''
\echo '### 2. USER B must NOT see USER A''s rows (RLS `using` clause)'
set role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000b002', false);
select set_config('request.jwt.claim.role', 'authenticated', false);
select (select count(*) from public.housing_saved_listings where user_id = '00000000-0000-4000-8000-00000000b001') as b_sees_a_listings,   -- expect 0
       (select count(*) from public.housing_saved_listings where user_id = '00000000-0000-4000-8000-00000000b002') as b_sees_own_listings; -- expect 1
select (select count(*) from public.housing_saved_searches where user_id = '00000000-0000-4000-8000-00000000b001') as b_sees_a_searches,   -- expect 0
       (select count(*) from public.housing_applications    where user_id = '00000000-0000-4000-8000-00000000b001') as b_sees_a_applications; -- expect 0

\echo ''
\echo '### 3. USER B must NOT write to USER A''s rows (RLS `with check` clause)'
-- 3a. INSERT a row claiming A's user_id → EXPECTED ERROR: new row violates row-level security policy
insert into public.housing_saved_listings (user_id, provider, source_listing_id, url, snapshot)
values ('00000000-0000-4000-8000-00000000b001', 'demo', 'b-injects-into-a', 'https://example.com/x', '{}'::jsonb);
select (select count(*) from public.housing_saved_listings where source_listing_id = 'b-injects-into-a') as injection_survived; -- expect 0

-- 3b. UPDATE / DELETE A's row as B → EXPECTED 0 rows affected (silent isolation)
update public.housing_saved_listings set notes = 'stolen by B' where user_id = '00000000-0000-4000-8000-00000000b001';
delete from public.housing_saved_listings where user_id = '00000000-0000-4000-8000-00000000b001';
update public.housing_saved_searches   set name = 'stolen by B' where user_id = '00000000-0000-4000-8000-00000000b001';
update public.housing_applications     set title = 'stolen by B' where user_id = '00000000-0000-4000-8000-00000000b001';

\echo ''
\echo '### 4. USER A is still intact after B''s attack attempts'
reset all;
reset role;
set role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000b001', false);
select set_config('request.jwt.claim.role', 'authenticated', false);
select (select count(*) from public.housing_saved_listings where user_id = '00000000-0000-4000-8000-00000000b001') as a_still_has_listing, -- expect 1
       (select notes      from public.housing_saved_listings where user_id = '00000000-0000-4000-8000-00000000b001') as a_notes_tampered,  -- expect NULL
       (select name       from public.housing_saved_searches where user_id = '00000000-0000-4000-8000-00000000b001') as a_search_name,     -- expect 'search-a'
       (select title      from public.housing_applications   where user_id = '00000000-0000-4000-8000-00000000b001') as a_app_title;       -- expect 'application-a'

\echo ''
\echo '### 5. an authenticated session WITHOUT a valid sub claim sees nothing'
reset all;
reset role;
set role authenticated; -- no request.jwt.claim.sub set
select (select count(*) from public.housing_saved_listings) as no_claim_sees_listings, -- expect 0
       (select count(*) from public.housing_saved_searches) as no_claim_sees_searches,  -- expect 0
       (select count(*) from public.housing_applications)   as no_claim_sees_apps;      -- expect 0

\echo ''
\echo '### 6. anon sees ZERO rows (platform grants exist, but no anon RLS policy)'
reset all;
reset role;
set role anon;
select count(*) as anon_sees_listings   from public.housing_saved_listings; -- expect 0
select count(*) as anon_sees_searches   from public.housing_saved_searches; -- expect 0
select count(*) as anon_sees_applications from public.housing_applications; -- expect 0

\echo ''
\echo '### 7. housing_listings (server-owned cache) is unreachable for anon AND authenticated'
-- Even though RLS would return 0 rows, the contract is DENY, not empty:
reset all;
reset role;
set role anon;
select count(*) from public.housing_listings;        -- EXPECTED ERROR: permission denied for table
reset all;
reset role;
set role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000b001', false);
select count(*) from public.housing_listings;        -- EXPECTED ERROR: permission denied for table
insert into public.housing_listings (provider, source_id, snapshot)
values ('demo', 'anon-insert-attempt', '{}'::jsonb); -- EXPECTED ERROR: permission denied for table
\echo '    (grants table, for the record — anon/authenticated must be empty on housing_listings):'
\dp public.housing_listings

\echo ''
\echo '### 8. service_role (bypassrls) sees everything — the app''s admin path'
reset all;
reset role;
set role service_role;
select (select count(*) from public.housing_saved_listings where user_id in ('00000000-0000-4000-8000-00000000b001','00000000-0000-4000-8000-00000000b002')) as service_sees_both_listings,  -- expect 2
       (select count(*) from public.housing_saved_searches where user_id in ('00000000-0000-4000-8000-00000000b001','00000000-0000-4000-8000-00000000b002')) as service_sees_both_searches;   -- expect 2

\echo ''
\echo '### 9. VERDICT — every row must say PASS'
reset all;
reset role;
with truth as (
  select
    (select count(*) from public.housing_saved_listings  where user_id = '00000000-0000-4000-8000-00000000b001') as a_listing,
    (select count(*) from public.housing_saved_listings  where user_id = '00000000-0000-4000-8000-00000000b002') as b_listing,
    (select count(*) from public.housing_saved_listings  where source_listing_id = 'b-injects-into-a')         as injection,
    (select count(*) from public.housing_saved_searches  where user_id = '00000000-0000-4000-8000-00000000b001' and name = 'search-a')    as a_search_intact,
    (select count(*) from public.housing_applications    where user_id = '00000000-0000-4000-8000-00000000b001' and title = 'application-a') as a_app_intact
)
select
  case when a_listing = 1  then 'PASS' else 'FAIL' end as a_kept_listing,
  case when b_listing = 1  then 'PASS' else 'FAIL' end as b_kept_listing,
  case when injection = 0  then 'PASS' else 'FAIL' end as cross_user_insert_blocked,
  case when a_search_intact = 1 then 'PASS' else 'FAIL' end as a_search_not_tampered,
  case when a_app_intact = 1    then 'PASS' else 'FAIL' end as a_application_not_tampered
from truth;
\echo 'Plus the EXPECTED ERROR statements from sections 3a (RLS with-check) and'
\echo '7 (explicit revokes on the server-owned cache): if any of them printed a'
\echo 'result set instead of an error, the verification FAILED. Sections 5 and'
\echo '6 must print ZERO rows: the platform grants exist, but without a matching'
\echo 'RLS policy (or a valid sub claim) the database returns nothing.'

\echo ''
\echo '### 10. cleanup — delete all throwaway rows created by this script'
set role service_role;
delete from public.housing_applications    where user_id in ('00000000-0000-4000-8000-00000000b001','00000000-0000-4000-8000-00000000b002');
delete from public.housing_saved_searches  where user_id in ('00000000-0000-4000-8000-00000000b001','00000000-0000-4000-8000-00000000b002');
delete from public.housing_saved_listings  where user_id in ('00000000-0000-4000-8000-00000000b001','00000000-0000-4000-8000-00000000b002');
reset all;
reset role;
delete from auth.users
where id in ('00000000-0000-4000-8000-00000000b001','00000000-0000-4000-8000-00000000b002');
select count(*) as leftover_test_rows
from public.housing_saved_listings
where user_id in ('00000000-0000-4000-8000-00000000b001','00000000-0000-4000-8000-00000000b002'); -- expect 0
