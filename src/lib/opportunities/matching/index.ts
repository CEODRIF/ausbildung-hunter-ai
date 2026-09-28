import type { CandidateProfile } from "@/lib/bewerbung-schema";
import type { Opportunity } from "@/lib/opportunities/types";

import {
  evalEducation,
  evalEmployment,
  evalExperience,
  evalGoal,
  evalLanguages,
  evalLocation,
  evalPreferences,
  evalRelocation,
  evalRemote,
  evalRole,
  evalSkills,
  evalTrainingType,
} from "./dimensions";
import { normalizeCandidate } from "./profile-normalizer";
import { assembleMatch } from "./scorer";
import { MATCHER_VERSION, matchResultSchema, type MatchResult } from "./types";

/**
 * Server-side matching service (Phase 5 foundation, Phase 7 production
 * dimension set — matcher v2).
 *
 * Usage (server-only, after the shared opportunity cache has been read):
 *
 *   const profile = await getCandidateProfile(userId); // validated, server-side
 *   const result  = computeMatch(profile, opportunity);
 *   const row     = applyMatch(profile, opportunity);  // opportunity + match
 *
 * The candidate profile is always retrieved server-side for the
 * authenticated user; the client only ever receives the MatchResult (no
 * profile internals), and match results are never written to the shared
 * opportunity cache.
 */

export function computeMatch(
  profile: CandidateProfile | null,
  opportunity: Opportunity,
): MatchResult {
  if (!profile) {
    return matchResultSchema.parse({
      status: "unavailable",
      score: null,
      version: MATCHER_VERSION,
      dimensions: [],
      reasons: [],
      missing_information: ["Kein Kandidatenprofil vorhanden."],
      cap: null,
    });
  }
  const candidate = normalizeCandidate(profile);
  return assembleMatch([
    evalGoal(candidate, opportunity),
    evalRole(candidate, opportunity),
    evalEducation(candidate, opportunity),
    evalSkills(candidate, opportunity),
    evalExperience(candidate, opportunity),
    evalLanguages(candidate, opportunity),
    evalLocation(candidate, opportunity),
    evalRelocation(candidate, opportunity),
    evalRemote(candidate, opportunity),
    evalEmployment(candidate, opportunity),
    evalTrainingType(candidate, opportunity),
    evalPreferences(candidate, opportunity),
  ]);
}

/** Pure matching: validated profile + normalized opportunity → result. */
export function matchOpportunity(
  profile: CandidateProfile,
  opportunity: Opportunity,
): MatchResult {
  return computeMatch(profile, opportunity);
}

/** Opportunity with the per-user match attached (match stays out of the
 *  shared cache — this runs after the cache read). */
export function applyMatch(
  profile: CandidateProfile,
  opportunity: Opportunity,
): Opportunity {
  return { ...opportunity, match: computeMatch(profile, opportunity) };
}

// Public surface for the search/saved layers and tests.
export {
  MATCH_STATUS_LABELS,
  DIMENSION_LABELS,
  STATUS_LABELS,
  formatMatchScore,
  topMissingInformation,
} from "./explanations";
export { MATCHER_VERSION, DIMENSION_WEIGHTS } from "./types";
export type {
  DataQuality,
  DimensionId,
  DimensionStatus,
  MatchDimension,
  MatchResult,
  MatchStatus,
} from "./types";
