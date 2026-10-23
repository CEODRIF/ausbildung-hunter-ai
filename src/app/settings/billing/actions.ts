"use server";

/**
 * Billing server actions (useActionState style).
 *
 * Security rules:
 * - The user identity always comes from the SERVER session
 *   (`supabase.auth.getUser()`), never from form data. The browser may
 *   submit intents (plan id, idempotency key, outcome) — never identity.
 * - Price/quota/entitlement decisions are made inside the service facades
 *   (`activateTrial`, `createMockCheckout`, `completeMockCheckout`), which
 *   gate on server env and validate plan ids against the typed catalogue.
 * - Mock payment completion is additionally impossible in production
 *   (fail-closed env check inside the facade).
 */

import { revalidatePath } from "next/cache";

import { createClient } from "@/lib/supabase/server";
import { activateTrial } from "@/lib/billing/trial";
import {
  completeMockCheckout,
  createMockCheckout,
} from "@/lib/billing/mock-checkout";

/** Resolve the authenticated user id from the server session, or null. */
async function sessionUserId(): Promise<string | null> {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    return user?.id ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Trial activation
// ---------------------------------------------------------------------------

export type TrialActionState =
  | { status: "idle" }
  | { status: "success" }
  | { status: "trial_used" }
  | { status: "paid_active" }
  | { status: "unauthorized" }
  | { status: "failed" };

/**
 * Activate the 72-hour trial for the signed-in user. The form submits no
 * identity data — only the intent.
 */
export async function activateTrialAction(): Promise<TrialActionState> {
  const userId = await sessionUserId();
  if (!userId) return { status: "unauthorized" };

  const outcome = await activateTrial(userId);
  if (!outcome.ok) return { status: "failed" };

  if (outcome.status === "activated") {
    await revalidatePath("/settings/billing");
    return { status: "success" };
  }
  if (outcome.status === "trial_already_used") return { status: "trial_used" };
  return { status: "paid_active" };
}

// ---------------------------------------------------------------------------
// Mock checkout — start
// ---------------------------------------------------------------------------

export type MockStartActionState =
  | { status: "idle" }
  | { status: "created" | "existing"; checkoutId: string; planId: string }
  | {
      status:
        | "unauthorized"
        | "invalid_input"
        | "mock_payments_disabled"
        | "invalid_plan"
        | "failed";
    };

/**
 * Start a mock checkout for the selected commercial plan. The idempotency
 * key (client-generated per form mount) makes duplicate submissions safe:
 * the same key returns the same checkout row.
 */
export async function startMockCheckoutAction(
  _prev: MockStartActionState,
  formData: FormData,
): Promise<MockStartActionState> {
  const userId = await sessionUserId();
  if (!userId) return { status: "unauthorized" };

  const planId = formData.get("plan_id");
  const idempotencyKey = formData.get("idempotency_key");
  if (typeof planId !== "string" || typeof idempotencyKey !== "string") {
    return { status: "invalid_input" };
  }

  const result = await createMockCheckout(userId, planId, idempotencyKey);
  if (!result.ok) return { status: result.error };

  return {
    status: result.status,
    checkoutId: result.checkout.id,
    planId: result.checkout.planId,
  };
}

// ---------------------------------------------------------------------------
// Mock checkout — simulate payment outcome
// ---------------------------------------------------------------------------

export type MockSimulateActionState =
  | { status: "idle" }
  | { status: "succeeded" | "already_succeeded"; checkoutId: string }
  | {
      status:
        | "unauthorized"
        | "invalid_input"
        | "mock_payments_disabled"
        | "not_found"
        | "terminal"
        | "expired"
        | "payment_failed"
        | "canceled"
        | "failed";
      checkoutId?: string;
    };

/**
 * Simulate the payment outcome for an existing checkout. Only the
 * server-side RPC can activate a (mock) subscription — this action cannot
 * grant entitlements on its own.
 */
export async function simulateMockPaymentAction(
  _prev: MockSimulateActionState,
  formData: FormData,
): Promise<MockSimulateActionState> {
  const userId = await sessionUserId();
  if (!userId) return { status: "unauthorized" };

  const checkoutId = formData.get("checkout_id");
  const outcome = formData.get("outcome");
  const safeCheckoutId =
    typeof checkoutId === "string" ? checkoutId : undefined;
  if (typeof checkoutId !== "string" || typeof outcome !== "string") {
    return { status: "invalid_input", checkoutId: safeCheckoutId };
  }

  const result = await completeMockCheckout(userId, checkoutId, outcome);
  if (!result.ok) {
    return { status: result.error, checkoutId };
  }

  await revalidatePath("/settings/billing");
  return { status: result.status, checkoutId };
}
