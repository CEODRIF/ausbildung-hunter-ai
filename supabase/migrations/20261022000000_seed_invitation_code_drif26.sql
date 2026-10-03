-- ----------------------------------------------------------------------------
-- Seed the registration invitation code DRIF26.
--
-- Verified against a real Postgres running the full migration chain: the only
-- invitation rows the schema ever creates are DRIF928 (registration) and
-- DRIF089 (quota upgrade, seeded by 20250512000000 and 20260927030000).
-- `select public.validate_invitation_code('DRIF26','registration')` returned
-- false, so DRIF26 could not be used to register at all.
--
-- DRIF26 is seeded with the SAME shape as the existing registration code
-- DRIF928 — the documented model is "one invitation code = one account":
--   type              = registration   (only valid for sign-up, never for the
--                                       quota-upgrade path)
--   is_active         = true
--   max_uses          = 1              (single use; enforced atomically at
--                                       sign-up since 20261021000000)
--   daily_email_limit = 50             (the profile default)
--
-- To hand out more accounts (or to use DRIF26 as a reusable test code), raise
-- max_uses — the counter is enforced by consume_invitation_code():
--   update public.invitation_codes set max_uses = 25 where code = 'DRIF26';
-- To stop new sign-ups with it without deleting the row:
--   update public.invitation_codes set is_active = false where code = 'DRIF26';
--
-- Idempotent: re-running never resurrects a spent code (used_count is left
-- untouched) and never creates a duplicate — `code` is UNIQUE.
-- ----------------------------------------------------------------------------

insert into public.invitation_codes (code, type, is_active, max_uses, daily_email_limit)
values ('DRIF26', 'registration', true, 1, 50)
on conflict (code) do update
  set type = excluded.type,
      is_active = true,
      daily_email_limit = excluded.daily_email_limit;
