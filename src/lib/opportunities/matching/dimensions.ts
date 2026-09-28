import type { Opportunity } from "@/lib/opportunities/types";
import type { NormalizedCandidate } from "./profile-normalizer";
import {
  CEFR_ORDER,
  EDUCATION_RANK,
  contentTokens,
  documentedYearsMs,
  normalizeText,
  parseExperienceRequirement,
  parseLanguageRequirement,
  postalToken,
  type CefrLevel,
} from "./text";
import type { DimensionId, MatchDimension } from "./types";
import type { DataQuality, DimensionStatus } from "./types";

/**
 * The twelve independent dimension evaluators (Phase 7 production set).
 * Each is a pure function of (normalized candidate, opportunity) and returns
 * a factual verdict. Verdicts here are RAW: the inferred-data cap (inferred
 * evidence is never scored more confidently than explicit evidence) is
 * applied once, in the assembly step — see scorer.ts.
 *
 * Every verdict carries short raw quotes of the documented candidate-side
 * and opportunity-side values (`candidate` / `opportunity`) for display.
 * Quotes are truncated documented values, never synthesized text.
 */

type CandidateSideQuality = "explicit" | "inferred" | "missing";

function quote(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, 200);
}

function dim(
  id: DimensionId,
  essential: boolean,
  status: DimensionStatus,
  evidence: string[],
  missing: string[],
  quality: DataQuality,
  candidate: string | null,
  opportunity: string | null,
): MatchDimension {
  return {
    id,
    essential,
    status,
    evidence: evidence.slice(0, 12).map((line) => line.slice(0, 300)),
    missing: missing.slice(0, 12).map((line) => line.slice(0, 300)),
    quality,
    candidate: quote(candidate),
    opportunity: quote(opportunity),
  };
}

const GOAL_LABEL: Record<"ausbildung" | "arbeit", string> = {
  ausbildung: "Ausbildung",
  arbeit: "Arbeit",
};

// ---------------------------------------------------------------------------
// 1. Goal compatibility / eligibility (always essential; both sides always
//    documented — Ausbildung profile vs. Arbeit offer is a real mismatch)
// ---------------------------------------------------------------------------

export function evalGoal(
  candidate: NormalizedCandidate,
  opportunity: Opportunity,
): MatchDimension {
  if (candidate.goal === opportunity.goal) {
    return dim(
      "goal",
      true,
      "match",
      [
        `Ihr Ziel (${GOAL_LABEL[candidate.goal]}) entspricht dem Angebotstyp (${GOAL_LABEL[opportunity.goal]}).`,
      ],
      [],
      "explicit",
      GOAL_LABEL[candidate.goal],
      GOAL_LABEL[opportunity.goal],
    );
  }
  return dim(
    "goal",
    true,
    "mismatch",
    [
      `Ihr Ziel (${GOAL_LABEL[candidate.goal]}) weicht vom Angebotstyp (${GOAL_LABEL[opportunity.goal]}) ab.`,
    ],
    [],
    "explicit",
    GOAL_LABEL[candidate.goal],
    GOAL_LABEL[opportunity.goal],
  );
}

// ---------------------------------------------------------------------------
// 2. Role compatibility (always essential; deterministic token matching —
//    no semantic similarity is claimed beyond documented overlap)
// ---------------------------------------------------------------------------

const STATUS_RANK: Record<DimensionStatus, number> = {
  mismatch: 0,
  unknown: 1,
  not_applicable: 2,
  partial: 3,
  match: 4,
};

function better(
  current: "match" | "partial" | "mismatch",
  next: "match" | "partial" | "mismatch",
): "match" | "partial" | "mismatch" {
  return STATUS_RANK[next] > STATUS_RANK[current] ? next : current;
}

