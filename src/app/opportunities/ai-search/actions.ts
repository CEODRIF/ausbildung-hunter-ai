"use server";

import { getCurrentUserAndProfile } from "@/lib/auth";
import { activateQuotaCode } from "@/lib/email-campaigns";
import { getSearchCreditStatus } from "@/lib/search-credits";

/**
 * Activate a search quota-upgrade code (server-only).
 *
 * Reuses the EXISTING code system — no parallel one:
 *   activateQuotaCode() → RPC activate_quota_upgrade() (validates the code in
 *   invitation_codes, enforces one-time redemption per user and max_uses, and
 *   writes user_quota_upgrades). The resulting entitlement is then read back
 *   from the database, so the limit never comes from the client: this action
 *   takes ONLY the code — there is no parameter for a limit, and no value sent
 *   by the browser is trusted.
 */
export interface ActivateSearchUpgradeResult {
  ok: boolean;
  message: string;
  creditsRemaining?: number;
  creditLimit?: number;
  resetHours?: number;
  premium?: boolean;
}

export async function activateSearchUpgrade(
  code: string,
): Promise<ActivateSearchUpgradeResult> {
  const { user, profile } = await getCurrentUserAndProfile();
  if (!user || !profile || profile.account_status !== "active")
    return { ok: false, message: "Not authorized." };

  const trimmed = typeof code === "string" ? code.trim() : "";
  if (!trimmed) return { ok: false, message: "Enter an upgrade code." };

  try {
    // Server-side verification against invitation_codes (never in the bundle).
    await activateQuotaCode(trimmed);
  } catch (error) {
    return {
      ok: false,
      message:
        error instanceof Error
          ? error.message
          : "Unable to activate the upgrade code.",
    };
  }

  // Source of truth = the database entitlement we just granted.
  const status = await getSearchCreditStatus(user.id);
  return {
    ok: true,
    message:
      status.premium && status.creditLimit > 0
        ? `Upgrade active — ${status.creditLimit} credits every ${status.resetHours} h.`
        : "Upgrade code activated.",
    creditsRemaining: status.creditsRemaining,
    creditLimit: status.creditLimit,
    resetHours: status.resetHours,
    premium: status.premium,
  };
}
