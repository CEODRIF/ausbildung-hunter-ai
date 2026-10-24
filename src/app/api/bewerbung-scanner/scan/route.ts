import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { checkRateLimit, tooManyRequests } from "@/lib/rate-limit";
import { scanRequestBodySchema } from "@/lib/bewerbung-schema";
import { createScan } from "@/lib/bewerbung-scanner";
import {
  runScan,
  SCANNER_FEATURE_DISABLED,
  SCANNER_QUOTA_EXHAUSTED,
  SCANNER_QUOTA_UNAVAILABLE,
} from "@/lib/bewerbung-scan";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  // One scan = up to 10 documents analysed by the vision model in a single
  // synchronous run. The daily AI quota is the primary gate; this caps bursts.
  const limited = await checkRateLimit("scanner_scan", user.id);
  if (!limited.allowed) return tooManyRequests(limited);
  const parsed = scanRequestBodySchema.safeParse(
    await request.json().catch(() => ({})),
  );
  if (!parsed.success)
    return NextResponse.json(
      { error: "Upload between 1 and 10 supported files." },
      { status: 400 },
    );
  try {
    const scanId = await createScan(parsed.data.goal, parsed.data.files);
    await runScan(scanId);
    return NextResponse.json({ scanId });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Scan failed.";
    // Canonical deny statuses (consistent with /api/ai/cover-letter):
    // quota exhaustion 429, plan denial 403, unverifiable state 503.
    if (message === SCANNER_QUOTA_EXHAUSTED)
      return NextResponse.json(
        { error: message, code: "quota_exhausted" },
        { status: 429 },
      );
    if (message === SCANNER_FEATURE_DISABLED)
      return NextResponse.json(
        { error: message, code: "feature_disabled" },
        { status: 403 },
      );
    if (message === SCANNER_QUOTA_UNAVAILABLE)
      return NextResponse.json(
        { error: message, code: "quota_unavailable" },
        { status: 503 },
      );
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
