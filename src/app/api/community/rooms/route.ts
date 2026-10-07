import { NextResponse } from "next/server";
import { getCurrentUserAndProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import {
  checkRateLimit,
  rateLimitHeaders,
  tooManyRequests,
} from "@/lib/rate-limit";
import { fetchCommunityRoomGroups } from "@/lib/community/rooms";

/**
 * GET /api/community/rooms — the room directory (categories + enabled rooms,
 * in display order). Member-readable by RLS; no privileged key involved.
 * Powers the mobile room sheet and any client-side resync of the sidebar.
 */
export async function GET() {
  const { user } = await getCurrentUserAndProfile();
  if (!user)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const limited = await checkRateLimit("community_history", user.id);
  if (!limited.allowed) return tooManyRequests(limited);

  const supabase = await createClient();
  const { groups, unavailable } = await fetchCommunityRoomGroups(supabase);
  if (unavailable)
    return NextResponse.json({ error: "Could not load rooms." }, { status: 500 });

  return NextResponse.json(
    { categories: groups },
    { headers: rateLimitHeaders(limited) },
  );
}
