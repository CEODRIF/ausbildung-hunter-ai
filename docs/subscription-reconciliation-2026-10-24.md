# Existing-user reconciliation — plan & dry-run procedure (2026-10-24)

Companion to the entitlement-enforcement fix branch
`fix/subscription-entitlement-enforcement`. **No production mutation is
performed by anything in this PR.** This document defines the reviewable
strategy for existing accounts.

## 1. What changes for existing users (and why it is safe)

The entitlement resolver (`entitlement-service.ts`) already resolves every
user's state from the **persisted `subscriptions` row** on each request —
no code path creates, alters, or infers entitlements from anything else.
The fix only tightens what the **non-commercial state** (free fallback +
legacy plus/pro) grants:

| User population today                                               | Today                                                  | After the fix                                                                                                                        | Data changed?      |
| ------------------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------ |
| Valid active commercial row (trial / premium_10d / premium_monthly) | plan matrix                                            | **identical** — nothing touches commercial resolution                                                                                | no                 |
| Valid active legacy row (plus / pro)                                | ai column + deckblatt 2/day + **7 features unmetered** | ai column + deckblatt 2/day + 7 features **disabled (0)**                                                                            | no (row untouched) |
| Canceled / expired rows                                             | free fallback                                          | **identical** (already fell back to free)                                                                                            | no                 |
| No row (the large majority of accounts)                             | free fallback = de-facto unlimited                     | free fallback = **only the defined free entitlements** (AI 100/day, emails 50/day, deckblatt 2/day, upload 10 MB, salary calculator) | no                 |
| Unknown plan / unreadable DB                                        | free fallback / fail-closed                            | **identical**                                                                                                                        | no                 |

- **No user is auto-downgraded** in the data sense: subscription rows are
  never modified. A legacy plus/pro user's _defined_ entitlements (AI +
  email columns) are preserved; only the accidental unlimited default for
  the 7 undefined features is removed.
- **No user is auto-upgraded or auto-assigned a plan.**
- **The known mis-linked Pro row is NOT repaired** — it is surfaced by the
  report below for the separate identity-resolution decision.

## 2. The read-only reconciliation report

New admin endpoint (SELECTs only, `requireAdmin` + rate limit):

```
GET /api/admin/subscription-reconciliation
→ { generatedAt, read_only: true, truncated, totals: {none, active, canceled, expired, invalid}, rows: [...] }
```

Each row carries: user_id, email, profile_status, plan, status, provider,
period dates, `classified` (the same state machine the entitlement
resolver uses: none / active / canceled / expired / invalid) and `flags`:

| Flag                              | Meaning                                             | Required manual decision                                                                                                          |
| --------------------------------- | --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `unknown_plan`                    | plan value outside the known catalog                | verify data integrity                                                                                                             |
| `no_profile`                      | subscription user has no profile row                | orphaned account → ownership decision                                                                                             |
| `profile_not_active`              | profile suspended/pending                           | align account state                                                                                                               |
| `canceled_future_end`             | canceled but period end in the future               | informational: entitlement already ended at cancellation (documented rule); end date is display-only                              |
| `email_shared_with_other_account` | the holder's email is used by more than one account | **mis-link signature** (e.g. the known Pro row on the wrong user id) → separate identity-resolution incident, never auto-repaired |

### Procedure (run after the PR is merged and deployed)

1. As an admin session, call the endpoint; save the JSON (it is the
   auditable artifact).
2. Review `totals`: `invalid` must be 0 in steady state (it means the DB
   read failed while generating the report — re-run).
3. Work the flagged rows **one by one** with the owner's decision:
   - `email_shared_with_other_account` → identity resolution (which account
     is the rightful owner) — handled by the SEPARATE incident track,
     using the existing admin `set_plan` / `cancel_subscription` actions
     (audited) — never by code in this PR.
   - `no_profile` / `profile_not_active` → account-lifecycle decision.
   - `unknown_plan` → data-integrity decision.
4. Re-run the report; verify the flag count only shrinks by decided items
   (idempotent: the report changes nothing between runs).

### Properties

- **Idempotent:** pure read; two consecutive runs produce the same report
  (modulo time-based reclassification at period boundaries).
- **Auditable:** admin-session gated, rate limited, read-only; the report
  JSON is the artifact.
- **Reversible:** it mutates nothing, so there is nothing to roll back.
  Any correction taken from it uses the existing audited admin actions.
- **Bounded:** at most 5000 rows per run with an explicit `truncated` flag.

## 3. Open product decision (owner input required)

The 7 features (`cover_letter`, `resume_ai`, `scanner`, `email_drafts`,
`opportunity_search`, `saved_opportunities`, `saved_applications`) have **no
canonical Free-tier definition** in the codebase. This fix denies them for
non-commercial states (fail-closed default, mandated). If the product wants
Free tiers for any of them, set the value in `NON_COMMERCIAL_FEATURE_LIMITS`
(`src/lib/billing/entitlement-service.ts`) — single place, no second code
path — and re-run the gates.
