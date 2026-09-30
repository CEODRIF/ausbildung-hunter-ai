import Link from "next/link";
import { redirect } from "next/navigation";
import { Card } from "@/components/ui";
import { getCurrentUserAndProfile } from "@/lib/auth";
import { requireAdmin } from "@/lib/billing/admin";
import { listAdminUsers } from "@/lib/billing/admin-users";
import { getServerT, getRequestLang } from "@/lib/i18n/server";
import { localeForLang } from "@/lib/i18n/core";
import {
  AdminUserActions,
  type AdminUserRow,
} from "@/components/admin-user-actions";
import { AdminNotifications } from "@/components/admin-notifications";
import { PLATFORM_OWNER_EMAIL } from "@/lib/notifications/admin";

export const dynamic = "force-dynamic";

type T = (path: string, vars?: Record<string, string | number>) => string;

/** Phase 10 — admin foundation. Gated twice: the page requires an active
 *  session AND a verified admin membership (server-side). */
export default async function AdminPage({
  searchParams,
}: {
  searchParams: Promise<{ email?: string; feedback?: string }>;
}) {
  const { user } = await getCurrentUserAndProfile();
  if (!user) redirect("/login");
  const admin = await requireAdmin();
  if (!admin) redirect("/dashboard");

  const params = await searchParams;
  const [users, t, lang] = await Promise.all([
    listAdminUsers(params.email ?? undefined),
    getServerT(),
    getRequestLang(),
  ]);
  const locale = localeForLang(lang);
  // Platform Updates (notifications) is reserved for the platform owner:
  // the section is only RENDERED for the owner account, and every API call
  // is re-verified server-side (requirePlatformOwner) — non-owner admins
  // neither see the UI nor can reach the endpoints.
  const isPlatformOwner =
    (admin.email ?? "").trim().toLowerCase() === PLATFORM_OWNER_EMAIL;

  return (
    <main className="min-h-screen bg-background px-5 py-8 sm:px-8 lg:px-10">
      <div className="mx-auto max-w-5xl">
        <Link
          href="/dashboard"
          className="text-sm font-semibold text-accent"
        >
          ← {t("admin.back")}
        </Link>
        <div className="mt-8 flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="mt-2 text-3xl font-bold tracking-[-0.04em] text-ink">
              {t("admin.title")}
            </h1>
            <p className="mt-2 text-sm text-muted">{t("admin.subtitle")}</p>
          </div>
          <AdminFilterForm t={t} initial={params.email ?? ""} />
        </div>
        {params.feedback && (
          <p className="mt-4 rounded-xl bg-success-soft px-4 py-3 text-sm font-semibold text-success">
            {params.feedback}
          </p>
        )}

        <Card className="mt-6 overflow-hidden">
          {users.length === 0 ? (
            <p className="px-6 py-10 text-center text-sm text-muted">
              {t("admin.noMatch")}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] text-start text-sm">
                <thead>
                  <tr className="border-b border-line text-[11px] uppercase tracking-[0.08em] text-faint">
                    <th className="px-5 py-3 text-start">{t("admin.user")}</th>
                    <th className="px-5 py-3 text-start">{t("admin.goal")}</th>
                    <th className="px-5 py-3 text-start">{t("admin.plan")}</th>
                    <th className="px-5 py-3 text-start">{t("admin.today")}</th>
                    <th className="px-5 py-3 text-start">{t("admin.role")}</th>
                    <th className="px-5 py-3 text-start">{t("admin.actions")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {users.map((row) => (
                    <tr key={row.id}>
                      <td className="px-5 py-3">
                        <p className="font-semibold text-ink-soft">
                          {row.full_name}
                        </p>
                        <p className="text-xs text-muted">{row.email}</p>
                      </td>
                      <td className="px-5 py-3 text-xs text-muted">
                        {row.selected_goal ?? "—"}
                      </td>
                      <td className="px-5 py-3">
                        {row.subscription ? (
                          <span className="text-xs font-semibold text-ink-soft">
                            {row.subscription.plan}{" "}
                            <span className="text-muted">
                              ({row.subscription.status}
                              {row.subscription.current_period_end
                                ? ` ${t("admin.until", {
                                    date: new Date(
                                      row.subscription.current_period_end,
                                    ).toLocaleDateString(locale),
                                  })}`
                                : ""}
                              )
                            </span>
                          </span>
                        ) : (
                          <span className="text-xs text-muted">
                            {t("admin.free")}
                          </span>
                        )}
                      </td>
                      <td className="px-5 py-3 text-xs text-muted">
                        {row.usage_today.emails_sent} /{" "}
                        {row.usage_today.ai_requests}
                      </td>
                      <td className="px-5 py-3">
                        {row.is_admin ? (
                          <span className="rounded-md bg-ai-soft px-1.5 py-0.5 text-[10px] font-bold text-ai">
                            {t("admin.adminBadge")}
                          </span>
                        ) : (
                          <span className="text-xs text-muted">
                            {t("admin.userRole")}
                          </span>
                        )}
                      </td>
                      <td className="px-5 py-3">
                        <AdminUserActions
                          actorId={admin.id}
                          row={row as AdminUserRow}
                        />
                      </td>
                    </tr>
              ))}
            </tbody>
          </table>
            </div>
          )}
        </Card>

        {isPlatformOwner && <AdminNotifications />}
      </div>
    </main>
  );
}

function AdminFilterForm({
  t,
  initial,
}: {
  t: T;
  initial: string;
}) {
  return (
    <form action="/admin" method="GET" className="flex items-center gap-2">
      <input
        type="search"
        name="email"
        defaultValue={initial}
        placeholder={t("admin.filterPlaceholder")}
        aria-label={t("admin.filterPlaceholder")}
        className="w-56 rounded-xl border border-line-strong bg-surface px-3 py-2 text-sm"
      />
      <button
        type="submit"
        className="rounded-xl bg-accent px-4 py-2 text-sm font-bold text-white"
      >
        {t("admin.filter")}
      </button>
    </form>
  );
}
