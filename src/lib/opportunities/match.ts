import type { CandidateForMatch, Opportunity } from "@/lib/opportunities/types";

const normalize = (value: string) =>
  value
    .toLocaleLowerCase("de-DE")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
const terms = (values: string[]) =>
  new Set(values.map(normalize).filter(Boolean));
export function matchOpportunity(
  candidate: CandidateForMatch,
  opportunity: Opportunity,
): Opportunity {
  const candidateSkills = terms([
    ...candidate.skills.technical,
    ...candidate.skills.software_tools,
    ...candidate.skills.marketing,
    ...candidate.skills.it,
    ...candidate.skills.soft,
    ...candidate.training.map((item) => item.name),
  ]);
  const opportunityTerms = terms([
    ...opportunity.required_skills,
    ...opportunity.preferred_skills,
    ...opportunity.extracted_keywords,
    opportunity.title,
    opportunity.profession || "",
  ]);
  const matchingSkills = [...opportunityTerms]
    .filter((term) =>
      [...candidateSkills].some(
        (skill) =>
          skill === term || skill.includes(term) || term.includes(skill),
      ),
    )
    .slice(0, 20);
  const missingSkills = [...opportunityTerms]
    .filter((term) => !matchingSkills.includes(term))
    .slice(0, 20);
  const roleTerms = terms([
    ...candidate.target_roles.map((item) => item.role),
    ...candidate.preferences.preferred_job_titles,
  ]);
  const roleMatch = [...roleTerms].some(
    (role) =>
      normalize(opportunity.title).includes(role) ||
      role.includes(normalize(opportunity.title)),
  );
  const locationTerms = terms(candidate.preferences.preferred_locations);
  const locationMatch =
    !locationTerms.size ||
    [...locationTerms].some((location) =>
      normalize(opportunity.location || "").includes(location),
    );
  const skillScore = opportunityTerms.size
    ? Math.round((matchingSkills.length / opportunityTerms.size) * 50)
    : 25;
  const score = Math.min(
    100,
    skillScore +
      (roleMatch ? 25 : 0) +
      (locationMatch ? 15 : 0) +
      (candidate.goal === opportunity.goal ? 10 : 0),
  );
  return {
    ...opportunity,
    match: {
      match_score: score,
      matching_skills: matchingSkills,
      missing_skills: missingSkills,
      matching_languages: [],
      missing_languages: opportunity.required_languages,
      education_match: null,
      experience_match: null,
      location_match: locationMatch,
      role_match: roleMatch,
      explanation: [
        roleMatch
          ? "Role overlaps with listed target roles."
          : "Role overlap was not documented in the profile.",
        matchingSkills.length
          ? "Strong match on listed skills."
          : "No matching listed skills were found.",
        locationMatch
          ? "Location aligns with the profile preference or no preference was documented."
          : "Location differs from the documented preference.",
      ],
    },
  };
}
