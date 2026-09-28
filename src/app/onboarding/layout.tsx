import { redirect } from "next/navigation";
import { getCurrentUserAndProfile } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function OnboardingLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const { user, profile } = await getCurrentUserAndProfile();
  if (!user) redirect("/login");
  if (!profile || profile.account_status === "pending") redirect("/verify");
  if (profile.account_status === "suspended")
    redirect("/login?error=suspended");
  if (profile.selected_goal) redirect("/dashboard");
  return children;
}
