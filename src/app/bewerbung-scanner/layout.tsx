import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { TrialExpiredNotice } from "@/components/plan-state-notice";
import { getCurrentUserAndProfile } from "@/lib/auth";
import { getPlanGate } from "@/lib/billing/plan-gate";

export const dynamic = "force-dynamic";

export default async function ScannerLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const { user, profile } = await getCurrentUserAndProfile();
  if (!user || !profile || profile.account_status !== "active")
    redirect("/login");
  // Mandatory plan selection (server-authoritative, no client state): an
  // account that never selected a plan lands on the plan page; an expired
  // trial keeps access and shows the red banner instead. The settings area
  // (plan selection itself, sign-out, support) is never gated → no loop.
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
