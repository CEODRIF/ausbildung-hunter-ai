import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { getCurrentUserAndProfile } from "@/lib/auth";

export const dynamic = "force-dynamic";

/**
 * Housing / Wohnen layout — same auth gate + shell as the other authenticated
 * areas. Every sub-route inherits the app shell and i18n.
 */
export default async function WohnenLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const { user, profile } = await getCurrentUserAndProfile();
  if (!user || !profile || profile.account_status !== "active") redirect("/login");
  return (
    <AppShell profile={profile}>
      {children}
    </AppShell>
  );
}
