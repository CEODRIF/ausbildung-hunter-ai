/**
 * Mock checkout — server-only facade over the two service-role RPCs
 * `create_mock_checkout` and `complete_mock_checkout`.
 *
 * Safety model (matches the migration contract):
 * - Creation and completion are gated by `mockPaymentsEnabled()` (server env
 *   check, fail closed). When the gate is off, NO database call is made.
 * - `getMockCheckout` is a plain user-scoped SELECT, deliberately NOT gated:
 *   a read can never activate anything, and in production no rows can exist
 *   because creation is gated — it resolves `not_found`.
 * - Amounts, plan limits, and entitlements always come from the server plan
 *   catalogue / `billing_plans` row — never from the client.
 * - A `succeeded` subscription row is only accepted when `provider === 'mock'`
 *   AND `mock === true`; mock transactions can never be mistaken for real
 *   payments.
 *
 * These facades never throw; every outcome is a discriminated union.
 */
import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import {
  getCommercialPlan,
  isCommercialPlanId,
} from "@/lib/billing/commercial-plans";
import { mockPaymentsEnabled } from "@/lib/billing/entitlement-service";
import { isUuidShape, parseIsoUtcMs } from "@/lib/billing/trial";

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export const MOCK_CHECKOUT_OUTCOMES = ["success", "failed", "canceled"] as const;

export type MockCheckoutOutcome = (typeof MOCK_CHECKOUT_OUTCOMES)[number];

export function isMockCheckoutOutcome(value: unknown): value is MockCheckoutOutcome {
  return (
    typeof value === "string" &&
    (MOCK_CHECKOUT_OUTCOMES as readonly string[]).includes(value)
  );
}

export type MockCheckoutStatus =
  | "pending"
  | "succeeded"
  | "failed"
  | "canceled"
  | "expired";

const MOCK_CHECKOUT_STATUSES: readonly string[] = [
  "pending",
  "succeeded",
  "failed",
  "canceled",
  "expired",
];

export function isMockCheckoutStatus(value: unknown): value is MockCheckoutStatus {
  return (
    typeof value === "string" &&
    MOCK_CHECKOUT_STATUSES.includes(value)
  );
}

export interface MockCheckoutInfo {
  id: string;
  planId: string;
  planLabel: string;
  amountCents: number;
  currency: "USD";
  status: MockCheckoutStatus;
  expiresAtMs: number;
  /** Always true — this record is a mock transaction, never a real payment. */
  isMock: true;
}

export interface MockSubscriptionInfo {
  planId: string;
  provider: "mock";
  periodStartMs: number;
  periodEndMs: number;
  /** Always true — mock-activated subscription, never a real payment. */
  isMock: true;
}

/**
 * A stored mock checkout row as returned by the read path
 * (`getMockCheckout`), for the success-page display.
 */
export interface MockCheckoutRecord {
  id: string;
  planId: string;
  amountCents: number;
  currency: "USD";
  status: MockCheckoutStatus;
  isMock: true;
  createdAtMs: number;
  expiresAtMs: number;
  subscriptionId: string | null;
}

// ---------------------------------------------------------------------------
// Shape validation (never trust the wire)
// ---------------------------------------------------------------------------

function parseCheckout(value: unknown): MockCheckoutInfo | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  if (!isUuidShape(obj.id)) return null;
  if (typeof obj.plan_id !== "string" || obj.plan_id.length === 0) return null;
  if (typeof obj.plan_label !== "string" || obj.plan_label.length === 0)
    return null;
  if (
    typeof obj.amount_cents !== "number" ||
    !Number.isFinite(obj.amount_cents) ||
    obj.amount_cents <= 0
  )
    return null;
  if (obj.currency !== "USD") return null;
  if (!isMockCheckoutStatus(obj.status)) return null;
  if (obj.is_mock !== true) return null;
  const expiresAtMs = parseIsoUtcMs(obj.expires_at);
  if (expiresAtMs === null) return null;
  return {
    id: obj.id,
    planId: obj.plan_id,
    planLabel: obj.plan_label,
    amountCents: obj.amount_cents,
    currency: "USD",
    status: obj.status,
    expiresAtMs,
    isMock: true,
  };
}

