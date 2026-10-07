import { NextResponse } from "next/server";
import { getCurrentUserAndProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import {
  checkRateLimit,
  rateLimitHeaders,
  tooManyRequests,
} from "@/lib/rate-limit";
import { fetchCommunityWriteGate } from "@/lib/community/roles";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * DELETE /api/community/friends/:userId — remove a friend.
 *
 * Either participant may remove the ACCEPTED friendship. Consequences:
 *  - the friendship row is deleted → a fresh request is possible later
 *    (unless someone blocks the other),
 *  - existing DM conversations are NOT deleted (history stays private to
 *    the two members), but sending NEW DM messages is blocked at the RLS
 *    layer (no accepted friendship anymore),
 *  - blocks are a separate table and survive friend-removal.
 */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ userId: string }> },
) {
  const { user, profile } = await getCurrentUserAndProfile();
  if (!user || !profile || profile.account_status !== "active") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const limited = await checkRateLimit("community_friend", user.id);
  if (!limited.allowed) return tooManyRequests(limited);

  // Phase 10: platform ban — banned users make no community mutations.
  const gate = await fetchCommunityWriteGate(user.id);
  if (!gate.writable) return NextResponse.json({ error: gate.code }, { status: 403 });

  const targetId = (await params).userId;
  if (!UUID.test(targetId) || targetId === user.id) {
    return NextResponse.json({ error: "not_friends" }, { status: 400 });
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("community_friendships")
    .delete()
    .eq("status", "accepted")
    .or(
      `requester_id.eq.${user.id}.and.requestee_id.eq.${targetId},requester_id.eq.${targetId}.and.requestee_id.eq.${user.id}`,
    )
    .select("id");
  if (error) {
    console.error("[community] remove friend failed:", error.message);
    return NextResponse.json({ error: "Could not remove friend." }, { status: 500 });
  }
  if (!data || data.length === 0) {
    return NextResponse.json({ error: "not_friends" }, { status: 404 });
  }
  return NextResponse.json(
    { removed: true },
    { status: 200, headers: rateLimitHeaders(limited) },
  );
}
