import { NextResponse } from "next/server";
import { getCurrentUserAndProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import {
  checkRateLimit,
  rateLimitHeaders,
  tooManyRequests,
} from "@/lib/rate-limit";
import { fetchSocialBadges } from "@/lib/community/social";

/**
 * GET /api/community/badges — the nav badge counts (DMs / friend requests /
 * notifications), the SAME server computation the pages use for their first
 * render.
 *
 * The shell calls this on EVENT (realtime RECONNECTED, network "online")
 * after a connection recovery, when the in-memory increment may have missed
 * rows delivered while the socket was down. It is never called on a timer —
 * badges stay event-driven.
 */
export async function GET() {
  const { user, profile } = await getCurrentUserAndProfile();
  if (!user || !profile || profile.account_status !== "active") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const limited = await checkRateLimit("community_profile", user.id);
  if (!limited.allowed) return tooManyRequests(limited);

  try {
    const supabase = await createClient();
    const badges = await fetchSocialBadges(supabase, user.id);
    if (!badges) {
      return NextResponse.json({ error: "Could not load badges." }, { status: 500 });
    }
    return NextResponse.json(badges, { headers: rateLimitHeaders(limited) });
  } catch (error) {
    // Badges are chrome: a transport throw must not escape as an unhandled
    // rejection.
    console.error("[community] badges read threw:", error);
    return NextResponse.json({ error: "Could not load badges." }, { status: 500 });
  }
}
