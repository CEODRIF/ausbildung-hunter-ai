/**
 * Payment & subscription history — READ-ONLY, user-scoped.
 *
 * The platform has NO real payment provider (see provider.ts — the
 * ManualBillingProvider seam; the webhook endpoint answers 501). The only
 * persisted "payment" data that can exist is:
 *
 *   1. `mock_checkouts` — simulated demo transactions, DB-constrained to
 *      `is_mock = true`. In production this table is always empty because
 *      checkout CREATION is env-gated off (`mockPaymentsEnabled()`); the
 *      read here is therefore a plain SELECT that can never activate
 *      anything.
 *   2. `admin_audit_log` — manual subscription changes made by
 *      administrators (set_plan / reactivate_subscription /
 *      cancel_subscription), target-scoped.
 *
 * Safety model:
 *   - Both tables have NO RLS policies (service-role only). The only access
 *     path is this server-side facade over `createAdminClient()`, scoped to
 *     the session user in TWO layers: the query filters by
 *     user_id/target_user_id AND every returned row is re-validated
 *     against the expected user id before it may be rendered.
 *   - NEVER INVENTS DATA: the UI renders exactly the persisted rows that
 *     pass shape validation; invalid rows are dropped, and empty results
 *     render the honest empty state — no placeholder transactions, no
 *     fabricated receipts.
 *   - Every result is explicitly labeled (simulated vs. manual grant); a
 *     mock row can never be rendered as a real charge (`is_mock` is
 *     DB-forced and re-checked here).
 *   - Read-only by construction: this module issues SELECTs only.
 *   - Never throws; failures resolve to a discriminated union so the page
 *     can show an "unavailable" note instead of guessing.
 */
import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { getBillingProvider } from "./provider";
import { isUuidShape, parseIsoUtcMs } from "./trial";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type OnlinePaymentStatus =
  "pending" | "succeeded" | "failed" | "canceled" | "expired";

const ONLINE_STATUSES: readonly string[] = [
  "pending",
  "succeeded",
  "failed",
  "canceled",
  "expired",
];

export type ManualGrantAction =
  "set_plan" | "reactivate_subscription" | "cancel_subscription";

const MANUAL_ACTIONS: readonly ManualGrantAction[] = [
  "set_plan",
  "reactivate_subscription",
  "cancel_subscription",
];

/** A persisted simulated (demo) checkout row. `isMock` is DB-forced true;
 *  it is never rendered as a real payment. */
export interface OnlinePaymentEntry {
  id: string;
  planId: string;
  amountCents: number;
  currency: "USD";
  status: OnlinePaymentStatus;
  createdAtMs: number;
  isMock: true;
}

/** A persisted manual subscription change by an administrator. */
export interface ManualGrantEntry {
  action: ManualGrantAction;
  /** From the audit details: granted/reactivated plan (null = n/a, e.g. cancel). */
  plan: string | null;
  /** From the audit details: granted period in days (null = unknown). */
  periodDays: number | null;
  createdAtMs: number;
}

export interface PaymentHistory {
  onlinePayments: OnlinePaymentEntry[];
  manualGrants: ManualGrantEntry[];
  /** False → the UI must state that no online payment provider is
   *  connected (manual grants only). */
  providerConfigured: boolean;
}

export type GetPaymentHistoryResult =
  | { ok: true; history: PaymentHistory }
  | { ok: false; error: "invalid_input" | "failed" };

/** Display cap per list (the history is an overview, not an export). */
const HISTORY_LIMIT = 50;

// ---------------------------------------------------------------------------
// Row validation (never trust the wire)
//
// TWO LAYERS of user scoping:
//   1. The query itself filters by user_id / target_user_id (primary).
//   2. The returned row is re-checked against the expected user id
//      (defense in depth) — if a query filter were ever removed or
//      bypassed, another user's rows would still be dropped here, not
//      rendered. The scoping column is therefore selected explicitly.
// ---------------------------------------------------------------------------

