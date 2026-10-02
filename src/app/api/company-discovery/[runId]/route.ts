import { NextResponse } from "next/server";
import { getCurrentUserAndProfile } from "@/lib/auth";
import {
  discoveryFailure,
  unauthorizedResponse,
} from "@/lib/company-discovery/api";
import { classifyDiscoveryDbError } from "@/lib/company-discovery/errors";
import { getDiscoveryRunStrict } from "@/lib/company-discovery/runs";

/**
 * GET /api/company-discovery/[runId] — the REAL state of one of the user's
 * runs (counters, source status, terminal state). The live progress panel
 * polls this while the run executes; every number it returns is measured by
 * the engine, never simulated.
 *
 * Deliberately NOT rate-limited, unlike start/cancel: it is a read-only,
 * auth-scoped, single-row lookup that the progress panel polls every ~1.5 s.
 * Charging the 4/min mutation budget for reads would turn the progress panel
 * into a 429 instead of a running state. Ownership is enforced by the run
 * store (user_id filter) — a foreign run id is indistinguishable from an
 * unknown one (404, not 403).
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ runId: string }> },
) {
  const { user, profile } = await getCurrentUserAndProfile();
  if (!user || !profile || profile.account_status !== "active")
    return unauthorizedResponse();

  const { runId } = await context.params;
  try {
    const run = await getDiscoveryRunStrict(runId, user.id);
    if (!run) return discoveryFailure("not_found", 404, "Run not found.");
    return NextResponse.json({ run });
  } catch (error) {
    // A persistence failure is NOT an unknown run: reporting it as 404 would
    // tell the user the run was deleted while the database is simply down.
    const code = classifyDiscoveryDbError(error);
    console.error(
      `[company-discovery] run read failed run="${runId}" code="${code}"`,
      error,
    );
    return discoveryFailure(code, 500, "Failed to read the discovery run.");
  }
}
