import { NextResponse } from "next/server";
import { getCurrentUserAndProfile } from "@/lib/auth";
import { cancelDiscoveryRun } from "@/lib/company-discovery/runs";
import { checkRateLimit, rateLimitHeaders, tooManyRequests } from "@/lib/rate-limit";

/**
 * POST /api/company-discovery/[runId]/cancel — Stop Search.
 *
 * Marks PENDING/RUNNING → CANCELLED (idempotent). The orchestrator re-reads
 * the run before every new work unit (pass, batch of offers), so a cancelled
 * run never starts a new source pass and never overwrites the terminal
 * state. Already-terminal runs are returned unchanged.
 */
export async function POST(
  _request: Request,
  context: { params: Promise<{ runId: string }> },
) {
  const { user, profile } = await getCurrentUserAndProfile();
  if (!user || !profile || profile.account_status !== "active")
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const limited = await checkRateLimit("company_discovery", user.id);
  if (!limited.allowed) return tooManyRequests(limited);

  const { runId } = await context.params;
  try {
    const run = await cancelDiscoveryRun(runId, user.id);
    return NextResponse.json({ run }, { headers: rateLimitHeaders(limited) });
  } catch (error) {
    const notFound = error instanceof Error && /not found/i.test(error.message);
    return NextResponse.json(
      {
        error: notFound
          ? "Run not found."
          : "The run could not be cancelled. Please try again.",
      },
      {
        status: notFound ? 404 : 500,
        headers: rateLimitHeaders(limited),
      },
    );
  }
}
