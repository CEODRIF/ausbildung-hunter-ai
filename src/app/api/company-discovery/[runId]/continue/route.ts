import { NextResponse } from "next/server";
import { getCurrentUserAndProfile } from "@/lib/auth";
import {
  discoveryFailure,
  rateLimitedResponse,
  unauthorizedResponse,
} from "@/lib/company-discovery/api";
import { classifyDiscoveryDbError } from "@/lib/company-discovery/errors";
import { continueDiscoveryRun } from "@/lib/company-discovery/runs";
import { runAfterResponse } from "@/lib/company-discovery/schedule";
import { runDiscoveryPipeline } from "@/lib/company-discovery/search";
import { checkRateLimit, rateLimitHeaders } from "@/lib/rate-limit";

/**
 * POST /api/company-discovery/[runId]/continue — Continue Research.
 *
 * A batch that hit the serverless invocation limit finishes as `partial`
 * with ALL its persisted companies and counters (the checkpoint). This route
 * reopens that run (`partial → running`) and executes a NEW batch for the
 * SAME run: the orchestrator rebuilds its dedupe state from the stored
 * companies, so nothing already verified is processed twice, and the counters
 * keep counting up towards the target.
 *
 * Contract (mirrors /start):
 *  - authenticate (session user; the id never comes from the body);
 *  - rate-limit the heavy-run scope (`company_discovery`);
 *  - answer with the reopened run BEFORE the engine runs (the client keeps
 *    polling `GET /[runId]` — no new live mechanism needed);
 *  - only a `partial` (or still `pending`) run can be continued; a
 *    `completed` run reached its target, `cancelled`/`failed` are terminal
 *    by decision and stay closed.
 *
 * No new credits: the run's target (and its charge, once wired) was fixed at
 * start — a continuation is the same run, not a new purchase.
 */
export const maxDuration = 60;

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

  let run;
  try {
    run = await continueDiscoveryRun(runId, user.id);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (/not found/i.test(message)) {
      return discoveryFailure("not_found", 404, "Run not found.", {
        headers: rateLimitHeaders(limited),
      });
    }
    if (/only a run/i.test(message)) {
      // A run that is completed / cancelled / failed cannot be continued.
      return discoveryFailure("invalid_params", 400, "This run cannot be continued.", {
        headers: rateLimitHeaders(limited),
      });
    }
    const code = classifyDiscoveryDbError(error);
    console.error(
      `[company-discovery] continue failed run="${runId}" code="${code}"`,
      error,
    );
    return discoveryFailure(
      code,
      500,
      "The run could not be continued. Please try again.",
      { headers: rateLimitHeaders(limited) },
    );
  }

  /** The continuation batch. It resumes from the persisted checkpoint,
   *  persists its own terminal state, and honors cancellation; a throw is
   *  logged, never returned (the run row already holds the truth). */
  const execute = async (): Promise<void> => {
    try {
      await runDiscoveryPipeline(run.runId, user.id);
    } catch (error) {
      console.error(`[company-discovery] continued run "${run.runId}" failed`, error);
    }
  };

  // Answer FIRST: the reopened run row is the contract the client mirrors.
  // The batch then continues after the response (same invocation budget). If
  // the runtime offers no `after` support, fall back to awaiting it — a
  // continuation must never be silently dropped.
  let scheduled = true;
  try {
    runAfterResponse(execute);
  } catch {
    scheduled = false;
  }
  if (!scheduled) await execute();

  return NextResponse.json(
    { runId: run.runId, status: run.status, scheduled, run },
    { status: 202, headers: rateLimitHeaders(limited) },
  );
}
