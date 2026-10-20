-- ---------------------------------------------------------------------------
-- Smart-input extracted fields: company phone number + industry classification.
--
-- WHY: the smart-input "Auto-organize" flow (Check information → Review →
-- Confirm) now supports a PHONE NUMBER field (the user-visible gap in the
-- "Detected information" panel) and an AI-derived INDUSTRY classification.
-- Both fields are OPTIONAL extras of the same extraction: every existing row
-- stays NULL, and every existing write path that does not send these fields
-- is unchanged (the column is simply absent from its payload).
--
-- Design (additive, rerunnable, migration-safe — same contract as
-- 20261115000000_bew_position_brief.sql):
--   * company_phone is NULLABLE text, capped at 80 characters. The value is
--     always the VERBATIM number from the pasted advertisement (original
--     formatting preserved, international country code included when present,
--     nothing completed or invented).
--   * company_industry is NULLABLE text, capped at 120 characters. The value
--     is a normalized category label (closed taxonomy) plus, when useful, a
--     more specific subcategory taken verbatim from the advertisement
--     ("IT & Software — Embedded Linux"). NULL = unknown / not configured.
--   * No NOT NULL, no default, no backfill: rows written before this
--     migration (or by the non-smart write paths — CSV import, manual
--     entry, row editing) keep NULL and never become "empty string".
--
-- The application layer probes for these columns (hasBewSmartColumns in
-- bewerbung-engine.ts) and degrades gracefully when the migration is pending
-- (no 42703 crash, phone/industry are simply not persisted).
--
-- No RLS changes (new columns inherit the existing bew_applications
-- policies). No triggers. Apply MANUALLY like every other migration in this
-- repo.
-- ---------------------------------------------------------------------------

alter table public.bew_applications
  add column if not exists company_phone    text,
  add column if not exists company_industry text;

-- Length guards (drop+add so re-runs stay idempotent; every existing row is
-- NULL, which satisfies each constraint below).
alter table public.bew_applications
  drop constraint if exists bew_applications_company_phone_length,
  drop constraint if exists bew_applications_company_industry_length;

alter table public.bew_applications
  add constraint bew_applications_company_phone_length
    check (company_phone is null or char_length(company_phone) between 1 and 80),
  add constraint bew_applications_company_industry_length
    check (company_industry is null or char_length(company_industry) between 1 and 120);
