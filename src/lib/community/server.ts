import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { COMMUNITY_PAGE_SIZE, type CommunityMessageView } from "@/lib/community";

/**
 * Unread community message count for the sidebar badge.
 *
 * "Unread" = messages created after this user's read cursor
 * (community_read_state.last_read_message_id). No read state yet → every
 * message counts. The counter is non-critical chrome: any failure degrades
 * to 0 and never breaks the page render.
 */
export async function getCommunityUnreadCount(userId: string): Promise<number> {
  try {
    const admin = createAdminClient();
    const { data: state } = await admin
      .from("community_read_state")
      .select("last_read_message_id")
      .eq("user_id", userId)
      .maybeSingle();

    if (!state?.last_read_message_id) return totalMessageCount(admin);

    const { data: last } = await admin
      .from("community_messages")
      .select("created_at")
      .eq("id", state.last_read_message_id)
      .maybeSingle();
    if (!last) return totalMessageCount(admin);

    const { count } = await admin
      .from("community_messages")
      .select("id", { count: "exact", head: true })
      .gt("created_at", last.created_at);
    return count ?? 0;
  } catch {
    return 0;
  }
}

async function totalMessageCount(
  admin: ReturnType<typeof createAdminClient>,
): Promise<number> {
  const { count } = await admin
    .from("community_messages")
    .select("id", { count: "exact", head: true });
  return count ?? 0;
}

/**
 * Initial chat window: the newest COMMUNITY_PAGE_SIZE messages, ascending,
 * each enriched with the author's community display name + avatar.
 */
export async function fetchInitialCommunityMessages(): Promise<CommunityMessageView[]> {
  const admin = createAdminClient();
  const { data: messages, error } = await admin
    .from("community_messages")
    .select("id,user_id,message,image_path,created_at,updated_at")
    .order("created_at", { ascending: false })
    .limit(COMMUNITY_PAGE_SIZE);
  if (error || !messages || messages.length === 0) return [];

  const authorIds = [...new Set(messages.map((m) => m.user_id))];
  const { data: profiles } = await admin
    .from("community_profiles")
    .select("user_id,display_name,avatar_id")
    .in("user_id", authorIds);
  const byUser = new Map(
    (profiles ?? []).map((p) => [p.user_id, p as CommunityMessageView["author"]]),
  );

  return messages
    .map((m) => ({ ...m, author: byUser.get(m.user_id) ?? null }))
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
}
