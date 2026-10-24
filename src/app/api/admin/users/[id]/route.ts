import { NextResponse } from "next/server";
import { z } from "zod";
import { executeAdminAction, isUuid, requireAdmin } from "@/lib/billing/admin";
import { checkRateLimit, tooManyRequests } from "@/lib/rate-limit";

const actionSchema = z
  .object({
    action: z.enum([
      "set_plan",
      "cancel_subscription",
      "reactivate_subscription",
      "grant_admin",
      "revoke_admin",
    ]),
    plan: z.enum(["plus", "pro"]).optional(),
    // Strict plan↔duration pairing: Plus = 10 days (the canonical
    // premium_10d tier), Pro = 30 days. The former flat 1|30|365 list is
    // gone. The pairing is re-enforced in executeAdminAction (billing) and
    // in the manage_subscription RPC (migration 20261128) — the schema is
    // the first gate, never the only one.
    periodDays: z.union([z.literal(10), z.literal(30)]).optional(),
  })
  .strict()
  .refine((body) => {
    if (
      body.action !== "set_plan" &&
      body.action !== "reactivate_subscription"
    ) {
      return true;
    }
    if (body.plan === "plus") return body.periodDays === 10;
    if (body.plan === "pro") return body.periodDays === 30;
    return false; // plan-changing action without a plan
  });

/**
 * Admin actions. The ACTOR is always the authenticated admin (session);
 * the TARGET is the URL parameter (validated). The body may only carry
 * the action + its documented parameters — any extra field (user_id,
 * plan injections beyond the enum, entitlements, …) is rejected 400.
 */
export async function POST(
  _request: Request,
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
  let body: unknown;
  try {
    body = await _request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = actionSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid action payload" },
      { status: 400 },
    );
  }
  const result = await executeAdminAction(
    adminUser.id,
    targetId,
    parsed.data.action,
    { plan: parsed.data.plan, periodDays: parsed.data.periodDays },
  );
  if (!result.ok) {
    // Status codes: 4xx = caller-side rejection (the request itself was
    // invalid or the state doesn't allow it); 5xx = infrastructure
    // problems the operator must act on (missing migration = the database
    // is behind the code; audit write failed = the action committed but
    // its audit record did not — verify manually).
    const status =
      result.reason === "user_not_found"
        ? 404
        : result.reason === "no_subscription"
          ? 409
          : result.reason === "rpc_unavailable"
            ? 503
            : result.reason === "audit_failed"
              ? 500
              : 400;
    return NextResponse.json({ error: result.reason }, { status });
  }
  return NextResponse.json({ ok: true, message: result.message });
}
