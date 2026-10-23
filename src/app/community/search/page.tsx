import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { COMMUNITY_COMING_SOON } from "@/lib/community/availability";
import { loadSocialPageContext } from "@/lib/community/social-pages";
import { fetchViewerSettings } from "@/lib/community/social";
import { runCommunitySearch, SEARCH_KINDS } from "@/lib/community/search";
import type { SearchViewItem } from "@/components/community/search-view";
import { CommunityShell } from "@/components/community/community-shell";
import { SearchView } from "@/components/community/search-view";
import { CommunityOnboarding } from "@/components/community-onboarding";
import { CommunityComingSoon } from "@/components/community-coming-soon";
import { SocialUnavailable } from "@/components/community/social-unavailable";

export const dynamic = "force-dynamic";

export function generateMetadata(): Metadata {
  if (!COMMUNITY_COMING_SOON) return {};
  return { title: { absolute: "Community — Coming Soon" } };
}

/**
 * /community/search — global Community search (Phase 5).
 *
 * SECURITY MODEL:
 *   * the page is server-guarded (no session → login, no community profile
 *     → onboarding), so the search form is never rendered to anonymous
 *     users,
 *   * the FIRST result page runs here on the server (one bounded RPC);
 *     every later interaction (filter change / Load more) goes through the
 *     SESSION-authenticated GET /api/community/search — the viewer id is
 *     always the session user (p_user === auth.uid() enforced in SQL),
 *   * DMs are not searchable: the `community_search` function references no
 *     DM table — exclusion by construction, not by client filtering.
 *
 * FILTERS are read from the URL (shareable links): q, kind, room (slug),
 * date. Invalid values fall back to the safe default — the search is never
 * widened by a malformed parameter.
 */
export default async function CommunitySearchPage({
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

  // Shell presence + notification prefs (same contract as the other pages).
  const viewer = await fetchViewerSettings(supabase, me.userId);

  const raw = await searchParams;
  const first = (value: string | string[] | undefined): string =>
    typeof value === "string" ? value : "";

  const query = first(raw.q).trim().slice(0, 200);
  const kindRaw = first(raw.kind) || "all";
  const kind = (SEARCH_KINDS as readonly string[]).includes(kindRaw) ? kindRaw : "all";
  const roomSlug = first(raw.room).trim().toLowerCase().slice(0, 64);
  const dateRaw = first(raw.date) || "all";
  const date = ["all", "week", "month", "year"].includes(dateRaw) ? dateRaw : "all";

  // Room filter: the SLUG is resolved against the directory the page already
  // loaded (no extra query; unknown slug → the filter is dropped, not an
  // error — the RPC itself would reject unknown ids anyway).
  const roomOptions = categories
    .flatMap((g) => g.rooms)
    .filter((r) => r.enabled)
    .map((r) => ({ id: r.id, slug: r.slug, name: r.name }));
  const room = roomSlug ? roomOptions.find((r) => r.slug === roomSlug) ?? null : null;

  const firstPage =
    query.length >= 2
       ? await runCommunitySearch({
           userId: me.userId,
           query,
           kind: kind as "all" | "message" | "question" | "answer" | "user" | "room",
           roomId: room?.id ?? null,
           // The date window → since translation happens in the data layer
           // (runCommunitySearch) — not during render.
           date: date as "all" | "week" | "month" | "year",
         })
      : { items: [], cursor: null, unavailable: false };

  // The server's item union includes the tab id "all" which the RPC never
  // emits per-row — narrow to the client's structural row kind.
  const items: SearchViewItem[] = firstPage.items.map((item) => ({
    ...item,
    kind:
      item.kind === "message" ||
      item.kind === "question" ||
      item.kind === "answer" ||
      item.kind === "user" ||
      item.kind === "room"
        ? item.kind
        : "message",
  }));

  return (
    <CommunityShell
      me={me}
      categories={categories}
      unread={unread}
      activeSlug={null}
      socialUnread={socialUnread}
      settings={viewer}
      mutedRooms={viewer?.mutedRooms ?? []}
      viewerIsModerator={ctx.viewerIsModerator}
    >
      <SearchView
        rooms={roomOptions}
        initialQuery={query}
        initialKind={kind as "all" | "message" | "question" | "answer"}
        initialRoomSlug={room ? room.slug : ""}
        initialDate={date as "all" | "week" | "month" | "year"}
        initialItems={items}
        initialCursor={firstPage.cursor}
        unavailable={firstPage.unavailable}
      />
    </CommunityShell>
  );
}
