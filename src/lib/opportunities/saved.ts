import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { candidateProfileSchema } from "@/lib/bewerbung-schema";
import { computeMatch, MATCHER_VERSION } from "@/lib/opportunities/matching";
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
  /** Saved-at snapshot of the per-user match (server-computed at save time).
   *  Stays historical: the CURRENT match is computed live on the detail
   *  page and may differ after profile updates. */
  match_score: number | null;
  /** "complete" | "incomplete" — null when no profile existed at save time
   *  (never "unavailable" is persisted; that state simply stores nulls). */
  match_status: string | null;
  /** Matcher version that produced the snapshot (provenance; null when no
   *  snapshot). Lets the UI detect engine upgrades after the fact. */
  matcher_version: number | null;
  /** Candidate-profile revision (updated_at) at snapshot time. When the
   *  profile's current revision is newer, the UI states the snapshot may
   *  be stale instead of presenting it as current. */
  match_profile_updated_at: string | null;
  saved_at: string;
  updated_at: string;
}

const SAVED_SELECT =
  "id, user_id, opportunity_key, provider, goal, title, company_name, location, source_url, source_name, source_external_id, posted_at, salary_label, training_type, education_requirement, contact_email, notes, match_score, match_status, matcher_version, match_profile_updated_at, saved_at, updated_at";

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

  // Optional server-computed match snapshot at save time (never
  // client-supplied, never written to the shared opportunity cache).
  // The snapshot stays historical — the current live match is recomputed
  // on the detail page and may differ after the profile changed.
  let matchScore: number | null = null;
  let matchStatus: string | null = null;
  let matcherVersion: number | null = null;
  let matchProfileUpdatedAt: string | null = null;
  try {
    const { data } = await admin
      .from("candidate_profiles")
      .select("profile_json, updated_at")
      .eq("user_id", userId)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (data?.profile_json) {
      const parsed = candidateProfileSchema.safeParse(data.profile_json);
      if (parsed.success) {
        const match = computeMatch(parsed.data, opportunity);
        matchScore = match.score; // null when incomplete — never a guess
        matchStatus =
          match.status === "complete" || match.status === "incomplete"
            ? match.status
            : null;
        matcherVersion = MATCHER_VERSION;
        matchProfileUpdatedAt =
          typeof data.updated_at === "string" ? data.updated_at : null;
      }
    }
  } catch {
    matchScore = null; // snapshot is best-effort and never blocks saving
    matchStatus = null;
    matcherVersion = null;
    matchProfileUpdatedAt = null;
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
    match_status: matchStatus,
    matcher_version: matcherVersion,
    match_profile_updated_at: matchProfileUpdatedAt,
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
  await logActivityBestEffort(admin, userId, {
    activity_type: "opportunity_saved",
    title: `Opportunity saved: ${opportunity.title || "Untitled"}`,
    description: opportunity.company_name ?? null,
    metadata: { opportunity_key: opportunity.id },
  });
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
  await logActivityBestEffort(admin, userId, {
    activity_type: "opportunity_removed",
    title: "Saved opportunity removed",
    description: null,
    metadata: { opportunity_key: opportunityKey },
  });
}

/** Best-effort activity logging: a failed audit insert must never turn a
 *  successful user action into an error. */
async function logActivityBestEffort(
  admin: ReturnType<typeof createAdminClient>,
  userId: string,
  entry: {
    activity_type: string;
    title: string;
    description: string | null;
    metadata: Record<string, unknown>;
  },
): Promise<void> {
  try {
    await admin.from("activity_logs").insert({
      user_id: userId,
      ...entry,
    });
  } catch {
    // intentionally non-fatal
  }
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

/** Latest candidate-profile revision (updated_at) for the user, or null
 *  when no profile exists. Server-side only — used to compare against
 *  snapshot metadata. */
export async function getProfileRevision(
  userId: string,
): Promise<string | null> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("candidate_profiles")
    .select("updated_at")
    .eq("user_id", userId)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) return null; // best-effort — staleness notes must not break pages
  return typeof data?.updated_at === "string" ? data.updated_at : null;
}

// ---------------------------------------------------------------------------
// Snapshot staleness (pure — server-side decision, testable)
// ---------------------------------------------------------------------------

export interface SnapshotStaleness {
  /** True when the stored snapshot must NOT be presented as the current
   *  match. */
  stale: boolean;
  /** Factual German explanations (display text; empty when fresh). */
  reasons: string[];
  /** Whether a snapshot exists at all (no profile at save time → false). */
  hasSnapshot: boolean;
}

/**
 * Compares a stored match snapshot with the current profile/engine state.
 * Deterministic and side-effect free; the caller supplies the current
 * profile revision (from `getProfileRevision`) and the current matcher
 * version — both obtained server-side.
 */
export function evaluateSnapshotStaleness(
  row: Pick<
    SavedOpportunityRow,
    | "match_score"
    | "match_status"
    | "matcher_version"
    | "match_profile_updated_at"
    | "saved_at"
  >,
  current: { profileUpdatedAt: string | null; matcherVersion: number },
): SnapshotStaleness {
  const hasSnapshot =
    row.match_status === "complete" || row.match_status === "incomplete";
  if (!hasSnapshot) {
    return { stale: false, reasons: [], hasSnapshot };
  }
  const reasons: string[] = [];
  if (
    current.profileUpdatedAt !== null &&
    row.match_profile_updated_at !== null &&
    current.profileUpdatedAt > row.match_profile_updated_at
  ) {
    reasons.push(
      "Ihr Profil wurde seit der Speicherung geändert – der gespeicherte Match-Stand ist veraltet.",
    );
  }
  if ((row.matcher_version ?? 0) < current.matcherVersion) {
    reasons.push(
      `Der Match-Stand stammt von einer älteren Matcher-Version (v${row.matcher_version ?? "?"} → v${current.matcherVersion}).`,
    );
  }
  return {
    stale: reasons.length > 0,
    reasons,
    hasSnapshot,
  };
}

/** Compact "Stand" label for snapshot dates (display only). */
export function formatSnapshotDate(
  savedAt: string | null,
  locale = "de-DE",
): string | null {
  if (!savedAt) return null;
  const parsed = Date.parse(savedAt);
  if (Number.isNaN(parsed)) return null;
  return new Date(parsed).toLocaleDateString(locale, {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}
