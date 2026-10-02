import { NextResponse } from "next/server";
import { getCurrentUserAndProfile } from "@/lib/auth";
import { getDiscoveryRun } from "@/lib/company-discovery/runs";
import { checkRateLimit, rateLimitHeaders, tooManyRequests } from "@/lib/rate-limit";

/**
 * GET /api/company-discovery/[runId] — the REAL state of one of the user's
 * runs (counters, source status, terminal state). The progress UI (Phase 7)
 * polls this; every number it returns is measured, never simulated.
 * Ownership is enforced by the run store (user_id filter) — a foreign run
 * id is indistinguishable from an unknown one (404, not 403).
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ runId: string }> },
) {
  const { user, profile } = await getCurrentUserAndProfile();
  if (!user || !profile || profile.account_status !== "active")
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const limited = await checkRateLimit("company_discovery", user.id);
  if (!limited.allowed) return tooManyRequests(limited);

  const { runId } = await context.params;
  const run = await getDiscoveryRun(runId, user.id);
  if (!run)
    return NextResponse.json(
      { error: "Run not found." },
      { status: 404, headers: rateLimitHeaders(limited) },
    );
  return NextResponse.json({ run }, { headers: rateLimitHeaders(limited) });
}
