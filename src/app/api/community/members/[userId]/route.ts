import { NextResponse } from "next/server";
import { getCurrentUserAndProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import {
  checkRateLimit,
  rateLimitHeaders,
  tooManyRequests,
} from "@/lib/rate-limit";
import { fetchMemberProfile } from "@/lib/community/social";
import { fetchReputationSummary } from "@/lib/community/reputation";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET /api/community/members/:userId — the profile-card payload.
 *
 * Privacy contract: ONLY community identity fields are selected
 * (username, avatar, bio, join date, server-computed presence) plus the
 * relationship of the VIEWER to the target. Email, real account name, plan
 * and every other account field are structurally out of reach — the
 * community profile table does not hold them.
 *
 * Phase 5: `stats` (the target's reputation summary) is a SIBLING of
 * `member` — the pinned `member` shape is untouched.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ userId: string }> },
) {
  const { user, profile } = await getCurrentUserAndProfile();
  if (!user || !profile || profile.account_status !== "active") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const limited = await checkRateLimit("community_profile", user.id);
  if (!limited.allowed) return tooManyRequests(limited);

  const targetId = (await params).userId;
  if (!UUID.test(targetId)) {
    return NextResponse.json({ error: "member_not_found" }, { status: 400 });
  }

  const supabase = await createClient();
  const [{ profile: member, relationship, unavailable }, stats] = await Promise.all([
    fetchMemberProfile(supabase, user.id, targetId),
    fetchReputationSummary(supabase, targetId),
  ]);
  if (unavailable) {
    return NextResponse.json({ error: "Could not load member." }, { status: 500 });
  }
  if (!member || !relationship) {
    return NextResponse.json({ error: "member_not_found" }, { status: 404 });
  }

  return NextResponse.json(
    { member, relationship, stats },
    { headers: rateLimitHeaders(limited) },
  );
}
