import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { getCurrentUserAndProfile } from "@/lib/auth";
import { PLATFORM_OWNER_USER_ID } from "@/lib/notifications/admin";

export const dynamic = "force-dynamic";

export default async function ApplicationsLayout({
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
