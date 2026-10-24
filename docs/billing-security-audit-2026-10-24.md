# Billing security audit — 2026-10-24

Companion to `tests/billing-security-isolation.test.ts`, which pins every
claim below as a regression guard. Baseline: `main` @ `e27fd83`.

## 1. RLS matrix (billing schema)

**Verification scope (audit pass 2):** the invariants below are test-pinned
against the **entire migration directory** (all 66 files, filename =
application order), as a NET inventory — `CREATE POLICY` minus
`DROP POLICY`, including **dynamically executed** policies
(`execute 'create policy …'` inside plpgsql, e.g. `daily_usage` in
`20261009000000_restore_dashboard_access.sql`). The parser is hardened
against its pass-1 silent-miss classes (missing `USING`, `WITH CHECK`,
unquoted names, quoted identifiers, schema-less tables, case, commented-out
DDL) and is pinned by its own self-test fixtures in
`tests/billing-security-isolation.test.ts`.

Core billing tables:

| Table                 | RLS | Net policies                                        | Who can read                                                                                                |
| --------------------- | --- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `billing_plans`       | on  | 1 — `select` `to authenticated` `using (true)`      | anyone authenticated (public catalogue)                                                                     |
| `subscriptions`       | on  | 1 — `select` own row `using (user_id = auth.uid())` | self only. **No insert/update/delete policy** — only the service-role admin layer writes subscription state |
| `admins`              | on  | **zero**                                            | service role only (no self-elevation path from the browser)                                                 |
| `admin_audit_log`     | on  | **zero**                                            | service role only                                                                                           |
| `subscription_events` | on  | **zero**                                            | service role only                                                                                           |
| `mock_checkouts`      | on  | **zero**                                            | service role only                                                                                           |
| `feature_usage`       | on  | 1 — `select` own row                                | self only                                                                                                   |
| `feature_usage_runs`  | on  | 1 — `select` own row                                | self only                                                                                                   |

Quota/usage metering tables (same invariant — no user write path via
PostgREST; writes happen inside RPCs): `daily_usage`,
`user_quota_upgrades`, `user_search_credits`, `credit_transactions`,
`searches`, `ai_deckblatt_usage`, `ai_deckblatt_runs`,
`housing_web_search_usage`, `housing_web_search_runs` — each exactly one
self-scoped `select` policy.

**Invariant (test-pinned):** across ALL migrations, every net policy on
these 17 tables is `select` (13 self-scoped + 1 public catalog read + 4
tables with zero policies); no user write path exists; no
`WITH CHECK` clause anywhere in the billing set.

**Database-level verification:** `tests/billing-rls-pg.test.ts` re-checks
the same invariants against a disposable local PostgreSQL (full chain
applied, `pg_policies` + `relrowsecurity` + 3-arg
`has_function_privilege` for the mock RPCs). It **skips honestly** when no
local PostgreSQL is reachable — on the host where this audit was executed
PostgreSQL was unavailable, so database-level verification was NOT
performed there (see §6.2).

Note: RLS is the _last_ line of defense. The application does not rely on it
for user reads — the billing UI reads through the service-role client with
explicit user-scoped filters (service role bypasses RLS by design), so a
policy drift would degrade to "no rows visible", never to "other users'
rows visible".

## 2. RPC permission matrix

| Function                                                                                                                 | Grants                                                                                    | Notes                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `create_mock_checkout` / `complete_mock_checkout`                                                                        | **service_role only** (`revoke … from public, authenticated` + `grant … to service_role`) | additionally env-gated by `mockPaymentsEnabled()` — disabled in every production runtime (matrix test-pinned) |
| `reserve_feature_op` / `complete_feature_op` / `release_feature_op` / `feature_quota_status` / `feature_capacity_status` | service_role only                                                                         | quota accounting never runs with a user token                                                                 |
| `activate_trial`                                                                                                         | service_role only                                                                         | one-shot per user, 72h, event logged                                                                          |
| `reserve_deckblatt_generation` / `complete_…`                                                                            | `authenticated` with `auth.uid()` guard                                                   | pre-existing user-session RPCs, plan-aware                                                                    |
| `reserve_search_credits` / `refund_search_credits`                                                                       | `authenticated` with `auth.uid()` guard                                                   | same pattern                                                                                                  |

