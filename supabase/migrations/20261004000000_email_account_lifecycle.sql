-- Phase 15 — Email account lifecycle: historical campaigns must not lock
-- an email account.
--
-- Before: email_campaigns.email_account_id was NOT NULL + ON DELETE
-- RESTRICT, so a user who had EVER created a campaign could never
-- disconnect that sender (the delete failed with a raw FK violation,
-- surfaced as a generic "disconnect_failed"). Campaigns are history —
-- they must outlive the sender reference.
--
-- After: the column is nullable and ON DELETE SET NULL. Disconnecting a
-- sender is still blocked by explicit server-side guards (active
-- campaigns / drafts in use — see settings/email action), and once
-- allowed, historical campaigns keep all their data; only the sender
-- pointer is cleared.
--
-- Strictly safer for GDPR deletion too: if Postgres cascades the
-- account before the campaigns, SET NULL resolves instead of RESTRICT
-- risking an ordering failure.
--
-- application_drafts.sender_email_account_id intentionally keeps
-- ON DELETE RESTRICT (a draft must retain its sender to stay sendable);
-- the disconnect action blocks with an actionable message instead.

alter table public.email_campaigns
  alter column email_account_id drop not null;

alter table public.email_campaigns
  drop constraint if exists email_campaigns_email_account_id_fkey;

alter table public.email_campaigns
  add constraint email_campaigns_email_account_id_fkey
  foreign key (email_account_id)
  references public.email_accounts(id)
  on delete set null;
