import { redirect } from "next/navigation";
import { getCurrentUserAndProfile } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { loadRecentApplications } from "@/lib/dashboard";
import { getServerT, getRequestLang } from "@/lib/i18n/server";
import { localeForLang } from "@/lib/i18n/core";
import { RecentApplicationsCard } from "@/components/dashboard-content";

export const dynamic = "force-dynamic";

/**
 * Applications index — the user's real drafts joined with persisted
 * campaign/message state. No synthetic rows: an empty workspace renders the
 * professional empty state with a next action.
 */
export default async function ApplicationsPage() {
  const { user } = await getCurrentUserAndProfile();
  if (!user) redirect("/login");
  const t = await getServerT();
  const locale = localeForLang(await getRequestLang());
  const admin = createAdminClient();
  const items = await loadRecentApplications(admin, user.id, 50);
  return (
    <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6 lg:px-10">
      <RecentApplicationsCard items={items} t={t} locale={locale} />
    </div>
  );
}