function parseMockSubscription(value: unknown): MockSubscriptionInfo | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  // provider "mock" AND explicit mock:true — a real-provider row can never
  // be rendered/accepted as a mock subscription.
  if (obj.provider !== "mock" || obj.mock !== true) return null;
  if (typeof obj.plan_id !== "string" || obj.plan_id.length === 0) return null;
  const startMs = parseIsoUtcMs(obj.current_period_start);
  const endMs = parseIsoUtcMs(obj.current_period_end);
  if (startMs === null || endMs === null || endMs <= startMs) return null;
  return {
    planId: obj.plan_id,
    provider: "mock",
    periodStartMs: startMs,
    periodEndMs: endMs,
    isMock: true,
  };
}

/** created_at / expires_at from PostgREST may arrive as ISO string or number. */
function toMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return parseIsoUtcMs(value);
}

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

export type CreateMockCheckoutResult =
  | { ok: true; status: "created" | "existing"; checkout: MockCheckoutInfo }
  | {
      ok: false;
      error: "mock_payments_disabled" | "invalid_input" | "invalid_plan" | "failed";
    };

/**
 * Start (or idempotently resume) a mock checkout for a commercial plan.
 * The idempotency key makes duplicate submissions safe; a foreign key
 * collision surfaces as `failed` (the RPC raises `idempotency_conflict`).
 */
export async function createMockCheckout(
  userId: string,
  planId: string,
  idempotencyKey: string,
): Promise<CreateMockCheckoutResult> {
  if (!mockPaymentsEnabled())
    return { ok: false, error: "mock_payments_disabled" };
  if (!isUuidShape(userId) || !isUuidShape(idempotencyKey))
    return { ok: false, error: "invalid_input" };

  // Server-side plan validation: only priced, commercial plans may be
  // checked out (the trial is excluded, as are any unknown identifiers).
  const plan = isCommercialPlanId(planId) ? getCommercialPlan(planId) : null;
  if (!plan || !plan.isCommercial || plan.priceCents <= 0)
    return { ok: false, error: "invalid_plan" };

  let admin: ReturnType<typeof createAdminClient>;
  try {
    admin = createAdminClient();
  } catch {
    return { ok: false, error: "failed" };
  }

  let data: unknown;
  try {
    const res = await admin.rpc("create_mock_checkout", {
      p_user_id: userId,
      p_plan_id: plan.id,
      p_idempotency_key: idempotencyKey,
    });
    if (res.error) return { ok: false, error: "failed" };
    data = res.data;
  } catch {
    return { ok: false, error: "failed" };
  }

  const obj = (Array.isArray(data) ? data[0] : data) as
    | Record<string, unknown>
    | null;
  if (!obj || typeof obj !== "object") return { ok: false, error: "failed" };

  if (obj.status !== "created" && obj.status !== "existing")
    return { ok: false, error: "failed" };

  const checkout = parseCheckout(obj.checkout);
  if (!checkout) return { ok: false, error: "failed" };

  return { ok: true, status: obj.status, checkout };
}

// ---------------------------------------------------------------------------
// complete
// ---------------------------------------------------------------------------

export type CompleteMockCheckoutResult =
  | { ok: true; status: "succeeded"; subscription: MockSubscriptionInfo }
  | { ok: true; status: "already_succeeded" }
  | {
      ok: false;
      error:
        | "mock_payments_disabled"
        | "invalid_input"
        | "not_found"
        | "terminal"
        | "expired"
        | "payment_failed"
        | "canceled"
        | "failed";
    };

/**
 * Simulate the payment outcome for an existing checkout. Only `success`
 * can grant a (mock) subscription; the transition happens atomically in
 * Postgres inside the RPC (FOR UPDATE on the checkout row).
 */
