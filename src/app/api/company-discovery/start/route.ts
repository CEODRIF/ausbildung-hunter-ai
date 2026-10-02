import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUserAndProfile } from "@/lib/auth";
import {
  discoveryFailure,
  rateLimitedResponse,
  unauthorizedResponse,
} from "@/lib/company-discovery/api";
import { classifyDiscoveryDbError } from "@/lib/company-discovery/errors";
import { createDiscoveryRun } from "@/lib/company-discovery/runs";
import { runAfterResponse } from "@/lib/company-discovery/schedule";
import { runDiscoveryPipeline } from "@/lib/company-discovery/search";
import { discoveryRunParamsSchema } from "@/lib/company-discovery/types";
import { checkRateLimit, rateLimitHeaders } from "@/lib/rate-limit";

/**
 * POST /api/company-discovery/start — register AND execute a Company &
 * Email Discovery run.
 *
 * Contract:
 *  - authenticate (session user; the id never comes from the body);
 *  - rate-limit the heavy-run scope (`company_discovery`);
 *  - validate with the SHARED zod schema (server is the source of truth —
 *    extra/unknown fields are stripped, the target is bounded);
 *  - persist the run (status `pending`) and answer with the run id
 *    IMMEDIATELY; the candidate engine then runs after the response and
 *    writes its real counters to the run row, which the client reads via
 *    `GET /[runId]` (live progress) and can stop via `POST /[runId]/cancel`.
 *  - every failure carries a stable machine `code` (see lib/…/errors.ts) so
 *    the UI shows an actionable, translated message instead of one generic
 *    line; internal details only reach the server log.
 *
 * Credits are NOT charged in this phase (wired to charge_search_credits in
 * the orchestration/credits phase). No client value (target, bounds,
 * concurrency, …) is trusted beyond the validated schema.
 */
export const maxDuration = 60;

export async function POST(request: Request) {
  const { user, profile } = await getCurrentUserAndProfile();
  if (!user || !profile || profile.account_status !== "active")
    return unauthorizedResponse();

  const limited = await checkRateLimit("company_discovery", user.id);
  if (!limited.allowed) return rateLimitedResponse(limited);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return discoveryFailure("invalid_params", 400, "Invalid JSON body.", {
      headers: rateLimitHeaders(limited),
    });
  }

  let params;
  try {
    params = discoveryRunParamsSchema.parse(body);
  } catch (error) {
    const issues =
      error instanceof z.ZodError
        ? error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        : [];
    console.error(
      `[company-discovery] invalid params user="${user.id}" issues=[${issues.join(", ")}]`,
    );
    return discoveryFailure("invalid_params", 400, "Invalid discovery parameters.", {
      issues,
      headers: rateLimitHeaders(limited),
    });
  }

  let run;
  try {
    run = await createDiscoveryRun(user.id, params);
  } catch (error) {
    const code = classifyDiscoveryDbError(error);
    console.error(
      `[company-discovery] run creation failed user="${user.id}" code="${code}"`,
      error,
    );
    return discoveryFailure(code, 500, "Failed to start the discovery run.", {
      headers: rateLimitHeaders(limited),
    });
  }

  /** The engine pass. It persists its own terminal state (completed/partial/
   *  failed) and honors cancellation; a throw is logged, never returned. */
  const execute = async (): Promise<void> => {
    try {
      await runDiscoveryPipeline(run.runId, user.id);
    } catch (error) {
      console.error(`[company-discovery] run "${run.runId}" failed`, error);
    }
  };

  // Answer FIRST: the run row is the contract the client mirrors. The pass
  // then continues after the response (same invocation budget). If the
  // runtime offers no `after` support, fall back to awaiting it — a run must
  // never be silently dropped.
  let scheduled = true;
  try {
    runAfterResponse(execute);
  } catch {
    scheduled = false;
  }
  if (!scheduled) await execute();

  return NextResponse.json(
    { runId: run.runId, status: run.status, scheduled, run },
    { status: 201, headers: rateLimitHeaders(limited) },
  );
}
