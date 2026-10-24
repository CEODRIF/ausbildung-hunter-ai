# Production rollout — Admin `db_error` (2026-10-25)

**Status:** NOT executed. This document is the exact, reviewed procedure. It
requires explicit operator approval before any production step is run.

## 1. Symptom

Admin → User Management: every subscription action (Assign Plus/Pro,
Reactivate, Cancel) fails with `فشل الإجراء (db_error)` — the UI's generic
`actionFailed({error})` string with the raw server reason `db_error`.

## 2. Exact root cause (verified, not guessed)

1. The deployed app (`main`, PR #72 merged at `33cb4c3`) runs all
   subscription admin actions through ONE atomic RPC:
   `public.manage_subscription(...)` — created by migration
   **`20261126000000_admin_manage_subscription.sql`**.
   Chain: `admin-user-actions.tsx` → `POST /api/admin/users/[id]`
   (`requireAdmin()` + rate limit + strict zod body) →
   `executeAdminAction` (`src/lib/billing/admin.ts`) →
   `admin.rpc("manage_subscription", { p_actor_id, p_target_id, p_action,
p_plan, p_period_days, p_reason: "admin_ui" })`.
2. The production database has **never applied** migration 20261126 (nor
   20261121/22/25/27). Supabase migrations do NOT run on PR merge or Vercel
   deploy — they require `supabase db push` or a manual SQL-editor run,
   which never happened. (Documented since the 2026-10-24 diagnostics:
   production state = migrations ≤20261116 + `20261120` applied +
   `20261123` applied manually; `20261121` had FAILED at apply time —
   `complete_feature_op` defect — and the editor rolled the whole batch
   back, so 20261121/22 stayed absent.)
3. PostgREST therefore answers the RPC with **PGRST202**
   (`function public.manage_subscription(...) does not exist`, SQLSTATE
   42883). The app mapped every RPC error to the undifferentiated reason
   `db_error` → the opaque UI message.

**Reproduction evidence (safe local mirror):** a disposable PostgreSQL
database was built with exactly the documented production migration set,
the identical call was executed, and it failed verbatim:

```
ERROR:  function public.manage_subscription(unknown, unknown, unknown, unknown, integer, unknown) does not exist
LINE 1: select public.manage_subscription('aaaaaaaa-…', 'bbbbbbbb-…', 'set_plan', 'plus', 30, 'admin_ui');
```

After applying the four-file rollout below to the mirror, ALL actions
succeeded: `set_plan plus 30` → one canonical row (`plus|active|manual`,
exact 2592000 s span, `created_by` = actor) + 1 audit row (before/after) +
1 billing event; `set_plan pro 30` → upsert on the same row;
`cancel_subscription` → `canceled` + `canceled_at`, row preserved;
`reactivate_subscription pro 1` → `active`, exact 86400 s span;
`set_plan free` → `invalid_plan` (admin can never grant free — D9 held);
`cancel` without a row → `no_subscription`; plus/pro entitlements live
(`plan_feature_limit` returns the 20261125 matrix, e.g. deckblatt 30 for
pro). Evidence log: generated 2026-10-25 in the operator workspace
(`/tmp/dberr/evidence.log` at diagnosis time — re-runnable via the same
mirror procedure).

## 3. What the fix commit (branch `fix/admin-subscription-db-error`) does

Code-side (no behavior change for healthy databases):

- `src/lib/billing/admin.ts`: the RPC error is now captured with its
  PostgREST code + message and logged SERVER-SIDE, sanitized (every UUID
  and e-mail redacted, whitespace-collapsed, truncated to 300 chars).
  A missing function (PGRST202 / 42883 / the "does not exist" message
  shape) maps to a DISTINCT reason `rpc_unavailable`; all other database
  errors keep `db_error`.
- `appendAudit` is error-aware: `grant_admin` / `revoke_admin` return
  `audit_failed` (HTTP 500) when the audit write fails instead of a false
  success (the underlying grant/revoke IS committed — the message tells
  the operator to verify).
- Route `src/app/api/admin/users/[id]/route.ts`: `rpc_unavailable` → 503,
  `audit_failed` → 500 (4xx stays caller-side, 5xx = operator action).
- UI `src/components/admin-user-actions.tsx` + i18n (de/en/fr/ar):
  `rpc_unavailable` and `audit_failed` render specific, actionable
  messages (naming migration 20261126) instead of "فشل الإجراء (db_error)".
- Cancel success message de-staled (the permanent Free plan no longer
  exists — D9): "…the account has no active plan; protected features are
  locked (account and data preserved)."
- Tests (`tests/billing-admin.test.ts`): reproduction of the exact
  production error (PGRST202 → 503 `rpc_unavailable` + sanitized log, no
  PII), PII redaction on other DB errors, throwing RPC client, audit-fail
  paths (grant/revoke → 500 `audit_failed`), unit pins for the sanitizer
  and the missing-function detector. All pre-existing admin tests
  unchanged and passing.

**The code fix alone does NOT make the production admin work** — the
database must receive the missing functions (section 4). Until then the
improved error message at least tells the operator exactly why.

## 4. Exact rollout (requires explicit approval; production SQL by the operator)

Pre-conditions (all verified at diagnosis time, 2026-10-25):

- Production state: migrations ≤ `20261116` + `20261120` + `20261123`
  (manual); **absent**: `20261121`, `20261122`, `20261124`, `20261125`,
  `20261126`, `20261127`.
- `public.subscriptions` already has the v2 columns (20261120 applied);
  `manage_subscription` absent.
- **Do NOT re-run 20261121 or 20261122**: their content is superseded by
  20261124 (which carries the CORRECTED function bodies — see its header —
  plus 20261122 verbatim, and keeps the 20261123 `feature_capacity_status`
  version instead of 20261121's regressing one).

Steps:

0. **Snapshot**: PITR snapshot (if enabled) + `pg_dump -n public`.
1. **Apply `20261124000000_production_repair_feature_quotas.sql`** — from
   branch `fix/20261124-production-repair` (NOT yet in `main`; extract the
   file from that branch or merge that branch first). Rerun-safe from the
   documented production state; every statement is
   create-if-not-exists / create-or-replace / drop-guarded; the only data
   statement is the idempotent ai-files bucket ceiling 10 MB → 15 MB.
   This also fixes the pre-existing P0: the saved-application capacity
   trigger's `42883` (it calls `plan_feature_limit`, which 20261124
   provides).
2. **Apply `20261125000000_plus_pro_feature_limits.sql`** (in `main`):
   idempotent guarded UPDATE filling the plus/pro `feature_limits`
   matrices (operator-customized matrices are never overwritten).
3. **Apply `20261126000000_admin_manage_subscription.sql`** (in `main`):
   creates `manage_subscription` — **this is the file that ends the
   `db_error`**.
4. **Apply `20261127000000_remove_free_deckblatt_fallback.sql`** (in
   `main`): deckblatt no-plan fallback 2/day → 0 (D9; deny-first from the
   first read after apply).
   Each file via the SQL editor, ONE file per run, verify zero errors in
   the output of every file before the next.

Post-verification (read-only):

- `select exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='manage_subscription');` → `t`
- `select public.plan_feature_limit('<some-legacy-user>', 'ai_assistant');` → NULL, no 42883 (kills the saved-applications P0).
- `select public.feature_quota_status('<some-user>', 'ai_assistant');` → one row.
- **Smoke (intentional DML, explicit approval):** on a throwaway test
  account: Admin → Assign Plus 30 → success message + table shows
  `Plus · 30 days`; user sees entitlements; Cancel → success; Reactivate →
  success; `select * from admin_audit_log where target_user_id='…'` shows
  the before/after rows.
- Watch Supabase logs: `42883` entries must stop.

Rollback (primary = PITR snapshot from step 0). Object-level, reverse
order: `drop function public.manage_subscription(uuid,uuid,text,text,integer,text);`
→ revert the 20261125 matrices (re-run the original empty-matrix seed
values) → `drop` the 20261124 objects per its header's reverse notes.
No step of the rollout deletes or alters user data (subscriptions,
usage rows, applications) — confirmed file by file at audit time.

## 5. Consequences & follow-ups (decisions, not blockers)

- `schema_migrations` will have NO entries for 20261121/22/24 (manual
  apply). A future `supabase db push` from `main` would attempt 20261121
  (which still fails on its documented defect) — so either (a) keep
  applying migrations manually via the SQL editor, or (b) follow up by
  merging the corrected `20261121` (branch
  `fix/20261121-complete-feature-op-begin`) into `main` so `db push`
  becomes safe again. Both are documented; neither is done by this change.
- The improved error mapping means that IF any future migration is ever
  skipped, the admin UI shows the specific "migration 20261126 not
  applied" guidance instead of an opaque `db_error`, and the server logs
  carry the exact PostgREST code.

## 6. Safety confirmations

No production SQL, migration, deploy, secret, environment, Supabase or
Vercel setting was changed by this task. All database verification ran on
disposable local PostgreSQL databases that were dropped after use. PR
state: `fix/admin-subscription-db-error` is pushed for review; nothing is
merged by this task.