export async function completeMockCheckout(
  userId: string,
  checkoutId: string,
  outcome: string,
): Promise<CompleteMockCheckoutResult> {
  if (!mockPaymentsEnabled())
    return { ok: false, error: "mock_payments_disabled" };
  if (!isUuidShape(userId) || !isUuidShape(checkoutId))
    return { ok: false, error: "invalid_input" };
  if (!isMockCheckoutOutcome(outcome))
    return { ok: false, error: "invalid_input" };

  let admin: ReturnType<typeof createAdminClient>;
  try {
    admin = createAdminClient();
  } catch {
    return { ok: false, error: "failed" };
  }

  let data: unknown;
  try {
    const res = await admin.rpc("complete_mock_checkout", {
      p_checkout_id: checkoutId,
      p_user_id: userId,
      p_outcome: outcome,
    });
    if (res.error) return { ok: false, error: "failed" };
    data = res.data;
  } catch {
    return { ok: false, error: "failed" };
  }

  const obj = (Array.isArray(data) ? data[0] : data) as
    | Record<string, unknown>
    | null;
  if (!obj || typeof obj !== "object") return { ok: false, error: "failed" };

  switch (obj.status) {
    case "succeeded": {
      const subscription = parseMockSubscription(obj.subscription);
      if (!subscription) return { ok: false, error: "failed" };
      return { ok: true, status: "succeeded", subscription };
    }
    case "already_succeeded":
      // Idempotent no-op: the subscription was already activated.
      return { ok: true, status: "already_succeeded" };
    case "not_found":
      return { ok: false, error: "not_found" };
    case "terminal":
      // Already failed/canceled/expired — no state change, no entitlement.
      return { ok: false, error: "terminal" };
    case "expired":
      return { ok: false, error: "expired" };
    case "failed":
      return { ok: false, error: "payment_failed" };
    case "canceled":
      return { ok: false, error: "canceled" };
    case "plan_error":
      // Plan/duration lookup failed inside the RPC; never surface details.
      return { ok: false, error: "failed" };
    default:
      return { ok: false, error: "failed" };
  }
}

// ---------------------------------------------------------------------------
// read (success page)
// ---------------------------------------------------------------------------

export type GetMockCheckoutResult =
  | { ok: true; checkout: MockCheckoutRecord }
  | { ok: false; error: "invalid_input" | "not_found" | "failed" };

/**
 * Read-only, user-scoped lookup of a stored mock checkout for display on
 * the success page. NOT gated by `mockPaymentsEnabled()` (a SELECT can
 * never activate an entitlement, and in production no rows can exist
 * because creation is gated — it resolves `not_found`).
 *
 * Rows that fail shape validation (or are not mock rows) resolve
 * `not_found` — they are never rendered as valid.
 */
export async function getMockCheckout(
  userId: string,
  checkoutId: string,
): Promise<GetMockCheckoutResult> {
  if (!isUuidShape(userId) || !isUuidShape(checkoutId))
    return { ok: false, error: "invalid_input" };

  let admin: ReturnType<typeof createAdminClient>;
  try {
    admin = createAdminClient();
  } catch {
    return { ok: false, error: "failed" };
  }

  // Untyped admin client: the builder resolves to a structural response.
  let res: { data: unknown; error: unknown };
  try {
    res = (await admin
      .from("mock_checkouts")
      .select(
        "id, plan_id, amount_cents, currency, status, is_mock, created_at, expires_at, subscription_id",
      )
      .eq("id", checkoutId)
      .eq("user_id", userId)
      .maybeSingle()) as { data: unknown; error: unknown };
  } catch {
    return { ok: false, error: "failed" };
  }
  if (res.error) return { ok: false, error: "failed" };

  const row = (Array.isArray(res.data) ? res.data[0] : res.data) as
    | Record<string, unknown>
    | null;
  if (!row || typeof row !== "object")
    return { ok: false, error: "not_found" };

  if (row.is_mock !== true) return { ok: false, error: "not_found" };
  if (!isUuidShape(row.id)) return { ok: false, error: "not_found" };
  if (typeof row.plan_id !== "string" || row.plan_id.length === 0)
    return { ok: false, error: "not_found" };
  if (
    typeof row.amount_cents !== "number" ||
    !Number.isFinite(row.amount_cents) ||
    row.amount_cents <= 0
  )
    return { ok: false, error: "not_found" };
  if (row.currency !== "USD") return { ok: false, error: "not_found" };
  if (!isMockCheckoutStatus(row.status))
    return { ok: false, error: "not_found" };

  const createdAtMs = toMs(row.created_at);
  const expiresAtMs = toMs(row.expires_at);
  if (createdAtMs === null || expiresAtMs === null)
    return { ok: false, error: "not_found" };

  const subscriptionId =
    typeof row.subscription_id === "string" && row.subscription_id.length > 0
      ? row.subscription_id
      : null;

  return {
    ok: true,
    checkout: {
      id: row.id,
      planId: row.plan_id,
      amountCents: row.amount_cents,
      currency: "USD",
      status: row.status,
      isMock: true,
      createdAtMs,
      expiresAtMs,
      subscriptionId,
    },
  };
}
