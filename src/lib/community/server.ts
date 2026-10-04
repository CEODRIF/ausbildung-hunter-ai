import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { COMMUNITY_PAGE_SIZE, type CommunityMessageView } from "@/lib/community";

/** The request-scoped client (RLS-enforced) used for member-readable data. */
type SessionClient = Awaited<ReturnType<typeof createClient>>;

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
  } catch (error) {
    // Logged (never swallowed silently) but non-fatal: the badge is chrome.
    console.error("[community] unread count unavailable:", error);
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

export interface CommunityHistory {
  /** Newest page, ascending. Empty when nothing could be read. */
  messages: CommunityMessageView[];
  /**
   * True when the history could not be read (DB outage / misconfigured env).
   * The chat still renders — the client resyncs through
   * /api/community/messages, and Realtime keeps delivering new messages — so
   * this is a degraded state, not an error page.
   */
  unavailable: boolean;
}

/**
 * Initial chat window: the newest COMMUNITY_PAGE_SIZE messages, ascending,
 * each enriched with the author's community display name + avatar.
 *
 * Runs on the CALLER'S session client, exactly like the
 * /api/community/messages route: the message + profile SELECT policies already
 * make this data member-readable, so no privileged key is involved (the admin
 * client used to throw straight out of the page render here and produced the
 * global "This page could not load" screen).
 *
 * Never throws: every failure is logged and reported as `unavailable`.
 */
export async function fetchInitialCommunityMessages(
  supabase: SessionClient,
): Promise<CommunityHistory> {
  try {
    const { data: messages, error } = await supabase
      .from("community_messages")
      .select("id,user_id,message,image_path,created_at,updated_at")
      .order("created_at", { ascending: false })
      .limit(COMMUNITY_PAGE_SIZE);
    if (error) {
      console.error("[community] initial message history failed:", error.message);
      return { messages: [], unavailable: true };
    }
    if (!messages || messages.length === 0) return { messages: [], unavailable: false };

    const authorIds = [...new Set(messages.map((m) => m.user_id))];
    const { data: profiles, error: profileError } = await supabase
      .from("community_profiles")
      .select("user_id,display_name,avatar_id")
      .in("user_id", authorIds);
    // Author labels are cosmetic (the client resolves them again via
    // ensureAuthor), so a failure here is logged and the messages still show.
    if (profileError)
      console.error("[community] author lookup failed:", profileError.message);
    const byUser = new Map(
      (profiles ?? []).map((p) => [p.user_id, p as CommunityMessageView["author"]]),
    );

    return {
      messages: messages
        .map((m) => ({ ...m, author: byUser.get(m.user_id) ?? null }))
        .sort((a, b) => a.created_at.localeCompare(b.created_at)),
      unavailable: false,
    };
  } catch (error) {
    console.error("[community] initial message history threw:", error);
    return { messages: [], unavailable: true };
  }
}
