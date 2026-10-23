import type { Metadata } from "next";
import { redirect } from "next/navigation";
import Link from "next/link";
import { COMMUNITY_COMING_SOON } from "@/lib/community/availability";
import { loadSocialPageContext } from "@/lib/community/social-pages";
import { fetchViewerSettings } from "@/lib/community/social";
import {
  fetchModerationMembers,
  fetchViewerRole,
  isModerator,
  type CommunityRole,
} from "@/lib/community/roles";
import {
  fetchModerationAudit,
  fetchReportCounts,
  fetchReportQueue,
} from "@/lib/community/moderation";
import type { ReportStatus } from "@/lib/community/reports";
import { fetchRoomSettingsList } from "@/lib/community/rooms";
import { CommunityShell } from "@/components/community/community-shell";
import { ModerationView } from "@/components/community/moderation-view";
import { CommunityOnboarding } from "@/components/community-onboarding";
import { CommunityComingSoon } from "@/components/community-coming-soon";
import { SocialUnavailable } from "@/components/community/social-unavailable";
import { Card } from "@/components/ui";
import { Icon } from "@/components/icon";
import { getServerT } from "@/lib/i18n/server";

export const dynamic = "force-dynamic";

export function generateMetadata(): Metadata {
  if (!COMMUNITY_COMING_SOON) return {};
  return { title: { absolute: "Community — Coming Soon" } };
}

type ModerationTab = "reports" | "members" | "rooms" | "audit";

/**
 * /community/moderation — the moderation console (Phase 5).
 *
 * ACCESS (all server-side; the client renders what it is handed):
 *   * the viewer's role is resolved from the database on every render —
 *     a demotion takes effect on the next navigation,
 *   * moderators see the queue + rooms + audit; the Members/roles tab is
 *     admin+ (role granting is itself rank-limited a second time inside
 *     setMemberRole — two independent gates),
 *   * every privileged action is a "use server" action that re-checks the
 *     role, rate-limits, and audits. The UI has no delete-key of its own.
 *
 * Pagination is keyset in the URL (status + before params) — no polling.
 */
export default async function ModerationPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (COMMUNITY_COMING_SOON) return <CommunityComingSoon />;

  const ctx = await loadSocialPageContext();
  if (ctx.status === "login") redirect("/login");
  if (ctx.status === "onboarding") return <CommunityOnboarding />;
  if (ctx.status === "unavailable") return <SocialUnavailable />;

  const { supabase, me, categories, unread, socialUnread } = ctx;

  const [viewer, role] = await Promise.all([
    fetchViewerSettings(supabase, me.userId),
    fetchViewerRole(supabase, me.userId),
  ]);
  if (!isModerator(role)) {
    return <ModerationDenied />;
  }

  const raw = await searchParams;
  const tabRaw = typeof raw.tab === "string" ? raw.tab : "reports";
  const tab: ModerationTab =
    tabRaw === "members" ? "members" : tabRaw === "rooms" ? "rooms" : tabRaw === "audit" ? "audit" : "reports";
  const statusRaw = typeof raw.status === "string" ? raw.status : "open";
  const status: ReportStatus =
    statusRaw === "reviewing"
      ? "reviewing"
      : statusRaw === "resolved"
        ? "resolved"
        : statusRaw === "dismissed"
          ? "dismissed"
          : "open";
  const beforeAt = typeof raw.before === "string" ? raw.before : null;
  const beforeId = typeof raw.beforeId === "string" ? raw.beforeId : null;

  const [counts, queue, members, roomSettings, audit] = await Promise.all([
    tab === "reports" ? fetchReportCounts() : Promise.resolve(null),
    tab === "reports"
      ? fetchReportQueue({
          status,
          beforeAt,
          beforeId: beforeId ?? null,
          limit: 20,
        })
      : Promise.resolve({ items: [], cursor: null, unavailable: false }),
    tab === "members" && role !== "moderator"
      ? fetchModerationMembers()
      : Promise.resolve({ items: [], unavailable: false }),
    tab === "rooms" ? fetchRoomSettingsList() : Promise.resolve(null),
    tab === "audit" ? fetchModerationAudit(30) : Promise.resolve([]),
  ]);

  return (
    <CommunityShell
      me={me}
      categories={categories}
      unread={unread}
      activeSlug={null}
      socialUnread={socialUnread}
      settings={viewer}
      mutedRooms={viewer?.mutedRooms ?? []}
      viewerIsModerator
    >
      <ModerationView
        me={{ userId: me.userId, displayName: me.displayName }}
        viewerRole={role as CommunityRole}
        tab={tab}
        queueStatus={status}
        queueCounts={counts}
        queue={queue.items}
        queueUnavailable={queue.unavailable}
        queueHasMore={queue.cursor !== null}
        members={members.items}
        membersUnavailable={members.unavailable}
        rooms={roomSettings?.rooms ?? null}
        roomCategories={roomSettings?.categories ?? []}
        roomsUnavailable={roomSettings ? roomSettings.unavailable : false}
        audit={audit}
      />
    </CommunityShell>
  );
}

/** The denied card — identical for "not a moderator" and "no session". */
async function ModerationDenied() {
  const t = await getServerT();
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col items-center p-8">
      <Card className="flex w-full flex-col items-center gap-3 p-8 text-center">
        <Icon name="shield" size={28} className="text-faint" />
        <h1 className="text-lg font-bold text-ink">{t("community.moderationDeniedTitle")}</h1>
        <p className="max-w-sm text-sm text-muted">{t("community.moderationDeniedText")}</p>
        <Link href="/community" className="text-sm font-bold text-accent hover:underline">
          {t("community.homeTitle")}
        </Link>
      </Card>
    </div>
  );
}
