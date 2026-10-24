-- =============================================================================
-- 20261125000000 — explicit feature matrix for the admin-assigned plus/pro
-- tiers (decision D1 of docs/subscription-system-design-2026-10-24.md).
--
-- WHY: the plus/pro rows seeded by 20261001000000 carry ONLY the legacy
-- per-day columns (emails 150/500, AI 400/1500) and feature_limits = '{}'.
-- Since the 2026-10-24 fail-closed entitlement fix (PR #71), an active
-- plus/pro subscription without a matrix resolved to the non-commercial
-- matrix — i.e. the 7 restricted features were DISABLED for exactly the
-- accounts the administrator granted Plus/Pro to. That is not what the
-- "Plus · 30 days" / "Pro · 30 days" admin tiers are for.
--
-- WHAT: seed explicit per-feature limits for plus/pro. Values are derived
-- from the canonical commercial catalogue (the two admin tiers map 1:1 onto
-- the two purchasable tiers' FEATURE sets) while each plan KEEPS its own
-- historic, higher per-day AI/e-mail columns:
--   plus = premium_10d feature values,   ai_requests_per_day stays 400
--   pro  = premium_monthly feature values, ai_requests_per_day stays 1500
-- The `ai_assistant` key is intentionally NOT in the matrix: the engine
-- reads ai requests from the ai_requests_per_day column for every matrix
-- plan (single source of truth per value).
--
-- PRODUCT DECISION REQUIRED: these numbers are a documented proposal (no
-- canonical per-feature values for plus/pro existed). Changing them later
-- = one UPDATE on this table; nothing else reads plan-specific values.
--
-- SAFETY: idempotent and guarded — only rows whose matrix is still empty
-- are filled; an operator-customized matrix is never overwritten.
-- =============================================================================

update public.billing_plans
   set feature_limits = case plan_id
         when 'plus' then '{
           "cover_letter": 25,
           "resume_ai": 20,
           "scanner": 20,
           "deckblatt": 15,
           "email_drafts": 60,
           "opportunity_search": 150,
           "saved_opportunities": 200,
           "saved_applications": 200,
           "salary_calculator": null,
           "automation": 100,
           "upload": 15
         }'::jsonb
         when 'pro' then '{
           "cover_letter": 50,
           "resume_ai": 60,
           "scanner": 60,
           "deckblatt": 30,
           "email_drafts": 120,
           "opportunity_search": 300,
           "saved_opportunities": 500,
           "saved_applications": 500,
           "salary_calculator": null,
           "automation": 250,
           "upload": 15
         }'::jsonb
       end
 where plan_id in ('plus', 'pro')
   and (feature_limits is null or feature_limits = '{}'::jsonb);
