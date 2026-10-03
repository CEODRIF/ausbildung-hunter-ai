import { redirect } from "next/navigation";
import { getCurrentUserAndProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { fetchInitialCommunityMessages } from "@/lib/community/server";
import { CommunityChat } from "@/components/community-chat";
import { CommunityOnboarding } from "@/components/community-onboarding";

export const dynamic = "force-dynamic";

/**
 * /community — shared group chat for all authenticated members.
 *
 * First visit: the onboarding screen (display name + one of the five
 * predefined avatars). After that: the real-time chat. Both are rendered
 * inside the standard AppShell (sidebar/header/footer unchanged).
 */
export default async function CommunityPage() {
  const { user, profile } = await getCurrentUserAndProfile();
  if (!user || !profile || profile.account_status !== "active")
    redirect("/login");

  const supabase = await createClient();
  const { data: communityProfile } = await supabase
    .from("community_profiles")
    .select("display_name,avatar_id")
    .eq("user_id", user.id)
    .maybeSingle();

  if (!communityProfile) {
    return <CommunityOnboarding />;
  }

  const initialMessages = await fetchInitialCommunityMessages();
  return (
    <CommunityChat
      me={{
        userId: user.id,
        displayName: communityProfile.display_name,
        avatarId: communityProfile.avatar_id,
      }}
      initialMessages={initialMessages}
    />
  );
}
