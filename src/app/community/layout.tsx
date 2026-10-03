import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { getCurrentUserAndProfile } from "@/lib/auth";
import { getCommunityUnreadCount } from "@/lib/community/server";

export const dynamic = "force-dynamic";

export default async function CommunityLayout({
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
