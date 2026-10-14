-- Smart personalization: an OPTIONAL, explicitly provided contact person
-- name per recipient (e.g. "Frau Dr. Schmidt").
--
-- Why this migration is necessary: the sending worker renders each
-- message from the `email_messages` row (recipient_email, company_name,
-- contact_name) plus the draft template. The contact name must therefore
-- survive draft → campaign → worker, and the only durable path is the
-- existing tables. Additive change only:
--   * both columns are nullable,
--   * no data is modified or deleted,
--   * row-level security already covers every row of both tables, so the
--     new columns inherit the existing policies.

alter table public.application_draft_recipients
  add column if not exists contact_name text;

alter table public.email_messages
  add column if not exists contact_name text;