export function evalRole(
  candidate: NormalizedCandidate,
  opportunity: Opportunity,
): MatchDimension {
  if (candidate.roles.length === 0) {
    return dim(
      "role",
      true,
      "unknown",
      [],
      ["Keine Zielberufe im Profil dokumentiert."],
      "missing",
      null,
      opportunity.title,
    );
  }
  const oppTexts = [
    opportunity.title,
    opportunity.profession ?? "",
    ...opportunity.alternative_professions,
    ...(opportunity.extracted_keywords ?? []),
  ].filter((text) => text.trim().length > 0);
  const oppNorms = oppTexts.map((raw) => ({
    raw,
    norm: normalizeText(raw),
    tokens: new Set(contentTokens(raw)),
  }));

  let status: "match" | "partial" | "mismatch" = "mismatch";
  const evidence: string[] = [];
  let matchedRoleText: string | null = null;
  let matchedOppText: string | null = null;
  for (const role of candidate.roles) {
    const roleNorm = normalizeText(role.text);
    if (!roleNorm) continue;
    const roleTokens = contentTokens(role.text);
    for (const opp of oppNorms) {
      if (!opp.norm) continue;
      if (opp.norm === roleNorm) {
        status = better(status, "match");
        evidence.push(
          `Zielberuf „${role.text}“ entspricht dem Beruf des Angebots („${opp.raw}“).`,
        );
        matchedRoleText = role.text;
        matchedOppText = opp.raw;
        break;
      }
      if (opp.norm.includes(roleNorm) || roleNorm.includes(opp.norm)) {
        status = better(status, "match");
        evidence.push(`Zielberuf „${role.text}“ kommt in „${opp.raw}“ vor.`);
        matchedRoleText = role.text;
        matchedOppText = opp.raw;
        break;
      }
      if (roleTokens.length > 0) {
        const shared = roleTokens.filter((token) => opp.tokens.has(token));
        if (shared.length >= 1 && shared.length / roleTokens.length >= 0.5) {
          status = better(status, "partial");
          evidence.push(
            `Gemeinsame Begriffe mit „${opp.raw}“: ${shared.slice(0, 4).join(", ")}.`,
          );
          if (!matchedRoleText) {
            matchedRoleText = role.text;
            matchedOppText = opp.raw;
          }
        }
      }
    }
  }
  const quality: CandidateSideQuality = candidate.roles.some(
    (role) => role.quality === "explicit",
  )
    ? "explicit"
    : "inferred";
  return dim(
    "role",
    true,
    status,
    evidence,
    [],
    quality,
    matchedRoleText ?? candidate.roles[0]?.text ?? null,
    matchedOppText ?? opportunity.title,
  );
}

// ---------------------------------------------------------------------------
// 3. Education requirement (essential for Ausbildung — eligibility)
// ---------------------------------------------------------------------------

export function evalEducation(
  candidate: NormalizedCandidate,
  opportunity: Opportunity,
): MatchDimension {
  const essential = opportunity.goal === "ausbildung";
  if (!candidate.education) {
    return dim(
      "education",
      essential,
      "unknown",
      [],
      ["Kein Schulabschluss im Profil dokumentiert."],
      "missing",
      null,
      opportunity.education_requirement?.raw ?? null,
    );
  }
  const requirement = opportunity.education_requirement;
  if (!requirement) {
    return dim(
      "education",
      essential,
      "not_applicable",
      [
        `Die Quelle dokumentiert keine konkrete Abschlussanforderung. Dokumentiert im Profil: ${candidate.education.raw}.`,
      ],
      [],
      "source_documented",
      candidate.education.raw,
      null,
    );
  }
  if (requirement.level === "unknown") {
    // The source documents a requirement the hierarchy cannot classify —
    // compatibility is not verifiable (fail-safe, not a pass).
    return dim(
      "education",
      essential,
      "unknown",
      [`Die Quelle nennt die Anforderung „${requirement.raw}“.`],
      [
        `Anforderung „${requirement.raw}“ ist nicht der Bildungsabschluss-Hierarchie zuordenbar – nicht verifizierbar.`,
      ],
      "source_documented",
      candidate.education.raw,
      requirement.raw,
    );
  }
  const candidateRank = EDUCATION_RANK[candidate.education.level];
  const requiredRank = EDUCATION_RANK[requirement.level];
  if (candidateRank >= requiredRank) {
    return dim(
      "education",
      essential,
      "match",
      [
        `Dokumentierter Abschluss (${candidate.education.raw}) erfüllt die Anforderung (${requirement.raw}).`,
      ],
      [],
      candidate.education.quality,
      candidate.education.raw,
      requirement.raw,
    );
  }
  return dim(
    "education",
    essential,
    "mismatch",
    [
      `Dokumentierter Abschluss (${candidate.education.raw}) liegt unter der Anforderung (${requirement.raw}).`,
    ],
    [],
    candidate.education.quality,
    candidate.education.raw,
    requirement.raw,
  );
}

