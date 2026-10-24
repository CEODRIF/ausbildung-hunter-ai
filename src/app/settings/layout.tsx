import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { TrialExpiredNotice } from "@/components/plan-state-notice";
import { getCurrentUserAndProfile } from "@/lib/auth";
import { getPlanGate } from "@/lib/billing/plan-gate";

export const dynamic = "force-dynamic";

export default async function SettingsLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const { user, profile } = await getCurrentUserAndProfile();
  if (!user || !profile || profile.account_status !== "active")
    redirect("/login");
  // The settings area is a SAFE EXIT (plan selection, account, sign-out,
  // support) — never plan-gated. The trial-expired banner still renders so
  // the state cannot be missed while the user is here.
  const gate = await getPlanGate(user.id);
  return (
    <AppShell
      profile={profile}
      topNotice={gate.trialExpired ? <TrialExpiredNotice /> : undefined}
    >
      {children}
    </AppShell>
  );
}
