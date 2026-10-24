import Link from "next/link";
import { getServerT } from "@/lib/i18n/server";

/**
 * Prominent red "trial expired" banner — server-authoritative (rendered by
 * the authenticated layouts only when `getPlanGate` reports the account's
 * 72 h trial has ended; never for a valid active subscription of any kind).
 *
 * It is a NOTICE, not a wall: account settings, sign-out and the plan
 * selection page stay reachable while it is shown. Localized through the
 * standard dictionary (de/en/fr/ar — a missing language key is a compile
 * error).
 */
export async function TrialExpiredNotice() {
  const t = await getServerT();
  return (
    <div role="alert" className="mx-auto mb-4 w-full max-w-7xl px-3 sm:px-6">
      <div className="flex flex-col gap-2 rounded-xl border-2 border-danger bg-danger/10 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm font-bold text-danger">
          {t("billing.trialExpired")}
        </p>
        <Link
          href="/settings/billing"
          className="inline-flex w-fit items-center justify-center rounded-lg bg-danger px-4 py-2 text-sm font-bold text-white hover:opacity-90"
        >
          {t("billing.trialExpiredCta")}
        </Link>
      </div>
    </div>
  );
}