// ---------------------------------------------------------------------------
// 4. Skills (required vs preferred; missing info is never a negative)
// ---------------------------------------------------------------------------

export function evalSkills(
  candidate: NormalizedCandidate,
  opportunity: Opportunity,
): MatchDimension {
  const required = [
    ...new Set(opportunity.required_skills.map(normalizeText).filter(Boolean)),
  ];
  const preferred = [
    ...new Set(opportunity.preferred_skills.map(normalizeText).filter(Boolean)),
  ];
  const oppQuote = required.length > 0 ? required : preferred;
  if (required.length === 0 && preferred.length === 0) {
    return dim(
      "skills",
      false,
      "not_applicable",
      ["Die Quelle dokumentiert keine Skills."],
      [],
      "source_documented",
      null,
      null,
    );
  }
  if (candidate.skills.length === 0) {
    return dim(
      "skills",
      false,
      "unknown",
      [],
      ["Keine Skills im Profil dokumentiert."],
      "missing",
      null,
      oppQuote.slice(0, 4).join(", ") || null,
    );
  }
  const matches = (term: string) =>
    candidate.skills.some(
      (skill) => skill === term || skill.includes(term) || term.includes(skill),
    );
  const evidence: string[] = [];
  let status: DimensionStatus;
  if (required.length > 0) {
    const matched = required.filter(matches);
    const missing = required.filter((term) => !matched.includes(term));
    status =
      matched.length === required.length
        ? "match"
        : matched.length > 0
          ? "partial"
          : "mismatch";
    if (matched.length > 0)
      evidence.push(`Dokumentiert: ${matched.slice(0, 6).join(", ")}.`);
    if (missing.length > 0)
      evidence.push(
        `Nicht im Profil dokumentiert: ${missing.slice(0, 6).join(", ")}.`,
      );
    if (preferred.length > 0) {
      const matchedPreferred = preferred.filter(matches);
      if (matchedPreferred.length > 0)
        evidence.push(
          `Wunsch-Skills erfüllt: ${matchedPreferred.slice(0, 4).join(", ")}.`,
        );
    }
  } else {
    // Only preferred skills documented: not a requirement to be satisfied.
    status = "not_applicable";
    const matchedPreferred = preferred.filter(matches);
    if (matchedPreferred.length > 0)
      evidence.push(
        `Wunsch-Skills erfüllt: ${matchedPreferred.slice(0, 6).join(", ")}.`,
      );
  }
  return dim(
    "skills",
    false,
    status,
    evidence,
    [],
    "inferred",
    candidate.skills.slice(0, 4).join(", ") || null,
    oppQuote.slice(0, 4).join(", ") || null,
  );
}

// ---------------------------------------------------------------------------
// 5. Experience (only explicitly documented "N Jahre" requirements; year math
//    referenced to the opportunity's retrieved_at → deterministic)
// ---------------------------------------------------------------------------

export function evalExperience(
  candidate: NormalizedCandidate,
  opportunity: Opportunity,
): MatchDimension {
  let requiredYears: number | null = null;
  for (const line of opportunity.requirements) {
    const years = parseExperienceRequirement(line);
    if (years !== null && (requiredYears === null || years > requiredYears))
      requiredYears = years;
  }
  if (requiredYears === null) {
    return dim(
      "experience",
      false,
      "not_applicable",
      ["Keine konkrete Erfahrungsanforderung dokumentiert."],
      [],
      "source_documented",
      null,
      null,
    );
  }
  if (candidate.experience.length === 0) {
    return dim(
      "experience",
      false,
      "unknown",
      [],
      ["Keine Berufserfahrung im Profil dokumentiert."],
      "missing",
      null,
      `${requiredYears} Jahre`,
    );
  }
  const dated = candidate.experience.filter((item) => item.startMs !== null);
  if (dated.length === 0) {
    return dim(
      "experience",
      false,
      "unknown",
      [],
      ["Dokumentierte Erfahrung ohne auswertbare Zeiträume."],
      "missing",
      `${candidate.experience.length} Einträge`,
      `${requiredYears} Jahre`,
    );
  }
  const reference = Date.parse(opportunity.retrieved_at);
  if (Number.isNaN(reference)) {
    return dim(
      "experience",
      false,
      "unknown",
      [],
      ["Referenzdatum des Angebots nicht auswertbar."],
      "source_documented",
      `${candidate.experience.length} Einträge`,
      `${requiredYears} Jahre`,
    );
  }
  let total = 0;
  for (const item of dated) {
    total += documentedYearsMs(item.startMs as number, item.endMs ?? reference);
  }
  const years = Math.floor(total * 10) / 10;
  const status: DimensionStatus =
    total >= requiredYears
      ? "match"
      : total >= requiredYears * 0.5
        ? "partial"
        : "mismatch";
  const quality: CandidateSideQuality = dated.every(
    (item) => item.quality === "explicit",
  )
    ? "explicit"
    : "inferred";
  return dim(
    "experience",
    false,
    status,
    [
      `Dokumentierte Erfahrung: ${years} Jahre (Anforderung: ${requiredYears} Jahre).`,
    ],
    [],
    quality,
    `${years} Jahre`,
    `${requiredYears} Jahre`,
  );
}

