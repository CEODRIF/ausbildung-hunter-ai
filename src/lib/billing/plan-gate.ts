import "server-only";

import { resolveSubscription } from "./entitlement-service";

/**
 * Mandatory plan-selection gate (docs/subscription-system-design-2026-10-24
 * §2/§5). Evaluated SERVER-side from trusted records on every request to an
 * authenticated tool area — never from client state.
 *
 *   selectionRequired — the account has NO selection at all: no
 *   subscription row AND the one-trial stamp was never set (NO_PLAN).
 *   The app redirects to /settings/billing (plan selection).
 *
 *   trialExpired — the account's one 72 h trial row exists but its period
 *   has ended. The layouts render the prominent localized red banner
 *   (TrialExpiredNotice); the engine has already revoked the trial-only
 *   entitlements (the row resolves to the no-matrix state).
 *
 * Rules that keep users un-trapped (D6 + safe exits):
 *   - lookup failure ⇒ NEITHER flag: a transient DB error must not bounce
 *     users who DO have a plan (and the engine already denies metered
 *     features fail-closed);
 *   - canceled / expired / admin-granted rows ⇒ never selectionRequired
 *     (a historical selection exists; the engine decides what it grants);
 *   - the redirect TARGET (/settings/billing) is never itself gated, so no
 *     redirect loop is possible; sign-out, settings, onboarding and support
 *     stay reachable in every state.
 */
export interface PlanGate {
  selectionRequired: boolean;
  trialExpired: boolean;
}

export async function getPlanGate(
  userId: string,
  nowMs: number = Date.now(),
): Promise<PlanGate> {
  const sub = await resolveSubscription(userId, nowMs);
  if (sub.lookupFailed) {
    return { selectionRequired: false, trialExpired: false };
  }
  // No row at all = never selected (trial_activated_at lives on the row, so
  // a missing row means the one-shot trial was never activated either).
  const selectionRequired = sub.row === null;
  const row = sub.row;
  const trialExpired =
    row !== null && row.plan === "trial" && sub.status === "expired";
  return { selectionRequired, trialExpired };
}
