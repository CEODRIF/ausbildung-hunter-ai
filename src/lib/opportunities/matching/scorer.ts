import {
  DIMENSION_WEIGHTS,
  EDUCATION_MISMATCH_MAX_SCORE,
  MATCHER_VERSION,
  STATUS_CONTRIBUTION,
  educationMismatchCapReason,
  matchResultSchema,
  type DimensionId,
  type MatchDimension,
  type MatchResult,
} from "./types";

/**
 * Assembles the raw dimension verdicts into the final MatchResult.
 *
 * Rules (documented, deterministic):
 * 1. Inferred cap: a dimension whose candidate-side evidence is inferred
 *    (AI-extracted, not user-confirmed) is never scored more confidently
 *    than `partial` — an inferred `match`, `partial`, or `mismatch` gets
 *    status `partial`, and an explicit graded contribution is capped at
 *    0.5 (a dimension without one falls back to the coarse 0.5).
 * 2. Completeness: any ESSENTIAL dimension left in state `unknown` makes
 *    the whole result `incomplete` — no numerical score is produced.
 * 3. Scoring: weighted, renormalized over the evaluated dimensions only.
 *    Each dimension contributes its graded `contribution` (v3: role
 *    similarity ratio, skill coverage, experience ratio, documented
 *    location mismatch = 0) when present, otherwise the coarse
 *    STATUS_CONTRIBUTION of its status (match = 1, partial = 0.5,
 *    mismatch = 0). `unknown` / `not_applicable` are removed from the
 *    denominator — a missing dimension neither inflates nor destroys the
 *    score, and never counts as a match.
 * 4. Hard cap: an explicitly documented, explicitly contradictory
 *    education requirement caps the score (critical incompatibility).
 * 5. Reasons: only for complete matches, only factual evidence lines.
 */

const INFERRED_NOTE =
  "Angabe aus dem CV extrahiert – nicht vom Nutzer bestätigt.";

/** Effective score share of a dimension: the graded contribution when
 *  documented, else the coarse status-based share (null for unknown /
 *  not_applicable — those are excluded from the score, never a pass). */
export function dimensionContribution(
  dimension: MatchDimension,
): number | null {
  if (dimension.contribution !== null && dimension.contribution !== undefined)
    return dimension.contribution;
  return STATUS_CONTRIBUTION[dimension.status];
}

function applyInferredCap(dimension: MatchDimension): MatchDimension {
  if (dimension.quality !== "inferred") return dimension;
  if (
    dimension.status !== "match" &&
    dimension.status !== "partial" &&
    dimension.status !== "mismatch"
  )
    return dimension;
  const evidence = [...dimension.evidence];
  if (!evidence.includes(INFERRED_NOTE)) evidence.push(INFERRED_NOTE);
  const explicit =
    dimension.contribution !== null && dimension.contribution !== undefined
      ? dimension.contribution
      : 0.5; // no graded share → coarse partial share
  return {
    ...dimension,
    status: "partial",
    contribution: Math.min(explicit, 0.5),
    evidence: evidence.slice(0, 12),
  };
}

const DIMENSION_ORDER: DimensionId[] = [
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
];

function dimensionOrder(dimensions: MatchDimension[]): MatchDimension[] {
  return [...dimensions].sort(
    (a, b) => DIMENSION_ORDER.indexOf(a.id) - DIMENSION_ORDER.indexOf(b.id),
  );
}

export function assembleMatch(rawDimensions: MatchDimension[]): MatchResult {
  const dimensions = dimensionOrder(rawDimensions.map(applyInferredCap));

  // 2. Completeness (essential unknown → incomplete, no score).
  const essentialUnknown = dimensions.some(
    (dimension) => dimension.essential && dimension.status === "unknown",
  );

  // 3. Score over evaluated dimensions only.
  const evaluated = dimensions.filter((dimension) => {
    const share = dimensionContribution(dimension);
    return share !== null && share !== undefined;
  });
  const weightSum = evaluated.reduce(
    (sum, dimension) => sum + DIMENSION_WEIGHTS[dimension.id],
    0,
  );
  let score: number | null = null;
  if (!essentialUnknown && weightSum > 0) {
    const weighted = evaluated.reduce((sum, dimension) => {
      const share = dimensionContribution(dimension) as number;
      return sum + DIMENSION_WEIGHTS[dimension.id] * share;
    }, 0);
    score = Math.min(
      100,
      Math.max(0, Math.round((100 * weighted) / weightSum)),
    );
  }

  // 4. Hard cap for an explicitly incompatible education requirement.
  let cap: MatchResult["cap"] = null;
  const hasExplicitEducationMismatch = dimensions.some(
    (dimension) =>
      dimension.id === "education" &&
      dimension.status === "mismatch" &&
      dimension.quality === "explicit",
  );
  if (hasExplicitEducationMismatch && score !== null) {
    if (score > EDUCATION_MISMATCH_MAX_SCORE)
      score = EDUCATION_MISMATCH_MAX_SCORE;
    cap = {
      max_score: EDUCATION_MISMATCH_MAX_SCORE,
      reason: educationMismatchCapReason(),
    };
  }

  const status: MatchResult["status"] = essentialUnknown
    ? "incomplete"
    : score !== null
      ? "complete"
      : "incomplete";

  // 5. Reasons (complete only) + consolidated missing information.
  const reasons =
    status === "complete"
      ? dimensions
          .filter((dimension) => dimension.status === "match")
          .map((dimension) => dimension.evidence[0])
          .filter((line): line is string => Boolean(line))
          .concat(
            dimensions
              .filter((dimension) => dimension.status === "partial")
              .map((dimension) => dimension.evidence[0])
              .filter((line): line is string => Boolean(line)),
          )
          .slice(0, 5)
      : [];

  const missingInformation = [
    ...new Set(
      dimensions.flatMap((dimension) => dimension.missing).filter(Boolean),
    ),
  ].slice(0, 16);

  return matchResultSchema.parse({
    status,
    score,
    version: MATCHER_VERSION,
    dimensions,
    reasons,
    missing_information: missingInformation,
    cap,
  });
}