// ---------------------------------------------------------------------------
// 6. Languages (CEFR comparison; inferred levels stay inferred; a required
//    language missing from the profile is `unknown`, not a negative)
// ---------------------------------------------------------------------------

export function evalLanguages(
  candidate: NormalizedCandidate,
  opportunity: Opportunity,
): MatchDimension {
  const requirements = opportunity.required_languages
    .map((raw) => {
      const parsed = parseLanguageRequirement(raw);
      return parsed ? { raw, ...parsed } : null;
    })
    .filter(
      (value): value is { raw: string; name: string; cefr: CefrLevel | null } =>
        value !== null,
    );
  const oppQuote =
    requirements.length > 0
      ? requirements
          .map((r) => r.raw)
          .slice(0, 3)
          .join(", ")
      : null;
  const candQuote =
    candidate.languages.length > 0
      ? candidate.languages
          .map((l) => l.raw)
          .slice(0, 3)
          .join(", ")
      : null;
  if (requirements.length === 0) {
    return dim(
      "languages",
      false,
      "not_applicable",
      ["Die Quelle dokumentiert keine Sprachanforderungen."],
      [],
      "source_documented",
      candQuote,
      null,
    );
  }
  let status: "match" | "partial" | "mismatch" | "unknown" = "match";
  const evidence: string[] = [];
  const missing: string[] = [];
  const involved: Array<"explicit" | "inferred"> = [];
  for (const requirement of requirements) {
    const candidateLanguage = candidate.languages.find(
      (language) => language.name === requirement.name,
    );
    if (!candidateLanguage) {
      missing.push(
        `Sprache „${requirement.raw}“ nicht im Profil dokumentiert.`,
      );
      status = "unknown";
      continue;
    }
    involved.push(candidateLanguage.quality);
    if (requirement.cefr === null) {
      evidence.push(
        `${candidateLanguage.raw} dokumentiert (Anforderung „${requirement.raw}“ ohne Niveaustufe).`,
      );
      continue;
    }
    const requiredLabel = CEFR_ORDER[requirement.cefr];
    if (candidateLanguage.cefr === null) {
      missing.push(
        `Niveaustufe für ${candidateLanguage.raw} nicht eindeutig dokumentiert.`,
      );
      if (STATUS_RANK[status] > STATUS_RANK.unknown) status = "unknown";
      continue;
    }
    if (candidateLanguage.cefr >= requirement.cefr) {
      evidence.push(
        `${candidateLanguage.raw} erfüllt die Anforderung ${requiredLabel}.`,
      );
    } else {
      evidence.push(
        `${candidateLanguage.raw} liegt unter der Anforderung ${requiredLabel}.`,
      );
      status = "mismatch";
    }
  }
  const quality: DataQuality =
    involved.length === 0
      ? "missing"
      : involved.every((q) => q === "inferred")
        ? "inferred"
        : "explicit";
  return dim(
    "languages",
    true,
    status,
    evidence,
    missing,
    quality,
    candQuote,
    oppQuote,
  );
}

// ---------------------------------------------------------------------------
// 7. Location (identity only — a documented difference is evaluated by the
//    dedicated relocation dimension, not here)
// ---------------------------------------------------------------------------

function sameDocumentedLocation(
  candidate: NormalizedCandidate,
  opportunity: Opportunity,
): boolean {
  const oppTokens = new Set(contentTokens(opportunity.location as string));
  const oppPlz = postalToken(opportunity.location as string);
  for (const location of candidate.locations) {
    if (contentTokens(location).some((token) => oppTokens.has(token)))
      return true;
    const plz = postalToken(location);
    if (plz && plz === oppPlz) return true;
  }
  return false;
}

