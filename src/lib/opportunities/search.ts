import "server-only";

import { createHash } from "node:crypto";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { candidateProfileSchema } from "@/lib/bewerbung-schema";
import {
  OpportunityNotFoundError,
  OpportunityProviderError,
  resolveOpportunity,
  searchArbeitsagentur,
} from "@/lib/opportunities/providers/arbeitsagentur";
import { matchOpportunity } from "@/lib/opportunities/match";
import {
  OPPORTUNITY_SCHEMA_VERSION,
  opportunitySchema,
  type CandidateForMatch,
  type Opportunity,
  type OpportunitySearchParams,
  type OpportunitySearchPage,
  type OpportunitySearchResponse,
} from "@/lib/opportunities/types";

export { OpportunityNotFoundError, OpportunityProviderError };

const CACHE_TTL_MS = 5 * 60 * 1000;

/** Shared cache payload. MUST stay user-independent: no user ids, no
 *  candidate profiles, no match data — matching happens after the cache read. */
const cachePayloadSchema = z.object({
  results: z.array(opportunitySchema),
  total: z.number().int().min(0),
  scan_truncated: z.boolean(),
  generated_at: z.string(),
});
type CachePayload = z.infer<typeof cachePayloadSchema>;

/**
 * Cache key = version + hash of the provider search query only.
 * `match` (and therefore any profile-derived data) is deliberately excluded
 * so the shared cache can never contain or leak user-specific results.
 */
export function buildCacheKey(params: OpportunitySearchParams): string {
  const providerQuery = {
    provider: "arbeitsagentur",
    goal: params.goal,
    keyword: params.keyword,
    role: params.role,
    company: params.company,
    location: params.location,
    radius: params.radius ?? null,
    freshness: params.freshness,
    page: params.page,
    pageSize: params.pageSize,
  };
  const hash = createHash("sha256")
    .update(JSON.stringify(providerQuery))
    .digest("hex");
  return `v${OPPORTUNITY_SCHEMA_VERSION}:${hash}`;
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

/** Fetch (or read from the shared cache) the user-independent result set. */
export async function fetchOpportunities(
  params: OpportunitySearchParams,
): Promise<OpportunitySearchPage & { generated_at: string }> {
  const key = buildCacheKey(params);
  const cached = await readCachedPayload(key);
  if (cached) return cached;
  const page = await searchArbeitsagentur(params);
  const payload = cachePayloadSchema.parse({
    ...page,
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
 * The shared cache holds source data only; the per-user match is computed
 * here, after the cache read, and is never written back to the cache.
 */
export async function searchOpportunities(
  params: OpportunitySearchParams,
  auth: { userId: string } | null,
): Promise<OpportunitySearchResponse> {
  const page = await fetchOpportunities(params);
  let matchAvailable = false;
  if (params.match && auth) {
    const candidate = await getCandidateProfile(auth.userId);
    if (candidate) {
      matchAvailable = true;
      page.results = page.results.map((opportunity) =>
        matchOpportunity(candidate, opportunity),
      );
    }
  }
  return {
    results: page.results,
    total: page.total,
    scan_truncated: page.scan_truncated,
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
