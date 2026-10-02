import { NextResponse } from "next/server";
import { getCurrentUserAndProfile } from "@/lib/auth";
import {
  discoveryFailure,
  rateLimitedResponse,
  unauthorizedResponse,
} from "@/lib/company-discovery/api";
import { classifyDiscoveryDbError } from "@/lib/company-discovery/errors";
import { cancelDiscoveryRun } from "@/lib/company-discovery/runs";
import { checkRateLimit, rateLimitHeaders } from "@/lib/rate-limit";

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
    return unauthorizedResponse();

  const limited = await checkRateLimit("company_discovery", user.id);
  if (!limited.allowed) return rateLimitedResponse(limited);

  const { runId } = await context.params;
  try {
    const run = await cancelDiscoveryRun(runId, user.id);
    return NextResponse.json({ run }, { headers: rateLimitHeaders(limited) });
  } catch (error) {
    const notFound = error instanceof Error && /not found/i.test(error.message);
    if (notFound)
      return discoveryFailure("not_found", 404, "Run not found.", {
        headers: rateLimitHeaders(limited),
      });
    const code = classifyDiscoveryDbError(error);
    console.error(
      `[company-discovery] cancel failed run="${runId}" code="${code}"`,
      error,
    );
    return discoveryFailure(
      code,
      500,
      "The run could not be cancelled. Please try again.",
      { headers: rateLimitHeaders(limited) },
    );
  }
}
