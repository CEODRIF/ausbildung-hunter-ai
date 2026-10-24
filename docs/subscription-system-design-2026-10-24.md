# Subscription system — architecture, state machine & plan matrix (2026-10-24)

Base: `main` @ `1ce6542` (incl. merged PRs #67–#70) **+ PR #71** (entitlement
enforcement, unmerged — this branch stacks on `0fd00fe`).

This document is the single design reference for the complete subscription
system: mandatory plan selection, the 72-hour trial, paid selection (pending
until verified), admin plan management, the canonical entitlement engine, and
the read-only reconciliation report.

**Revision (2026-10-24, PR #72): the permanent Free plan is REMOVED.** The
system now has exactly three plan states — one-shot 72 h Free Trial, paid
Plus, paid Pro. The historical `free` row value survives ONLY as a read-only
legacy state: it grants nothing, is never written by new code, and is treated
as "no valid selection" by the plan gate (see §2, §3, decision D9, §9).

---

## 1. Facts from the codebase (what already exists)

| Fact                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Location                                                                                                              |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| 72 h trial RPC, atomic, one-trial guard (`trial_activated_at` + `FOR UPDATE`), service-role only, writes `plan='trial'`, `status='active'`, `current_period_start/end` (+72 h), `trial_activated_at`, `subscription_events.trial_activated`                                                                                                                                                                                                                                       | `supabase/migrations/20261120000000_subscription_billing_v2.sql:242–365`                                              |
| Trial matrix already seeded in `billing_plans` (ai 5/d, cover_letter 1/d, resume_ai 1/cycle, scanner 1/cycle, deckblatt 1/d, email_drafts 3/d, opp_search 5/d, saved_opp 3 items, saved_apps 3 items, automation 0, upload 2 MB; emails 3/d, ai 5/d)                                                                                                                                                                                                                              | `20261120000000:87–88`                                                                                                |
| `activate_trial` is already ID-pure: re-activation returns `trial_already_used` (no restart); a paid-active user gets `paid_active`                                                                                                                                                                                                                                                                                                                                               | `src/lib/billing/trial.ts` + RPC                                                                                      |
| Engine: `resolveSubscription` / `checkFeature` / `reserveFeatureOp` / `assertSavedApplicationCapacity` / `classifyRawSubscription`; expiry computed per evaluation (no job, no cache); fail-closed on lookup error; the explicit non-commercial matrix (`NON_COMMERCIAL_FEATURE_LIMITS`) for free fallback + legacy plus/pro                                                                                                                                                      | `src/lib/billing/entitlement-service.ts` (PR #71)                                                                     |
| Engine branch condition: `isCommercialPlanId(sub.planId)` = `trial                                                                                                                                                                                                                                                                                                                                                                                                                | premium_10d                                                                                                           | premium_monthly` → plan-row matrix; everything else → non-commercial matrix | `commercial-plans.ts:51–55` |
| **plus/pro `billing_plans` rows: `feature_limits = '{}'`, `is_commercial = false`, `duration_kind='none'`, price 0; only legacy columns emails_per_day 150/500, ai_requests_per_day 400/1500**                                                                                                                                                                                                                                                                                    | `20261001000000:31–34` (no later update)                                                                              |
| Mock checkout: `create_mock_checkout` / `complete_mock_checkout` RPCs + `mock_checkouts` table (`is_mock=true` constraint, `idempotency_key` unique); `complete` upserts the subscription row (`provider='mock'`); server action gated by `mockPaymentsEnabled()` (env + non-production only); webhook route is a 501 no-op — **no real payment provider exists**                                                                                                                 | `20261122000000`, `src/app/settings/billing/actions.ts`, `src/app/api/billing/webhook/route.ts`                       |
| Admin: `requireAdmin()` (server session → `admins` table), `POST /api/admin/users/[id]` (strict body: action + plan plus/pro + periodDays 1/30/365; actor never client-sent), two-step confirmation UI (names target e-mail + action label; cancel = no request; exactly one request on confirm), non-atomic TS service-role writes, `admin_audit_log` (`actor_id, target_user_id, action, details jsonb, created_at` — writer currently fire-and-forget, no before/after/reason) | `src/lib/billing/admin.ts`, `src/app/api/admin/users/[id]/route.ts`, `src/components/admin-user-actions.tsx` (PR #69) |
| `subscriptions.user_id UNIQUE` → exactly one subscription row per user (canonical state)                                                                                                                                                                                                                                                                                                                                                                                          | `20261001000000:52`                                                                                                   |
| AppShell is a client component shared by 8 authenticated layouts; settings layout has NO plan gate (safe exit); onboarding redirects to /dashboard once a goal is set                                                                                                                                                                                                                                                                                                             | `src/components/app-shell.tsx`, layouts                                                                               |
| i18n: dictionaries de (source) / en / fr / ar — a missing key in any language is a TS error                                                                                                                                                                                                                                                                                                                                                                                       | `src/lib/i18n/dictionaries.ts`                                                                                        |

## 2. Canonical subscription state machine (server-authoritative)

One row per user (`subscriptions.user_id UNIQUE`). Every state is derived at
request time from (row, `billing_plans` row, `mock_checkouts`) — never from
client state, labels, or cached values.

```
                    ┌────────────────────────────────────────────┐
                    │  NO_PLAN  (no row, trial never activated)  │  ← mandatory
                    └───────────────┬────────────────────────────┘    selection
                       user selects │ (trial: activate_trial RPC — atomic, once)
                    ┌───────────────▼──────────┐   paid choice (mock checkout,
                    │ TRIAL_ACTIVE (72 h UTC)  │    only when mockPaymentsEnabled;
                    └───────────────┬──────────┘    otherwise stays NO_PLAN + notice)
              72 h elapse (computed │                user completes verified checkout
             on every evaluation)   │                          ┌────────────▼────────────┐
                    ┌───────────────▼──────────┐               │ PAID_ACTIVE (premium_10d │
                    │ TRIAL_EXPIRED            │               │  or premium_monthly,     │
                    └───┬──────────────┬───────┘               │  provider='mock' until a │
        selects again   │              │ cancels/admin         │  real provider exists)   │
                    ┌───▼────────┐     └────────────────────────┤──────────────┬───────────┘
                    │ NO_PLAN    │    admin set_plan plus/pro   └──────────────▼───────────┐
                    │ (one-shot  │    (provider='manual', 1/30/365 d)       ┌──────────────▼─────┐
                    │  trial:    │                                          │ ADMIN_ACTIVE       │
                    │  no second │                                          │ (plus / pro)      │
                    │  trial)    │                                          └──────┬──────────┬──┘
                    └────────────┘                             period end passes    │          │ user/admin cancels
                                                                 ┌───────────────────▼──┐  ┌───▼──────────────┐
                    ┌────────────────────────────────────────────┤ PAID/ADMIN_EXPIRED │  │ CANCELED         │
                    │  every active state can also become:      └──────────────────────┘  │ (entitlements END│
                    │  CANCELED (at cancellation) or EXPIRED                              │  AT cancellation;│
                    └─────────────────────────────────────────────────────────────────── │  period end =    │
                    LOOKUP_FAILED (DB error/missing plan row) — strictly worse than      │  display only)   │
                    every state: all metered features denied, no selection redirect      └──────────────────┘
```

Rules (all evaluated server-side, per request):

1. **NO_PLAN** — no subscription row and `trial_activated_at` null, **OR only
   the historical `free` row** (D9: the permanent Free plan was removed — a
   `free` row grants nothing and is no longer a valid selection). →
   **mandatory plan selection**: protected app areas redirect to
   `/settings/billing`. (After the one trial is used, `trial_activated_at` is
   set ⇒ the row is a trial row ⇒ the user is in TRIAL_EXPIRED, never back in
   NO_PLAN.)
2. **TRIAL_ACTIVE** — row `plan='trial'`, `status='active'`, `current_period_end
   > now` (UTC). Trial = exactly 72 h after activation (`fixed_hours/72`, the
   > canonical duration — NOT calendar days). One per account (RPC-enforced).
3. **TRIAL_EXPIRED** — row `plan='trial'` whose period end has passed. Trial-only
   entitlements revoked by the engine (the row resolves to the explicit
   NO-ENTITLEMENT matrix — every protected feature 0, D9). There is NO
   fallback Free tier. Red localized banner; authentication, account, own data
   (RLS reads), settings, plan selection and sign-out remain reachable; no
   account or data is deleted or deactivated.
4. **PENDING_CHECKOUT** — a `mock_checkouts` row with `status='pending'` for the
   user (no subscription row yet). Grants NOTHING. Derivable state, not a
   subscription status (the `subscription_status` enum is unchanged).
5. **PAID_ACTIVE / ADMIN_ACTIVE** — `status='active'`, period not ended, known
   non-free plan. Entitlements = the plan row's `feature_limits` matrix.
   Distinction by `provider`: `mock` (verified checkout completion) vs `manual`
   (explicit, audited admin grant). **An admin grant is never displayed as a
   verified customer payment.**
6. **CANCELED** — `status='canceled'`. Entitlements end AT cancellation
   (documented Phase-12 rule); `current_period_end` is display information only.
7. **EXPIRED** — `status='expired'`, or `'active'` with the period end in the
   past (computed on every evaluation — no job, no cache).
8. **LOOKUP_FAILED / INVALID** — DB error, missing plan row, unknown plan id in
   the row. STRICTER than every state: all metered features denied
   (`lookup_error`). No selection redirect (a transient DB failure must not
   bounce users who DO have a plan — the engine already denies safely).

The historical plan label is never consulted for entitlements (PR #71 rule,
kept).

## 3. Feature → plan matrix (the canonical table)

Per-feature values: `billing_plans.feature_limits` (DB, read at runtime) for
matrix plans; the explicit `NON_COMMERCIAL_FEATURE_LIMITS` for the no-matrix
states. Quota kinds (reset semantics): per_day = 00:00 UTC; per_cycle = the
active window (72 h / 10 d / month / 30 d admin grant); items = concurrent
stored rows; none = never metered; static_mb = per-file cap.

| Feature (quota kind)         | NO_PLAN & invalid | NO ENTITLEMENT* (D9) | TRIAL (72 h)                            | PLUS (admin) | PRO (admin) | PREMIUM 10D | PREMIUM MONTHLY |
| ---------------------------- | ----------------- | -------------------- | --------------------------------------- | ------------ | ----------- | ----------- | --------------- |
| ai_assistant (per_day)       | **deny (lookup)** | 0 (denied)           | 5/d                                     | 400/d        | 1500/d      | 100/d       | 200/d           |
| cover_letter (per_day)       | **deny**          | 0 (403)              | 1/d                                     | 25/d         | 50/d        | 25/d        | 50/d            |
| resume_ai (per_cycle)        | **deny**          | 0 (403)              | 1                                       | 20           | 60          | 20          | 60              |
| scanner (per_cycle)          | **deny**          | 0 (403)              | 1                                       | 20           | 60          | 20          | 60              |
| deckblatt (per_day)          | **deny**          | 0 (denied)           | 1/d                                     | 15/d         | 30/d        | 15/d        | 30/d            |
| email_drafts (per_day)       | **deny**          | 0 (403)              | 3/d                                     | 60/d         | 120/d       | 60/d        | 120/d           |
| opportunity_search (per_day) | **deny**          | 0 (403)              | 5/d                                     | 150/d        | 300/d       | 150/d       | 300/d           |
| saved_opportunities (items)  | **deny**          | 0 (403)              | 3                                       | 200          | 500         | 200         | 500             |
| saved_applications (items)   | **deny**          | 0 (403)              | 3                                       | 200          | 500         | 200         | 500             |
| salary_calculator (none)     | allow             | allow                | allow                                   | allow        | allow       | allow       | allow           |
| automation (per_day)         | **deny**          | 0 (403)              | 0 (403)                                 | 100/d        | 250/d       | 100/d       | 250/d           |
| upload (static_mb)           | 10 MB             | 10 MB                | 2 MB                                    | 15 MB        | 15 MB       | 15 MB       | 15 MB           |
| emails/campaign (legacy)     | **deny**          | 0 (denied)           | 3/d (floor 50 for campaigns, canonical) | 150/d        | 500/d       | 100/d       | 250/d           |

\* "NO ENTITLEMENT" = any resolved state WITHOUT an active entitled plan:
the historical `free` row (D9), canceled / expired / unknown-plan rows, and
no row (unreachable in tool areas — the gate redirects). There is NO Free
fallback: ai_assistant and deckblatt are 0 (previously 100/d and 2/d), not a
grant. The 10 MB upload cap stays — it is an account baseline, not a plan
entitlement — and the quota-free salary calculator stays available.
Lookup-failed is the separate deny column (503, stricter).

**Plus/Pro columns = decision D1 below** (no canonical per-feature values exist
in the product configuration today; the mapping is explicit, documented, and
one-constant reversible).

Denial semantics (unchanged from #71): `feature_disabled`/`plan_expired` → 403,
`quota_exhausted` → 429, `lookup_error`/meter failure → 503, consistent
non-sensitive messages.

## 4. Documented decisions & gaps (no invented business rules)

- **D1 — Plus/Pro feature matrix (PRODUCT DECISION REQUIRED).** The canonical
  configuration gives plus/pro only legacy per-day columns (150/500 emails,
  400/1500 AI) and `feature_limits = '{}'` — under #71's fail-closed policy an
  active plus/pro subscription therefore granted ONLY ai/deckblatt/upload and
  disabled all 7 restricted features, which is not what the admin tool's
  "Plus · 30 days" tier is for. This PR seeds an explicit matrix (branch-only
  migration, never applied to production before review): **Plus = Premium-10d
  feature values, Pro = Premium-monthly feature values**, keeping each plan's
  own canonical AI/e-mail per-day columns (400/150, 1500/500). Rationale: the
  two admin tiers map 1:1 onto the two purchasable tiers' feature sets while
  keeping their historic (higher) AI/e-mail allowances. Values live in ONE
  migration + ONE TS mirror constant (`PLUS_PRO_FEATURE_LIMITS` in
  `plans.ts`) so the product owner can change them in one place. **Flagged for
  product sign-off in the PR.**
- **D2 — No real payment provider exists.** The webhook is a 501 no-op and the
  only activation path for paid plans is the mock checkout (env-flagged,
  non-production only — never on ausbildungsweg.net). Per the mandate: a paid
  selection stays **PENDING** and the UI explains the next step ("payment
  verification is not configured — contact support or use the free trial"); it
  NEVER activates. No credentials invented, no mock enabled in production.
- **D3 — Trial duration is exactly 72 hours** (canonical `fixed_hours/72`),
  not 3 calendar days. Start/end are UTC `timestamptz` written by the RPC.
- **D4 — Admin grants are entitlements, not payments.** `provider='manual'`;
  the UI (admin page + user billing page) renders them distinctly ("admin-
  granted"), and the audit record carries `actor_id` + `reason`.
- **D5 — Cancellation ends entitlements immediately** (Phase-12 documented
  rule, unchanged). The period end stays for display.
- **D6 — Lookup failure ⇒ no redirect, deny everything metered.** A transient
  DB outage must not trap users in the selection flow; the engine already
  fails closed.
- **D7 — The one-trial rule is absolute** (RPC-enforced, `trial_activated_at`
  never cleared). No "trial reset" by users OR admin in this PR (admin can
  grant plus/pro if a trial was consumed — the documented support path).
- **D8 — UI reference:** the User Administration screenshot was not available
  in the working environment; the existing page (user/e-mail · goal · plan+
  status · usage today · role · actions) is extended in place, keeping its
  structure.
- **D9 — The permanent Free plan is REMOVED (product decision, 2026-10-24).**
  Exactly three plan states exist: one-shot 72 h Trial, paid Plus, paid Pro.
  Consequences, all enforced server-side:
  - The engine's no-matrix states (no row, historical `free` row, canceled,
    expired, unknown plan) grant **ZERO** for every protected feature — the
    former free grants (100 AI/d, 50 e-mails/d, 2 Deckblatt/d) are gone from
    `NON_COMMERCIAL_FEATURE_LIMITS`, the legacy counter resolver
    (`entitlements.ts` fallback 0/0), and the dashboard display (0, not 100).
    Kept: authentication, profile, own-data reads (RLS), sign-out, settings,
    plan page, support contact, the 10 MB upload baseline (account
    functionality), the quota-free salary calculator.
  - The plan gate treats a historical `free` row as **no valid selection**
    (redirect to `/settings/billing`); unknown plan ids normalize to the
    no-entitlement state — fail safe toward selection, never toward a grant.
  - DB level: migration `20261127000000_remove_free_deckblatt_fallback.sql`
    replaces the three deckblatt RPCs with the legacy fallback 0 instead of 2
    (additive `create or replace`, identical signatures/grants; 20261121 is
    not rewritten).
  - The `free` value stays in `subscriptions.plan`'s CHECK constraint —
    historical production rows must keep reading. It is history, not an
    offer: no code path ever writes `plan='free'` again, the admin RPC only
    accepts `{plus, pro}`, and no UI offers a Free card.
  - Reconciliation reports classify `free` rows as `legacy_free` (not
    `invalid` — they are expected, not errors); the admin user table shows
    them as "Kein Plan".
  - Admins can neither reactivate an expired trial (D7 unchanged) nor grant a
    free entitlement (D4: only plus/pro, audited).

## 5. Enforced flows

**New user:** register → e-mail confirm → onboarding (goal) → /dashboard →
**plan gate: NO_PLAN ⇒ redirect /settings/billing** → choose Free Trial
(`activate_trial` server action, RPC atomic) or a paid plan (mock checkout
when enabled; otherwise the pending notice D2) → revalidate → full app with
verified entitlements.

**Existing user (login):** gate evaluates the REAL state:

- active trial / active paid / active admin grant → in (banner only if
  TRIAL_EXPIRED — which is NOT active);
- TRIAL_EXPIRED / CANCELED / EXPIRED row → in, with the red trial-expired
  banner (trial rows only) and the engine denying metered tools; the plan
  page is one step away;
- NO_PLAN (no row, trial never used) → **redirect to plan selection**;
- historical `free` row (D9 — permanent Free removed) → **redirect to plan
  selection**, exactly like NO_PLAN (the row is display identity only);
- LOOKUP_FAILED → in (D6), tools denied fail-closed.

**Safe exits (never gated):** `/settings/*` (incl. plan selection itself),
onboarding, verify, sign-out (client), support contact (billing page). The
gate only fires on the tool layouts, so no redirect loop is possible: the
redirect target is always outside the gated set.

**Admin (User Administration):** search → row shows canonical state +
provider + trial start/end + period end → action (Plus·30 / Pro·30 / cancel /
reactivate) → **two-step confirmation naming e-mail, plan, duration, exact
action** → one atomic RPC (subscription write + `admin_audit_log` with
before/after/reason + `subscription_events`) → inline result. Audit trail
viewable per user (read-only endpoint, admin-only).

## 6. Atomic admin operation (new SQL RPC, branch-only migration)

`public.manage_subscription(p_actor_id, p_target_id, p_action, p_plan,
p_period_days, p_reason) → jsonb` — `security definer`, `search_path=public`,
executable by `service_role` only:

- validates `p_action ∈ {set_plan, cancel_subscription, reactivate_subscription}`,
  `p_plan ∈ {plus, pro}` (set/reactivate), `p_period_days ∈ {1,30,365}`,
  uuids — server-side, not the browser;
- `SELECT … FOR UPDATE` on the target's subscription row (serializes
  concurrent admin actions; the UNIQUE user_id guarantees the one-row
  invariant);

**P0 uniqueness question — RESOLVED (verified, no new migration needed).**
The upsert's `ON CONFLICT (user_id)` requires a unique constraint/index on
`subscriptions.user_id`. It exists since the table's original DDL
(`20261001000000`: `user_id uuid not null unique references auth.users(id)`
— an inline column-level UNIQUE, i.e. the constraint
`subscriptions_user_id_key`; this is why a naive `unique (user_id)` grep
misses it). Verified against a real disposable PostgreSQL (full migration
chain) in `tests/billing-rls-pg.test.ts` → "P0 pin": exactly one unique
constraint on `subscriptions.user_id`. Consequently duplicate rows per user
are impossible by construction; no dedup migration is required and none is
added (per the safety rules: no blind constraints, no auto-deletes).

- set/reactivate: upsert row `plan, status='active', provider='manual',
period_start=now, period_end=now + period_days days (fixed_days semantics —
the existing "· 30 days" rule), canceled_at=null`;
- cancel: `status='canceled', canceled_at=now` (period end preserved);
- writes `admin_audit_log (actor_id, target_user_id, action, details)` with
  `details = {plan, period_days, reason, before:{plan,status,provider,
period_start,period_end,canceled_at}, after:{…}}` and
  `subscription_events` (`subscription_activated` / `subscription_canceled`,
  provider `manual`) — **all in one transaction**: no audit-less mutation, no
  half-state;
- returns `{status:'ok', before, after}` (or a structured error code).

The TS route keeps `requireAdmin()` + `admin_actions` rate limit + strict zod
body; it calls the RPC with the SESSION-derived actor id. Grant/revoke admin
(orthogonal, unchanged) stay TS-side.

## 7. Reconciliation report v2 (read-only)

Extends PR #71's `GET /api/admin/subscription-reconciliation`:
classifies each account as `no_selection | trial_active | trial_expired |
paid_active | admin_granted | pending_payment | canceled | expired |
legacy_free | invalid`, adds trial start/end + period fields, the
`email_shared_with_other_account` flag (mis-link signature, kept), and a
`selection_required` flag (= NO_PLAN, incl. legacy `free` rows per D9).
`legacy_free` = the historical permanent-Free row state (expected, grants
nothing, selection required); `invalid` is reserved for rows with an UNKNOWN
plan value or a lookup failure. Still: SELECT only, capped, admin-only, no
mutation.

## 8. Out of scope (explicit)

- No production migration execution (branch-only SQL ships with the PR).
- No real payment provider integration / webhook implementation (D2).
- No trial resets, no automatic plan assignment, no reassignment of the
  mis-linked Pro account (stays a separate identity-resolution incident).
- No price/label/billing-rule changes (canonical values preserved).
- No destructive migration of historical `free` rows (see §9: they are
  re-interpreted by the application, never rewritten or deleted).

## 9. Removing the permanent Free plan — strategy & deployment order (D9)

**Production records with `plan='free'`:** re-interpreted in the application
layer only. The engine never grants them anything (no-matrix → zero
entitlements), the plan gate treats them as "no valid selection" (redirect to
plan selection), the reconciliation report lists them as `legacy_free`, and
the admin table shows them as "Kein Plan". No UPDATE, no DELETE, no
constraint change: the `free` value remains readable historical state (the
CHECK constraint keeps it), and users' rows, profiles, applications and all
stored data are untouched.

**What changed where (all in this PR):**

| Layer | Change |
| ----- | ------ |
| Engine (`entitlement-service.ts`) | No-matrix states grant 0 for every protected feature (AI, e-mail drafts, cover letter, resume AI, scanner, Deckblatt, opportunity search, saved items, automation); former `FREE_PLAN_LIMITS` (50 e-mails/100 AI) and `DECKBLATT_LEGACY_DAILY_LIMIT` (2/d) constants deleted — a missing mapping can no longer become a grant |
| Legacy counters (`entitlements.ts`) | Fallback `emailsPerDay`/`aiPerDay` 0/0 (was 50/100); the `reserve_ai_request` RPC then denies at the DB level |
| Plan gate (`plan-gate.ts`) | `free` row ⇒ `selectionRequired` (was: counted as a valid selection) |
| Deckblatt DB RPCs | `20261127000000` — legacy fallback 2 → 0 in `get_deckblatt_usage_status` / `reserve_deckblatt_generation` / `release_deckblatt_generation` (identical signatures, security, grants; `create or replace` only) |
| Reconciliation | `free` row ⇒ `legacy_free` state (was `invalid`) |
| Admin UI | `free` row shown as "Kein Plan — Auswahl erforderlich" |
| UI text (de/en/fr/ar) | "free plan limits apply" → "no active plan — protected features are locked" |
| Dashboard display | AI limit shown = real entitlement (0 when no plan), not the former 100 default |

**Deployment order (documented, NOT executed):**

1. **Apply the new migrations first** (20261125 plus/pro matrix if not yet,
   then 20261127 deckblatt fallback). They are additive and idempotent; the
   old app code keeps working (it already denied no-plan users for
   engine-checked features; the deckblatt RPC becomes stricter, never more
   permissive).
2. **Deploy the application** (this PR). After this step the app-level
   engine denies every protected feature for no-plan users, and the gate
   redirects `free`-row users to plan selection.
3. **Verify** (read-only): reconciliation report shows `legacy_free` for the
   historical rows; no `invalid`/`unknown_plan` spikes; trial + plus/pro
   entitlements unchanged (compare before/after `stateTotals`).

Either order is safe: whichever lands first only DENIES more, never grants
more. Rollback = revert the app deployment; the DB migration is harmless on
its own (users without an entitled plan simply cannot reserve Deckblatt
generations until the app is rolled forward again or the old RPC bodies are
re-installed from 20261121).
