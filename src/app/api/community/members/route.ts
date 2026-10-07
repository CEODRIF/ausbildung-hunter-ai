import { NextResponse } from "next/server";
import { getCurrentUserAndProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import {
  checkRateLimit,
  rateLimitHeaders,
  tooManyRequests,
} from "@/lib/rate-limit";
import { mapVisiblePresence } from "@/lib/community/presence";

/**
 * GET /api/community/members — the community member list for the members
 * panel and the @-mention autocomplete (one bounded page, oldest members
 * first — the people with the longest history are the most-mentionable).
 *
 * Identity + privacy-mapped presence: user_id + display name + avatar id +
 * presence state. No email, no real name, no other profile data — and a
 * member with show_presence = false appears offline without last_seen
 * (the SAME mapping every other surface uses — one shared derivation).
 */
export async function GET() {
  const { user } = await getCurrentUserAndProfile();
  if (!user)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const limited = await checkRateLimit("community_history", user.id);
  if (!limited.allowed) return tooManyRequests(limited);

  try {
    const supabase = await createClient();
    const { data, error } = await supabase
      .from("community_profiles")
      .select(
        "user_id,display_name,avatar_id,last_seen_at,presence_mode,show_presence",
      )
      .order("created_at", { ascending: true })
      .limit(300);
    if (error)
      return NextResponse.json({ error: "Could not load members." }, { status: 500 });

    const items = ((data ?? []) as Array<{
      user_id: string;
      display_name: string;
      avatar_id: string;
      last_seen_at: string | null;
      presence_mode: "online" | "away" | "dnd" | null;
      show_presence: boolean | null;
    }>).map((row) => {
      const mapped = mapVisiblePresence(row, row.user_id === user.id);
      return {
        user_id: row.user_id,
        display_name: row.display_name,
        avatar_id: row.avatar_id,
        presence: mapped.state,
        last_seen_at: mapped.lastSeenAt,
      };
    });

    return NextResponse.json(
      { items },
      { headers: rateLimitHeaders(limited) },
    );
  } catch (error) {
    // A transport-level throw (not just a query error) must not escape as an
    // unhandled rejection — the panel is chrome, it degrades gracefully.
    console.error("[community] members read threw:", error);
    return NextResponse.json({ error: "Could not load members." }, { status: 500 });
  }
}