export function evalLocation(
  candidate: NormalizedCandidate,
  opportunity: Opportunity,
): MatchDimension {
  if (!opportunity.location) {
    return dim(
      "location",
      false,
      "not_applicable",
      ["Kein Standort im Angebot dokumentiert."],
      [],
      "source_documented",
      null,
      null,
    );
  }
  if (candidate.locations.length === 0) {
    return dim(
      "location",
      false,
      "unknown",
      [],
      ["Kein Standort im Profil dokumentiert."],
      "missing",
      null,
      opportunity.location,
    );
  }
  if (sameDocumentedLocation(candidate, opportunity)) {
    return dim(
      "location",
      false,
      "match",
      [
        `Angebot in ${opportunity.location} – entspricht Ihrem dokumentierten Standort.`,
      ],
      [],
      "explicit",
      candidate.locations[0],
      opportunity.location,
    );
  }
  // Documented difference — the severity is decided by the relocation
  // dimension (willingness), not by location identity alone.
  return dim(
    "location",
    false,
    "not_applicable",
    [
      `Angebots-Standort (${opportunity.location}) weicht vom dokumentierten Standort ab – Bewertung über die Dimension „Umzugsbereitschaft“.`,
    ],
    [],
    "explicit",
    candidate.locations[0],
    opportunity.location,
  );
}

// ---------------------------------------------------------------------------
// 8. Relocation preference (only when a move is required: documented
//    different locations. Unknown willingness → unknown, never incompatible)
// ---------------------------------------------------------------------------

export function evalRelocation(
  candidate: NormalizedCandidate,
  opportunity: Opportunity,
): MatchDimension {
  if (!opportunity.location) {
    return dim(
      "relocation",
      false,
      "not_applicable",
      ["Kein Standort im Angebot dokumentiert."],
      [],
      "source_documented",
      null,
      null,
    );
  }
  if (candidate.locations.length === 0) {
    return dim(
      "relocation",
      false,
      "not_applicable",
      ["Kein Umzug zu bewerten – kein Standort im Profil dokumentiert."],
      [],
      "source_documented",
      null,
      opportunity.location,
    );
  }
  const willingnessQuote =
    candidate.relocation === true
      ? "Umzug möglich"
      : candidate.relocation === false
        ? "Umzug nicht gewünscht"
        : null;
  if (sameDocumentedLocation(candidate, opportunity)) {
    return dim(
      "relocation",
      false,
      "not_applicable",
      [
        "Kein Umzug erforderlich – der Angebots-Standort entspricht dem Profil.",
      ],
      [],
      "explicit",
      willingnessQuote,
      opportunity.location,
    );
  }
  if (candidate.relocation === true) {
    return dim(
      "relocation",
      false,
      "partial",
      [`Andere Stadt (${opportunity.location}); Umzug laut Profil möglich.`],
      [],
      "explicit",
      willingnessQuote,
      opportunity.location,
    );
  }
  if (candidate.relocation === false) {
    return dim(
      "relocation",
      false,
      "mismatch",
      [
        `Andere Stadt (${opportunity.location}); Umzug laut Profil nicht gewünscht.`,
      ],
      [],
      "explicit",
      willingnessQuote,
      opportunity.location,
    );
  }
  return dim(
    "relocation",
    false,
    "unknown",
    [
      "Umzugsbereitschaft nicht dokumentiert – daher nicht als Konflikt gewertet.",
    ],
    ["Umzugsbereitschaft nicht dokumentiert."],
    "explicit",
    null,
    opportunity.location,
  );
}

// ---------------------------------------------------------------------------
// 9. Remote (only when the source documents home office; missing = unknown)
// ---------------------------------------------------------------------------

