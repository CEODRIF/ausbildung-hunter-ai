import "server-only";

import { resolveSubscription } from "./entitlement-service";
import { isPlanId } from "./plans";

/**
 * Mandatory plan-selection gate (docs/subscription-system-design-2026-10-24
 * §2/§5). Evaluated SERVER-side from trusted records on every request to an
 * authenticated tool area — never from client state.
 *
 *   selectionRequired — the account has NO valid selection: no
 *   subscription row at all, OR only the historical `free` row. The
 *   permanent Free plan was removed (2026-10-24, PR #72 revision) — a
 *   `free` row grants nothing and is no longer a valid selection, so
 *   such accounts must choose an offer (one-time trial when still
 *   eligible, or a paid plan). The app redirects to /settings/billing
 *   (plan selection).
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
 *   - canceled / expired / admin-granted rows (trial, plus, pro,
 *     premium_*) ⇒ never selectionRequired (a historical selection
 *     exists; the engine decides what it grants);
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
  // A historical `free` row is NO LONGER a valid selection (permanent Free
  // plan removed 2026-10-24, PR #72 revision): it grants nothing, so the
  // account must make an explicit plan choice.
  // The isPlanId check is a second, independent fail-safe: unknown plan
  // values are already normalized to "free" by resolveSubscription, but the
  // gate must never let an invalid value through on its own — fail toward
  // plan selection, never toward a grant.
  const selectionRequired =
    sub.row === null || !isPlanId(sub.row.plan) || sub.row.plan === "free";
  const row = sub.row;
  const trialExpired =
    row !== null && row.plan === "trial" && sub.status === "expired";
  return { selectionRequired, trialExpired };
}
