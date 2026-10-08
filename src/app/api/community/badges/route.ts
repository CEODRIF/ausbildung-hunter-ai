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
 * The shell polls this every 1s while mounted (`?poll=1` → the higher
 * community_poll bucket) and also on events (realtime RECONNECTED, network
 * "online") after a connection recovery. Auth + RLS are identical to a
 * normal load — a poll can never read more.
 */
export async function GET(request: Request) {
  const { user, profile } = await getCurrentUserAndProfile();
  if (!user || !profile || profile.account_status !== "active") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const isPoll = new URL(request.url).searchParams.get("poll") === "1";
  const limited = await checkRateLimit(
    isPoll ? "community_poll" : "community_profile",
    user.id,
  );
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
