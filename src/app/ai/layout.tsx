import { redirect } from "next/navigation";
import { TrialExpiredNotice } from "@/components/plan-state-notice";
import { getCurrentUserAndProfile } from "@/lib/auth";
import { getPlanGate } from "@/lib/billing/plan-gate";
export const dynamic = "force-dynamic";
export default async function AILayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const { user, profile } = await getCurrentUserAndProfile();
  if (!user || !profile || profile.account_status !== "active")
    redirect("/login");
  // Mandatory plan selection (server-authoritative, no client state): this
  // area hosts metered AI tools, so it follows the same gate as the other
  // authenticated tool areas. The settings area (plan selection itself,
  // sign-out, support) is never gated → no loop.
  const gate = await getPlanGate(user.id);
  if (gate.selectionRequired) redirect("/settings/billing");
  return (
    <>
      {gate.trialExpired && <TrialExpiredNotice />}
      {children}
    </>
  );
}
