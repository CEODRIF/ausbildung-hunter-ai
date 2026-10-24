import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { TrialExpiredNotice } from "@/components/plan-state-notice";
import { getCurrentUserAndProfile } from "@/lib/auth";
import { getPlanGate } from "@/lib/billing/plan-gate";

export const dynamic = "force-dynamic";

/**
 * AI Deckblatt Generator — authenticated shell.
 *
 * Mirrors the opportunities layout exactly: logged-in, ACTIVE users only
 * (anything else redirects to the EXISTING login — no new auth system),
 * rendered inside the global AppShell (desktop sidebar / mobile bottom nav
 * + drawer). The page header and its usage indicator live inside the page
 * component, so the shell's chrome stays untouched.
 */
export default async function DeckblattLayout({
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
