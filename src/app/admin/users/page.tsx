import { redirect } from "next/navigation";
import { Icon } from "@/components/icon";
import { getCurrentUserAndProfile } from "@/lib/auth";
import { requireAdmin } from "@/lib/billing/admin";
import { listAdminUsers } from "@/lib/billing/admin-users";
import { getServerT, getRequestLang } from "@/lib/i18n/server";
import { localeForLang } from "@/lib/i18n/core";
import { AdminUserTable } from "@/components/admin-user-table";

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

  return (
    <>
      <div className="mt-8 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-4">
          <span
            aria-hidden="true"
            className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl text-white shadow-[var(--shadow-card)]"
            style={{ background: "var(--gradient-neon)" }}
          >
            <Icon name="user" size={22} />
          </span>
          <div>
            <h1 className="text-2xl font-bold tracking-[-0.03em] text-ink sm:text-3xl">
              {t("admin.title")}
            </h1>
            <p className="mt-1 text-sm text-muted">{t("admin.subtitle")}</p>
          </div>
        </div>
        <AdminFilterForm t={t} initial={params.email ?? ""} />
      </div>
      {params.feedback && (
        <p className="mt-4 flex items-center gap-2 rounded-2xl border border-success/25 bg-success-soft px-4 py-3 text-sm font-semibold text-success">
          <Icon name="check" size={15} className="shrink-0" />
          {params.feedback}
        </p>
      )}

      <AdminUserTable
        t={t}
        locale={locale}
        users={users}
        actorId={admin.id}
      />
    </>
  );
}

function AdminFilterForm({ t, initial }: { t: T; initial: string }) {
  return (
    <form
      action="/admin/users"
      method="GET"
      className="flex items-center gap-2 rounded-2xl border border-line-strong bg-surface p-1.5 shadow-[var(--shadow-card)]"
    >
      <div className="relative">
        <span className="pointer-events-none absolute start-3 top-1/2 -translate-y-1/2 text-faint">
          <Icon name="search" size={15} />
        </span>
        <input
          type="search"
          name="email"
          defaultValue={initial}
          placeholder={t("admin.filterPlaceholder")}
          aria-label={t("admin.filterPlaceholder")}
          className="w-52 rounded-xl bg-surface-2/70 py-2 pe-3 ps-9 text-sm text-ink outline-none transition placeholder:text-faint focus:bg-surface focus:ring-2 focus:ring-accent/30 sm:w-56"
        />
      </div>
      <button
        type="submit"
        className="rounded-xl bg-accent px-4 py-2 text-sm font-bold text-white transition-colors hover:bg-accent-deep"
      >
        {t("admin.filter")}
      </button>
    </form>
  );
}
