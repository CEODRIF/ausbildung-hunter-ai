-- ============================================================================
-- Production pre/post-fix PROBE — READ-ONLY (pure SELECT statements only; no DDL, no DML)
-- Run in the Supabase SQL editor. Paste the results back for verification.
--
-- PRE-FIX expectations are marked (PRE). After applying 20261120→21→22,
-- re-run the same script: every (PRE) expectation inverts as noted.
-- ============================================================================

-- 1) Migration ledger (PRE: latest < 20261120000000; none of 20261120..23 listed)
select version
  from supabase_migrations.schema_migrations
 order by version desc
 limit 6;

-- 2) Function inventory — a name in the output = PRESENT (with its overload
--    count); a listed name MISSING from the output = ABSENT.
--    PRE expectations per group comment below. Key correction: the 4
--    deckblatt functions come from 20261020 (already applied in prod), NOT
--    20261121 — 20261121 re-creates only 3 of them (identical signatures)
--    and leaves complete_deckblatt_generation untouched (its header, L40).
select p.proname as function_name,
       p.oid,
       (select count(*) from pg_proc q join pg_namespace nq on nq.oid = q.pronamespace
         where nq.nspname = 'public' and p.proname = q.proname)::int as overloads
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.proname in (
     -- expected ABSENT pre-fix (created by 20261120):
     'subscription_period_end', 'activate_trial',
     -- expected ABSENT pre-fix (created by 20261121):
     'feature_quota_kind', 'plan_feature_limit',
     'reserve_feature_op', 'complete_feature_op', 'release_feature_op',
      'expire_stale_feature_runs', 'feature_quota_status',
      'release_ai_request',
      -- expected PRESENT pre-fix with the OLD 20261020 version (20261121
      -- re-creates these three, identical signatures):
      'get_deckblatt_usage_status',
      'reserve_deckblatt_generation', 'release_deckblatt_generation',
      -- expected PRESENT both pre- and post-fix (20261020; 20261121 leaves
      -- it deliberately untouched):
      'complete_deckblatt_generation',
     -- expected ABSENT pre-fix (created by 20261122):
     'create_mock_checkout', 'complete_mock_checkout',
     -- expected PRESENT (manual 20261123 + older):
     'enforce_saved_application_capacity', 'check_saved_application_capacity',
     'feature_capacity_status', 'activate_quota_upgrade',
     'reserve_email_capacity', 'reserve_email_capacity_on',
     'set_updated_at'
   )
 order by p.proname;

-- 3) Table inventory — a name in the output = PRESENT; missing = ABSENT.
--    PRE: feature_usage / feature_usage_runs / subscription_events /
--    mock_checkouts absent; the other 8 present (user_capacity_locks via the
--    manual 20261123, the rest via older applied migrations).
select c.relname as table_name
  from pg_class c
  join pg_namespace n on n.oid = c.oid
 where n.nspname = 'public'
   and c.relname in (
     -- expected ABSENT pre-fix:
     'feature_usage', 'feature_usage_runs',      -- NOTE: names are feature_usage(_runs),
     'subscription_events', 'mock_checkouts',    -- NOT user_feature_usage
     -- expected PRESENT:
     'billing_plans', 'subscriptions', 'daily_usage',
     'ai_deckblatt_usage', 'ai_deckblatt_runs', 'bew_applications',
     'user_capacity_locks', 'saved_opportunities', 'application_drafts'
   )
 order by 1;

-- 4) Columns on billing_plans / subscriptions (PRE: no feature_limits / price_cents /
--    duration_kind / duration_value / is_commercial on billing_plans;
--    no trial_activated_at on subscriptions)
select table_name, column_name
  from information_schema.columns
 where table_schema = 'public'
   and table_name in ('billing_plans', 'subscriptions')
 order by table_name, ordinal_position;

-- 5) Constraint names + definitions the migrations will drop/recreate
--    (PRE: expect all 4 rows with the OLD narrow definitions)
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

-- 6) Existing data the widened checks must validate
--    (PRE: plans ⊆ {plus, pro}, providers ⊆ {manual}; billing_plans ⊆ {free, plus, pro})
select 'subscriptions' as what, plan, status, provider, count(*)
  from public.subscriptions
 group by 1, 2, 3, 4
 order by 2, 3, 4;

select 'billing_plans' as what, plan_id, emails_per_day, ai_requests_per_day
  from public.billing_plans
 order by plan_id;

-- 7) The trigger left dangling by the manual 20261123 (PRE: present)
select tgname, tgrelid::regclass as on_table
  from pg_trigger
 where tgname = 'bew_applications_enforce_saved_capacity';

-- 8) RLS state of the new tables (run AFTER fix for the 4 new tables:
--    expect relrowsecurity = t and ZERO pg_policies rows for
--    subscription_events / mock_checkouts)
select relname, relrowsecurity
  from pg_class
 where relnamespace = 'public'::regnamespace
   and relname in ('user_capacity_locks', 'feature_usage', 'feature_usage_runs',
                   'subscription_events', 'mock_checkouts');

-- 9) storage bucket the 20261121 tail updates (PRE: expect a row; file_size_limit < 15728640)
select id, file_size_limit
  from storage.buckets
 where id = 'ai-files';

-- ============================================================================
-- POST-FIX spot checks (run after applying 20261120→21→22)
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

-- P4. seed rows present with the 12-key matrices
select plan_id, price_cents, duration_kind, duration_value, is_commercial,
       feature_limits ->> 'saved_applications' as saved_applications_limit
  from public.billing_plans
 where plan_id in ('trial', 'premium_10d', 'premium_monthly')
 order by plan_id;

-- P5. deckblatt constraint widened (expect: single check def with <= 60)
select conname, pg_get_constraintdef(oid)
  from pg_constraint
 where connamespace = 'public'::regnamespace
   and conrelid = 'public.ai_deckblatt_usage'::regclass
   and contype = 'c';
