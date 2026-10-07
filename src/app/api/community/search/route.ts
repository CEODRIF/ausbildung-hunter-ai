import { NextResponse } from "next/server";
import { getCurrentUserAndProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import {
  checkRateLimit,
  rateLimitHeaders,
  tooManyRequests,
} from "@/lib/rate-limit";
import { fetchRoomBySlug } from "@/lib/community/rooms";
import {
  runCommunitySearch,
  SEARCH_KINDS,
  type SearchKind,
} from "@/lib/community/search";

/**
 * GET /api/community/search — global Community search (Phase 5).
 *
 * The query itself runs in Postgres (v6 `community_search` SECURITY
 * DEFINER function): tsvector/GIN full-text over messages, questions,
 * answers, member usernames and room names. Direct messages are NOT
 * searched (the function references no DM table), blocked authors (either
 * direction), hidden (moderated) rows, removed answers and disabled rooms
 * are excluded inside the function, and the viewer identity always comes
 * from the authenticated session (p_user === auth.uid() enforced in SQL).
 *
 * Params:
 *   q          — the query (2–200 chars, required)
 *   kind       — all | message | question | answer | user | room (default all)
 *   room       — room SLUG filter (resolved server-side; unknown → 400)
 *   author_id  — author UUID filter (validated)
 *   date       — all | week | month | year (created_at lower bound)
 *   before_at / before_id — keyset cursor from the previous page
 *
 * Response: { items, cursor, more } — 20 results per page, no offset.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function sinceForDate(date: string | null): string | null {
  switch (date) {
    case "week":
      return new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    case "month":
      return new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    case "year":
      return new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();
    default:
      return null;
  }
}

export async function GET(request: Request) {
  const { user } = await getCurrentUserAndProfile();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const limited = await checkRateLimit("community_search", user.id);
  if (!limited.allowed) return tooManyRequests(limited);

  const url = new URL(request.url);
  const q = url.searchParams.get("q")?.trim() ?? "";
  if (q.length < 2 || q.length > 200) {
    return NextResponse.json({ error: "query_invalid" }, { status: 400 });
  }

  const kindRaw = url.searchParams.get("kind") ?? "all";
  const kind = (SEARCH_KINDS as readonly string[]).includes(kindRaw)
    ? (kindRaw as SearchKind)
    : "all";

  const authorId = url.searchParams.get("author_id");
  if (authorId && !UUID.test(authorId)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const dateRaw = url.searchParams.get("date") ?? "all";
  const since = sinceForDate(dateRaw);
  if (!["all", "week", "month", "year"].includes(dateRaw)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const beforeAt = url.searchParams.get("before_at");
  const beforeId = url.searchParams.get("before_id");
  if (beforeAt && Number.isNaN(Date.parse(beforeAt))) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  if (beforeId && !UUID.test(beforeId)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const supabase = await createClient();
  let roomId: string | null = null;
  const roomSlug = url.searchParams.get("room");
  if (roomSlug && roomSlug.trim().length > 0) {
    const { room, unavailable } = await fetchRoomBySlug(supabase, roomSlug.trim().toLowerCase());
    if (unavailable) {
      return NextResponse.json({ error: "Could not load room." }, { status: 500 });
    }
    if (!room) {
      return NextResponse.json({ error: "room_not_found" }, { status: 400 });
    }
    roomId = room.id;
  }

  const page = await runCommunitySearch({
    userId: user.id,
    query: q,
    kind,
    roomId,
    authorId: authorId ?? null,
    since,
    cursor: beforeAt && beforeId ? { createdAt: beforeAt, id: beforeId } : null,
  });
  if (page.unavailable) {
    return NextResponse.json({ error: "search_failed" }, { status: 500 });
  }

  return NextResponse.json(
    {
      items: page.items,
      cursor: page.cursor,
      more: page.cursor !== null,
    },
    { headers: rateLimitHeaders(limited) },
  );
}
