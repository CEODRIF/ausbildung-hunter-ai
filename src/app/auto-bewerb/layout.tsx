import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { TrialExpiredNotice } from "@/components/plan-state-notice";
import { getCurrentUserAndProfile } from "@/lib/auth";
import { getPlanGate } from "@/lib/billing/plan-gate";

export const dynamic = "force-dynamic";

/**
 * /auto-bewerb — authenticated shell (AUTO BEWERB).
 *
 * Mirrors the existing feature layouts exactly (bewerbung-studio /
 * bewerbung-automation): logged-in, ACTIVE users only (anything else
 * redirects to the EXISTING login — no new auth system), rendered inside
 * the global AppShell. The feature is fully isolated: it reads/writes only
 * its own `auto_bewerb_*` tables through the dedicated engine and reuses
 * the shared storage/email/quota primitives unmodified.
 */
export default async function AutoBewerbLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const { user, profile } = await getCurrentUserAndProfile();
  if (!user || !profile || profile.account_status !== "active")
    redirect("/login");
  const gate = await getPlanGate(user.id);
  if (gate.selectionRequired) redirect("/settings/billing");
  return (
    <AppShell
      profile={profile}
      topNotice={gate.trialExpired ? <TrialExpiredNotice /> : undefined}
    >
      {children}
    </AppShell>
  );
}
