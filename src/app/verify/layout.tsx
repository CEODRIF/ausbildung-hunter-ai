import { redirect } from "next/navigation";
import { getCurrentUserAndProfile } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function VerifyLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const { user, profile } = await getCurrentUserAndProfile();
  if (!user) redirect("/login");
  if (profile?.account_status === "active")
    redirect(profile.selected_goal ? "/dashboard" : "/onboarding");
  return children;
}
