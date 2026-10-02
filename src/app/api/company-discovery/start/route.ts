import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUserAndProfile } from "@/lib/auth";
import { createDiscoveryRun } from "@/lib/company-discovery/runs";
import { runDiscoveryPipeline } from "@/lib/company-discovery/search";
import { discoveryRunParamsSchema } from "@/lib/company-discovery/types";
import { checkRateLimit, rateLimitHeaders, tooManyRequests } from "@/lib/rate-limit";

/**
 * POST /api/company-discovery/start — register AND execute a Company &
 * Email Discovery run.
 *
 * Contract:
 *  - authenticate (session user; the id never comes from the body);
 *  - rate-limit the heavy-run scope (`company_discovery`);
 *  - validate with the SHARED zod schema (server is the source of truth —
 *    extra/unknown fields are stripped, the target is bounded);
 *  - persist the run (status `pending`) and run the Phase 2 candidate
 *    engine synchronously; the response carries the FINAL real state.
 *
 * Credits are NOT charged in this phase (wired to charge_search_credits in
 * the orchestration/credits phase). No client value (target, bounds,
 * concurrency, …) is trusted beyond the validated schema.
 *
 * Duration: one run is a few BA batch fetches (bounded by the server-side
 * limits), so the request stays within the platform's function budget.
 */
export const maxDuration = 60;

export async function POST(request: Request) {
  const { user, profile } = await getCurrentUserAndProfile();
  if (!user || !profile || profile.account_status !== "active")
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const limited = await checkRateLimit("company_discovery", user.id);
  if (!limited.allowed) return tooManyRequests(limited);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body." },
      { status: 400, headers: rateLimitHeaders(limited) },
    );
  }

  let params;
  try {
    params = discoveryRunParamsSchema.parse(body);
  } catch (error) {
    const issues =
      error instanceof z.ZodError
        ? error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        : [];
    return NextResponse.json(
      { error: "Invalid discovery parameters.", issues },
      { status: 400, headers: rateLimitHeaders(limited) },
    );
  }

  let run;
  try {
    run = await createDiscoveryRun(user.id, params);
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error && error.message
            ? error.message
            : "Failed to start the discovery run.",
      },
      { status: 500, headers: rateLimitHeaders(limited) },
    );
  }

  // Execute the candidate engine. The pipeline writes its own terminal
  // state (completed/partial/failed) and re-checks cancellation; an
  // unexpected throw lands on the 500 path below, which also finishes the
  // run as failed (controlled message, no internals).
  try {
    run = await runDiscoveryPipeline(run.runId, user.id);
    return NextResponse.json(
      { runId: run.runId, status: run.status, run },
      { status: 201, headers: rateLimitHeaders(limited) },
    );
  } catch (error) {
    return NextResponse.json(
      {
        runId: run.runId,
        error:
          error instanceof Error && error.message
            ? error.message
            : "The discovery run failed.",
      },
      { status: 500, headers: rateLimitHeaders(limited) },
    );
  }
}
