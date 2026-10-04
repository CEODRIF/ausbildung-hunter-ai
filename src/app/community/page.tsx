import { redirect } from "next/navigation";
import Link from "next/link";
import { getCurrentUserAndProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { fetchInitialCommunityMessages } from "@/lib/community/server";
import { getServerT } from "@/lib/i18n/server";
import { Card } from "@/components/ui";
import { Icon } from "@/components/icon";
import { CommunityChat } from "@/components/community-chat";
import { CommunityOnboarding } from "@/components/community-onboarding";

export const dynamic = "force-dynamic";

/**
 * /community — shared group chat for all authenticated members.
 *
 * First visit: the onboarding screen (display name + one of the five
 * predefined avatars). After that: the real-time chat. Both are rendered
 * inside the standard AppShell (sidebar/header/footer unchanged).
 *
 * Every data read here is degraded-safe: a database hiccup (or an incomplete
 * server environment) must NEVER escalate into the global error boundary —
 * that is what produced the post-onboarding "This page could not load" screen.
 */
export default async function CommunityPage() {
  const { user, profile } = await getCurrentUserAndProfile();
  if (!user || !profile || profile.account_status !== "active")
    redirect("/login");

  const supabase = await createClient();

  let communityProfile: { display_name: string; avatar_id: string } | null = null;
  let lookupFailed = false;
  try {
    const { data, error } = await supabase
      .from("community_profiles")
      .select("display_name,avatar_id")
      .eq("user_id", user.id)
      .maybeSingle();
    if (error) {
      lookupFailed = true;
      console.error("[community] profile lookup failed:", error.message);
    } else {
      communityProfile =
        (data as { display_name: string; avatar_id: string } | null) ?? null;
    }
  } catch (error) {
    // Network/DB outage: logged for the server logs, never thrown onward.
    lookupFailed = true;
    console.error("[community] profile lookup threw:", error);
  }

  // A failed lookup is NOT "no profile yet": rendering onboarding here would
  // invite a second (doomed) profile write, so show a retryable state instead.
  if (lookupFailed) return <CommunityUnavailable />;
  if (!communityProfile) return <CommunityOnboarding />;

  const history = await fetchInitialCommunityMessages(supabase);
  return (
    <CommunityChat
      me={{
        userId: user.id,
        displayName: communityProfile.display_name,
        avatarId: communityProfile.avatar_id,
      }}
      initialMessages={history.messages}
      historyUnavailable={history.unavailable}
    />
  );
}

/**
 * Non-fatal, retryable state for an unreadable community profile. Uses the
 * shared error copy + the same card tokens as the rest of the app.
 */
async function CommunityUnavailable() {
  const t = await getServerT();
  return (
    <div className="mx-auto flex w-full max-w-md flex-1 flex-col items-center justify-center px-4 py-10 text-center sm:px-6">
      <Card className="w-full">
        <div className="flex flex-col items-center gap-3 p-6 sm:p-8">
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
