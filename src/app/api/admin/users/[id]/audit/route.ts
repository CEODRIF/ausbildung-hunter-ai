import { NextResponse } from "next/server";
import { z } from "zod";
import { isUuid, requireAdmin } from "@/lib/billing/admin";
import { createAdminClient } from "@/lib/supabase/admin";
import { checkRateLimit, tooManyRequests } from "@/lib/rate-limit";

const querySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(50).optional(),
  })
  .strict();

interface AuditEntry {
  created_at: string;
  action: string;
  plan: string | null;
  period_days: number | null;
  reason: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

/**
 * Read-only audit trail for ONE target user (admin-only). Every successful
 * administrative subscription change writes an admin_audit_log row with
 * actor, action, reason and full before/after state (atomic with the change
 * — migration 20261126). This endpoint NEVER mutates: it only lists the
 * last N entries (default 20, max 50), newest first.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const adminUser = await requireAdmin();
  if (!adminUser) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const limited = await checkRateLimit("admin_actions", adminUser.id);
  if (!limited.allowed) return tooManyRequests(limited);
  const { id: targetId } = await context.params;
  if (!isUuid(targetId)) {
    return NextResponse.json({ error: "Invalid user id" }, { status: 400 });
  }

  const query = new URL(request.url).searchParams;
  const parsed = querySchema.safeParse({
    limit: query.get("limit") ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid query" }, { status: 400 });
  }
  const limit = parsed.data.limit ?? 20;

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("admin_audit_log")
    .select("created_at, action, details")
    .eq("target_user_id", targetId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) {
    return NextResponse.json({ error: "audit_unavailable" }, { status: 503 });
  }

  const entries: AuditEntry[] = (
    (data ?? []) as Array<Record<string, unknown>>
  ).map((row) => {
    const details = (row.details as Record<string, unknown> | null) ?? {};
    const before = details["before"] as
      Record<string, unknown> | null | undefined;
    const after = details["after"] as
      Record<string, unknown> | null | undefined;
    return {
      created_at: String(row.created_at ?? ""),
      action: String(row.action ?? ""),
      plan: typeof details["plan"] === "string" ? details["plan"] : null,
      period_days:
        typeof details["period_days"] === "number"
          ? details["period_days"]
          : null,
      reason: typeof details["reason"] === "string" ? details["reason"] : null,
      before: before && typeof before === "object" ? before : null,
      after: after && typeof after === "object" ? after : null,
    };
  });

  return NextResponse.json({ entries });
}
