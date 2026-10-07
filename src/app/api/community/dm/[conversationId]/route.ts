import { NextResponse } from "next/server";
import { getCurrentUserAndProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import {
  checkRateLimit,
  rateLimitHeaders,
  tooManyRequests,
} from "@/lib/rate-limit";
import {
  fetchDmMessagePage,
  fetchProfiles,
  loadDmConversation,
} from "@/lib/community/social";
import { mapVisiblePresence } from "@/lib/community/presence";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET /api/community/dm/:conversationId?before_at=…
 *
 * One page of the conversation (newest-first DB fetch → ascending response),
 * enriched with authors, reactions and reply previews — the same fixed-batch
 * pattern as the room message page. Authorization: membership is enforced
 * by RLS (loadDmConversation returns null for non-members → 404,
 * deliberately indistinct from "does not exist").
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ conversationId: string }> },
) {
  const { user, profile } = await getCurrentUserAndProfile();
  if (!user || !profile || profile.account_status !== "active") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const limited = await checkRateLimit("community_dm_history", user.id);
  if (!limited.allowed) return tooManyRequests(limited);

  const { conversationId } = await params;
  if (!UUID.test(conversationId)) {
    return NextResponse.json({ error: "conversation_not_found" }, { status: 400 });
  }

  const url = new URL(request.url);
  const beforeAt = url.searchParams.get("before_at");
  if (beforeAt && Number.isNaN(Date.parse(beforeAt))) {
    return NextResponse.json({ error: "invalid_cursor" }, { status: 400 });
  }

  const supabase = await createClient();
  const loaded = await loadDmConversation(supabase, user.id, conversationId);
  if (!loaded) {
    return NextResponse.json({ error: "conversation_not_found" }, { status: 404 });
  }

  // The other member's identity for the header (one tiny query).
  const other = await fetchProfiles(supabase, [loaded.otherId]);
  const otherRow = other.get(loaded.otherId);

  const { messages, unavailable } = await fetchDmMessagePage(
    supabase,
    loaded.conversation,
    user.id,
    beforeAt,
  );
  if (unavailable) {
    return NextResponse.json({ error: "Could not load messages." }, { status: 500 });
  }

  // Phase 3: presence is privacy-mapped (the ONE shared derivation — the
  // peer with show_presence = false appears offline without last_seen).
  const otherMapped = otherRow ? mapVisiblePresence(otherRow, false) : null;
  return NextResponse.json(
    {
      conversation: loaded.conversation,
      other: otherRow
        ? {
            userId: otherRow.user_id,
            displayName: otherRow.display_name,
            avatarId: otherRow.avatar_id,
            bio: otherRow.bio,
            online: otherMapped !== null && otherMapped.state !== "offline",
            presence: otherMapped?.state ?? "offline",
            lastSeenAt: otherMapped?.lastSeenAt ?? null,
          }
        : null,
      messages,
    },
    { headers: rateLimitHeaders(limited) },
  );
}
