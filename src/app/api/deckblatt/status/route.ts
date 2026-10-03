import "server-only";
import { NextResponse } from "next/server";
import { getDeckblattUsageStatus } from "@/lib/deckblatt/usage";
import { getCurrentUserAndProfile } from "@/lib/auth";

export const runtime = "nodejs";

/**
 * GET /api/deckblatt/status
 *
 * Read-only today's quota state for the page header indicator
 * ("X von 2 Designs heute verfügbar"). Authenticated only; the usage row
 * is fetched via the security-definer RPC (RLS would allow the direct
 * SELECT too, but the RPC keeps one access path for the whole feature).
 */
export async function GET() {
  const { user } = await getCurrentUserAndProfile();
  if (!user) {
    return NextResponse.json({ code: "unauthorized" }, { status: 401 });
  }
  const status = await getDeckblattUsageStatus();
  if (!status) {
    return NextResponse.json({ code: "usage_unavailable" }, { status: 503 });
  }
  return NextResponse.json(status);
}
