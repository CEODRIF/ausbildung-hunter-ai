import { NextResponse } from "next/server";
import {
  announcementSchema,
  sendPlatformAnnouncement,
} from "@/lib/community/admin-ops";
import { isPlatformAdmin } from "@/lib/community/platform-admin";
import {
  checkRateLimit,
  rateLimitHeaders,
  tooManyRequests,
} from "@/lib/rate-limit";

/**
 * POST /api/admin/announcements — send ONE platform announcement to ALL
 * users (the existing notification system: a single target_type='all' row,
 * delivered realtime, idempotent per client-generated send_key).
 *
 * Authorization: isPlatformAdmin() — the session user must be the stable
 * platform-admin id AND hold a public.admins membership (service-role
 * read). The actor is NEVER taken from the body. Rate-limited
 * (admin_actions scope). Input validated twice (route + lib).
 */
export async function POST(request: Request): Promise<NextResponse> {
  const check = await isPlatformAdmin();
  if (!check.ok) {
    return NextResponse.json(
      { error: check.code === "unauthenticated" ? "Unauthorized" : "Forbidden" },
      { status: check.code === "unauthenticated" ? 401 : 403 },
    );
  }
  const limited = await checkRateLimit("admin_actions", check.userId);
  if (!limited.allowed) return tooManyRequests(limited);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_payload" }, { status: 400 });
  }
  const parsed = announcementSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_announcement", issues: parsed.error.issues.slice(0, 3).map((i) => i.path.join(".")) },
      { status: 400 },
    );
  }

  const result = await sendPlatformAnnouncement({
    actorId: check.userId,
    payload: parsed.data,
  });
  if (!result.ok) {
    return NextResponse.json(
      { error: result.error },
      { status: result.error === "invalid" ? 400 : 500 },
    );
  }
  return NextResponse.json(
    { ok: true, duplicate: result.duplicate },
    { status: result.duplicate ? 200 : 201, headers: rateLimitHeaders(limited) },
  );
}
