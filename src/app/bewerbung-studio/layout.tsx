import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { TrialExpiredNotice } from "@/components/plan-state-notice";
import { getCurrentUserAndProfile } from "@/lib/auth";
import { getPlanGate } from "@/lib/billing/plan-gate";

export const dynamic = "force-dynamic";

/**
 * AI Bewerbung Studio — route gate.
 *
 * Same account lifecycle as the dashboard: unauthenticated → /login,
 * unconfirmed → /verify, suspended → login error, pending/no profile →
 * /verify, no goal → /onboarding, no plan selected → /settings/billing.
 * The shell (nav + language/theme + trial banner) is identical to every
 * other app page; the page itself renders the one-page Studio workflow.
 */
export default async function StudioLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const { user, profile } = await getCurrentUserAndProfile();
  if (!user) redirect("/login");
  // /verify is reserved for users who have NOT confirmed their email (the
  // Supabase confirmation-link flow). A confirmed user must never bounce
  // back to /verify.
  if (!user.email_confirmed_at) redirect("/verify");
  if (profile?.account_status === "suspended")
    redirect("/login?error=suspended");
  if (!profile || profile.account_status === "pending") redirect("/verify");
  if (!profile.selected_goal) redirect("/onboarding");
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
