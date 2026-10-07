import { redirect } from "next/navigation";
import { Card } from "@/components/ui";
import { AnnouncementsForm } from "@/components/admin-announcements";
import { getCurrentUserAndProfile } from "@/lib/auth";
import { fetchAnnouncementHistory } from "@/lib/community/admin-ops";
import { isPlatformAdmin } from "@/lib/community/platform-admin";
import { getServerT, getRequestLang } from "@/lib/i18n/server";
import { localeForLang } from "@/lib/i18n/core";

export const dynamic = "force-dynamic";

const TYPE_LABEL_KEYS: Record<string, string> = {
  announcement: "admin.notifTypeAnnouncement",
  info: "admin.notifTypeInfo",
  important: "admin.notifTypeImportant",
  maintenance: "admin.notifTypeMaintenance",
  improvement: "admin.notifTypeImprovement",
  social: "admin.notifTypeInfo",
};

/**
 * Admin → Announcements (platform admin only). Create + confirm + send an
 * announcement to ALL users (one target_type='all' row in the existing
 * notification system — realtime delivery + history included), and review
 * recent sends.
 */
export default async function AdminAnnouncementsPage() {
  const { user } = await getCurrentUserAndProfile();
  if (!user) redirect("/login");
  const platform = await isPlatformAdmin();
  if (!platform.ok) redirect("/admin/users");

  const [t, lang, history] = await Promise.all([
    getServerT(),
    getRequestLang(),
    fetchAnnouncementHistory(20),
  ]);
  const locale = localeForLang(lang);

  return (
    <>
      <div className="mt-8">
        <h1 className="text-3xl font-bold tracking-[-0.04em] text-ink">
          {t("admin.announcementsTitle")}
        </h1>
        <p className="mt-2 text-sm text-muted">
          {t("admin.announcementsSubtitle")}
        </p>
      </div>

      <Card className="mt-6 px-5 py-4">
        <h2 className="text-base font-bold text-ink">{t("admin.newNotification")}</h2>
        <p className="mb-4 mt-1 text-sm text-muted">
          {t("admin.sendTo")}: <strong>{t("admin.allUsers")}</strong>
        </p>
        <AnnouncementsForm />
      </Card>

      <Card className="mt-6 overflow-hidden">
        <div className="border-b border-line px-5 py-4">
          <h2 className="text-base font-bold text-ink">
            {t("admin.historyTitle")}
          </h2>
        </div>
        {history.unavailable ? (
          <p className="px-6 py-8 text-center text-sm text-muted">
            {t("admin.historyError")}
          </p>
        ) : history.items.length === 0 ? (
          <p className="px-6 py-8 text-center text-sm text-muted">
            {t("admin.historyEmpty")}
          </p>
        ) : (
          <ul className="divide-y divide-line">
            {history.items.map((row) => (
              <li key={row.id} className="px-5 py-4">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span className="rounded-md bg-ai-soft px-1.5 py-0.5 text-[10px] font-bold text-ai">
                    {t(TYPE_LABEL_KEYS[row.type] ?? "admin.notifTypeAnnouncement")}
                  </span>
                  <span className="text-sm font-bold text-ink">{row.title}</span>
                  <time
                    dateTime={row.createdAt}
                    className="ms-auto text-xs text-faint"
                  >
                    {new Date(row.createdAt).toLocaleString(locale)}
                  </time>
                </div>
                {row.content && (
                  <p className="mt-1 line-clamp-2 text-sm text-muted">
                    {row.content}
                  </p>
                )}
                {row.linkUrl && (
                  <a
                    href={row.linkUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-1 inline-block max-w-full truncate text-xs text-accent hover:underline"
                  >
                    {row.linkUrl}
                  </a>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
