import { z } from "zod";

/**
 * Phase 5 — deterministic, explainable matching engine.
 *
 * Invariants (see README "Matching engine v2"):
 * - Pure and deterministic: same profile + same opportunity = same result.
 *   No AI calls, no network calls, no randomness, no wall clock (experience
 *   year math is referenced to the opportunity's `retrieved_at`, which is
 *   fixed per record).
 * - A numerical score is NEVER produced when essential information is
 *   missing: the result is `incomplete` (profile exists but a required
 *   dimension is unknown) or `unavailable` (no candidate profile).
 * - `unknown` is never converted into 0, never into a match, and never
 *   silently dropped — it is surfaced in `missing_information`.
 * - Inferred candidate data (AI-extracted, not user-confirmed) is never
 *   scored more confidently than explicit data: an evaluated dimension
 *   relying on inferred data is capped at `partial` (documented rule).
 *
 * This module is import-safe for both server code and tests; it must not
 * import anything that reads env, auth, or the network.
 */

/** Matcher version. Bump when scoring/semantics change (provenance only —
 *  match results are never cached, so no cache invalidation is needed).
 *  v2 (Phase 7): production dimension set (12 dimensions incl. relocation,
 *  training type, preferences), re-weighted model, and structured
 *  candidate/opportunity evidence quotes per dimension. */
export const MATCHER_VERSION = 2;

/** Overall match status.
 * - complete: every essential dimension was evaluated → a score exists.
 * - incomplete: a profile exists, but essential information is missing →
 *   NO score. The UI must show "Match unvollständig".
 * - unavailable: no (validated) candidate profile at all → NO score. */
export const matchStatusSchema = z.enum([
  "complete",
  "incomplete",
  "unavailable",
]);
export type MatchStatus = z.infer<typeof matchStatusSchema>;

export type DimensionId =
  | "goal"
  | "role"
  | "education"
  | "skills"
  | "experience"
  | "languages"
  | "location"
  | "relocation"
  | "remote"
  | "employment"
  | "training_type"
  | "preferences";

/** Per-dimension verdict.
 * - match: documented facts on both sides are compatible.
 * - partial: compatible but not fully verifiable (overlap only, inferred
 *   data, or a requirement the source cannot express).
 * - mismatch: documented facts on both sides conflict.
 * - unknown: one side does not document the needed information. Never
 *   treated as 0 and never as a match.
 * - not_applicable: the source documents no requirement for this dimension,
 *   so there is nothing to evaluate (not a pass, not a fail) — or the
 *   evaluation is deliberately delegated to a sibling dimension
 *   (documented per dimension, e.g. location → relocation). */
export const dimensionStatusSchema = z.enum([
  "match",
  "partial",
  "mismatch",
  "unknown",
  "not_applicable",
]);
export type DimensionStatus = z.infer<typeof dimensionStatusSchema>;

/** Provenance of the candidate-side information a verdict relied on.
 * - explicit: documented and user-provided/structural (e.g. goal, city).
 * - inferred: documented but AI-extracted, not user-confirmed.
 * - missing: the candidate side does not document the information.
 * - source_documented: the verdict rests on source data only (no
 *   candidate-side data needed, e.g. not_applicable). */
export const dataQualitySchema = z.enum([
  "explicit",
  "inferred",
  "missing",
  "source_documented",
]);
export type DataQuality = z.infer<typeof dataQualitySchema>;

export const matchDimensionSchema = z.object({
  id: z.enum([
    "goal",
    "role",
    "education",
    "skills",
    "experience",
    "languages",
    "location",
    "relocation",
    "remote",
    "employment",
    "training_type",
    "preferences",
  ]),
  status: dimensionStatusSchema,
  /** Whether this dimension must be evaluated for a score to exist, for
   *  this specific (profile, opportunity) pair. An essential dimension in
   *  state `unknown` makes the whole result `incomplete`. */
  essential: z.boolean(),
  /** Factual, data-derived statements (German). Never marketing copy. */
  evidence: z.array(z.string().max(300)).max(12),
  /** What is missing on either side (German). */
  missing: z.array(z.string().max(300)).max(12),
  quality: dataQualitySchema,
  /** Short raw quote of the documented candidate-side value (display
   *  evidence; null when the candidate side documents nothing). */
  candidate: z.string().max(200).nullable(),
  /** Short raw quote of the documented opportunity-side value (display
   *  evidence; null when the source documents nothing). */
  opportunity: z.string().max(200).nullable(),
});
export type MatchDimension = z.infer<typeof matchDimensionSchema>;

export const matchResultSchema = z.object({
  status: matchStatusSchema,
  /** 0–100, only when status === "complete". Never a guess. */
  score: z.number().int().min(0).max(100).nullable(),
  version: z.number().int().positive(),
  dimensions: z.array(matchDimensionSchema).max(16),
  /** Key positive evidence (only for complete matches; [] otherwise). */
  reasons: z.array(z.string().max(300)).max(8),
  /** Consolidated missing information across dimensions. */
  missing_information: z.array(z.string().max(300)).max(16),
  /** Set when a hard incompatibility capped the score. */
  cap: z
    .object({
      max_score: z.number().int().min(0).max(100),
      reason: z.string().max(300),
    })
    .nullable(),
});
export type MatchResult = z.infer<typeof matchResultSchema>;

// ---------------------------------------------------------------------------
// Scoring model
// ---------------------------------------------------------------------------

/**
 * Final dimension weights (must sum to 1.0). The score is computed ONLY over
 * the dimensions that were actually evaluated (match/partial/mismatch);
 * unknown and not_applicable weights are removed from the denominator, so a
 * missing dimension neither inflates nor destroys the score.
 */
/**
 * v2 weight model (12 dimensions, must sum to 1.0). Relocation got its own
 * dimension (split out of location); training type and user preferences
 * are low-weight, honest dimensions that are usually `not_applicable` or
 * `unknown` because the BA source / profile schema do not document the
 * needed values.
 */
export const DIMENSION_WEIGHTS: Record<DimensionId, number> = {
  goal: 0.18,
  role: 0.2,
  education: 0.2,
  skills: 0.14,
  experience: 0.09,
  languages: 0.09,
  location: 0.04,
  relocation: 0.02,
  remote: 0.01,
  employment: 0.01,
  training_type: 0.01,
  preferences: 0.01,
};

/** Status contribution to a dimension's weight. */
export const STATUS_CONTRIBUTION: Record<DimensionStatus, number | null> = {
  match: 1,
  partial: 0.5,
  mismatch: 0,
  unknown: null,
  not_applicable: null,
};

/**
 * Hard incompatibility cap: an explicitly documented, explicitly
 * contradictory education requirement (candidate below the required
 * school-leaving certificate) caps the overall score.
 */
export const EDUCATION_MISMATCH_MAX_SCORE = 30;

export function educationMismatchCapReason(): string {
  return "Der dokumentierte Schulabschluss liegt unter der dokumentierten Anforderung der Ausbildung.";
}
