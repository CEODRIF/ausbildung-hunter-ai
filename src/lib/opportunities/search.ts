import "server-only";

import { createHash } from "node:crypto";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  candidateProfileSchema,
  type CandidateProfile,
} from "@/lib/bewerbung-schema";
import {
  BaFetchFailure,
  OpportunityNotFoundError,
  OpportunityProviderError,
  fetchOpportunityWindow,
  resolveOpportunity,
} from "@/lib/opportunities/providers/arbeitsagentur";
import { applyMatch } from "@/lib/opportunities/matching";
import {
  OPPORTUNITY_SCHEMA_VERSION,
  opportunitySchema,
  usesScanWindow,
  type Opportunity,
  type OpportunitySearchParams,
  type OpportunitySearchResponse,
  type OpportunityWindow,
  type SourceStatus,
} from "@/lib/opportunities/types";

export {
  BaFetchFailure,
  OpportunityNotFoundError,
  OpportunityProviderError,
};

const CACHE_TTL_MS = 5 * 60 * 1000;
/** Degraded (partially failed) windows are cached much shorter so the cache
 *  self-heals as soon as the upstream recovers. */
const DEGRADED_CACHE_TTL_MS = 60 * 1000;
/** Short-lived details cache: keeps exports, saved-opportunity views and
 *  prefill from re-hitting BA per opportunity. */
const DETAILS_CACHE_TTL_MS = 15 * 60 * 1000;
export const BA_SOURCE_ID = "bundesagentur";

/**
 * Shared cache payload. MUST stay user-independent: no user ids, no
 * candidate profiles, no match data — matching happens after the cache read.
 *
 * v3: `mode` distinguishes true upstream pagination (window = one page) from
 * bounded server-side windows (window = filtered/sorted set, page-independent,
 * so turning pages never re-hits the provider).
 * v4: payload shape unchanged — `match` stays null in the shared window; the
 * explainable MatchResult is attached only in-memory, per user.
 */
const freshnessCountsSchema = z.object({
  any: z.number().int().min(0),
  today: z.number().int().min(0),
  yesterday: z.number().int().min(0),
  week: z.number().int().min(0),
  twoWeeks: z.number().int().min(0),
  fourWeeks: z.number().int().min(0),
});
const filterCountsSchema = z.object({
  freshness: freshnessCountsSchema,
  beginn: z.object({
    any: z.number().int().min(0),
    from_now: z.number().int().min(0),
    months: z.array(
      z.object({
        month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
        count: z.number().int().min(0),
      }),
    ),
  }),
});
const cachePayloadSchema = z.object({
  mode: z.enum(["upstream", "scan"]),
  window: z.array(opportunitySchema),
  total: z.number().int().min(0),
  scan_truncated: z.boolean(),
  exhausted: z.boolean(),
  /** Partial window from a mid-scan upstream failure. `default(false)` keeps
   *  older cached payloads valid (they were never degraded). */
  degraded: z.boolean().default(false),
  /** Real per-option counts (scan mode); v8 payloads always carry the field. */
  filter_counts: filterCountsSchema.nullable().default(null),
  generated_at: z.string(),
});
type CachePayload = z.infer<typeof cachePayloadSchema>;

function providerQueryHash(params: OpportunitySearchParams, withPage: boolean) {
  const providerQuery: Record<string, unknown> = {
    provider: "arbeitsagentur",
    goal: params.goal,
    keyword: params.keyword,
    role: params.role,
    company: params.company,
    location: params.location,
    radius: params.radius ?? null,
    cities: params.cities,
    beginn: params.beginn,
    freshness: params.freshness,
    sort: params.sort,
    employment: params.employment,
    training_type: params.training_type,
    home_office: params.home_office,
    salary: params.salary,
    contact_email: params.contact_email,
    distance_max: params.distance_max ?? null,
    pageSize: params.pageSize,
  };
  if (withPage) providerQuery.page = params.page;
  return createHash("sha256")
    .update(JSON.stringify(providerQuery))
    .digest("hex");
}

