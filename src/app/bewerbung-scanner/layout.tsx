import { redirect } from "next/navigation";
import { getCurrentUserAndProfile } from "@/lib/auth";
export const dynamic = "force-dynamic";
export default async function ScannerLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const { user, profile } = await getCurrentUserAndProfile();
  if (!user || !profile || profile.account_status !== "active")
    redirect("/login");
  return children;
}
