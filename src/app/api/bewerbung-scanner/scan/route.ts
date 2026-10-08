import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { checkRateLimit, tooManyRequests } from "@/lib/rate-limit";
import { scanRequestBodySchema } from "@/lib/bewerbung-schema";
import { createScan } from "@/lib/bewerbung-scanner";
import { runScan } from "@/lib/bewerbung-scan";

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
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Scan failed." },
      { status: 400 },
    );
  }
}
