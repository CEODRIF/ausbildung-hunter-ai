import { NextResponse } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Phase 14 — worker work-discovery endpoint.
 *
 * Same trust boundary as the processing endpoint: the
 * `x-email-worker-secret` header (worker == service-level trust).
 * The body must be empty (strict) — the worker supplies nothing it
 * controls; Postgres decides which campaign is due next. Returns
 * `campaign: null` when the queue is empty.
 */
const claimBody = z.object({}).strict();

export async function POST(request: Request) {
  const configuredSecret = process.env.EMAIL_WORKER_SECRET;
  const suppliedSecret = request.headers.get("x-email-worker-secret");
  if (!configuredSecret || suppliedSecret !== configuredSecret)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!claimBody.safeParse(body ?? {}).success)
    return NextResponse.json(
      { error: "Claim request must be empty" },
      { status: 400 },
    );

  const admin = createAdminClient();
  const { data, error } = await admin.rpc("claim_next_pending_campaign");
  if (error)
    return NextResponse.json({ error: "Claim failed" }, { status: 500 });
  if (!data || !data["campaign_id"])
    return NextResponse.json({ campaign: null }, { status: 200 });

  return NextResponse.json({
    campaign: {
      userId: data["user_id"],
      campaignId: data["campaign_id"],
    },
  });
}
