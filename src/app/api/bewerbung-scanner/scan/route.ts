import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  createScan,
  runScan,
  type ScanGoal,
  type ScanFile,
} from "@/lib/bewerbung-scanner";

export const runtime = "nodejs";
export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = (await request.json().catch(() => ({}))) as {
    goal?: ScanGoal;
    files?: ScanFile[];
  };
  if (body.goal !== "ausbildung" && body.goal !== "arbeit")
    return NextResponse.json(
      { error: "Choose Ausbildung or Arbeit." },
      { status: 400 },
    );
  if (
    !Array.isArray(body.files) ||
    !body.files.length ||
    body.files.length > 10
  )
    return NextResponse.json(
      { error: "Upload between 1 and 10 files." },
      { status: 400 },
    );
  try {
    const scanId = await createScan(body.goal, body.files);
    await runScan(scanId);
    return NextResponse.json({ scanId });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Scan failed." },
      { status: 400 },
    );
  }
}
