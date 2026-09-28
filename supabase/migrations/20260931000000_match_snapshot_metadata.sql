-- Phase 7: production matching — saved match snapshot metadata.
--
-- The saved match snapshot (match_score / match_status, migration 9) is
-- HISTORICAL by design: the current match is always recomputed live on the
-- detail page. These two columns let the UI distinguish
--   * current match          — computed live, server-side, on the detail page;
--   * historical snapshot    — the stored values, captured with the engine
--     version (matcher_version) and the candidate-profile revision at
--     snapshot time (match_profile_updated_at);
--   * incomplete snapshot    — match_status = 'incomplete' (score null —
--     never a guess).
-- When the profile's current updated_at is newer than
-- match_profile_updated_at (or the engine version changed), the UI states
-- that the snapshot may be stale instead of presenting it as current.
--
-- RLS is unchanged: the existing policy ("Users can manage their own saved
-- opportunities") already covers ALL operations on the table for
-- authenticated users scoped by auth.uid() = user_id, so the new columns
-- inherit the same isolation.

alter table public.saved_opportunities
  add column if not exists matcher_version integer,
  add column if not exists match_profile_updated_at timestamptz;
