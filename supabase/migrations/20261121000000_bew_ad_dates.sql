-- ---------------------------------------------------------------------------
-- Smart-input advertisement dates: start / end / application deadline.
--
-- WHY: the simplified smart-input flow (paste → "Text analysieren" → editable
-- form → confirm) extracts the THREE key dates of an Ausbildung
-- advertisement — Ausbildungsbeginn, Ausbildungsende and Bewerbungsschluss —
-- and the user confirms them in the same form. All three are OPTIONAL extras
-- of the same extraction: every existing row stays NULL, and every existing
-- write path that does not send these fields is unchanged (the columns are
-- simply absent from its payload).
--
-- Design (additive, rerunnable, migration-safe — same contract as
-- 20261117000000_bew_smart_input_phone_industry.sql):
--   * All three columns are NULLABLE text, capped at 40 characters. The
--     values are always VERBATIM from the pasted advertisement (e.g.
--     "01.09.2027", "01. September 2027") or freely corrected by the user in
--     the review form — never normalized, completed or invented.
--   * No NOT NULL, no default, no backfill: rows written before this
--     migration (or by the non-smart write paths — CSV import, manual
--     entry, row editing) keep NULL and never become "empty string".
--
-- The application layer probes for these columns (hasBewAdDateColumns in
-- bewerbung-engine.ts) and degrades gracefully when the migration is pending
-- (no 42703 crash; the dates are simply not persisted).
--
-- No RLS changes (new columns inherit the existing bew_applications
-- policies). No triggers. Apply MANUALLY like every other migration in this
-- repo.
-- ---------------------------------------------------------------------------

alter table public.bew_applications
  add column if not exists start_date          text,
  add column if not exists end_date            text,
  add column if not exists application_deadline text;

-- Length guards (drop+add so re-runs stay idempotent; every existing row is
-- NULL, which satisfies each constraint below).
alter table public.bew_applications
  drop constraint if exists bew_applications_start_date_length,
  drop constraint if exists bew_applications_end_date_length,
  drop constraint if exists bew_applications_application_deadline_length;

alter table public.bew_applications
  add constraint bew_applications_start_date_length
    check (start_date is null or char_length(start_date) between 1 and 40),
  add constraint bew_applications_end_date_length
    check (end_date is null or char_length(end_date) between 1 and 40),
  add constraint bew_applications_application_deadline_length
    check (application_deadline is null or char_length(application_deadline) between 1 and 40);
