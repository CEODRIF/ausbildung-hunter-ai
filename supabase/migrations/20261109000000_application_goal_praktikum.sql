-- Third application type: "Praktikum".
--
-- WHY a migration is genuinely required:
--   `application_drafts.goal` is `public.application_goal NOT NULL` — a
--   Postgres ENUM created with only ('ausbildung', 'arbeit'). Any draft
--   saved with goal = 'praktikum' is rejected by the database unless the
--   enum carries the value, so the type cannot be supported in code alone.
--
-- Additive & safe:
--   * ADD VALUE IF NOT EXISTS only appends to the enum — no existing rows,
--     data, or constraints are touched (no destructive changes),
--   * with IF NOT EXISTS the statement is re-runnable,
--   * it must be applied BEFORE (or at) the deployment of the code that
--     offers the Praktikum option. Until then the application is fully
--     functional with the two existing types: the composer probes the enum
--     (see src/lib/contact-name-support.ts → supportsPraktikumGoal) and
--     hides the third option rather than writing a value the database
--     rejects (same graceful-degradation approach as contact_name).

alter type public.application_goal
  add value if not exists 'praktikum';
