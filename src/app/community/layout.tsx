import Link from "next/link";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { Card } from "@/components/ui";
import { Icon } from "@/components/icon";
import { getCurrentUserAndProfile } from "@/lib/auth";
import { fetchCommunityBanState } from "@/lib/community/roles";
import { getCommunityUnreadCount } from "@/lib/community/server";
import { getServerT, getRequestLang } from "@/lib/i18n/server";

export const dynamic = "force-dynamic";

export default async function CommunityLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const { user, profile } = await getCurrentUserAndProfile();
  if (!user || !profile || profile.account_status !== "active")
    redirect("/login");

  // Phase 10: an ACTIVE platform ban removes the Community entirely.
  // This screen is the UI layer only — the real enforcement is the
  // database (every community RLS policy embeds community_is_banned(),
  // and every mutation route re-checks the write gate), so a client that
  // skips this layout still cannot read or write anything.
  const ban = await fetchCommunityBanState(profile.id);
  if (ban.banned) {
    return (
      <AppShell profile={profile} fill>
        <CommunityBannedScreen reason={ban.reason} expiresAt={ban.expiresAt} />
      </AppShell>
    );
  }

  const communityUnread = await getCommunityUnreadCount(profile.id);
  return (
    <AppShell profile={profile} communityUnread={communityUnread} fill>
      {children}
    </AppShell>
  );
}

/**
 * The dedicated localized banned screen. Deliberately minimal: it shows
 * the title, the admin-supplied reason (if any) and the expiration (if
 * any) — no moderation internals (no ban id, no admin identity, no
 * audit data). Navigation out of Community (app nav) and the logout
 * (profile menu) stay available through the shell, as required.
 */
async function CommunityBannedScreen({
  reason,
  expiresAt,
}: {
  reason: string | null;
  expiresAt: string | null;
}) {
  const t = await getServerT();
  const lang = await getRequestLang();
  const dateLocale =
    lang === "de" ? "de-DE" : lang === "fr" ? "fr-FR" : lang === "ar" ? "ar" : "en-US";

  return (
    <div className="absolute inset-0 flex items-start justify-center overflow-y-auto p-4 sm:items-center sm:p-8">
      <Card className="flex w-full max-w-md flex-col items-center gap-4 p-6 text-center sm:p-8">
        <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-danger/10 text-danger">
          <Icon name="shield" size={22} />
        </span>
        <div>
          <h1 className="text-lg font-bold text-ink">{t("community.bannedTitle")}</h1>
          <p className="mt-1.5 text-sm leading-6 text-muted">
            {t("community.bannedBody")}
          </p>
          {reason && (
            <p className="mt-2 text-sm font-medium text-ink-soft">
              {t("community.bannedReason", { reason })}
            </p>
          )}
          {expiresAt && (
            <p className="mt-2 text-sm text-muted">
              {t("community.bannedExpires", {
                date: new Date(expiresAt).toLocaleDateString(dateLocale, {
                  day: "2-digit",
                  month: "long",
                  year: "numeric",
                }),
              })}
            </p>
          )}
        </div>
        <Link href="/dashboard" className="mt-1">
          <span className="text-sm font-bold text-accent hover:underline">
            {t("nav.dashboard")}
          </span>
        </Link>
      </Card>
    </div>
  );
}
