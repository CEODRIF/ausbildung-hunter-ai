import { NextResponse } from "next/server";
import { z } from "zod";

import { getCurrentUserAndProfile } from "@/lib/auth";
import {
  checkRateLimit,
  rateLimitHeaders,
  tooManyRequests,
} from "@/lib/rate-limit";
import { allowedDomainIds } from "@/lib/housing/web-search/config";
import {
  runHousingWebSearch,
  type HousingWebSearchOutcome,
} from "@/lib/housing/web-search/discovery";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * POST /api/housing/web-search — live housing discovery over the web.
 *
 * Two bounded modes (see docs/housing-web-search-plan.md):
 *   mode "web"      — general web search (German query, English retry if thin)
 *   mode "targeted" — domain-restricted search; fetchable-policy domains are
 *                     robots-checked + fetched for verification, restricted
 *                     portals are link-only (never fetched).
 *
 * Cost/abuse gates:
 *   - authenticated + per-user rate limit (housing_web_search: 10/hour)
 *   - provider resolution is honest: nothing configured → 200 with
 *     status "not_configured" (NOT an error, and no paid call)
 *   - daily soft budget per process instance
 *   - ≤2 search calls + ≤3 page fetches per request, 25s request budget
 *
 * The Azure key (when the Foundry endpoint is configured) is server-side
 * only — it never reaches the browser, logs, or the response.
 */

const paramsSchema = z
  .object({
    city: z.string().max(120).default(""),
    postal_code: z.string().max(10).default(""),
    radius_km: z.number().int().min(0).max(100).default(10),
    max_warm_rent: z.number().int().min(0).max(20000).nullable().default(null),
    accommodation_type: z
      .enum(["all", "apartment", "wg_room", "furnished", "studio"])
      .default("all"),
    rooms: z.union([z.number().int().min(1).max(10), z.literal("all")]).default("all"),
    min_area_sqm: z.number().int().min(0).max(2000).nullable().default(null),
    available_before: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable()
      .default(null),
  })
  .strict();

const bodySchema = z
  .object({
    mode: z.enum(["web", "targeted"]).default("web"),
    params: paramsSchema,
    domains: z.array(z.string().min(1).max(200)).max(100).optional(),
  })
  .strict();

const ALLOWED = new Set(allowedDomainIds());

function outcomeResponse(
  outcome: HousingWebSearchOutcome,
  headers: Record<string, string>,
): NextResponse {
  // All pipeline outcomes (including provider rate limits and "not
  // configured") come back as 200 with a machine-readable `status` field —
  // the UI renders honest states from it. 4xx/5xx are reserved for request
  // failures (auth, validation, unexpected errors).
  return NextResponse.json(outcome, { status: 200, headers });
}

export async function POST(request: Request) {
  const { user } = await getCurrentUserAndProfile();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const limited = await checkRateLimit("housing_web_search", user.id);
  if (!limited.allowed) return tooManyRequests(limited);

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid search request." }, { status: 400 });
  }
  const body = parsed.data;

  // Domain allowlist is binding server-side: unknown domains are dropped and
  // reported, never silently fetched or searched.
  const requested = body.domains ?? [];
  const validDomains = requested.filter((d) => ALLOWED.has(d));
  const rejectedDomains = requested.filter((d) => !ALLOWED.has(d));

  try {
    const outcome = await runHousingWebSearch({
      mode: body.mode,
      params: body.params,
      domains: validDomains,
    });
    if (rejectedDomains.length > 0) {
      outcome.warnings.push(
        `domains_rejected:${rejectedDomains.slice(0, 3).join(",")}`,
      );
    }
    return outcomeResponse(outcome, rateLimitHeaders(limited));
  } catch {
    // Controlled, key-free message only.
    return NextResponse.json(
      {
        status: "provider_error",
        message: "The web search request failed.",
        listings: [],
        citations: [],
        queries: [],
        stats: { searchCalls: 0, pagesFetched: 0, bingRequests: null },
        warnings: [],
        cached: false,
      },
      { status: 502, headers: rateLimitHeaders(limited) },
    );
  }
}
