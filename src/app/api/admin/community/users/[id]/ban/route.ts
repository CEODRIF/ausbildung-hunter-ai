import { NextResponse } from "next/server";
import { z } from "zod";
import {
  BAN_DURATIONS,
  banUser,
  unbanUser,
} from "@/lib/community/admin-ops";
import { isPlatformAdmin } from "@/lib/community/platform-admin";
import {
  checkRateLimit,
  rateLimitHeaders,
  tooManyRequests,
} from "@/lib/rate-limit";

/**
 * POST /api/admin/community/users/:id/ban — ban / unban a community user.
 *
 *   body { "ban": true,  "reason"?, "durationKey"? ("24h"|"7d"|"30d"|null) }
 *   body { "ban": false }
 *
 * Authorization: isPlatformAdmin() (session-derived actor — the :id in the
 * path is the TARGET, the actor is never client-supplied). Guards in the
 * lib layer: target must be a community member, self-ban impossible, the
 * platform admin itself is protected, one active ban per user. Every
 * success is audited (admin_ban_user / admin_unban_user).
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const banBodySchema = z
  .object({
    ban: z.boolean(),
    reason: z.string().trim().max(500).optional().or(z.literal("")),
    durationKey: z.enum(Object.keys(BAN_DURATIONS) as [string, ...string[]]).optional(),
  })
  .strict();

export async function POST(
  request: Request,
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

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_payload" }, { status: 400 });
  }
  const parsed = banBodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_payload" }, { status: 400 });
  }

  const data = parsed.data as {
    ban: boolean;
    reason?: string;
    durationKey?: string;
  };
  const result = data.ban
    ? await banUser({
        actorId: check.userId,
        targetUserId: id,
        reason: data.reason ?? null,
        durationKey: data.durationKey ?? null,
      })
    : await unbanUser({ actorId: check.userId, targetUserId: id });

  if (!result.ok) {
    return NextResponse.json(
      { error: result.error },
      { status: result.error === "failed" ? 500 : 400 },
    );
  }
  return NextResponse.json({ ok: true }, { headers: rateLimitHeaders(limited) });
}
