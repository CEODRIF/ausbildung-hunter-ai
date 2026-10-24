-- ============================================================================
-- Billing-plans CANONICAL verification — READ-ONLY (production-safe)
--
-- Verifies that billing_plans matches the canonical values defined by the
-- repository: v1 seed (20261001) for the legacy rows + v2 column defaults
-- (20261120) + v2 commercial seeds (20261120, mirrored 1:1 in
-- src/lib/billing/commercial-plans.ts, drift-guarded by
-- tests/subscription-migrations.test.ts).
--
-- EXPECTED RESULT: exactly 6 rows, all canonical_ok = true.
-- Any canonical_ok = false row is a genuine data deviation (investigate
-- before any further billing work).
--
-- Strictly SELECT-only: no writes, no RPC calls, no locks, no user-level
-- data (subscriptions are reported in aggregate only — no user_id, no
-- e-mails — per the owner-account restriction).
-- ============================================================================

-- V1) Plan catalogue vs canonical matrix ------------------------------------
select plan_id,
       price_cents,
       duration_kind,
       duration_value,
       is_commercial,
       emails_per_day,
       ai_requests_per_day,
       feature_limits,
       case plan_id
         when 'free' then (
           price_cents = 0 and is_commercial = false
           and duration_kind = 'none' and duration_value = 0
           and emails_per_day = 50 and ai_requests_per_day = 100
           and feature_limits = '{}'::jsonb)
         when 'plus' then (
           price_cents = 0 and is_commercial = false
           and duration_kind = 'none' and duration_value = 0
           and emails_per_day = 150 and ai_requests_per_day = 400
           and feature_limits = '{}'::jsonb)
         when 'pro' then (
           price_cents = 0 and is_commercial = false
           and duration_kind = 'none' and duration_value = 0
           and emails_per_day = 500 and ai_requests_per_day = 1500
           and feature_limits = '{}'::jsonb)
         when 'trial' then (
           price_cents = 0 and is_commercial = false
           and duration_kind = 'fixed_hours' and duration_value = 72
           and emails_per_day = 3 and ai_requests_per_day = 5
           and feature_limits = '{"ai_assistant":5,"cover_letter":1,"resume_ai":1,"scanner":1,"deckblatt":1,"email_drafts":3,"opportunity_search":5,"saved_opportunities":3,"saved_applications":3,"salary_calculator":null,"automation":0,"upload":2}'::jsonb)
         when 'premium_10d' then (
           price_cents = 1000 and is_commercial = true
           and duration_kind = 'fixed_days' and duration_value = 10
           and emails_per_day = 100 and ai_requests_per_day = 100
           and feature_limits = '{"ai_assistant":100,"cover_letter":25,"resume_ai":20,"scanner":20,"deckblatt":15,"email_drafts":60,"opportunity_search":150,"saved_opportunities":200,"saved_applications":200,"salary_calculator":null,"automation":100,"upload":15}'::jsonb)
         when 'premium_monthly' then (
           price_cents = 2000 and is_commercial = true
           and duration_kind = 'calendar_month' and duration_value = 1
           and emails_per_day = 250 and ai_requests_per_day = 200
           and feature_limits = '{"ai_assistant":200,"cover_letter":50,"resume_ai":60,"scanner":60,"deckblatt":30,"email_drafts":120,"opportunity_search":300,"saved_opportunities":500,"saved_applications":500,"salary_calculator":null,"automation":250,"upload":15}'::jsonb)
         else false  -- unknown plan id present in the catalogue
       end as canonical_ok
  from public.billing_plans
 order by plan_id;

-- V2) Subscription distribution (AGGREGATE ONLY — no user ids, no e-mails) --
select plan,
       status,
       provider,
       count(*) as rows,
       bool_and(current_period_end is null or current_period_end > now())
         as all_ends_future_or_null
  from public.subscriptions
 group by plan, status, provider
 order by plan, status, provider;

-- V3) Mock checkout must remain service-role-only (disabled for users) ----
-- NOTE: uses the 3-ARG form has_function_privilege(user, regproc,
-- 'execute') with the OID resolved from pg_proc. The 2-arg form
-- has_function_privilege(user, 'funcname(args)') is BROKEN in this
-- PostgreSQL build family (Supabase PostgreSQL and Ubuntu PG 14.24): it
-- fails with 22P02 "expected a left parenthesis" even for 'now'.
select p.proname || '(' ||
       (select string_agg(t.typname, ', ' order by a.ord)
          from unnest(p.proargtypes) with ordinality as a(oid, ord)
          join pg_type t on t.oid = a.oid) || ')' as function,
       has_function_privilege('service_role', p.oid, 'execute') as service_role,
       has_function_privilege('authenticated', p.oid, 'execute') as authenticated,
       has_function_privilege('anon', p.oid, 'execute') as anon
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.proname in ('create_mock_checkout', 'complete_mock_checkout')
 order by p.proname;

-- ============================================================================
-- EXPECTED (canonical, matches repo seeds + commercial-plans.ts):
--   V1: 6 rows, ALL canonical_ok = true
--        (free/plus/pro: price 0, non-commercial, 'none'/0, 50/100,
--         150/400, 500/1500, feature_limits = '{}'  ← THIS IS BY DESIGN:
--         legacy plans are granted, never purchased; their limits live in
--         the legacy columns, and is_commercial=false is the mock-checkout
--         gate. Do not "fix" these values.)
--   V2: pro | active | manual → 1 row, all_ends_future_or_null = true
--       (plus any free/trial/premium rows that exist)
--   V3: 2 rows, each with service_role=t authenticated=f anon=f
--       (complete_mock_checkout(uuid, uuid, text),
--        create_mock_checkout(uuid, text, text))
-- ============================================================================
