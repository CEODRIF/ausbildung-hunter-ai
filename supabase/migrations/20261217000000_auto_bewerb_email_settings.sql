-- ===========================================================================
-- AUTO BEWERB — Step 6: GLOBAL e-mail settings (one row per user).
--
-- The whole batch now sends ONE identical e-mail: shared subject, shared
-- body (sent VERBATIM — no token substitution), one sending account, shared
-- attachment flags and an optional explicit global recipient.
--
-- This extends the EXISTING global template row (auto_bewerb_email_templates,
-- one row per user) with the remaining configuration — no new table. The
-- per-company DELIVERY destination is NOT stored here: it stays verified per
-- company (legacy manual auto_bewerb_companies.recipient_email, otherwise
-- the advertisement's extracted applicationEmail). recipient = '' means
-- "deliver to each company's own verified address" — never to one
-- company's address.
--
-- Additive only; safe to re-apply. Databases without this migration keep
-- working via the legacy per-company fallback (probed at runtime).
-- ===========================================================================

alter table public.auto_bewerb_email_templates
  add column if not exists recipient text not null default '',
  add column if not exists subject   text not null default '',
  add column if not exists account_id uuid references public.email_accounts(id) on delete set null,
  add column if not exists attach_cv    boolean not null default true,
  add column if not exists attach_letter boolean not null default true;

comment on column public.auto_bewerb_email_templates.recipient is
  'Optional explicit GLOBAL recipient for the whole batch; empty = each company''s verified application email.';
comment on column public.auto_bewerb_email_templates.subject is
  'The ONE shared e-mail subject for every application.';
comment on column public.auto_bewerb_email_templates.account_id is
  'The ONE shared sending account (email_accounts.id) for every application.';
