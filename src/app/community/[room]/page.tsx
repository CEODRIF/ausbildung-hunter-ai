import type { Metadata } from "next";
import { redirect } from "next/navigation";
import Link from "next/link";
import { getCurrentUserAndProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import {
  fetchCommunityRoomGroups,
  fetchRoomBySlug,
  fetchRoomMessagePage,
  fetchRoomUnreadMap,
  fetchRoomVoice,
} from "@/lib/community/rooms";
import {
  buildViewerSettings,
  fetchSocialBadges,
  VIEWER_SETTINGS_SELECT,
} from "@/lib/community/social";
import { COMMUNITY_COMING_SOON } from "@/lib/community/availability";
import { fetchViewerRole, isModerator } from "@/lib/community/roles";
import { fetchRoomPins } from "@/lib/community/pins";
import { getServerT } from "@/lib/i18n/server";
import { Button, Card } from "@/components/ui";
import { Icon } from "@/components/icon";
import { CommunityShell } from "@/components/community/community-shell";
import { RoomChat } from "@/components/community/room-chat";
import { CommunityOnboarding } from "@/components/community-onboarding";
import { CommunityComingSoon } from "@/components/community-coming-soon";

export const dynamic = "force-dynamic";

/**
 * /community/[room] — ONE room, live.
 *
 * Server work (all degraded-safe):
 *   1. resolve the room by slug (enabled rooms only — RLS hides the rest),
 *   2. prefetch the newest page WITH authors, reactions and reply previews
 *      (fixed batch queries, no N+1),
 *   3. prefetch the room directory + per-room unread for the nav.
 *
 * The room identity is rendered via <RoomChat key={room.id}> — the key makes
 * Next remount the client for every room switch, which cleanly tears down the
 * previous room's realtime channel (no stale subscriptions, no cross-room
 * message bleed).
 */
export function generateMetadata(): Metadata {
  if (!COMMUNITY_COMING_SOON) return {};
  return { title: { absolute: "Community — Coming Soon" } };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function CommunityRoomPage({
  params,
  searchParams,
}: {
  params: Promise<{ room: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (COMMUNITY_COMING_SOON) return <CommunityComingSoon />;

  const { room: roomSlug } = await params;
  // Phase 3: the ?message= deep link (notification center / toast). Invalid
  // values are dropped — the room simply opens at the newest page.
  const rawMessage = (await searchParams).message;
  const jumpToMessageId =
    typeof rawMessage === "string" && UUID.test(rawMessage) ? rawMessage : null;
  const { user, profile } = await getCurrentUserAndProfile();
  if (!user || !profile || profile.account_status !== "active")
    redirect("/login");

  const supabase = await createClient();

  const { room, unavailable } = await fetchRoomBySlug(supabase, roomSlug);
  if (unavailable) return <CommunityUnavailable />;
  if (!room) return <RoomNotFound />;

  type ProfileRow = {
    display_name: string;
    avatar_id: string;
  } & Parameters<typeof buildViewerSettings>[0];
  let communityProfile: ProfileRow | null = null;
  let lookupFailed = false;
  try {
    const { data, error } = await supabase
      .from("community_profiles")
      .select(`display_name,avatar_id,${VIEWER_SETTINGS_SELECT}`)
      .eq("user_id", user.id)
      .maybeSingle();
    if (error) {
      lookupFailed = true;
      console.error("[community] profile lookup failed:", error.message);
    } else {
      communityProfile = (data as ProfileRow | null) ?? null;
    }
  } catch (error) {
    lookupFailed = true;
    console.error("[community] profile lookup threw:", error);
  }

  // A failed lookup is NOT "no profile yet" — see the home page comment.
  if (lookupFailed) return <CommunityUnavailable />;
  if (!communityProfile) return <CommunityOnboarding />;

  const [page, directory, unread, socialUnread, voice, viewerRole, pins] =
    await Promise.all([
      fetchRoomMessagePage(supabase, room.id, user.id),
      fetchCommunityRoomGroups(supabase),
      fetchRoomUnreadMap(user.id),
      fetchSocialBadges(supabase, user.id),
      // Phase 4: active voice conversation (aggregate count only — no
      // participant identities reach this page).
      fetchRoomVoice(supabase, room.id),
      // Phase 5: the viewer's community role (degrades to 'member' — the
      // nav hides the moderation entry, the page guards server-side anyway).
      fetchViewerRole(supabase, user.id),
      // Phase 5: the room's pins (RLS: enabled rooms only; bounded, one
      // batch query for the pinned messages — no N+1).
      fetchRoomPins(supabase, room.id, {
        id: user.id,
        displayName: communityProfile.display_name,
        avatarId: communityProfile.avatar_id,
      }),
    ]);

  const me = {
    userId: user.id,
    displayName: communityProfile.display_name,
    avatarId: communityProfile.avatar_id,
    // Phase 10: server-computed platform-admin flag (drives the badge on
    // the viewer's OWN messages) — computed in getCurrentUserAndProfile
    // from the session user id, never from client input.
    platformAdmin: profile.isPlatformAdmin === true,
  };
  // Phase 3: presence + notification preferences (own row, one query).
  const viewer = buildViewerSettings(communityProfile);

  // Phase 5: pins → the RoomChat's structural view (the only pin
  // representation the client ever sees).
  const t = await getServerT();
  const pinned = pins.map((p) => ({
    pinId: p.pinId,
    messageId: p.message.id,
    pinnedAt: p.pinnedAt,
    pinnedByName: p.pinnedBy?.display_name ?? null,
    preview:
      (p.message.message ?? "").trim().slice(0, 160) ||
      (p.message.image_path ? t("community.imageAlt") : ""),
    authorName: null,
  }));

  return (
    <CommunityShell
      me={me}
      categories={directory.groups}
      unread={unread}
      activeSlug={room.slug}
      socialUnread={socialUnread}
      settings={viewer}
      mutedRooms={viewer.mutedRooms}
      viewerIsModerator={isModerator(viewerRole)}
    >
      <RoomChat
        key={room.id}
        me={me}
        room={room}
        initialMessages={page.messages}
        historyUnavailable={page.unavailable}
        jumpToMessageId={jumpToMessageId}
        initialVoice={voice}
        canModerate={isModerator(viewerRole)}
        pinned={pinned}
      />
    </CommunityShell>
  );
}

/** Unknown slug (or a disabled room) — a styled card, not a bare 404. */
async function RoomNotFound() {
  const t = await getServerT();
  return (
    <div className="absolute inset-0 flex items-center justify-center overflow-y-auto p-4">
      <Card className="w-full max-w-md">
        <div className="flex flex-col items-center gap-3 p-6 text-center sm:p-8">
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-surface-2 text-muted">
            <Icon name="hash" size={22} />
          </span>
          <h2 className="text-lg font-bold text-ink">
            {t("community.roomNotFoundTitle")}
          </h2>
          <p className="text-sm leading-6 text-muted">{t("community.roomNotFoundText")}</p>
          <Link href="/community" className="mt-1">
            <Button variant="secondary" size="sm">
              <Icon name="arrowLeft" size={14} className="rtl:rotate-180" />
              {t("community.backToCommunity")}
            </Button>
          </Link>
        </div>
      </Card>
    </div>
  );
}

/**
 * Non-fatal, retryable state for an unreadable room/profile. Uses the shared
 * error copy + the same card tokens as the rest of the app.
 */
async function CommunityUnavailable() {
  const t = await getServerT();
  return (
    <div className="absolute inset-0 flex items-center justify-center overflow-y-auto p-4">
      <Card className="w-full max-w-md">
        <div className="flex flex-col items-center gap-3 p-6 text-center sm:p-8">
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-danger-soft text-danger">
            <Icon name="alert" size={22} />
          </span>
          <h2 className="text-lg font-bold text-ink">{t("common.error")}</h2>
          <p className="text-sm leading-6 text-muted">{t("common.errorHint")}</p>
          <Link
            href="/community"
            className="mt-1 text-sm font-semibold text-accent underline underline-offset-4"
          >
            {t("common.retry")}
          </Link>
        </div>
      </Card>
    </div>
  );
}