/**
 * Cache key = version + mode + hash of the provider search query only.
 * `match` (and therefore any profile-derived data) is deliberately excluded
 * so the shared cache can never contain or leak user-specific results.
 * Upstream mode is per-page; scan mode is page-independent (the window).
 */
export function buildCacheKey(params: OpportunitySearchParams): string {
  const scan = usesScanWindow(params);
  return scan
    ? `v${OPPORTUNITY_SCHEMA_VERSION}:scan:${providerQueryHash(params, false)}`
    : `v${OPPORTUNITY_SCHEMA_VERSION}:page:${providerQueryHash(params, true)}`;
}

async function readCachedPayload(key: string): Promise<CachePayload | null> {
  const admin = createAdminClient();
  // Column is `results` (jsonb) per supabase/migrations/20260927060000_opportunities.sql.
  const { data, error } = await admin
    .from("opportunity_cache")
    .select("results")
    .eq("cache_key", key)
    .eq("schema_version", OPPORTUNITY_SCHEMA_VERSION)
    .gte("expires_at", new Date().toISOString())
    .maybeSingle();
  if (error || !data || !data.results) return null;
  const parsed = cachePayloadSchema.safeParse(data.results);
  if (!parsed.success) return null;
  return parsed.data;
}

async function writeCachedPayload(
  key: string,
  payload: CachePayload,
  ttlMs: number = CACHE_TTL_MS,
) {
  const admin = createAdminClient();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
  // Opportunistic cleanup: expired rows and rows from older schema versions
  // (their payloads no longer match the current format and are refreshable).
  await admin
    .from("opportunity_cache")
    .delete()
    .or(
      `expires_at.lt.${now.toISOString()},schema_version.lt.${OPPORTUNITY_SCHEMA_VERSION}`,
    );
  const { error } = await admin.from("opportunity_cache").upsert({
    cache_key: key,
    provider: "arbeitsagentur",
    normalized_query: key,
    results: payload,
    expires_at: expiresAt,
    schema_version: OPPORTUNITY_SCHEMA_VERSION,
  });
  if (error)
    console.error("[opportunities] cache write failed:", error.message);
}

/** Fetch (or read from the shared cache) the user-independent window. */
async function fetchWindow(
  params: OpportunitySearchParams,
): Promise<CachePayload> {
  const key = buildCacheKey(params);
  const cached = await readCachedPayload(key);
  if (cached) return cached;
  const window = await fetchOpportunityWindow(params);
  const payload = cachePayloadSchema.parse({
    ...window,
    generated_at: new Date().toISOString(),
  });
  // A degraded window is real but partial: cache it briefly so the failure
  // does not amplify into repeated upstream scans, short enough that the
  // cache self-heals quickly once the source recovers.
  await writeCachedPayload(key, payload, window.degraded ? DEGRADED_CACHE_TTL_MS : CACHE_TTL_MS);
  return payload;
}

/**
 * The cached, user-independent window WITHOUT per-user matching and without
 * page slicing — for programmatic consumers (Company & Email Discovery)
 * that need the full filtered set, not one UI page.
 *
 * Same shared cache, same provider call, same failure semantics as
 * `searchOpportunities`; the returned window never carries `match` data
 * (it is null in the shared payload by design).
 */
export async function fetchOpportunityWindowCached(
  params: OpportunitySearchParams,
): Promise<OpportunityWindow> {
  const payload = await fetchWindow(params);
  return {
    mode: payload.mode,
    window: payload.window,
    total: payload.total,
    scan_truncated: payload.scan_truncated,
    exhausted: payload.exhausted,
    degraded: payload.degraded,
    filter_counts: payload.filter_counts,
  };
}

/** The authenticated user's latest VALIDATED candidate profile, fetched
 *  server-side (never browser-supplied). Invalid/foreign JSON → null.
 *  Exported for reuse by the AI search pipeline (same source of truth —
 *  no second profile-lookup implementation). */
