import { NextResponse } from "next/server";
import { fetchUserMessagesForAdmin } from "@/lib/community/admin-ops";
import { isPlatformAdmin } from "@/lib/community/platform-admin";
import {
  checkRateLimit,
  rateLimitHeaders,
  tooManyRequests,
} from "@/lib/rate-limit";

/**
 * GET /api/admin/community/users/:id/messages — the user's recent community
 * messages (the admin moderation detail view: pick one to delete).
 * Text previews are truncated server-side (500 chars) — never a full
 * content dump, and the response is platform-admin-only.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const check = await isPlatformAdmin();
  if (!check.ok) {
    return NextResponse.json(
      { error: check.code === "unauthenticated" ? "Unauthorized" : "Forbidden" },
      { status: check.code === "unauthenticated" ? 401 : 403 },
    );
  }
  const { id } = await context.params;
  if (!UUID.test(id)) {
    return NextResponse.json({ error: "invalid_user" }, { status: 400 });
  }
  const limited = await checkRateLimit("admin_actions", check.userId);
  if (!limited.allowed) return tooManyRequests(limited);

  const { items, unavailable } = await fetchUserMessagesForAdmin(id, 20);
  if (unavailable) {
    return NextResponse.json({ error: "unavailable" }, { status: 500 });
  }
  return NextResponse.json(
    { items: items.map((m) => ({ ...m, text: m.text?.slice(0, 500) ?? null })) },
    { headers: rateLimitHeaders(limited) },
  );
}
