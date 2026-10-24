-- ============================================================================
-- Subscription-visibility diagnostic — READ-ONLY (production-safe)
--
-- Purpose: disambiguate exactly why a logged-in user does not see the
-- subscriptions row (plan='pro', status='active', provider='manual') on
-- /settings/billing. The UI read path is:
--   page -> getBillingStatus(user.id) -> resolveSubscription(user.id)
--   -> service-role query: subscriptions WHERE user_id = <session uid>
-- Service role BYPASSES RLS, so RLS cannot hide the row from the UI;
-- the only hiding mechanisms are the three checked below.
--
-- Strictly SELECT-only: no INSERT/UPDATE/DELETE/ALTER/DROP/CREATE, no
-- RPC calls, no locks, no writes of any kind.
-- ============================================================================

-- D1) THE subscription row with everything the read path decides on:
--     - user_id: must equal the authenticated user's id (D2)
--     - period_in_future: FALSE = the app computes the row as EXPIRED at
--       read time (DB status stays 'active' by design — no job rewrites it)
--       and the UI shows the free fallback
select s.id as subscription_id,
       s.user_id,
       a.email as owner_email,
       a.created_at as owner_auth_created,
       s.plan,
       s.status,
       s.provider,
       s.current_period_start,
       s.current_period_end,
       (s.current_period_end is null or s.current_period_end > now())
         as period_in_future,
       s.canceled_at,
       s.trial_activated_at
  from public.subscriptions s
  left join auth.users a on a.id = s.user_id
 order by s.created_at;

-- D2) ALL auth users — identify the id of the account the user is
--     actually logged in with (compare its id against D1.user_id).
select u.id as auth_uid, u.email, u.created_at
  from auth.users u
 order by u.created_at;

-- D3) RLS policies on subscriptions (completeness check only — the UI
--     read is service-role and bypasses RLS; expected: exactly the
--     self-read SELECT policy, no user write policies).
select polname,
       cmd,
       (select array_agg(r::regrole::text order by r::regrole::text)
          from unnest(roles) as r) as applicable_roles,
       coalesce(qual::text, '') as using_expr
  from pg_policy
 where tablename = 'subscriptions'
 order by polname;

-- D4) The billing_plans 'pro' row the read path loads for a valid row
--     (expected: 1 row with the 20261120 v2 columns present; a missing
--     row would make the UI show Free + the lookup-failed notice).
select plan_id,
       emails_per_day,
       ai_requests_per_day,
       price_cents,
       duration_kind,
       duration_value,
       is_commercial,
       feature_limits
  from public.billing_plans
 where plan_id = 'pro';

-- ============================================================================
-- INTERPRETATION (exactly one primary cause; the read path admits no others)
--
-- CAUSE H1 — user_id mismatch:
--   D1.user_id is NOT the auth_uid of the account the user logs in with
--   (D2). The row belongs to a different auth user (e.g. an older or a
--   test account). The UI query `subscriptions WHERE user_id = <session
--   uid>` legitimately finds nothing -> "Free / no active subscription".
--   Resolution (manual, your call — nothing here changes it): assign the
--   plan to the correct user via the admin panel (Users -> set plan pro,
--   which writes that user's own row), or correct the row's user_id.
--
-- CAUSE H2 — lapsed period (stale 'active'):
--   D1.user_id matches but D1.period_in_future = FALSE. The app checks
--   current_period_end at read time (by design, no background job updates
--   the DB status), computes the row as EXPIRED, and — before the fix on
--   branch fix/billing-subscription-visibility (commit 2865292) — rendered
--   the card as "Free / Expired", losing the Pro identity entirely.
--   Resolution: (a) deploy 2865292 so the card shows "Pro / Expired" with
--   its dates (visible + actionable); (b) renew the period via the admin
--   panel (Users -> set plan pro with the desired duration — it rewrites
--   current_period_start/end on the SAME row; no second subscription).
--
-- CAUSE H3 — plan-catalog lookup failure:
--   D1 matches and the period is future, but D4 returns NO row (or the
--   server cannot read it): the UI shows "Free / Active" PLUS the
--   'lookup failed' warning line. If the user sees that warning, also
--   verify Vercel has SUPABASE_SERVICE_ROLE_KEY + NEXT_PUBLIC_SUPABASE_URL
--   set for the production project (a missing service-role key makes
--   EVERY server-side lookup fail closed to free).
--
-- If D1/D2/D4 all check out (uid matches, period future, pro row present)
-- and the page still shows Free WITHOUT the lookup-failed warning, capture
-- the page HTML (View Source) and the browser network tab of the page
-- load for the next step — that state is unreachable in the current code
-- and would indicate a stale deployment.
-- ============================================================================
