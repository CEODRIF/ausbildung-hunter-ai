-- ============================================================================
-- REAL-DATABASE verification of the invitation-code contract.
--
-- This is not a unit test and not a mock: it is a runnable script that proves
-- the trigger behaviour against an actual PostgreSQL instance. The unit suite
-- (tests/auth-invitation-atomicity.test.ts) only pins the SQL *text*; this
-- script pins the SQL *behaviour* — rollback, counter movement and the
-- single-use guarantee included.
--
-- TARGET: a scratch/staging database. Blocks 1-6 create and then delete their
-- own throwaway rows (isolated VERIFY* codes + fixed test UUIDs), so the
-- script is repeatable and never touches a real invitation code's counters.
-- Do NOT point it at production.
--
-- HOW TO RUN (no Supabase project, no docker):
--   1. create a scratch database and apply the auth migration chain:
--        initdb -D /tmp/pg && pg_ctl -D /tmp/pg start
--        createdb authflow
--        psql -d authflow -v ON_ERROR_STOP=1 -f supabase/tests/supabase_stub.sql
--        for m in 20250512000000_auth_foundation \
--                 20261005000000_email_confirmation_activation \
--                 20261006000000_harden_confirmation_trigger \
--                 20261007000000_restore_profile_creation_trigger \
--                 20261008000000_restore_profiles_access \
--                 20261021000000_invitation_code_atomicity \
--                 20261022000000_seed_invitation_code_drif26; do
--          psql -d authflow -v ON_ERROR_STOP=1 -f supabase/migrations/$m.sql
--        done
--   2. psql -d authflow -f supabase/tests/invitation_atomicity.sql
--
-- HOW TO READ THE OUTPUT: every "ERROR: invitation_code_*" line below is the
-- EXPECTED, DESIRED result — it is the database refusing a sign-up and rolling
-- it back. A run in which those statements SUCCEED is a failed verification.
-- ============================================================================

\pset pager off
\set ON_ERROR_STOP off

\echo '### setup - reset this script own throwaway rows (safe re-run)'
delete from auth.users where id in (
  '00000000-0000-4000-8000-00000000a001',
  '00000000-0000-4000-8000-00000000a002',
  '00000000-0000-4000-8000-00000000a003',
  '00000000-0000-4000-8000-00000000a004',
  '00000000-0000-4000-8000-00000000a005');
delete from public.invitation_codes where code in ('VERIFYONCE', 'VERIFYNAME');

\echo ''
\echo '### 0. the seeded registration codes exist and are valid'
select code, type, is_active, max_uses, used_count
from public.invitation_codes where code in ('DRIF26', 'DRIF928') order by code;
select public.validate_invitation_code('DRIF26', 'registration') as drif26_is_valid;

\echo ''
\echo '### 1. one-use code: the first sign-up wins, and the code is charged AT SIGN-UP'
insert into public.invitation_codes (code, type, is_active, max_uses, daily_email_limit)
values ('VERIFYONCE', 'registration', true, 1, 50);
insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-4000-8000-00000000a001', 'verify.a@example.com',
   '{"full_name":"Verify A","invitation_code":"VERIFYONCE"}'::jsonb);
select (select count(*) from public.profiles where email = 'verify.a@example.com') as accounts,
       (select used_count from public.invitation_codes where code = 'VERIFYONCE') as code_uses;

\echo ''
\echo '### 2. the SAME code again -> rejected, and NOTHING is left behind (rollback)'
insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-4000-8000-00000000a002', 'verify.b@example.com',
   '{"full_name":"Verify B","invitation_code":"VERIFYONCE"}'::jsonb);
select (select count(*) from auth.users where email = 'verify.b@example.com') as auth_user_leaked,
       (select count(*) from public.profiles where email = 'verify.b@example.com') as profile_leaked;

\echo ''
\echo '### 3. no invitation code at all -> rejected (closes the public-anon-key bypass)'
insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-4000-8000-00000000a003', 'verify.c@example.com',
   '{"full_name":"Verify C"}'::jsonb);
select count(*) as leaked from auth.users where email = 'verify.c@example.com';

\echo ''
\echo '### 4. unknown code -> rejected'
insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-4000-8000-00000000a004', 'verify.d@example.com',
   '{"full_name":"Verify D","invitation_code":"VERIFYNOPE"}'::jsonb);
select count(*) as leaked from auth.users where email = 'verify.d@example.com';

\echo ''
\echo '### 5. sign-up WITHOUT full_name still gets a valid profile (no CHECK crash)'
insert into public.invitation_codes (code, type, is_active, max_uses, daily_email_limit)
values ('VERIFYNAME', 'registration', true, 1, 50);
insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-4000-8000-00000000a005', 'verify.empty@example.com',
   '{"invitation_code":"VERIFYNAME"}'::jsonb);
select full_name, account_status from public.profiles where email = 'verify.empty@example.com';

\echo ''
\echo '### 6. confirmation activates the profile WITHOUT charging the code twice'
update auth.users set email_confirmed_at = now()
where email in ('verify.a@example.com', 'verify.empty@example.com');
select code, used_count, max_uses from public.invitation_codes
where code in ('VERIFYONCE', 'VERIFYNAME') order by code;
select u.email, p.account_status from auth.users u join public.profiles p on p.id = u.id
where u.email in ('verify.a@example.com', 'verify.empty@example.com') order by u.email;

\echo ''
\echo '### 7. no orphans in either direction (over the whole database)'
select (select count(*) from public.profiles p left join auth.users u on u.id = p.id where u.id is null) as orphan_profiles,
       (select count(*) from auth.users u left join public.profiles p on p.id = u.id where p.id is null) as orphan_auth_users;

\echo ''
\echo '### teardown - remove this script own rows again'
delete from auth.users where id in (
  '00000000-0000-4000-8000-00000000a001',
  '00000000-0000-4000-8000-00000000a005');
delete from public.invitation_codes where code in ('VERIFYONCE', 'VERIFYNAME');
select count(*) as leftover_verify_codes from public.invitation_codes where code like 'VERIFY%';
