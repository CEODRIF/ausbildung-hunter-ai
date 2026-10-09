import { randomUUID } from "node:crypto";

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
  ZERO_FUNNEL,
  type HousingWebSearchOutcome,
} from "@/lib/housing/web-search/discovery";
import {
  completeHousingWebSearch,
  getHousingWebSearchDailyLimit,
  getHousingWebSearchStatus,
  nextBerlinMidnight,
  releaseHousingWebSearch,
  reserveHousingWebSearch,
  type HousingWebSearchQuotaStatus,
} from "@/lib/housing/web-search/quota";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * /api/housing/web-search — live housing discovery over the web.
 *
 * POST (run a search):
 *   mode "web"      — general web search (German query, English retry if thin)
 *   mode "targeted" — domain-restricted search; fetchable-policy domains are
 *                     robots-checked + fetched for verification, restricted
 *                     portals are link-only (never fetched).
 *
 * GET — today's per-user quota (never consumes anything).
 *
 * Gates (all server-side, validated BEFORE any paid provider call):
 *   - authentication
 *   - per-user rate limit (housing_web_search: 10/hour, in-memory)
 *   - strict per-user DAILY quota (default 20 per Europe/Berlin day) via
 *     atomic Postgres RPCs (migration 20261107000000_housing_web_search_quota)
 *   - honest provider resolution: nothing configured → 200 with status
 *     "not_configured" (NOT an error, and no paid call)
 *   - ≤2 search calls + ≤3 page fetches per request, 25s request budget
 *
 * Quota settlement: one slot is reserved BEFORE the provider call. It is
 * refunded (released) when no paid call ran — result-cache hit, provider
 * failure, or any non-"ok" status — and marked succeeded otherwise. A retry
 * resending the same `request_id` is idempotent (never charged twice).
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
    /** Optional client idempotency key: a retry resending the SAME id is
     *  never charged twice (already_reserved). */
    request_id: z.string().uuid().optional(),
  })
  .strict();

const ALLOWED = new Set(allowedDomainIds());

/** The per-user daily quota as reported to the client (no PII). */
type QuotaInfo = HousingWebSearchQuotaStatus;

function emptyOutcome(
  status: string,
  message: string,
  mode: "web" | "targeted",
): Record<string, unknown> {
  return {
    status,
    message,
    provider: null,
    mode,
    listings: [],
    citations: [],
    queries: [],
    stats: { searchCalls: 0, pagesFetched: 0, bingRequests: null },
    funnel: { ...ZERO_FUNNEL },
    warnings: [],
    cached: false,
    fetchedAt: new Date().toISOString(),
  };
}

/** Quota block for a POST response, derived deterministically from the
 *  reservation/settlement (no extra RPC round-trip per request). */
function postQuota(
  outcome: HousingWebSearchOutcome,
  reservation: { used: number; remaining: number },
): QuotaInfo {
  // A cached hit or a non-ok outcome was refunded (released) — the slot is
  // back in the pool, so report the pre-reservation numbers.
  const refunded = outcome.cached || outcome.status !== "ok";
  return {
    limit: getHousingWebSearchDailyLimit(),
    used: Math.max(reservation.used - (refunded ? 1 : 0), 0),
    remaining: reservation.remaining + (refunded ? 1 : 0),
    usageDate: new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Berlin",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date()),
    resetsAt: nextBerlinMidnight().toISOString(),
  };
}

export async function GET() {
  const { user } = await getCurrentUserAndProfile();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const status = await getHousingWebSearchStatus();
  if (!status) {
    // Honest, non-blocking: the UI can still run searches (the POST path
    // re-checks the quota itself).
    return NextResponse.json({ status: "quota_unavailable", quota: null });
  }
  return NextResponse.json({ status: "ok", quota: status });
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

  // ------------------------------------------------------------------
  // Quota: reserve ONE per-user daily slot BEFORE any provider call.
  // Atomic in Postgres (single conditional upsert) — concurrent requests
  // can never exceed the limit; idempotent per run_id (no double charge).
  // ------------------------------------------------------------------
  const runId = body.request_id ?? randomUUID();
  const reservation = await reserveHousingWebSearch(runId);
  if (reservation === null) {
    // The quota RPC itself failed (e.g. migration not applied). Fail closed:
    // no paid call without a quota slot — and the UI shows an honest state.
    return NextResponse.json(
      { ...emptyOutcome("quota_unavailable", "quota_rpc_failed", body.mode), quota: null },
      { status: 200, headers: rateLimitHeaders(limited) },
    );
  }
  if (reservation.status === "quota_exhausted") {
    return NextResponse.json(
      {
        ...emptyOutcome("daily_quota_exhausted", "daily_quota_exhausted", body.mode),
        quota: {
          limit: getHousingWebSearchDailyLimit(),
          used: reservation.used,
          remaining: 0,
          usageDate: new Intl.DateTimeFormat("en-CA", {
            timeZone: "Europe/Berlin",
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
          }).format(new Date()),
          resetsAt: nextBerlinMidnight().toISOString(),
        },
      },
      { status: 200, headers: rateLimitHeaders(limited) },
    );
  }

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
    // Run-level diagnostics (counts + warning codes + run_id only — no URLs,
    // no response text, no keys). `status=ok listings=0` is the signature of
    // a search that ran but displayed nothing; the warnings + funnel say why.
    console.info(
      `[housing-web-search] run finished run_id=${runId} status=${outcome.status} provider=${outcome.provider ?? "n/a"} provider_calls=${outcome.funnel.providerCalls} web_search_calls=${outcome.funnel.webSearchCalls} raw=${outcome.funnel.rawCandidates} unique=${outcome.funnel.uniqueCandidates} invalid_urls=${outcome.funnel.invalidUrls} search_pages_rejected=${outcome.funnel.searchPagesRejected} unique_search_pages=${outcome.funnel.uniqueSearchPages} non_listing_content=${outcome.funnel.contentRejected} kept_via_json=${outcome.funnel.jsonOnlyKept} city_mismatches=${outcome.funnel.cityMismatches} duplicates=${outcome.funnel.duplicateResults} off_allowlist=${outcome.funnel.offAllowlist} json_items=${outcome.funnel.jsonItems} json_matched=${outcome.funnel.jsonMatched} fabricated=${outcome.funnel.fabricatedRejected} enriched=${outcome.funnel.detailsEnriched} images=${outcome.funnel.imagesAttached} valid=${outcome.funnel.validListings} displayed=${outcome.funnel.displayedListings} elapsed_ms=${outcome.funnel.elapsedMs} bing_requests=${outcome.stats.bingRequests ?? "n/a"} warnings=[${outcome.warnings.slice(0, 6).join(",")}]`,
    );
    // Settle the reserved slot: refund when NO paid search ran (cache hit or
    // non-ok status), otherwise mark the run succeeded (audit ledger).
    if (outcome.cached || outcome.status !== "ok") {
      await releaseHousingWebSearch(runId);
    } else {
      await completeHousingWebSearch(runId);
    }
    return NextResponse.json(
      { ...outcome, quota: postQuota(outcome, reservation) },
      { status: 200, headers: rateLimitHeaders(limited) },
    );
  } catch {
    // Refund the never-settled slot (crash-safety net; stale recovery in the
    // RPC covers the case where even this call is lost).
    await releaseHousingWebSearch(runId).catch(() => undefined);
    // Controlled, key-free message only.
    return NextResponse.json(
      { ...emptyOutcome("provider_error", "The web search request failed.", body.mode), quota: null },
      { status: 502, headers: rateLimitHeaders(limited) },
    );
  }
}
