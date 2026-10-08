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
import { fetchCommunityWriteGate } from "@/lib/community/roles";

/**
 * GET /api/community/friends — the full friends view (friends + incoming +
 * outgoing + blocked). The page prefetches it server-side; the client calls
 * this after realtime relationship changes to converge.
 */
export async function GET(request: Request) {
  const { user, profile } = await getCurrentUserAndProfile();
  if (!user || !profile || profile.account_status !== "active") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  // `?poll=1` marks the 1s background poll of the friends view
  // (community_poll bucket, 240/min) — auth + RLS identical to a normal load.
  const isPoll = new URL(request.url).searchParams.get("poll") === "1";
  const limited = await checkRateLimit(
    isPoll ? "community_poll" : "community_profile",
    user.id,
  );
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
 * Production diagnostics (incident: the friend request failed in production
 * while the modal + card renders fine). Every failure path logs ONE safe,
 * structured line — the SQLSTATE `code` is the discriminator:
 *   42501 → row-level security violation (insert policy missing/broken)
 *   23503 → foreign key (target row vanished)
 *   23514 → check constraint violation
 *   23505 → duplicate (handled as convergence, never a failure)
 * The message is truncated and carries no user content or credentials.
 */
function logFriendRequestFailure(
  step: string,
  userId: string,
  targetId: string | null,
  code: string | null | undefined,
  message: string | null | undefined,
): void {
  console.error(
    `[community] friend_request_failed step=${step} userId=${userId}` +
      ` target=${targetId ?? "-"}` +
      ` code=${code ?? "unknown"}` +
      ` message=${(message ?? "").slice(0, 200)}`,
  );
}

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

  // Phase 10: platform ban — banned users make no community mutations.
  const gate = await fetchCommunityWriteGate(user.id);
  if (!gate.writable) return NextResponse.json({ error: gate.code }, { status: 403 });

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
    logFriendRequestFailure("target", user.id, rawUserId, targetRes.error.code, targetRes.error.message);
    return NextResponse.json({ error: "friendship_error", code: targetRes.error.code ?? "db_read" }, { status: 500 });
  }
  const target = targetRes.data as { user_id: string } | null;
  if (!target) {
    return NextResponse.json({ error: "member_not_found" }, { status: 404 });
  }

  // Block check — both directions. PostgREST or= syntax: the comma separates
  // alternatives; AND only exists as a composite group with dotted filters
  // inside: and(col.eq.v,col2.eq.v). (The old chained shorthand
  // colA.eq.X.and.colB.eq.Y is invalid and made every social write fail
  // with 400 "invalid input syntax for type uuid".)
  const blockRes = await supabase
    .from("community_blocks")
    .select("blocker_id,blocked_id")
    .or(
      `and(blocker_id.eq.${user.id},blocked_id.eq.${rawUserId}),and(blocker_id.eq.${rawUserId},blocked_id.eq.${user.id})`,
    );
  if (blockRes.error) {
    logFriendRequestFailure("block", user.id, rawUserId, blockRes.error.code, blockRes.error.message);
    return NextResponse.json({ error: "friendship_error", code: blockRes.error.code ?? "db_read" }, { status: 500 });
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
          `and(requester_id.eq.${user.id},requestee_id.eq.${rawUserId}),and(requester_id.eq.${rawUserId},requestee_id.eq.${user.id})`,
        )
        .maybeSingle();
       if (!existingRes.error && existingRes.data) {
        return NextResponse.json(
          { friendship: existingRes.data, duplicate: true },
          { status: 200, headers: rateLimitHeaders(limited) },
        );
      }
      // The collision was real but the existing row is not readable —
      // log it (normally impossible: the viewer is a participant).
      logFriendRequestFailure("duplicate_recover", user.id, rawUserId, existingRes.error?.code, existingRes.error?.message);
    }
    // THE production discriminator: 42501 = RLS violation (the insert
    // policy "Users can send friend requests as themselves" is not
    // effective on this database), 23503 = FK, 23514 = check constraint.
    logFriendRequestFailure("insert", user.id, rawUserId, error.code, error.message);
    return NextResponse.json({ error: "friendship_error", code: error.code ?? "unknown" }, { status: 500 });
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
