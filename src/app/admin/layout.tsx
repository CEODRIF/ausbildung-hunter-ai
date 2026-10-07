import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUserAndProfile } from "@/lib/auth";
import { requireAdmin } from "@/lib/billing/admin";
import { isPlatformAdmin } from "@/lib/community/platform-admin";
import { getServerT } from "@/lib/i18n/server";
import { AdminNav } from "@/components/admin-nav";

export const dynamic = "force-dynamic";

/**
 * Admin area layout — shared chrome for every /admin page.
 *
 * Gate (server-side, the ONLY one that matters): an active session AND a
 * verified public.admins membership (requireAdmin). The platform-admin
 * sections (overview / announcements / community moderation) additionally
 * re-check isPlatformAdmin() INSIDE their page — the nav simply does not
 * render them for non-platform admins, which is presentation, not security.
 */
export default async function AdminLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const { user } = await getCurrentUserAndProfile();
  if (!user) redirect("/login");
  const admin = await requireAdmin();
  if (!admin) redirect("/dashboard");
  const platform = (await isPlatformAdmin()).ok;
  const t = await getServerT();

  return (
    <main className="min-h-screen bg-background px-5 py-8 sm:px-8 lg:px-10">
      <div className="mx-auto max-w-5xl">
        <Link
          href="/dashboard"
          className="text-sm font-semibold text-accent"
        >
          ← {t("admin.back")}
        </Link>
        <AdminNav
          isPlatformAdmin={platform}
          labels={{
            overview: t("admin.navOverview"),
            announcements: t("admin.navAnnouncements"),
            community: t("admin.navCommunity"),
            users: t("admin.navUsers"),
          }}
        />
        {children}
      </div>
    </main>
  );
}
