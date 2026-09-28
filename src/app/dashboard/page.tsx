import { DashboardContent } from "@/components/dashboard-content";
import { getDashboardData } from "@/lib/dashboard";
import { requireActiveUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const current = await requireActiveUser();
  if (!current) return null;
  const data = await getDashboardData(current.user.id);
  return <DashboardContent data={data} />;
}
