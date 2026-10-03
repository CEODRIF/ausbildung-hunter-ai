import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { getCurrentUserAndProfile } from "@/lib/auth";
import { getCommunityUnreadCount } from "@/lib/community/server";

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
  const communityUnread = await getCommunityUnreadCount(profile.id);
  return (
    <AppShell profile={profile} communityUnread={communityUnread}>
      {children}
    </AppShell>
  );
}
