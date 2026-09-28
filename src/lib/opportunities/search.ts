import "server-only";

import { createHash } from "node:crypto";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { candidateProfileSchema } from "@/lib/bewerbung-schema";
import {
  OpportunityNotFoundError,
  OpportunityProviderError,
  fetchOpportunityWindow,
  resolveOpportunity,
} from "@/lib/opportunities/providers/arbeitsagentur";
import { matchOpportunity } from "@/lib/opportunities/match";
import {
  OPPORTUNITY_SCHEMA_VERSION,
  opportunitySchema,
  usesScanWindow,
  type CandidateForMatch,
  type Opportunity,
  type OpportunitySearchParams,
  type OpportunitySearchResponse,
} from "@/lib/opportunities/types";

export { OpportunityNotFoundError, OpportunityProviderError };

const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Shared cache payload. MUST stay user-independent: no user ids, no
 * candidate profiles, no match data — matching happens after the cache read.
 *
 * v3: `mode` distinguishes true upstream pagination (window = one page) from
 * bounded server-side windows (window = filtered/sorted set, page-independent,
 * so turning pages never re-hits the provider).
 */
const cachePayloadSchema = z.object({
  mode: z.enum(["upstream", "scan"]),
  window: z.array(opportunitySchema),
  total: z.number().int().min(0),
  scan_truncated: z.boolean(),
  exhausted: z.boolean(),
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
    freshness: params.freshness,
    sort: params.sort,
    employment: params.employment,
    training_type: params.training_type,
    home_office: params.home_office,
    salary_documented: params.salary_documented,
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
  const { data, error } = await admin
    .from("opportunity_cache")
    .select("result")
    .eq("cache_key", key)
    .eq("schema_version", OPPORTUNITY_SCHEMA_VERSION)
    .gte("expires_at", new Date().toISOString())
    .maybeSingle();
  if (error || !data || !data.result) return null;
  const parsed = cachePayloadSchema.safeParse(data.result);
  if (!parsed.success) return null;
  return parsed.data;
}

async function writeCachedPayload(key: string, payload: CachePayload) {
  const admin = createAdminClient();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + CACHE_TTL_MS).toISOString();
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
    result: payload,
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
  await writeCachedPayload(key, payload);
  return payload;
}

async function getCandidateProfile(
  userId: string,
): Promise<CandidateForMatch | null> {
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
 * Server-side opportunity search for an authenticated user.
 *
 * Flow: read/write the shared (user-independent) window → compute the
 * per-user match (never written back to the cache) → slice the requested
 * page. `sort=match` sorts the whole window by per-user score before
 * slicing; `relevance`/`newest`/... sorting is deterministic and cached.
 */
export async function searchOpportunities(
  params: OpportunitySearchParams,
  auth: { userId: string } | null,
): Promise<OpportunitySearchResponse> {
  const payload = await fetchWindow(params);
  const candidate =
    params.match && auth ? await getCandidateProfile(auth.userId) : null;
  const matchAvailable = candidate !== null;

  let window = payload.window;
  if (matchAvailable && params.sort === "match") {
    // Per-user ordering: match the whole window, sort by score desc
    // (no score → last), stable id tiebreak. In-memory only.
    window = window
      .map((opportunity) => matchOpportunity(candidate, opportunity))
      .sort((a, b) => {
        const as = a.match?.match_score ?? -1;
        const bs = b.match?.match_score ?? -1;
        if (bs !== as) return bs - as;
        return a.id < b.id ? -1 : 1;
      });
  }

  const start =
    payload.mode === "upstream" ? 0 : (params.page - 1) * params.pageSize;
  const results = window.slice(start, start + params.pageSize);
  if (matchAvailable && params.sort !== "match") {
    return {
      results: results.map((opportunity) =>
        matchOpportunity(candidate, opportunity),
      ),
      total: payload.total,
      scan_truncated: payload.scan_truncated,
      mode: payload.mode,
      match_available: true,
    };
  }
  return {
    results,
    total: payload.total,
    scan_truncated: payload.scan_truncated,
    mode: payload.mode,
    match_available: matchAvailable,
  };
}

export interface OpportunityDetailsResult {
  opportunity: Opportunity;
  match_available: boolean;
}

/**
 * Fetch the canonical opportunity from the authoritative source and, when the
 * user has a candidate profile, compute the match. Classification (Ausbildung
 * vs Arbeit) always comes from the source record — never from query params.
 */
export async function getOpportunityDetails(
  id: string,
  auth: { userId: string } | null,
): Promise<OpportunityDetailsResult> {
  if (!auth) throw new Error("Not authorized.");
  const opportunity = await resolveOpportunity(id);
  const candidate = await getCandidateProfile(auth.userId);
  if (!candidate) return { opportunity, match_available: false };
  return {
    opportunity: matchOpportunity(candidate, opportunity),
    match_available: true,
  };
}
