-- ============================================================================
-- 20261129000000 — effective_daily_email_limit: entitlement-only, no free floor
--
-- Context (P0 quota audit, 2026-10-25):
--   The previous version (20261001000000_billing_and_admin.sql) computed
--     greatest(coalesce(plan_limit, coalesce(profile_base, 50)), upgrade)
--   so EVERY user without a valid plan row — never-subscribed users,
--   historical `free` rows, and canceled/expired subscriptions — kept a
--   default 50 e-mails/day allowance even though the product has NO
--   permanent Free plan (2026-10-24 decision) and the metered entitlement
--   engine (checkFeature) grants them zero.
--
-- Approved change:
--   E-mail sending capacity now follows the entitlement ONLY:
--     - no valid entitlement (no active, unexpired subscription row)  -> 0
--     - active plan (trial / plus / pro / premium_10d / premium_monthly)
--         -> billing_plans.emails_per_day for that plan (unchanged values:
--            trial 3, plus 150, pro 500, premium_10d 100, premium_monthly 250)
--     - invitation-code quota upgrades still apply (max of both sources,
--       unchanged)
--   This removes the mismatch where the UI's metered features showed
--   "not available" while the e-mail surface still granted 50 sends/day.
--
-- Safety:
--   - Function replacement only (CREATE OR REPLACE) — no table, column, or
--     data changes; no user data is read-modified or deleted.
--   - profiles.daily_email_limit remains in the schema (historical base +
--     display) but no longer feeds the effective limit.
--   - Grants are preserved by CREATE OR REPLACE and re-asserted idempotently
--     below (service_role only, as before).
--   - All consumers (get_daily_usage_snapshot, reserve_email_capacity,
--     reserve_email_capacity_on, campaign scheduling) call this same
--     function, so enforcement and display stay consistent by construction.
--
-- Rollback guidance (manual; restore the previous function body verbatim
-- from 20261001000000_billing_and_admin.sql). No data migration needed.
-- ============================================================================

create or replace function public.effective_daily_email_limit(target_user_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  plan_limit integer;
  upgrade_limit integer;
begin
   -- Plan base: ONLY a valid (active, unexpired) subscription row on an
   -- ENTITLEMENT plan counts. Historical `free` rows (production legacy
   -- state) resolve to NULL — free is history, never a grant (same policy
   -- as migration 20261127 for deckblatt and the entitlement engine,
   -- which rejects `free` rows); canceled and expired rows too.
   select bp.emails_per_day into plan_limit
   from public.subscriptions s
   join public.billing_plans bp on bp.plan_id = s.plan
   where s.user_id = target_user_id
     and s.status = 'active'
     and s.plan is distinct from 'free'
     and (s.current_period_end is null or s.current_period_end > timezone('utc', now()));

  -- Invitation-code quota upgrades (max of both sources, unchanged).
  select max(ic.daily_email_limit) into upgrade_limit
  from public.user_quota_upgrades uqu
  join public.invitation_codes ic on ic.id = uqu.code_id
  where uqu.user_id = target_user_id
    and uqu.active = true
    and ic.is_active = true;

  -- NO profile-base floor: no entitlement -> 0 (fail closed).
  return greatest(
    coalesce(plan_limit, 0),
    coalesce(upgrade_limit, 0)
  );
end;
$$;

grant execute on function public.effective_daily_email_limit(uuid) to service_role;
