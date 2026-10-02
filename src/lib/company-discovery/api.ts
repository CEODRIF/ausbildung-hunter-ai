import "server-only";

import { NextResponse } from "next/server";
import { rateLimitHeaders, type RateLimitResult } from "@/lib/rate-limit";
import type { DiscoveryErrorCode } from "./errors";

/**
 * Shared HTTP answers of the Company Discovery routes.
 *
 * One place decides status + machine code + headers, so `start`, `[runId]`
 * and `cancel` can never drift apart. Every failure body carries a stable
 * `code` the UI translates; the English `error` string is for logs and
 * debugging and is never rendered to the user.
 */

/** Auth gate answer (session missing, not active, or no profile). */
export function unauthorizedResponse(): NextResponse {
  return NextResponse.json(
    { code: "unauthorized" satisfies DiscoveryErrorCode, error: "Unauthorized" },
    { status: 401 },
  );
}

/** 429 for the heavy-run scope, with the standard Retry-After contract. */
export function rateLimitedResponse(result: RateLimitResult): NextResponse {
  const seconds = Math.max(1, Math.ceil(result.retryAfterSeconds));
  return NextResponse.json(
    {
      code: "rate_limited" satisfies DiscoveryErrorCode,
      error: "Too many discovery runs. Please try again shortly.",
      retry_after: seconds,
    },
    {
      status: 429,
      headers: { "retry-after": String(seconds), ...rateLimitHeaders(result) },
    },
  );
}

/** Controlled failure: a code for the UI, optional field paths, never internals. */
export function discoveryFailure(
  code: DiscoveryErrorCode,
  status: number,
  error: string,
  options: { issues?: string[]; headers?: Record<string, string> } = {},
): NextResponse {
  return NextResponse.json(
    { code, error, ...(options.issues ? { issues: options.issues } : {}) },
    {
      status,
      ...(options.headers ? { headers: options.headers } : {}),
    },
  );
}
