import { NextResponse } from "next/server";
import { z } from "zod";
import { adminHideMessage } from "@/lib/community/admin-ops";
import { isPlatformAdmin } from "@/lib/community/platform-admin";
import {
  checkRateLimit,
  rateLimitHeaders,
  tooManyRequests,
} from "@/lib/rate-limit";

/**
 * POST /api/admin/community/messages/:id — admin deletion of ANY community
 * message (the existing soft-hide model: hidden_by/hidden_at; the row and
 * its audit stay, the message disappears from every member read path and
 * from realtime). Works regardless of room membership or authorship.
 *
 *   body { "reason"? }  (optional, ≤200 chars — stored in the audit row)
 *
 * Authorization: isPlatformAdmin() — the session-derived actor; the :id
 * path param is the TARGET and is validated as a UUID. The operation is
 * idempotent (already-hidden → ok, no second audit row). Every fresh hide
 * is audited as action='admin_message_delete'.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const hideBodySchema = z
  .object({
    reason: z.string().trim().max(200).optional().or(z.literal("")),
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
    return NextResponse.json({ error: "invalid_message" }, { status: 400 });
  }
  const limited = await checkRateLimit("admin_actions", check.userId);
  if (!limited.allowed) return tooManyRequests(limited);

  let body: unknown = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  const parsed = hideBodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_payload" }, { status: 400 });
  }

  const result = await adminHideMessage({
    actorId: check.userId,
    messageId: id,
    reason: (parsed.data as { reason?: string }).reason ?? null,
  });
  if (!result.ok) {
    return NextResponse.json(
      { error: result.error },
      { status: result.error === "failed" ? 500 : 400 },
    );
  }
  return NextResponse.json(
    { ok: true, alreadyHidden: result.alreadyHidden },
    { headers: rateLimitHeaders(limited) },
  );
}
