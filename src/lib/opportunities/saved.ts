import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { candidateProfileSchema } from "@/lib/bewerbung-schema";
import { matchOpportunity } from "@/lib/opportunities/match";
import {
  OpportunityNotFoundError,
  OpportunityProviderError,
  parseOpportunityKey,
  resolveOpportunity,
} from "@/lib/opportunities/providers/arbeitsagentur";

export { OpportunityNotFoundError, OpportunityProviderError };

export interface SavedOpportunityRow {
  id: string;
  user_id: string;
  opportunity_key: string;
  provider: string | null;
  goal: "ausbildung" | "arbeit" | null;
  title: string | null;
  company_name: string | null;
  location: string | null;
  source_url: string | null;
  source_name: string | null;
  source_external_id: string | null;
  posted_at: string | null;
  salary_label: string | null;
  training_type: string | null;
  education_requirement: string | null;
  contact_email: string | null;
  notes: string | null;
  match_score: number | null;
  saved_at: string;
  updated_at: string;
}

const SAVED_SELECT =
  "id, user_id, opportunity_key, provider, goal, title, company_name, location, source_url, source_name, source_external_id, posted_at, salary_label, training_type, education_requirement, contact_email, notes, match_score, saved_at, updated_at";

function assertValidKey(opportunityKey: string) {
  parseOpportunityKey(opportunityKey); // throws on malformed/foreign keys
}

/**
 * Save an opportunity for the authenticated user. Only the opportunity key
 * comes from the client; every stored field is re-derived server-side from
 * the authoritative source, so clients cannot inject titles, companies,
 * URLs, salaries, or match scores.
 */
export async function saveOpportunityFromKey(
  userId: string,
  opportunityKey: string,
  notes?: string,
): Promise<SavedOpportunityRow> {
  assertValidKey(opportunityKey);
  const opportunity = await resolveOpportunity(opportunityKey);
  const admin = createAdminClient();

  // Optional server-computed match snapshot (never client-supplied).
  let matchScore: number | null = null;
  try {
    const { data } = await admin
      .from("candidate_profiles")
      .select("profile_json")
      .eq("user_id", userId)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (data?.profile_json) {
      const parsed = candidateProfileSchema.safeParse(data.profile_json);
      if (parsed.success)
        matchScore =
          matchOpportunity(parsed.data, opportunity).match?.match_score ?? null;
    }
  } catch {
    matchScore = null; // snapshot is best-effort and never blocks saving
  }

  const row = {
    user_id: userId,
    opportunity_key: opportunity.id,
    provider: opportunity.provider,
    goal: opportunity.goal,
    title: opportunity.title,
    company_name: opportunity.company_name,
    location: opportunity.location,
    source_url: opportunity.source_url,
    source_name: opportunity.source_name,
    source_external_id: opportunity.external_id,
    posted_at: opportunity.posted_at,
    salary_label: opportunity.salary?.label ?? null,
    training_type: opportunity.training_type,
    education_requirement: opportunity.education_requirement?.raw ?? null,
    contact_email: opportunity.contact?.email ?? null,
    notes: notes?.trim() ? notes.trim().slice(0, 500) : null,
    match_score: matchScore,
  };
  const { data, error } = await admin
    .from("saved_opportunities")
    .upsert(row, {
      onConflict: "user_id,opportunity_key",
      ignoreDuplicates: true,
    })
    .select(SAVED_SELECT)
    .single();
  if (error)
    throw new OpportunityProviderError(
      "Unable to save the opportunity right now.",
    );
  return data as SavedOpportunityRow;
}

/** Unsave — scoped to the authenticated user (RLS enforces this too). */
export async function removeSavedOpportunity(
  userId: string,
  opportunityKey: string,
): Promise<void> {
  assertValidKey(opportunityKey);
  const admin = createAdminClient();
  const { error } = await admin
    .from("saved_opportunities")
    .delete()
    .eq("user_id", userId)
    .eq("opportunity_key", opportunityKey);
  if (error)
    throw new OpportunityProviderError(
      "Unable to remove the saved opportunity right now.",
    );
}

/** Update notes only — no opportunity fields can be changed this way. */
export async function updateSavedOpportunityNotes(
  userId: string,
  opportunityKey: string,
  notes: string,
): Promise<void> {
  assertValidKey(opportunityKey);
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("saved_opportunities")
    .update({ notes: notes.trim().slice(0, 500) })
    .eq("user_id", userId)
    .eq("opportunity_key", opportunityKey)
    .select("id")
    .single();
  if (error)
    throw new OpportunityProviderError("Unable to update the notes right now.");
  if (!data) throw new OpportunityNotFoundError("Not found.");
}

export async function listSavedOpportunities(
  userId: string,
): Promise<SavedOpportunityRow[]> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("saved_opportunities")
    .select(SAVED_SELECT)
    .eq("user_id", userId)
    .order("saved_at", { ascending: false });
  if (error)
    throw new OpportunityProviderError(
      "Unable to load saved opportunities right now.",
    );
  return (data ?? []) as SavedOpportunityRow[];
}
