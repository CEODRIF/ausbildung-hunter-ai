import { NextResponse } from "next/server";
import { getCurrentUserAndProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import {
  checkRateLimit,
  rateLimitHeaders,
  tooManyRequests,
} from "@/lib/rate-limit";
import {
  createSocialNotification,
  fetchFriendsList,
  socialSendKey,
} from "@/lib/community/social";

/**
 * GET /api/community/friends — the full friends view (friends + incoming +
 * outgoing + blocked). The page prefetches it server-side; the client calls
 * this after realtime relationship changes to converge.
 */
export async function GET() {
  const { user, profile } = await getCurrentUserAndProfile();
  if (!user || !profile || profile.account_status !== "active") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const limited = await checkRateLimit("community_profile", user.id);
  if (!limited.allowed) return tooManyRequests(limited);

  const supabase = await createClient();
  const result = await fetchFriendsList(supabase, user.id);
  if (result.unavailable) {
    return NextResponse.json({ error: "Could not load friends." }, { status: 500 });
  }
  return NextResponse.json(
    result,
    { headers: rateLimitHeaders(limited) },
  );
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * POST /api/community/friends — send a friend request.
 *
 * Server-side gates (never trust the client):
 *   1. active session (user_id is ALWAYS from the session),
 *   2. target is a community member,
 *   3. no self-requests,
 *   4. no active block in EITHER direction (blocked users cannot request),
 *   5. no duplicate: the canonical pair index makes "already pending" or
 *      "already friends" a hard, race-free database rule (23505 → the
 *      current state is returned so the client can converge).
 */
export async function POST(request: Request) {
  const { user, profile } = await getCurrentUserAndProfile();
  if (!user || !profile || profile.account_status !== "active") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const limited = await checkRateLimit("community_friend", user.id);
  if (!limited.allowed) return tooManyRequests(limited);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
  const rawUserId = (body as { userId?: unknown })?.userId;
  if (typeof rawUserId !== "string" || !UUID.test(rawUserId)) {
    return NextResponse.json({ error: "member_not_found" }, { status: 400 });
  }
  if (rawUserId === user.id) {
    return NextResponse.json({ error: "self_request" }, { status: 400 });
  }

  const supabase = await createClient();

  // Target must be a community member (identity check, nothing else leaks).
  const targetRes = await supabase
    .from("community_profiles")
    .select("user_id")
    .eq("user_id", rawUserId)
    .maybeSingle();
  if (targetRes.error) {
    return NextResponse.json({ error: "Could not send request." }, { status: 500 });
  }
  const target = targetRes.data as { user_id: string } | null;
  if (!target) {
    return NextResponse.json({ error: "member_not_found" }, { status: 404 });
  }

  // Block check — both directions.
  const blockRes = await supabase
    .from("community_blocks")
    .select("blocker_id,blocked_id")
    .or(
      `blocker_id.eq.${user.id}.and.blocked_id.eq.${rawUserId},blocker_id.eq.${rawUserId}.and.blocked_id.eq.${user.id}`,
    );
  if (blockRes.error) {
    return NextResponse.json({ error: "Could not send request." }, { status: 500 });
  }
  if ((blockRes.data ?? []).length > 0) {
    return NextResponse.json({ error: "blocked" }, { status: 403 });
  }

  const { data: inserted, error } = await supabase
    .from("community_friendships")
    .insert({ requester_id: user.id, requestee_id: rawUserId })
    .select("id,requester_id,requestee_id,status,created_at")
    .single();
  if (error) {
    if (error.code === "23505") {
      // Already pending (in some direction) or already friends — return the
      // canonical row so the client's state machine converges.
      const existingRes = await supabase
        .from("community_friendships")
        .select("id,requester_id,requestee_id,status,created_at")
        .or(
          `requester_id.eq.${user.id}.and.requestee_id.eq.${rawUserId},requester_id.eq.${rawUserId}.and.requestee_id.eq.${user.id}`,
        )
        .maybeSingle();
      if (!existingRes.error && existingRes.data) {
        return NextResponse.json(
          { friendship: existingRes.data, duplicate: true },
          { status: 200, headers: rateLimitHeaders(limited) },
        );
      }
    }
    console.error("[community] friend request insert failed:", error.message);
    return NextResponse.json({ error: "Could not send request." }, { status: 500 });
  }

  // Phase 3: friend_request notification (idempotent by request id; the
  // text is rendered client-side per viewer language from the kind marker
  // + structured fields).
  void createSocialNotification({
    targetUserId: rawUserId,
    actorUserId: user.id,
    title: "friend_request",
    content: "",
    sendKey: socialSendKey("friend_request", inserted.id),
  });

  return NextResponse.json(
    { friendship: inserted },
    { status: 201, headers: rateLimitHeaders(limited) },
  );
}
