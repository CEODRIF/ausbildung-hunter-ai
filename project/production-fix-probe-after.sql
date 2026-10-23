-- ============================================================================
-- Production POST-MIGRATION probe — READ-ONLY (pure SELECT statements only;
-- no DDL, no DML).
-- Run this file ONLY AFTER 20261120 → 20261121 → 20261122 have been applied
-- successfully. The P-section below invokes the new functions, so running
-- this file pre-migration fails with 42883 by design — that failure is
-- expected and changes nothing (see production-fix-probe-before.sql for the
-- pre-migration state capture).
--
-- Note: a manual SQL-editor apply does NOT register versions in
-- supabase_migrations.schema_migrations, so this probe deliberately does not
-- check the ledger.
-- ============================================================================

-- A1) Function inventory — ALL 23 names must now appear (a missing name means
--     the migration that creates it did not run or did not finish).
--     The 12 genuinely new ones must be present:
--       subscription_period_end, activate_trial (20261120);
--       feature_quota_kind, plan_feature_limit, reserve_feature_op,
--       complete_feature_op, release_feature_op, expire_stale_feature_runs,
--       feature_quota_status, release_ai_request (20261121);
--       create_mock_checkout, complete_mock_checkout (20261122).
--     The deckblatt family must still be present (3 re-created in place by
--     20261121, complete_deckblatt_generation deliberately untouched).
select p.proname as function_name,
       p.oid,
       (select count(*) from pg_proc q join pg_namespace nq on nq.oid = q.pronamespace
         where nq.nspname = 'public' and p.proname = q.proname)::int as overloads
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.proname in (
     'subscription_period_end', 'activate_trial',
     'feature_quota_kind', 'plan_feature_limit',
     'reserve_feature_op', 'complete_feature_op', 'release_feature_op',
     'expire_stale_feature_runs', 'feature_quota_status',
     'release_ai_request',
     'get_deckblatt_usage_status',
     'reserve_deckblatt_generation', 'release_deckblatt_generation',
     'complete_deckblatt_generation',
     'create_mock_checkout', 'complete_mock_checkout',
     'enforce_saved_application_capacity', 'check_saved_application_capacity',
     'feature_capacity_status', 'activate_quota_upgrade',
     'reserve_email_capacity', 'reserve_email_capacity_on',
     'set_updated_at'
   )
 order by p.proname;

-- A2) Table inventory — ALL 12 names must now appear (pre-fix the 4 new
--     ledger/checkout tables were absent).
select c.relname as table_name
  from pg_class c
  join pg_namespace n on n.oid = c.oid
 where n.nspname = 'public'
   and c.relname in (
     'feature_usage', 'feature_usage_runs',
     'subscription_events', 'mock_checkouts',
     'billing_plans', 'subscriptions', 'daily_usage',
     'ai_deckblatt_usage', 'ai_deckblatt_runs', 'bew_applications',
     'user_capacity_locks', 'saved_opportunities', 'application_drafts'
   )
 order by 1;

-- A3) Constraints — the 4 names are re-added with WIDENED definitions under
--     the SAME names. Expected texts (from 20261120 L76-77 / L106-107 /
--     L110-111 and 20261121 L629-630):
--       billing_plans_plan_id_check:
--         plan_id in ('free','plus','pro','trial','premium_10d','premium_monthly')
--       subscriptions_plan_check:
--         plan in ('free','plus','pro','trial','premium_10d','premium_monthly')
--       subscriptions_provider_check:  provider in ('manual','mock')
--       ai_deckblatt_usage_generations_used_check:
--         generations_used >= 0 and generations_used <= 60
--     A leftover OLD narrow definition or a duplicate = problem.
select conname, conrelid::regclass as on_table, pg_get_constraintdef(oid) as definition
  from pg_constraint
 where connamespace = 'public'::regnamespace
   and conname in (
     'billing_plans_plan_id_check',
     'subscriptions_plan_check',
     'subscriptions_provider_check',
     'ai_deckblatt_usage_generations_used_check'
   )
 order by conname;

-- A4) Columns — the new columns must now appear:
--     billing_plans:   price_cents, duration_kind, duration_value,
--                      is_commercial, feature_limits
--     subscriptions:   trial_activated_at
select table_name, column_name
  from information_schema.columns
 where table_schema = 'public'
   and table_name in ('billing_plans', 'subscriptions')
 order by table_name, ordinal_position;

-- A5) RLS — all 5 ledger/capacity tables must have row security enabled
--     (relrowsecurity = t for every row).
select relname, relrowsecurity
  from pg_class
 where relnamespace = 'public'::regnamespace
   and relname in ('user_capacity_locks', 'feature_usage', 'feature_usage_runs',
                   'subscription_events', 'mock_checkouts');

-- A6) storage bucket — the 20261121 tail raised the ceiling to 15 MB
--     (expect file_size_limit = 15728640; pre-fix it was 10485760).
select id, file_size_limit
  from storage.buckets
 where id = 'ai-files';

-- ============================================================================
-- P-section: invoke the new functions. A 42883 here = a migration did not
-- land. These three calls are the actual write-path restoration proof:
-- plan_feature_limit resolving is what removes the dangling reference that
-- breaks every bew_applications content write (the P0).
-- ============================================================================

-- P1. plan_feature_limit resolves WITHOUT 42883 (expect: NULL for a legacy
--     user; an integer if that user holds an active commercial plan)
select public.plan_feature_limit(
  coalesce((select user_id from public.subscriptions limit 1),
           (select id from auth.users limit 1)),
  'saved_applications');

-- P2. feature_quota_status answers (expect: a jsonb with "used"; a
--     'missing_args' error is expected and harmless only if BOTH
--     subscriptions and auth.users are empty)
select public.feature_quota_status(
  coalesce((select user_id from public.subscriptions limit 1),
           (select id from auth.users limit 1)),
  'ai_assistant');

-- P3. the F1 advisory RPC now answers (expect: one row; status 'unmetered'
--     for a legacy user — the dangling plan_feature_limit ref is resolved)
select public.check_saved_application_capacity(
  coalesce((select user_id from public.subscriptions limit 1),
           (select id from auth.users limit 1)),
  1, null);

-- P4. seed rows present with the 12-key matrices (expect saved_applications 3/200/500)
select plan_id, price_cents, duration_kind, duration_value, is_commercial,
       feature_limits ->> 'saved_applications' as saved_applications_limit
  from public.billing_plans
 where plan_id in ('trial', 'premium_10d', 'premium_monthly')
 order by plan_id;

-- P5. deckblatt constraint widened (expect: a single check def with <= 60)
select conname, pg_get_constraintdef(oid)
  from pg_constraint
 where connamespace = 'public'::regnamespace
   and conrelid = 'public.ai_deckblatt_usage'::regclass
   and contype = 'c';
