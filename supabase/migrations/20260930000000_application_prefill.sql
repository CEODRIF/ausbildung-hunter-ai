-- Phase 6: application prefill from an opportunity.
--
-- When a user prepares an application from an opportunity, the draft records
-- WHICH opportunity it was pre-filled from (a server-derived snapshot).
-- These are display/context columns only — the composer's subject, body,
-- and recipients are still user-editable, and every field is re-derived
-- server-side from the authoritative source at prefill time (never from the
-- browser). All four are nullable: a normal (non-prefilled) draft leaves
-- them null.
--
-- RLS is unchanged: the existing policy ("Users can manage their own drafts")
-- already covers ALL operations on the table for authenticated users scoped
-- by auth.uid() = user_id, so the new columns inherit the same isolation.

alter table public.application_drafts
  add column if not exists opportunity_key text,
  add column if not exists opportunity_title text,
  add column if not exists opportunity_company text,
  add column if not exists opportunity_source_url text;
