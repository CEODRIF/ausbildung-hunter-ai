/**
 * Phase 10 — payment-provider abstraction.
 *
 * NO external payment provider is configured. The interface below is the
 * seam a future provider (Stripe, etc.) plugs into. The only implemented
 * provider is `manual`: subscription state is managed by administrators
 * through the admin foundation, and every webhook verification returns an
 * explicit "provider not configured" result instead of faking validation.
 *
 * Implementations must never be invoked with browser-supplied state, and
 * `verifyWebhook` must return null unless the provider is configured —
 * an unconfigured provider can neither create nor cancel anything.
 */

export interface BillingProvider {
  /** Stable provider id (persisted on subscriptions.provider). */
  id: string;
  /** False → the UI must show the "billing provider not configured" state. */
  configured: boolean;
  /** Create/extend a subscription for the user (server-side only). */
  activateSubscription(input: {
    userId: string;
    plan: "plus" | "pro";
    periodDays: number;
    actorId: string;
  }): Promise<{ ok: true } | { ok: false; reason: string }>;
  /** Cancel a subscription (server-side only). */
  cancelSubscription(input: {
    userId: string;
    actorId: string;
  }): Promise<{ ok: true } | { ok: false; reason: string }>;
  /** Verify an incoming provider webhook. Unconfigured → always null. */
  verifyWebhook(
    payload: unknown,
    signature: string | null,
  ): Promise<{
    event:
      "subscription.created" | "subscription.updated" | "subscription.canceled";
    userId: string;
    plan: string;
  } | null>;
}

/** Admin-managed subscriptions: the "provider" is the admin UI itself.
 *  It is NOT a payment provider — `configured` stays false so the billing
 *  UI always shows the explicit not-configured state. */
export class ManualBillingProvider implements BillingProvider {
  readonly id = "manual";
  readonly configured = false;

  activateSubscription(): Promise<
    { ok: true } | { ok: false; reason: string }
  > {
    return Promise.resolve({
      ok: false,
      reason: "provider_not_configured",
    });
  }

  cancelSubscription(): Promise<{ ok: true } | { ok: false; reason: string }> {
    return Promise.resolve({
      ok: false,
      reason: "provider_not_configured",
    });
  }

  // Unconfigured: no payload is ever parsed, no signature ever checked.
  async verifyWebhook() {
    return null;
  }
}

let providerInstance: BillingProvider | null = null;

export function getBillingProvider(): BillingProvider {
  if (!providerInstance) providerInstance = new ManualBillingProvider();
  return providerInstance;
}

export type BillingWebhookEvent = {
  event:
    "subscription.created" | "subscription.updated" | "subscription.canceled";
  userId: string;
  plan: string;
};

/** Webhook entry used by the API route. Deterministic: an unconfigured
 *  provider returns `provider_not_configured` — never a parsed event. */
export async function verifyBillingWebhook(
  payload: unknown,
  signature: string | null,
): Promise<
  | { ok: true; event: BillingWebhookEvent }
  | { ok: false; reason: "provider_not_configured" | "invalid_signature" }
> {
  const provider = getBillingProvider();
  if (!provider.configured) {
    return { ok: false, reason: "provider_not_configured" };
  }
  const event = await provider.verifyWebhook(payload, signature);
  if (!event) return { ok: false, reason: "invalid_signature" };
  return { ok: true, event };
}
