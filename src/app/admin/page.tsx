import { redirect } from "next/navigation";
import { Card } from "@/components/ui";
import { AdminIdentityForm } from "@/components/admin-identity-form";
import { getCurrentUserAndProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCommunityMemberCount } from "@/lib/community/server";
import { fetchActiveBanCount } from "@/lib/community/admin-ops";
import {
  fetchModerationAudit,
  fetchReportCounts,
} from "@/lib/community/moderation";
import { isPlatformAdmin } from "@/lib/community/platform-admin";
import { getServerT, getRequestLang } from "@/lib/i18n/server";
import { localeForLang } from "@/lib/i18n/core";

export const dynamic = "force-dynamic";

/**
 * Admin overview — platform-admin section: platform-wide community stats,
 * the recent admin audit trail and the admin's own Community identity
 * (custom display name + the red verification badge it carries).
 *
 * Gate: isPlatformAdmin() (stable id + public.admins membership). A
 * billing-only admin lands on /admin/users (their existing surface).
 */
export default async function AdminOverviewPage() {
  const { user } = await getCurrentUserAndProfile();
  if (!user) redirect("/login");
  const platform = await isPlatformAdmin();
  if (!platform.ok) redirect("/admin/users");

  const [t, lang, supabase] = await Promise.all([
    getServerT(),
    getRequestLang(),
    createClient(),
  ]);
  const locale = localeForLang(lang);

  const [memberCount, reportCounts, banCount, auditRows, identity] =
    await Promise.all([
      getCommunityMemberCount(supabase),
      fetchReportCounts(),
      fetchActiveBanCount(),
      fetchModerationAudit(10),
      (async () => {
        const admin = createAdminClient();
        const { data } = await admin
          .from("community_profiles")
          .select("display_name")
          .eq("user_id", user.id)
          .maybeSingle();
        return ((data as { display_name?: string } | null)?.display_name ??
          null);
      })(),
    ]);

  const stats: Array<{ label: string; value: number }> = [
    { label: t("admin.statMembers"), value: memberCount },
    {
      label: t("admin.statOpenReports"),
      value: reportCounts ? reportCounts.open : 0,
    },
    { label: t("admin.statActiveBans"), value: banCount },
  ];

  return (
    <>
      <div className="mt-8">
        <h1 className="text-3xl font-bold tracking-[-0.04em] text-ink">
          {t("admin.overviewTitle")}
        </h1>
        <p className="mt-2 text-sm text-muted">
          {t("admin.overviewSubtitle")}
        </p>
      </div>

      <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-3">
        {stats.map((s) => (
          <Card key={s.label} className="px-5 py-4">
            <p className="text-xs font-semibold uppercase tracking-[0.08em] text-faint">
              {s.label}
            </p>
            <p className="mt-1 text-2xl font-bold text-ink">{s.value}</p>
          </Card>
        ))}
      </div>

      <Card className="mt-6 px-5 py-4">
        <h2 className="text-base font-bold text-ink">
          {t("admin.identityTitle")}
        </h2>
        <p className="mt-1 text-sm text-muted">{t("admin.identityHint")}</p>
        <AdminIdentityForm currentName={identity ?? ""} />
      </Card>

      <Card className="mt-6 overflow-hidden">
        <div className="border-b border-line px-5 py-4">
          <h2 className="text-base font-bold text-ink">
            {t("admin.recentActions")}
          </h2>
        </div>
        {auditRows.length === 0 ? (
          <p className="px-6 py-8 text-center text-sm text-muted">
            {t("admin.recentActionsEmpty")}
          </p>
        ) : (
          <ul className="divide-y divide-line">
            {auditRows.map((row) => (
              <li key={row.id} className="flex items-baseline gap-3 px-5 py-3">
                <span className="shrink-0 rounded-md bg-ai-soft px-1.5 py-0.5 text-[10px] font-bold text-ai">
                  {row.action}
                </span>
                <span className="min-w-0 flex-1 truncate text-sm text-ink-soft">
                  {row.reason ?? row.targetType}
                </span>
                <time
                  dateTime={row.createdAt}
                  className="shrink-0 text-xs text-faint"
                >
                  {new Date(row.createdAt).toLocaleString(locale)}
                </time>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