All RPCs are `security definer` and run `set search_path = public`
(structural guards in `subscription-migrations.test.ts`).

## 3. Identity & authorization

- **User identity**: billing server actions resolve it exclusively via
  `supabase.auth.getUser()`; the only formData fields are intents
  (`plan_id`, `idempotency_key`, `checkout_id`, `outcome`) — no identity
  field is ever accepted (source-contract test-pinned in
  `billing-page.test.ts` + `billing-security-isolation.test.ts`).
- **Admin identity**: `/api/admin/users/[id]` derives the actor from the
  session (`requireAdmin()`), checks `isUuid` on the path target, applies a
  per-actor rate limit, and validates the body against a strict
  action-enum schema. Every action is written to `admin_audit_log`
  (actor, target, action, details).
- **Service role**: `createAdminClient()` is the only service-role
  constructor; it is imported exclusively by `server-only` modules
  (test-pinned: no `"use client"` file may import it or reference
  service-role identifiers; every billing module that touches Supabase is
  `server-only`).
- **Webhook**: `/api/billing/webhook` answers 501
  `billing_provider_not_configured` — it never validates, mutates, or
  pretends to process payment events.

## 4. Cross-user isolation (test-pinned)

- `getMockCheckout(userId, checkoutId)`: dual filter `id = …` **and**
  `user_id = …` (a guessed checkout id of another user returns no row).
- `getBillingStatus` / `resolveSubscription`: single row lookup scoped to
  the session `user_id` only.
- Payment history facade: `mock_checkouts` by `user_id`,
  `admin_audit_log` by `target_user_id` (the user's own grants).
- Admin list: `listAdminUsers` is the only surface that sees other users —
  admin-only route + admin-only table page (gated by `requireAdmin`).

## 5. Log & data-exposure review

- Admin layout: `console.error` on action failure — server-side only, no
  secret material (action/error codes at most).
- `account-data.ts` export: includes the user's **own** subscription
  (whitelisted fields) — self-scoped, no other users' data.
- No billing secret is ever rendered: no token, key, or service-role
  material appears in any page/action source (boundary test-pinned).

## 6. Known issues & limitations (honest)

1. **Canonical `20261121` refund leak** (`release_feature_op`): fixed on
   branch `fix/20261121-complete-feature-op-begin` @ `6f95b1d` (validated on
   PG14); production carries the defective version until the pending repair
   (`fix/20261124-production-repair` @ `42c2cf3`, runbook
   `project/production-repair-runbook-2026-10-24.md`) is approved & applied.
   NOT re-implemented by this work.
2. **CI has no PostgreSQL**: this repo's test matrix (vitest/tsc/eslint/
   build) pins the SQL _text_ (full-directory, drop-netted, parser
   self-tested) and the _service behavior_. Database-level verification is
   available via `tests/billing-rls-pg.test.ts` on any machine with a local
   PostgreSQL — it skips honestly when unavailable, and a green CI suite
   never claims DB-level verification it did not run. (Prior sessions
   verified the RLS/RPC surface on local PG14 — clean DB + production-like
   clone — from the earlier host; that host is no longer the audit
   environment.)
3. **One production data issue open**: the `pro | active | manual` row whose
   `user_id` ≠ intended account. Resolution is two deliberate admin actions
   (grant to intended user, cancel orphan) — never a transfer, never
   automatic (see `project/subscription-visibility-next-actions-2026-10-24.md`).
4. **No real payment provider**: see `docs/billing-payment-capabilities.md`.
   The webhook seam exists; until a provider is configured, no online
   payment data can exist and the UI says so explicitly.

## 7. Wrong-user subscription — operational procedure (no code)

Diagnose (read-only): `/admin/users` (email + plan + status + period end)
and the diagnostics branch `docs/billing-diagnostics` (D1/D2).
Resolve: two confirmed admin actions — `set_plan pro` on the intended user
(writes that user's own row), then `cancel_subscription` on the orphan
(row keeps its history; entitlements revert to Free immediately).
Forbidden: `UPDATE subscriptions SET user_id = …`, any auto-reassignment.
Prevention: PR `feat/billing-admin-action-confirmation` makes every action
name the target e-mail before it fires.
