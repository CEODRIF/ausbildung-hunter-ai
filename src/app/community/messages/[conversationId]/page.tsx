import type { Metadata } from "next";
import { redirect } from "next/navigation";
import Link from "next/link";
import { COMMUNITY_COMING_SOON } from "@/lib/community/availability";
import {
  fetchDmMessagePage,
  fetchDmSummary,
  fetchSocialProfile,
  fetchViewerSettings,
  loadDmConversation,
} from "@/lib/community/social";
import { loadSocialPageContext } from "@/lib/community/social-pages";
import { getServerT } from "@/lib/i18n/server";
import { Button, Card } from "@/components/ui";
import { Icon } from "@/components/icon";
import { CommunityShell } from "@/components/community/community-shell";
import { DmInbox } from "@/components/community/dm-inbox";
import { DmChat } from "@/components/community/dm-chat";
import { CommunityOnboarding } from "@/components/community-onboarding";
import { CommunityComingSoon } from "@/components/community-coming-soon";
import { SocialUnavailable } from "@/components/community/social-unavailable";

export const dynamic = "force-dynamic";

export function generateMetadata(): Metadata {
  if (!COMMUNITY_COMING_SOON) return {};
  return { title: { absolute: "Community — Coming Soon" } };
}

/**
 * /community/messages/[conversationId] — ONE live DM conversation.
 *
 * Authorization: the conversationId is NEVER trusted from the URL.
 * `loadDmConversation` verifies membership in the database (RLS hides
 * non-member rows; the explicit membership check is defense in depth).
 * "Not a member" and "does not exist" render the SAME not-found card —
 * the error is deliberately indistinct so an attacker cannot probe which
 * conversations exist.
 *
 * Desktop: inbox sidebar + conversation (keyed remount tears down the old
 * realtime channel). Mobile: full-width conversation with its own back
 * button to the inbox.
 */
export default async function CommunityDmConversationPage({
  params,
}: {
  params: Promise<{ conversationId: string }>;
}) {
  if (COMMUNITY_COMING_SOON) return <CommunityComingSoon />;

  const { conversationId } = await params;
  const ctx = await loadSocialPageContext();
  if (ctx.status === "login") redirect("/login");
  if (ctx.status === "onboarding") return <CommunityOnboarding />;
  if (ctx.status === "unavailable") return <SocialUnavailable />;

  const { supabase, me, categories, unread, socialUnread } = ctx;

  // Server-side membership check (never trust the URL).
  const loaded = await loadDmConversation(supabase, me.userId, conversationId).catch(
    (error) => {
      console.error("[community] conversation lookup threw:", error);
      return null;
    },
  );
  if (!loaded) return <ConversationNotFound />;

  const [summary, other, page, viewer] = await Promise.all([
    fetchDmSummary(supabase, me.userId),
    fetchSocialProfile(supabase, loaded.otherId, me.userId),
    fetchDmMessagePage(supabase, loaded.conversation, me.userId, null),
    fetchViewerSettings(supabase, me.userId),
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
      viewerIsModerator={ctx.viewerIsModerator}
    >
      <div className="absolute inset-0 flex min-h-0">
        {/* Desktop sidebar (the mobile flow is list → tap → conversation). */}
        <aside className="hidden w-80 shrink-0 flex-col border-e border-line bg-surface lg:flex">
          <div className="shrink-0 border-b border-line px-4 py-3">
            <InboxTitle />
          </div>
          <div className="min-h-0 flex-1">
            <DmInbox
              me={{ userId: me.userId }}
              initial={summary.conversations}
              unavailable={summary.unavailable}
              activeConversationId={conversationId}
              variant="sidebar"
            />
          </div>
        </aside>
        <div className="relative min-w-0 flex-1">
          <DmChat
            key={conversationId}
            me={me}
            conversation={{ id: conversationId }}
            other={other}
            initialMessages={page.messages}
            historyUnavailable={page.unavailable}
          />
        </div>
      </div>
    </CommunityShell>
  );
}

/** Sidebar header (server component — the page is async-translated). */
async function InboxTitle() {
  const t = await getServerT();
  return <h2 className="text-sm font-bold text-ink">{t("community.messagesTitle")}</h2>;
}

/**
 * Unknown conversationId OR not a member — deliberately ONE shared state.
 */
async function ConversationNotFound() {
  const t = await getServerT();
  return (
    <div className="absolute inset-0 flex items-center justify-center overflow-y-auto p-4">
      <Card className="w-full max-w-md">
        <div className="flex flex-col items-center gap-3 p-6 text-center sm:p-8">
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-surface-2 text-muted">
            <Icon name="message" size={22} />
          </span>
          <h2 className="text-lg font-bold text-ink">
            {t("community.conversationNotFound")}
          </h2>
          <Link href="/community/messages" className="mt-1">
            <Button variant="secondary" size="sm">
              <Icon name="arrowLeft" size={14} className="rtl:rotate-180" />
              {t("community.backToMessages")}
            </Button>
          </Link>
        </div>
      </Card>
    </div>
  );
}
