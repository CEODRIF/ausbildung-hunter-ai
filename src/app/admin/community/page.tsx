import { redirect } from "next/navigation";
import { AdminCommunityClient } from "@/components/admin-community";
import { getCurrentUserAndProfile } from "@/lib/auth";
import {
  fetchAdminCommunityUser,
  fetchUserMessagesForAdmin,
  searchAdminUsers,
} from "@/lib/community/admin-ops";
import { isPlatformAdmin } from "@/lib/community/platform-admin";
import { getServerT } from "@/lib/i18n/server";

export const dynamic = "force-dynamic";

/**
 * Admin → Community moderation (platform admin only). URL-driven:
 *   /admin/community            — search box
 *   /admin/community?q=…        — search results
 *   /admin/community?user=…     — user detail: profile + ban state +
 *                                 recent messages (delete targets)
 * The privileged operations (ban/unban/message hide) run through the
 * isPlatformAdmin-gated API routes; this page only renders server-fetched
 * data.
 */
export default async function AdminCommunityPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; user?: string }>;
}) {
  const { user } = await getCurrentUserAndProfile();
  if (!user) redirect("/login");
  const platform = await isPlatformAdmin();
  if (!platform.ok) redirect("/admin/users");

  const params = await searchParams;
  const t = await getServerT();

  const userIdParam =
    typeof params.user === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(params.user)
      ? params.user
      : null;

  if (userIdParam) {
    const [userDetail, messages] = await Promise.all([
      fetchAdminCommunityUser(userIdParam),
      fetchUserMessagesForAdmin(userIdParam, 20),
    ]);
    return (
      <>
        <div className="mt-8">
          <h1 className="text-3xl font-bold tracking-[-0.04em] text-ink">
            {t("admin.moderationTitle")}
          </h1>
        </div>
        <AdminCommunityClient
          mode="detail"
          initialQuery={typeof params.q === "string" ? params.q : ""}
          userDetail={userDetail}
          messages={messages.items}
          messagesUnavailable={messages.unavailable}
        />
      </>
    );
  }

  const q = typeof params.q === "string" ? params.q.trim() : "";
  const searching = q.length >= 3;
  if (!searching) {
    return (
      <>
        <div className="mt-8">
          <h1 className="text-3xl font-bold tracking-[-0.04em] text-ink">
            {t("admin.moderationTitle")}
          </h1>
          <p className="mt-2 text-sm text-muted">
            {t("admin.moderationSubtitle")}
          </p>
        </div>
        <AdminCommunityClient mode="search" initialQuery="" />
      </>
    );
  }

  const { items, unavailable } = await searchAdminUsers(q);
  return (
    <>
      <div className="mt-8">
        <h1 className="text-3xl font-bold tracking-[-0.04em] text-ink">
          {t("admin.moderationTitle")}
        </h1>
        <p className="mt-2 text-sm text-muted">{t("admin.moderationSubtitle")}</p>
      </div>
      <AdminCommunityClient
        mode="results"
        initialQuery={q}
        results={items}
        searchFailed={unavailable}
      />
    </>
  );
}
