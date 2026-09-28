import { NextResponse } from "next/server";
import { processCampaignBatch } from "@/lib/email-campaigns";

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
    const result = await processCampaignBatch(
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
