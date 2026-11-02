-- AUTO BEWERB — automatic company approval (product decision 2026-11-02)
--
-- The mandatory manual "Genehmigen" step is removed from the send workflow.
-- A company is send-eligible as soon as its data is complete (verified
-- recipient + the documents the global attachment flags demand); the engine
-- re-checks every safety condition (recipient, documents, duplicate-send,
-- quota/window) at prepare and dispatch time.
--
-- The `approved` column is KEPT as a historical audit field but can no
-- longer block anything:
--   * the default flips to TRUE so even a pre-code deployment of this
--     migration auto-approves new rows at the schema level;
--   * every existing row (reserved AND released history) is backfilled to
--     TRUE so no legacy `approved = false` state can resurface as
--     "nicht genehmigt" anywhere;
--   * no code path writes `approved = false` anymore (the approve function
--     and its API action were deleted with this release).
--
-- No user content (ad text, documents, e-mail settings, history) is touched;
-- only the approval flag and its timestamp are normalized.

alter table public.auto_bewerb_companies
  alter column approved set default true;

update public.auto_bewerb_companies
set approved = true,
    approved_at = coalesce(approved_at, now());
