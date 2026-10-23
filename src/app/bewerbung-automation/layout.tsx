import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { getCurrentUserAndProfile } from "@/lib/auth";

export const dynamic = "force-dynamic";

/**
 * /bewerbung-automation — authenticated shell.
 *
 * Mirrors the existing feature layouts exactly (deckblatt / opportunities):
 * logged-in, ACTIVE users only (anything else redirects to the EXISTING
 * login — no new auth system), rendered inside the global AppShell (desktop
 * sidebar / mobile bottom nav + drawer). The feature itself is fully isolated:
 * it reads/writes only its own `bew_*` tables through the dedicated engine
 * and reuses the shared sending/quota primitives unmodified.
 */
export default async function BewerbungAutomationLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const { user, profile } = await getCurrentUserAndProfile();
  if (!user || !profile || profile.account_status !== "active")
    redirect("/login");
  return (
    <AppShell profile={profile}>
      {children}
    </AppShell>
  );
}
