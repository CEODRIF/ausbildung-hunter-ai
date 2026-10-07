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
 * POST /api/community/blocks/:userId — block a member.
 *
 * Blocking composes with every other state (you can block a friend or a
 * stranger); it composes with the friendship row too: the friendship stays
 * stored, but every social write (requests, DMs) checks the block first, so
 * the relationship is suspended until the unblock. Duplicate blocks are
 * idempotent (unique constraint → 23505 → 200 with the existing state).
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ userId: string }> },
) {
  const { user, profile } = await getCurrentUserAndProfile();
  if (!user || !profile || profile.account_status !== "active") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const limited = await checkRateLimit("community_block", user.id);
  if (!limited.allowed) return tooManyRequests(limited);

  // Phase 10: platform ban — banned users make no community mutations.
  const gate = await fetchCommunityWriteGate(user.id);
  if (!gate.writable) return NextResponse.json({ error: gate.code }, { status: 403 });

  const targetId = (await params).userId;
  if (!UUID.test(targetId)) {
    return NextResponse.json({ error: "member_not_found" }, { status: 400 });
  }
  if (targetId === user.id) {
    return NextResponse.json({ error: "self_block" }, { status: 400 });
  }

  const supabase = await createClient();

  // The target must be a community member (don't block arbitrary auth ids).
  const targetRes = await supabase
    .from("community_profiles")
    .select("user_id")
    .eq("user_id", targetId)
    .maybeSingle();
  if (targetRes.error) {
    return NextResponse.json({ error: "Could not update block." }, { status: 500 });
  }
  if (!targetRes.data) {
    return NextResponse.json({ error: "member_not_found" }, { status: 404 });
  }

  const { error } = await supabase
    .from("community_blocks")
    .insert({ blocker_id: user.id, blocked_id: targetId });
  if (error) {
    if (error.code === "23505") {
      // Already blocked — idempotent success.
      return NextResponse.json(
        { blocked: true, duplicate: true },
        { status: 200, headers: rateLimitHeaders(limited) },
      );
    }
    console.error("[community] block failed:", error.message);
    return NextResponse.json({ error: "Could not update block." }, { status: 500 });
  }
  return NextResponse.json({ blocked: true }, { status: 201, headers: rateLimitHeaders(limited) });
}

/**
 * DELETE /api/community/blocks/:userId — unblock.
 *
 * Only the blocker may unblock. Idempotent: unblocking someone you did not
 * block is a 404 (the state is already "unblocked").
 */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ userId: string }> },
) {
  const { user, profile } = await getCurrentUserAndProfile();
  if (!user || !profile || profile.account_status !== "active") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const limited = await checkRateLimit("community_block", user.id);
  if (!limited.allowed) return tooManyRequests(limited);

  // Phase 10: platform ban — banned users make no community mutations.
  const gate = await fetchCommunityWriteGate(user.id);
  if (!gate.writable) return NextResponse.json({ error: gate.code }, { status: 403 });

  const targetId = (await params).userId;
  if (!UUID.test(targetId)) {
    return NextResponse.json({ error: "member_not_found" }, { status: 400 });
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("community_blocks")
    .delete()
    .eq("blocker_id", user.id)
    .eq("blocked_id", targetId)
    .select("id");
  if (error) {
    console.error("[community] unblock failed:", error.message);
    return NextResponse.json({ error: "Could not update block." }, { status: 500 });
  }
  if (!data || data.length === 0) {
    return NextResponse.json({ error: "not_blocked" }, { status: 404 });
  }
  return NextResponse.json({ unblocked: true }, { status: 200, headers: rateLimitHeaders(limited) });
}