function parseOnlineRow(
  value: unknown,
  expectedUserId: string,
): OnlinePaymentEntry | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  if (obj.user_id !== expectedUserId) return null; // layer 2
  if (!isUuidShape(obj.id)) return null;
  if (typeof obj.plan_id !== "string" || obj.plan_id.length === 0) return null;
  if (
    typeof obj.amount_cents !== "number" ||
    !Number.isFinite(obj.amount_cents) ||
    obj.amount_cents <= 0
  )
    return null;
  if (obj.currency !== "USD") return null;
  if (typeof obj.status !== "string" || !ONLINE_STATUSES.includes(obj.status))
    return null;
  if (obj.is_mock !== true) return null; // DB-forced; re-checked
  const createdAtMs = parseIsoUtcMs(obj.created_at);
  if (createdAtMs === null) return null;
  return {
    id: obj.id as string,
    planId: obj.plan_id,
    amountCents: obj.amount_cents,
    currency: "USD",
    status: obj.status as OnlinePaymentStatus,
    createdAtMs,
    isMock: true,
  };
}

function parseManualRow(
  value: unknown,
  expectedUserId: string,
): ManualGrantEntry | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  if (obj.target_user_id !== expectedUserId) return null; // layer 2
  if (
    typeof obj.action !== "string" ||
    !MANUAL_ACTIONS.includes(obj.action as ManualGrantAction)
  )
    return null;
  const details =
    obj.details &&
    typeof obj.details === "object" &&
    !Array.isArray(obj.details)
      ? (obj.details as Record<string, unknown>)
      : null;
  const plan =
    details && typeof details.plan === "string" && details.plan.length > 0
      ? details.plan
      : null;
  const periodDays =
    details &&
    typeof details.period_days === "number" &&
    Number.isFinite(details.period_days)
      ? details.period_days
      : null;
  const createdAtMs = parseIsoUtcMs(obj.created_at);
  if (createdAtMs === null) return null;
  return {
    action: obj.action as ManualGrantAction,
    plan,
    periodDays,
    createdAtMs,
  };
}

// ---------------------------------------------------------------------------
// Facade
// ---------------------------------------------------------------------------

/**
 * Read the user's persisted payment/subscription history.
 * Never throws; on ANY lookup failure returns `{ok:false}` so the page can
 * show the explicit "unavailable" note (no fabricated history).
 */
export async function getPaymentHistory(
  userId: string,
): Promise<GetPaymentHistoryResult> {
  if (!isUuidShape(userId)) return { ok: false, error: "invalid_input" };

  let admin: ReturnType<typeof createAdminClient>;
  try {
    admin = createAdminClient();
  } catch {
    return { ok: false, error: "failed" };
  }

  const empty: PaymentHistory = {
    onlinePayments: [],
    manualGrants: [],
    providerConfigured: getBillingProvider().configured,
  };

  let onlineRes: { data: unknown; error: unknown };
  try {
    onlineRes = (await admin
      .from("mock_checkouts")
      .select(
        "id, user_id, plan_id, amount_cents, currency, status, is_mock, created_at",
      )
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(HISTORY_LIMIT)) as { data: unknown; error: unknown };
  } catch {
    return { ok: false, error: "failed" };
  }
  if (onlineRes.error) return { ok: false, error: "failed" };
  const onlineRows = Array.isArray(onlineRes.data) ? onlineRes.data : [];

  let manualRes: { data: unknown; error: unknown };
  try {
    manualRes = (await admin
      .from("admin_audit_log")
      .select("action, target_user_id, details, created_at")
      .eq("target_user_id", userId)
      .in("action", [...MANUAL_ACTIONS])
      .order("created_at", { ascending: false })
      .limit(HISTORY_LIMIT)) as { data: unknown; error: unknown };
  } catch {
    return { ok: false, error: "failed" };
  }
  if (manualRes.error) return { ok: false, error: "failed" };
  const manualRows = Array.isArray(manualRes.data) ? manualRes.data : [];

  return {
    ok: true,
    history: {
      onlinePayments: onlineRows
        .map((row) => parseOnlineRow(row, userId))
        .filter((row): row is OnlinePaymentEntry => row !== null),
      manualGrants: manualRows
        .map((row) => parseManualRow(row, userId))
        .filter((row): row is ManualGrantEntry => row !== null),
      providerConfigured: empty.providerConfigured,
    },
  };
}