export function evalRemote(
  candidate: NormalizedCandidate,
  opportunity: Opportunity,
): MatchDimension {
  if (
    opportunity.home_office === null ||
    opportunity.home_office === undefined
  ) {
    return dim(
      "remote",
      false,
      "not_applicable",
      ["Die Quelle dokumentiert keine Home-Office-Angabe."],
      [],
      "source_documented",
      null,
      null,
    );
  }
  const oppQuote = opportunity.home_office
    ? "Home Office möglich"
    : "Kein Home Office";
  if (candidate.remotePreference === null) {
    return dim(
      "remote",
      false,
      "unknown",
      [],
      ["Keine Home-Office-Präferenz im Profil dokumentiert."],
      "missing",
      null,
      oppQuote,
    );
  }
  if (candidate.remotePreference === "remote") {
    return opportunity.home_office
      ? dim(
          "remote",
          false,
          "match",
          ["Home Office möglich – entspricht Ihrer Präferenz."],
          [],
          "inferred",
          "Remote",
          oppQuote,
        )
      : dim(
          "remote",
          false,
          "mismatch",
          ["Kein Home Office dokumentiert – weicht von Ihrer Präferenz ab."],
          [],
          "inferred",
          "Remote",
          oppQuote,
        );
  }
  if (candidate.remotePreference === "hybrid") {
    return opportunity.home_office
      ? dim(
          "remote",
          false,
          "partial",
          [
            "Home Office möglich – ein hybrides Modell ist aus der Quelle nicht verifizierbar.",
          ],
          [],
          "inferred",
          "Hybrid",
          oppQuote,
        )
      : dim(
          "remote",
          false,
          "mismatch",
          ["Kein Home Office dokumentiert – Hybrid nicht möglich."],
          [],
          "inferred",
          "Hybrid",
          oppQuote,
        );
  }
  return dim(
    "remote",
    false,
    "match",
    ["Vor-Ort-Arbeit mit dem Angebot vereinbar."],
    [],
    "inferred",
    "Vor Ort",
    oppQuote,
  );
}

// ---------------------------------------------------------------------------
// 10. Employment (the candidate profile documents no working-time preference
//     field today → always unknown when the source documents a type)
// ---------------------------------------------------------------------------

export function evalEmployment(
  candidate: NormalizedCandidate,
  opportunity: Opportunity,
): MatchDimension {
  if (!opportunity.employment_type) {
    return dim(
      "employment",
      false,
      "not_applicable",
      ["Keine Arbeitszeitform im Angebot dokumentiert."],
      [],
      "source_documented",
      null,
      null,
    );
  }
  void candidate;
  return dim(
    "employment",
    false,
    "unknown",
    [`Angebot: ${opportunity.employment_type}.`],
    ["Keine Präferenz zur Arbeitszeitform im Profil dokumentiert."],
    "missing",
    null,
    opportunity.employment_type,
  );
}

// ---------------------------------------------------------------------------
// 11. Training type (documented by the source for Ausbildung offers; the
//     profile schema has no training-type preference field today → unknown,
//     never a negative, never blocking)
// ---------------------------------------------------------------------------

export function evalTrainingType(
  candidate: NormalizedCandidate,
  opportunity: Opportunity,
): MatchDimension {
  void candidate;
  if (!opportunity.training_type) {
    return dim(
      "training_type",
      false,
      "not_applicable",
      ["Die Quelle dokumentiert keine Ausbildungsform."],
      [],
      "source_documented",
      null,
      null,
    );
  }
  return dim(
    "training_type",
    false,
    "unknown",
    [`Angebot: Ausbildungsform „${opportunity.training_type}“ dokumentiert.`],
    ["Keine Präferenz zur Ausbildungsform im Profil dokumentiert."],
    "missing",
    null,
    opportunity.training_type,
  );
}

// ---------------------------------------------------------------------------
// 12. User preferences (industry preferences vs. the opportunity's industry.
//     The BA source documents no industry field today → unknown when the
//     candidate documents preferences, not_applicable otherwise)
// ---------------------------------------------------------------------------

export function evalPreferences(
  candidate: NormalizedCandidate,
  opportunity: Opportunity,
): MatchDimension {
  void opportunity;
  if (candidate.industries.length === 0) {
    return dim(
      "preferences",
      false,
      "not_applicable",
      ["Keine Branchenpräferenz im Profil dokumentiert."],
      [],
      "source_documented",
      null,
      null,
    );
  }
  return dim(
    "preferences",
    false,
    "unknown",
    [
      `Dokumentierte Branchenpräferenz: ${candidate.industries.slice(0, 3).join(", ")}.`,
    ],
    [
      "Die Quelle dokumentiert keine Branche für das Angebot – keine Bewertung möglich.",
    ],
    "missing",
    candidate.industries.slice(0, 3).join(", "),
    null,
  );
}
