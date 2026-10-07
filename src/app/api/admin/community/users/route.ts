import { NextResponse } from "next/server";
import { z } from "zod";
import { searchAdminUsers } from "@/lib/community/admin-ops";
import { isPlatformAdmin } from "@/lib/community/platform-admin";
import {
  checkRateLimit,
  rateLimitHeaders,
  tooManyRequests,
} from "@/lib/rate-limit";

/**
 * GET /api/admin/community/users?q=<email|display name> — the admin user
 * search (community moderation surface). Bounded (30 results),
 * service-role reads only. Authorization: isPlatformAdmin(); the query is
 * validated (3–120 chars, no wildcard meaning — PostgREST ilike with
 * user-controlled % could widen the scan, so % and _ are stripped).
 */
const filterSchema = z
  .object({ q: z.string().trim().min(3).max(120) })
  .strict();

export async function GET(request: Request): Promise<NextResponse> {
  const check = await isPlatformAdmin();
  if (!check.ok) {
    return NextResponse.json(
      { error: check.code === "unauthenticated" ? "Unauthorized" : "Forbidden" },
      { status: check.code === "unauthenticated" ? 401 : 403 },
    );
  }
  const limited = await checkRateLimit("admin_actions", check.userId);
  if (!limited.allowed) return tooManyRequests(limited);

  const parsed = filterSchema.safeParse({
    q: new URL(request.url).searchParams.get("q") ?? "",
  });
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_query" }, { status: 400 });
  }
  // Neutralize LIKE metacharacters: the search is a plain substring.
  const query = parsed.data.q.replace(/[%_\\]/g, "");

  const { items, unavailable } = await searchAdminUsers(query);
  if (unavailable) {
    return NextResponse.json({ error: "search_unavailable" }, { status: 500 });
  }
  return NextResponse.json({ items }, { headers: rateLimitHeaders(limited) });
}
