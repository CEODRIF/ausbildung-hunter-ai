import "server-only";

import { after } from "next/server";

/**
 * Run a discovery pass AFTER the HTTP response has been sent.
 *
 * Company Discovery reports REAL live counters, so the run cannot happen
 * inside the request: the API answers as soon as the run row exists (status
 * `pending`) and the browser polls `GET /api/company-discovery/[runId]` for
 * the counters the pipeline writes while it works. `after()` is Next.js'
 * supported hook for exactly this and keeps the work inside the same
 * serverless invocation budget (`maxDuration`).
 *
 * Isolated in its own module so route tests can replace it with a
 * synchronous stub instead of simulating the framework's request scope.
 */
export function runAfterResponse(work: () => Promise<void>): void {
  after(work);
}
