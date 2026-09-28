-- Phase 5: saved opportunities keep a SAVED-AT match snapshot in addition to
-- the existing score. `match_status` records whether the snapshot was a
-- complete match (score present) or an incomplete one (score null — never a
-- guess). The snapshot is historical; the current live match is always
-- recomputed server-side on the detail page, so a later profile update can
-- change the live match without overwriting this row.
--
-- RLS is unchanged: the existing policy ("Users can manage their own saved
-- opportunities") already covers ALL operations on the table for
-- authenticated users scoped by auth.uid() = user_id, so the new column
-- inherits the same isolation.

alter table public.saved_opportunities
  add column if not exists match_status text
  check (match_status in ('complete', 'incomplete'));
