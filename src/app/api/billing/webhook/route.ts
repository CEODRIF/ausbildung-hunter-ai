import { NextResponse } from "next/server";
import { verifyBillingWebhook } from "@/lib/billing/provider";

/**
 * Payment-provider webhook seam. No provider is configured, so this route
 * ALWAYS answers 501 with the explicit reason — it never validates, never
 * mutates state, and never pretends to speak a provider protocol. When a
 * real provider is configured in `src/lib/billing/provider.ts`, this
 * route is the (only) place that becomes provider-aware.
 */
export async function POST(request: Request): Promise<NextResponse> {
  let payload: unknown = null;
  try {
    payload = await request.json();
  } catch {
    payload = null;
  }
  const signature = request.headers.get("x-billing-signature");
  const result = await verifyBillingWebhook(payload, signature);
  if (!result.ok) {
    return NextResponse.json(
      { error: "billing_provider_not_configured", reason: result.reason },
      { status: 501 },
    );
  }
  // Unreachable while no provider is configured; a future provider
  // implementation handles its verified events here (server-side).
  return NextResponse.json({ ok: true, event: result.event.event });
}
