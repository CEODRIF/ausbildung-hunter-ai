# Payment capabilities — what is persisted, what is missing

Date: 2026-10-24 · Status: documentation of the current, **implemented** state.
No mock checkout is enabled in production; no real payment provider is connected.

## 1. Payment provider status

- **No real payment provider is configured.** `src/lib/billing/provider.ts`
  defines the `BillingProvider` seam; the only implementation is
  `ManualBillingProvider` with `configured: false`.
- The webhook endpoint `/api/billing/webhook` answers **501
  `billing_provider_not_configured`** — it never parses or "accepts" a
  payment event.
- Consequence: **there are no real charges, invoices, receipts, or stored
  payment methods** anywhere in the system. The UI must never imply
  otherwise (the history section shows an explicit "no online provider"
  notice while `providerConfigured === false`).

## 2. Persisted payment/subscription data

| Table                 | Contents                                                                                                     | RLS                                      | Read path                                                    |
| --------------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------- | ------------------------------------------------------------ |
| `subscriptions`       | One row per user: plan, status, provider (`manual` today; `mock` reserved), period, `trial_activated_at`     | self-read only; **no user write policy** | `resolveSubscription` (service role, user-scoped)            |
| `mock_checkouts`      | Simulated demo transactions. DB-constrained `is_mock = true`, `currency = 'USD'`, positive amount            | **no policies — service-role only**      | `getPaymentHistory` / `getMockCheckout` (user-scoped SELECT) |
| `subscription_events` | Append-only lifecycle events (trial, mock checkout lifecycle) written by the RPCs                            | **no policies — service-role only**      | not exposed in the UI (internal audit)                       |
| `admin_audit_log`     | Every admin action (set_plan, cancel, reactivate, grant/revoke admin) with actor, target, details, timestamp | **no policies — service-role only**      | `getPaymentHistory` (target-scoped SELECT)                   |

- `mock_checkouts` is **always empty in production**: creation is gated by
  `mockPaymentsEnabled()`, which requires `MOCK_PAYMENTS_ENABLED=true` **and**
  a non-production runtime. Rows can only exist in dev/preview, and are
  explicitly labeled "Simulated (demo)" — they can never be mistaken for a
  real charge (`is_mock` is DB-forced and re-validated on read).
- Manual grants are **not payments**. The UI distinguishes them as
  "Manual subscription changes" with the granted plan/period and date.

## 3. What the UI shows (and honestly omits)

`/settings/billing` → "Payment & subscription history" section:

- Online payments: exactly the persisted `mock_checkouts` rows of the
  session user (newest 50), each labeled simulated; **honest empty state**
  when none exist.
- Manual changes: exactly the persisted `admin_audit_log` rows
  (set_plan / reactivate / cancel) targeting the session user (newest 50).
- Any read failure renders an explicit "history unavailable" note — the
  section never fabricates or placeholder data.

## 4. Missing capabilities (documented, not silently hidden)

- Real payment provider integration (Stripe or similar) — seam exists in
  `provider.ts`; not implemented.
- Receipts/invoices, payment methods, refunds — no data model exists.
- Renewal/billing cycles — manual `set_plan` durations (1/30/365 days);
  there is no automatic renewal.
- If a provider is added later: store verified transactions in a
  new table (never `mock_checkouts`), set `configured: true`, implement
  webhook verification with signature checks, and extend this document.

## 5. Non-goals / safety invariants (test-pinned)

- Mock checkout stays **disabled in production** (env matrix tested).
- No payment data is ever accepted from the browser; identity comes from
  the server session only.
- No subscription is ever transferred between users (admin `set_plan`
  writes the target user's own row; there is no transfer action).
- **Two-layer user scoping**: every history query filters by
  `user_id`/`target_user_id` AND the facade re-validates the scoping
  column on each returned row — a regression in either layer cannot
  render another user's transactions (test-pinned with a
  filter-ignoring database emulation).

## 6. History scope honesty

The "Manual subscription changes" list contains EXACTLY the three
subscription actions that are audited (`set_plan`,
`reactivate_subscription`, `cancel_subscription`) — it is NOT a complete
subscription lifecycle event feed (e.g. trial activation and mock
checkout lifecycle live in `subscription_events`, which is an internal
audit table and is intentionally not exposed per-user). The UI must not
imply otherwise.
