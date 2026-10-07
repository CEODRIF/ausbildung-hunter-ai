import { NextResponse } from "next/server";
import { getCurrentUserAndProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import {
  checkRateLimit,
  rateLimitHeaders,
  tooManyRequests,
} from "@/lib/rate-limit";
import {
  fetchDmSummary,
  openDmConversation,
} from "@/lib/community/social";
import { fetchCommunityWriteGate } from "@/lib/community/roles";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * POST /api/community/dm — open (or reuse) the DM conversation with a
 * friend. GATES (server-side): target is a member, the pair is ACCEPTED
 * friends, no block in either direction. The unique-pair constraint makes
 * concurrent opens idempotent.
 */
export async function POST(request: Request) {
  const { user, profile } = await getCurrentUserAndProfile();
  if (!user || !profile || profile.account_status !== "active") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const limited = await checkRateLimit("community_dm_history", user.id);
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

  const supabase = await createClient();
  const { conversation, error } = await openDmConversation(supabase, user.id, rawUserId);
  if (error === "member_not_found") {
    return NextResponse.json({ error: "member_not_found" }, { status: 404 });
  }
  if (error === "not_friends") {
    return NextResponse.json({ error: "not_friends" }, { status: 403 });
  }
  if (error === "blocked") {
    return NextResponse.json({ error: "blocked" }, { status: 403 });
  }
  if (error === "unavailable" || !conversation) {
    return NextResponse.json({ error: "Could not open conversation." }, { status: 500 });
  }
  return NextResponse.json(
    { conversation },
    { status: 201, headers: rateLimitHeaders(limited) },
  );
}

/**
 * GET /api/community/dm — the inbox: every conversation with the other
 * member's identity, unread count, last-message shape and timestamp
 * (ONE SQL summary + ONE profile batch — never a message download).
 */
export async function GET() {
  const { user, profile } = await getCurrentUserAndProfile();
  if (!user || !profile || profile.account_status !== "active") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const limited = await checkRateLimit("community_dm_history", user.id);
  if (!limited.allowed) return tooManyRequests(limited);

  const supabase = await createClient();
  const { conversations, unavailable } = await fetchDmSummary(supabase, user.id);
  if (unavailable) {
    return NextResponse.json({ error: "Could not load conversations." }, { status: 500 });
  }
  return NextResponse.json(
    { conversations },
    { headers: rateLimitHeaders(limited) },
  );
}
