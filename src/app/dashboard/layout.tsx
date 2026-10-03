import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { getCurrentUserAndProfile } from "@/lib/auth";
import { getCommunityUnreadCount } from "@/lib/community/server";

export const dynamic = "force-dynamic";

export default async function DashboardLayout({
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
  // Confirmed but the profile row is missing or still pending: safe fallback
  // (the on_auth_user_email_confirmed trigger activates the profile; a
  // confirmed user in this state has inconsistent account data).
  if (!profile || profile.account_status === "pending") redirect("/verify");
  if (!profile.selected_goal) redirect("/onboarding");
  const communityUnread = await getCommunityUnreadCount(profile.id);
  return (
    <AppShell profile={profile} communityUnread={communityUnread}>
      {children}
    </AppShell>
  );
}