export async function getCandidateProfile(
  userId: string,
): Promise<CandidateProfile | null> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("candidate_profiles")
    .select("profile_json")
    .eq("user_id", userId)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!data?.profile_json) return null;
  const parsed = candidateProfileSchema.safeParse(data.profile_json);
  return parsed.success ? parsed.data : null;
}

/**
 * `sort=match` ordering (documented, deterministic):
 * - complete matches first, by score descending (ties by stable id);
 * - incomplete matches after all complete ones (stable id order) — an
 *   incomplete match carries NO score and is never ranked as a perfect
 *   match;
 * - (match: null cannot occur here — a candidate profile exists.)
 */
function compareByMatch(a: Opportunity, b: Opportunity): number {
  const aComplete = a.match?.status === "complete";
  const bComplete = b.match?.status === "complete";
  if (aComplete !== bComplete) return aComplete ? -1 : 1;
  if (aComplete && bComplete) {
    const diff = (b.match?.score ?? 0) - (a.match?.score ?? 0);
    if (diff !== 0) return diff;
  }
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

/**
 * Server-side opportunity search for an authenticated user.
 *
 * Flow: provider → shared (user-independent) cache → normalized window →
 * authenticated candidate profile → matching engine → user-specific
 * results. The per-user match is computed AFTER the cache read and is
 * never written back to the cache. `sort=match` reorders the whole window
 * by the documented match order before slicing; the other sorts are
 * deterministic and cached.
 */
export async function searchOpportunities(
  params: OpportunitySearchParams,
  auth: { userId: string } | null,
): Promise<OpportunitySearchResponse> {
  let payload = await fetchWindow(params);

  // Stale upstream page (an old shared URL, or a page beyond the source
  // total): the source returns an EMPTY page while total > 0 — that would
  // render "N results" over an empty list. Self-heal by serving page 1
  // (one extra window read, usually a cache hit; bounded, never a loop).
  // A genuinely empty source (total = 0) needs no healing.
  let healedToFirst = false;
  if (
    payload.mode === "upstream" &&
    payload.window.length === 0 &&
    payload.total > 0 &&
    params.page > 1
  ) {
    payload = await fetchWindow({ ...params, page: 1 });
    healedToFirst = true;
  }

  const candidate =
    params.match && auth ? await getCandidateProfile(auth.userId) : null;
  const matchAvailable = candidate !== null;
  const filter_counts = payload.filter_counts ?? null;

  let window = payload.window;
  if (matchAvailable && params.sort === "match") {
    window = window
      .map((opportunity) => applyMatch(candidate, opportunity))
      .sort(compareByMatch);
  }

  // Scan mode is page-independent: the window IS the full filtered set, so an
  // out-of-range page (e.g. a stale page after the user edited the query)
  // would slice to an EMPTY list while total says otherwise. Clamp to the
  // last reachable page — the response always carries real rows.
  const effectivePage = healedToFirst
    ? 1
    : payload.mode === "scan"
      ? Math.min(
          params.page,
          Math.max(1, Math.ceil(window.length / params.pageSize)),
        )
      : params.page;
  const start =
    payload.mode === "upstream" ? 0 : (effectivePage - 1) * params.pageSize;
  const results = window.slice(start, start + params.pageSize);
  // Present only when the official source delivered partial data: the UI
  // shows a small non-blocking notice, never a full failure, for a degraded
  // window (the results it carries are real, just incomplete).
  const sources: SourceStatus[] | undefined = payload.degraded
    ? [{ source: BA_SOURCE_ID, status: "degraded", retryable: true }]
    : undefined;
  if (matchAvailable && params.sort !== "match") {
    return {
      results: results.map((opportunity) => applyMatch(candidate, opportunity)),
      page: effectivePage,
      total: payload.total,
      scan_truncated: payload.scan_truncated,
      mode: payload.mode,
      match_available: true,
      filter_counts,
      ...(sources ? { sources } : {}),
    };
  }
  return {
    results,
    page: effectivePage,
    total: payload.total,
    scan_truncated: payload.scan_truncated,
    mode: payload.mode,
    match_available: matchAvailable,
    filter_counts,
    ...(sources ? { sources } : {}),
  };
}

/** In-flight detail promises (per process): concurrent lookups for the same
 *  opportunity share ONE provider call instead of re-hitting BA. */
const inFlightDetails = new Map<string, Promise<Opportunity>>();

function detailsCacheKey(key: string): string {
  return `v${OPPORTUNITY_SCHEMA_VERSION}:details:${key}`;
}

async function readCachedDetails(key: string): Promise<Opportunity | null> {
  try {
    const admin = createAdminClient();
    // Column is `results` (jsonb) per
    // supabase/migrations/20260927060000_opportunities.sql.
    const { data, error } = await admin
      .from("opportunity_cache")
      .select("results")
      .eq("cache_key", detailsCacheKey(key))
      .eq("schema_version", OPPORTUNITY_SCHEMA_VERSION)
      .gte("expires_at", new Date().toISOString())
      .maybeSingle();
    if (error || !data || !data.results) return null;
    const parsed = opportunitySchema.safeParse(data.results);
    return parsed.success ? parsed.data : null;
  } catch {
    // The cache is an optimization — a cache failure must never break the
    // lookup itself.
    return null;
  }
}

async function writeCachedDetails(key: string, opportunity: Opportunity) {
  try {
    const admin = createAdminClient();
    const now = new Date();
    const { error } = await admin.from("opportunity_cache").upsert({
      cache_key: detailsCacheKey(key),
      provider: "arbeitsagentur",
      normalized_query: detailsCacheKey(key),
      results: opportunity,
      expires_at: new Date(now.getTime() + DETAILS_CACHE_TTL_MS).toISOString(),
      schema_version: OPPORTUNITY_SCHEMA_VERSION,
    });
    if (error)
      console.error(
        "[opportunities] details cache write failed:",
        error.message,
      );
  } catch (error) {
    console.error(
      "[opportunities] details cache write failed:",
      error instanceof Error ? error.message : String(error),
    );
  }
}

/**
 * Resolve the canonical opportunity, served from the short-lived details
 * cache (15 min) when fresh. The cached record is exactly what the source
 * published (email, contact, description) — nothing is inferred. Not-found
 * and provider failures are NOT cached and propagate unchanged.
 */
export async function resolveOpportunityCached(
  key: string,
): Promise<Opportunity> {
  const cached = await readCachedDetails(key);
  if (cached) return cached;
  const inFlight = inFlightDetails.get(key);
  if (inFlight) return inFlight;
  const pending = (async () => {
    try {
      const opportunity = await resolveOpportunity(key);
      await writeCachedDetails(key, opportunity);
      return opportunity;
    } finally {
      inFlightDetails.delete(key);
    }
  })();
  inFlightDetails.set(key, pending);
  return pending;
}

export interface OpportunityDetailsResult {
  opportunity: Opportunity;
  match_available: boolean;
}

/**
 * Fetch the canonical opportunity (via the short-lived details cache) and,
 * when the user has a candidate profile, compute the match. Classification
 * (Ausbildung vs Arbeit) always comes from the source record — never from
 * query params.
 *
 * Performance: the opportunity lookup and the profile lookup are INDEPENDENT
 * — they run in parallel (previously sequential: a cold details cache waited
 * for the full BA detail call AND then for the profile round-trip).
 */
export async function getOpportunityDetails(
  id: string,
  auth: { userId: string } | null,
): Promise<OpportunityDetailsResult> {
  if (!auth) throw new Error("Not authorized.");
  const [opportunity, candidate] = await Promise.all([
    resolveOpportunityCached(id),
    getCandidateProfile(auth.userId),
  ]);
  if (!candidate) return { opportunity, match_available: false };
  return {
    opportunity: applyMatch(candidate, opportunity),
    match_available: true,
  };
}
