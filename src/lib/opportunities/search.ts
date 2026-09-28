import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentUserAndProfile } from "@/lib/auth";
import { candidateProfileSchema } from "@/lib/bewerbung-schema";
import {
  searchParamsSchema,
  opportunitySchema,
  type Opportunity,
  type OpportunitySearchParams,
} from "@/lib/opportunities/types";
import {
  searchArbeitsagentur,
  getArbeitsagenturDetails,
} from "@/lib/opportunities/providers/arbeitsagentur";
import { matchOpportunity } from "@/lib/opportunities/match";
import { createHash } from "node:crypto";

const cacheTtlMs = 5 * 60 * 1000;
function cacheKey(params: OpportunitySearchParams) {
  return createHash("sha256").update(JSON.stringify(params)).digest("hex");
}
function dedupe(opportunities: Opportunity[]) {
  const seen = new Set<string>();
  return opportunities.filter((item) => {
    const key = `${item.provider}:${item.provider_job_id}:${item.source_url}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
export async function searchOpportunities(input: unknown) {
  const current = await getCurrentUserAndProfile();
  if (
    !current.user ||
    !current.profile ||
    current.profile.account_status !== "active"
  )
    throw new Error("Not authorized.");
  const params = searchParamsSchema.parse(input);
  const key = cacheKey(params);
  const admin = createAdminClient();
  const { data: cached } = await admin
    .from("opportunity_cache")
    .select("results, result_count, retrieved_at, expires_at")
    .eq("cache_key", key)
    .gt("expires_at", new Date().toISOString())
    .maybeSingle<{
      results: unknown;
      result_count: number;
      retrieved_at: string;
      expires_at: string;
    }>();
  if (cached)
    return {
      results: (cached.results as Opportunity[]).map((item) =>
        opportunitySchema.parse(item),
      ),
      total: cached.result_count,
      retrievedAt: cached.retrieved_at,
      warnings: [],
    };
  const ba = await searchArbeitsagentur(params);
  let results = dedupe(ba.results.map((item) => item.opportunity));
  if (params.match) {
    const { data: candidate } = await admin
      .from("candidate_profiles")
      .select("profile_json")
      .eq("user_id", current.user.id)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle<{ profile_json: unknown }>();
    if (candidate)
      results = results.map((result) =>
        matchOpportunity(
          candidateProfileSchema.parse(candidate.profile_json),
          result,
        ),
      );
  }
  const retrievedAt = new Date().toISOString();
  await admin.from("opportunity_cache").upsert(
    {
      cache_key: key,
      provider: "arbeitsagentur",
      normalized_query: params,
      results,
      result_count: ba.total,
      retrieved_at: retrievedAt,
      expires_at: new Date(Date.now() + cacheTtlMs).toISOString(),
    },
    { onConflict: "cache_key" },
  );
  return {
    results,
    total: ba.total,
    retrievedAt,
    warnings: ba.warning ? [ba.warning] : [],
  };
}
export async function getOpportunityDetails(
  id: string,
  goal: "ausbildung" | "arbeit" = "arbeit",
) {
  const current = await getCurrentUserAndProfile();
  if (
    !current.user ||
    !current.profile ||
    current.profile.account_status !== "active"
  )
    throw new Error("Not authorized.");
  if (!id.startsWith("arbeitsagentur:"))
    throw new Error("Unsupported opportunity provider.");
  const ref = id.replace("arbeitsagentur:", "");
  return getArbeitsagenturDetails(ref, goal);
}
export async function saveOpportunity(input: {
  opportunity: Opportunity;
  notes?: string;
}) {
  const current = await getCurrentUserAndProfile();
  if (
    !current.user ||
    !current.profile ||
    current.profile.account_status !== "active"
  )
    throw new Error("Not authorized.");
  const admin = createAdminClient();
  const { error } = await admin.from("saved_opportunities").upsert(
    {
      user_id: current.user.id,
      opportunity_key: input.opportunity.id,
      provider: input.opportunity.provider,
      source_url: input.opportunity.source_url,
      title: input.opportunity.title,
      company_name: input.opportunity.company_name,
      location: input.opportunity.location,
      goal: input.opportunity.goal,
      notes: input.notes || null,
    },
    { onConflict: "user_id,opportunity_key" },
  );
  if (error) throw new Error("Unable to save opportunity.");
}
export async function removeSavedOpportunity(opportunityKey: string) {
  const current = await getCurrentUserAndProfile();
  if (!current.user) throw new Error("Not authorized.");
  const admin = createAdminClient();
  await admin
    .from("saved_opportunities")
    .delete()
    .eq("user_id", current.user.id)
    .eq("opportunity_key", opportunityKey);
}
