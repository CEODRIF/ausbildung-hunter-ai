import { NextResponse } from "next/server";
import { getCurrentUserAndProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import {
  checkRateLimit,
  rateLimitHeaders,
  tooManyRequests,
} from "@/lib/rate-limit";
import { fetchNotifications } from "@/lib/community/social";

/**
 * GET /api/community/notifications — the viewer's notifications (first page,
 * newest first) with PERSONAL read flags. The same bounded query the
 * server-rendered page and the "load more" action use — RLS is the
 * visibility boundary (own + global rows only).
 *
 * The notifications view polls this every 1s while mounted
 * (`?poll=1` → the higher community_poll bucket, 240/min) to guarantee
 * 1-second freshness; auth is IDENTICAL to a normal load, so a poll can
 * never read more than a page visit.
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
    const { items, unavailable } = await fetchNotifications(supabase, user.id, 30, null);
    if (unavailable) {
      return NextResponse.json({ error: "Could not load notifications." }, { status: 500 });
    }
    return NextResponse.json({ items }, { headers: rateLimitHeaders(limited) });
  } catch (error) {
    console.error("[community] notifications read threw:", error);
    return NextResponse.json({ error: "Could not load notifications." }, { status: 500 });
  }
}
