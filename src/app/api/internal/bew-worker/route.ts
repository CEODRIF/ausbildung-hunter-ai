import { NextResponse } from "next/server";
import { processBewSendBatch } from "@/lib/bewerbung-engine";

/**
 * Internal Bewerbung-Automation drain trigger (mirror of /api/internal/
 * email-worker, isolated to the feature's OWN engine).
 *
 * Secret-gated (x-email-worker-secret — the SAME existing credential as the
 * protected engine's worker, so no new production secret is required),
 * bounded (≤5 messages per call), and idempotent: `processBewSendBatch`
 * claims applications with FOR UPDATE SKIP LOCKED, so overlapping
 * invocations (browser poll, worker, cron) can never double-send. No e-mail
 * is sent unless a campaign is explicitly in the `sending` state — which
 * only the user's confirmed action starts.
 */
export async function POST(request: Request) {
  const configuredSecret = process.env.EMAIL_WORKER_SECRET;
  const suppliedSecret = request.headers.get("x-email-worker-secret");
  if (!configuredSecret || suppliedSecret !== configuredSecret)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = (await request.json().catch(() => ({}))) as {
    userId?: string;
    campaignId?: string;
    batchSize?: number;
  };
  if (!body.userId || !body.campaignId)
    return NextResponse.json(
      { error: "Missing worker job fields" },
      { status: 400 },
    );
  try {
    const result = await processBewSendBatch(
      body.userId,
      body.campaignId,
      Math.min(body.batchSize ?? 5, 5),
    );
    return NextResponse.json(result);
  } catch {
    return NextResponse.json(
      { error: "Worker processing failed" },
      { status: 500 },
    );
  }
}
