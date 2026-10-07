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
  socialSendKey,
} from "@/lib/community/social";
import { fetchCommunityWriteGate } from "@/lib/community/roles";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface RequestRow {
  id: string;
  requester_id: string;
  requestee_id: string;
  status: "pending" | "accepted";
}

// Unit discriminants per member: TS only eliminates union members whose
// discriminant is a unit type (a `"a" | "b"` discriminant is never removed in
// the false branch, which would break the narrowing below).
async function loadOwnedRequest(
  requestId: string,
): Promise<
  | { status: "error" }
  | { status: "not_found" }
  | { status: "ok"; row: RequestRow }
> {
  if (!UUID.test(requestId)) return { status: "not_found" };
  const supabase = await createClient();
  // RLS restricts this to the viewer's own rows (participant only).
  const { data, error } = await supabase
    .from("community_friendships")
    .select("id,requester_id,requestee_id,status")
    .eq("id", requestId)
    .maybeSingle();
  if (error) return { status: "error" };
  if (!data) return { status: "not_found" };
  return { status: "ok", row: data as RequestRow };
}

/**
 * POST /api/community/friends/requests/:id  { action: "accept" | "decline" }
 *
 * Only the REQUESTEE may accept or decline, and only while the request is
 * still pending. Acceptance checks that neither side blocked the other in
 * the meantime (a block placed after the request must kill it). Decline
 * deletes the row — a fresh request can always be sent afterwards.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ requestId: string }> },
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

  const { requestId } = await params;
  const loaded = await loadOwnedRequest(requestId);
  if (loaded.status === "error") {
    return NextResponse.json({ error: "Could not update request." }, { status: 500 });
  }
  if (loaded.status === "not_found") {
    return NextResponse.json({ error: "request_not_found" }, { status: 404 });
  }
  const row = loaded.row;
  if (row.requestee_id !== user.id) {
    // Not my inbox — only the requestee may act on an incoming request.
    return NextResponse.json({ error: "not_allowed" }, { status: 403 });
  }
  if (row.status !== "pending") {
    return NextResponse.json(
      { friendship: row, duplicate: true },
      { status: 200, headers: rateLimitHeaders(limited) },
    );
  }

  let action: unknown = null;
  try {
    action = ((await _request.json()) as { action?: unknown })?.action;
  } catch {
    action = null;
  }
  if (action !== "accept" && action !== "decline") {
    return NextResponse.json({ error: "invalid_action" }, { status: 400 });
  }

  const supabase = await createClient();

  if (action === "accept") {
    // A block in either direction kills the request (checked in the API;
    // the DM RLS remains the final gate for messaging).
    const blockRes = await supabase
      .from("community_blocks")
      .select("blocker_id,blocked_id")
      .or(
        `blocker_id.eq.${user.id}.and.blocked_id.eq.${row.requester_id},blocker_id.eq.${row.requester_id}.and.blocked_id.eq.${user.id}`,
      );
    if (blockRes.error) {
      return NextResponse.json({ error: "Could not accept request." }, { status: 500 });
    }
    if ((blockRes.data ?? []).length > 0) {
      // Clean up the stale request, then reject.
      await supabase.from("community_friendships").delete().eq("id", row.id);
      return NextResponse.json({ error: "blocked" }, { status: 403 });
    }

    const { error } = await supabase
      .from("community_friendships")
      .update({ status: "accepted" })
      .eq("id", row.id)
      .eq("requestee_id", user.id) // defense in depth on top of RLS
      .eq("status", "pending"); // no double-accept races
    if (error) {
      console.error("[community] accept failed:", error.message);
      return NextResponse.json({ error: "Could not accept request." }, { status: 500 });
    }

    // Phase 3: friend_accepted notification (idempotent by request id;
    // text rendered client-side per viewer language from the kind marker).
    void createSocialNotification({
      targetUserId: row.requester_id,
      actorUserId: user.id,
      title: "friend_accepted",
      content: "",
      sendKey: socialSendKey("friend_accepted", row.id),
    });

    return NextResponse.json(
      { friendship: { ...row, status: "accepted" as const } },
      { status: 200, headers: rateLimitHeaders(limited) },
    );
  }

  // decline → delete the pair row (a fresh request is possible afterwards).
  const { error } = await supabase
    .from("community_friendships")
    .delete()
    .eq("id", row.id)
    .eq("requestee_id", user.id)
    .eq("status", "pending");
  if (error) {
    console.error("[community] decline failed:", error.message);
    return NextResponse.json({ error: "Could not decline request." }, { status: 500 });
  }
  return NextResponse.json({ declined: true }, { status: 200, headers: rateLimitHeaders(limited) });
}

/**
 * DELETE /api/community/friends/requests/:id — CANCEL an outgoing request.
 * Only the requester, only while pending.
 */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ requestId: string }> },
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

  const { requestId } = await params;
  const loaded = await loadOwnedRequest(requestId);
  if (loaded.status === "error") {
    return NextResponse.json({ error: "Could not cancel request." }, { status: 500 });
  }
  if (loaded.status === "not_found") {
    return NextResponse.json({ error: "request_not_found" }, { status: 404 });
  }
  const row = loaded.row;
  if (row.requester_id !== user.id) {
    return NextResponse.json({ error: "not_allowed" }, { status: 403 });
  }
  if (row.status !== "pending") {
    return NextResponse.json({ error: "not_pending" }, { status: 409 });
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("community_friendships")
    .delete()
    .eq("id", row.id)
    .eq("requester_id", user.id)
    .eq("status", "pending");
  if (error) {
    console.error("[community] cancel failed:", error.message);
    return NextResponse.json({ error: "Could not cancel request." }, { status: 500 });
  }
  return NextResponse.json({ cancelled: true }, { status: 200, headers: rateLimitHeaders(limited) });
}
