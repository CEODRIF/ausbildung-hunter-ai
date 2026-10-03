import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { getCurrentUserAndProfile } from "@/lib/auth";
import { PLATFORM_OWNER_USER_ID } from "@/lib/notifications/admin";

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
  // Sidebar "Platform Updates" entry: server-side UID comparison.
  const isPlatformOwner = user.id === PLATFORM_OWNER_USER_ID;
  return (
    <AppShell profile={profile} isPlatformOwner={isPlatformOwner}>
      {children}
    </AppShell>
  );
}
