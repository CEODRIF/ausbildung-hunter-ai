import { NextResponse } from "next/server";
import { getCurrentUserAndProfile } from "@/lib/auth";
import {
  discoveryFailure,
  unauthorizedResponse,
} from "@/lib/company-discovery/api";
import { classifyDiscoveryDbError } from "@/lib/company-discovery/errors";
import {
  getDiscoveryRunStrict,
  listRunCompaniesWithEmails,
} from "@/lib/company-discovery/runs";

/**
 * GET /api/company-discovery/[runId]/results — the persisted outcome of a run:
 * every discovered company with the public addresses stored for it (and the
 * provenance of each address).
 *
 * This is what makes results survive a refresh / re-login: the page and the
 * client read them from the database, never from React state. Read-only and
 * auth-scoped; deliberately not rate-limited (the same reasoning as the run
 * endpoint — reads must never turn a result into a 429).
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
    const companies = await listRunCompaniesWithEmails(runId, user.id);
    return NextResponse.json({ run, companies });
  } catch (error) {
    const code = classifyDiscoveryDbError(error);
    console.error(
      `[company-discovery] results read failed run="${runId}" code="${code}"`,
      error,
    );
    return discoveryFailure(code, 500, "Failed to read the discovery results.");
  }
}
