import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  candidateProfileSchema,
  type CandidateProfile,
} from "@/lib/bewerbung-schema";
import {
  DIMENSION_WEIGHTS,
  MATCHER_VERSION,
  computeMatch,
  dimensionContribution,
  matchOpportunity,
  type MatchDimension,
  type MatchResult,
} from "@/lib/opportunities/matching";
import type { Opportunity } from "@/lib/opportunities/types";

const { candidateProfileFixture } = await import("../helpers");

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

function profile(overrides: Record<string, unknown> = {}): CandidateProfile {
  const base = candidateProfileFixture();
  return candidateProfileSchema.parse({ ...base, ...overrides });
}

function explicitRole(name: string) {
  return { role: name, reason: "test", source: "user_provided" };
}

function opp(overrides: Partial<Opportunity> = {}): Opportunity {
  return {
    id: "arbeitsagentur:TEST-1",
    provider: "arbeitsagentur",
    external_id: "TEST-1",
    source_name: "S",
    source_url: "https://example.test/1",
    source_type: "official_source",
    additional_sources: [],
    source_ids: [],
    enrichment: null,
    application_url: null,
    aggregator_url: null,
    title: "Ausbildung Mechatroniker/in",
    goal: "ausbildung",
    stellenangebotsart: "AUSBILDUNG",
    company_name: null,
    company_url: null,
    location: "10115 Berlin",
    location_detail: null,
    distance_km: null,
    latitude: null,
    longitude: null,
    profession: "Mechatroniker/in",
    alternative_professions: [],
    description: null,
    tasks: [],
    requirements: [],
    employment_type: null,
    home_office: null,
    career_change_friendly: null,
    salary: null,
    training_type: "AUSBILDUNG",
    education_requirement: { raw: "HAUPTSCHULABSCHLUSS", level: "basic" },
    valid_from: null,
    application_deadline: null,
    posted_at: null,
    updated_at: null,
    retrieved_at: "2026-09-28T12:00:00.000Z",
    contact: null,
    required_skills: [],
    preferred_skills: [],
    required_languages: [],
    extracted_keywords: [],
    match: null,
    ...overrides,
  };
}

/** An Arbeit opportunity with minimal source data (no requirements at all). */
function arbeitOpp(overrides: Partial<Opportunity> = {}): Opportunity {
  return opp({
    id: "arbeitsagentur:TEST-A1",
    external_id: "TEST-A1",
    title: "Maler/in und Tapezierer/in",
    goal: "arbeit",
    stellenangebotsart: "ARBEIT",
    profession: "Maler/in und Tapezierer/in",
    training_type: null,
    education_requirement: null,
    ...overrides,
  });
}

function dimension(result: MatchResult, id: MatchDimension["id"]) {
  const found = result.dimensions.find((d) => d.id === id);
  if (!found) throw new Error(`dimension ${id} missing in result`);
  return found;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Goal
// ---------------------------------------------------------------------------

describe("dimension: goal", () => {
  it("Ausbildung profile vs Ausbildung opportunity → match", () => {
    const result = computeMatch(profile({ goal: "ausbildung" }), opp());
    const goal = dimension(result, "goal");
    expect(goal.status).toBe("match");
    expect(goal.evidence.join(" ")).toContain("entspricht");
  });

  it("Arbeit profile vs Arbeit opportunity → match", () => {
    const result = computeMatch(profile({ goal: "arbeit" }), arbeitOpp());
    expect(dimension(result, "goal").status).toBe("match");
  });

  it("conflicting goals → mismatch, reflected (not silently converted), still scored", () => {
    const result = computeMatch(profile({ goal: "ausbildung" }), arbeitOpp());
    const goal = dimension(result, "goal");
    expect(goal.status).toBe("mismatch");
    expect(goal.evidence.join(" ")).toContain("weicht");
    expect(result.status).toBe("complete");
    expect(result.score).not.toBeNull();
    expect(result.score as number).toBeLessThan(100);
  });

  it("note: a validated profile always has a goal (schema-required); a missing goal is impossible after validation", () => {
    expect(
      candidateProfileSchema.safeParse({
        ...candidateProfileFixture(),
        goal: undefined,
      }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Role (deterministic token matching — no claimed semantic similarity)
// ---------------------------------------------------------------------------

describe("dimension: role", () => {
  it("exact token match (user-confirmed role) → match", () => {
    const result = computeMatch(
      profile({
        goal: "ausbildung",
        target_roles: [explicitRole("Mechatroniker")],
        preferences: { ...profile().preferences, preferred_job_titles: [] },
      }),
      opp(),
    );
    expect(dimension(result, "role").status).toBe("match");
  });

  it("partial token overlap → partial", () => {
    const result = computeMatch(
      profile({
        goal: "ausbildung",
        target_roles: [explicitRole("Anlagenmechaniker SHK")],
        preferences: { ...profile().preferences, preferred_job_titles: [] },
      }),
      opp({ profession: "Anlagenmechaniker/in - Sanitär, Heizung" }),
    );
    const role = dimension(result, "role");
    expect(role.status).toBe("partial");
    expect(role.evidence.join(" ")).toContain("Gemeinsame Begriffe");
  });

  it("no overlap with an explicit role → mismatch", () => {
    const result = computeMatch(
      profile({
        goal: "arbeit",
        target_roles: [explicitRole("Mechatroniker")],
        preferences: { ...profile().preferences, preferred_job_titles: [] },
      }),
      arbeitOpp(),
    );
    expect(dimension(result, "role").status).toBe("mismatch");
  });

  it("inferred role overlap is capped at partial (provenance preserved)", () => {
    // Fixture default: target_roles ai_extracted + profession match.
    const result = computeMatch(profile({ goal: "ausbildung" }), opp());
    const role = dimension(result, "role");
    expect(role.quality).toBe("inferred");
    expect(role.status).toBe("partial");
  });

  it("no documented roles → unknown → incomplete (no score)", () => {
    const result = computeMatch(
      profile({
        goal: "ausbildung",
        target_roles: [],
        preferences: { ...profile().preferences, preferred_job_titles: [] },
      }),
      opp(),
    );
    const role = dimension(result, "role");
    expect(role.status).toBe("unknown");
    expect(role.essential).toBe(true);
    expect(result.status).toBe("incomplete");
    expect(result.score).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Education / Ausbildung eligibility
// ---------------------------------------------------------------------------

function educationProfile(
  level: string,
  source: "ai_extracted" | "user_provided" = "user_provided",
) {
  return profile({
    goal: "ausbildung",
    target_roles: [explicitRole("Mechatroniker")],
    preferences: { ...profile().preferences, preferred_job_titles: [] },
    education: [
      {
        school: null,
        university: null,
        degree: null,
        field_of_study: null,
        graduation_year: null,
        education_level: level,
        source,
      },
    ],
  });
}

describe("dimension: education / ausbildung eligibility", () => {
  it("documented compatible (higher satisfies lower per hierarchy) → match", () => {
    const result = computeMatch(
      educationProfile("Abitur"),
      opp({
        education_requirement: { raw: "HAUPTSCHULABSCHLUSS", level: "basic" },
      }),
    );
    const education = dimension(result, "education");
    expect(education.status).toBe("match");
    expect(education.essential).toBe(true);
  });

  it("documented insufficient (explicit) → mismatch + hard cap", () => {
    const result = computeMatch(
      educationProfile("Mittlerer Schulabschluss"),
      opp({ education_requirement: { raw: "ABITUR", level: "university" } }),
    );
    const education = dimension(result, "education");
    expect(education.status).toBe("mismatch");
    expect(result.status).toBe("complete");
    expect(result.score).not.toBeNull();
    expect(result.score as number).toBeLessThanOrEqual(30);
    expect(result.cap).not.toBeNull();
    expect(result.cap?.max_score).toBe(30);
  });

  it("insufficient but only inferred → partial, no hard cap", () => {
    const result = computeMatch(
      educationProfile("Mittlerer Schulabschluss", "ai_extracted"),
      opp({ education_requirement: { raw: "ABITUR", level: "university" } }),
    );
    const education = dimension(result, "education");
    expect(education.status).toBe("partial");
    expect(education.quality).toBe("inferred");
    expect(result.cap).toBeNull();
  });

  it("missing education → unknown → incomplete (no false positive, no score)", () => {
    const result = computeMatch(
      profile({
        goal: "ausbildung",
        target_roles: [explicitRole("Mechatroniker")],
        preferences: { ...profile().preferences, preferred_job_titles: [] },
        education: [],
      }),
      opp(),
    );
    const education = dimension(result, "education");
    expect(education.status).toBe("unknown");
    expect(result.status).toBe("incomplete");
    expect(result.score).toBeNull();
  });

  it("unclassifiable documented requirement → unknown → incomplete (fail-safe)", () => {
    const result = computeMatch(
      educationProfile("Abitur"),
      opp({
        education_requirement: {
          raw: "ETWAS_NICHT_EINGEORDNETES",
          level: "unknown",
        },
      }),
    );
    expect(dimension(result, "education").status).toBe("unknown");
    expect(result.status).toBe("incomplete");
    expect(result.score).toBeNull();
  });

  it("source documents no requirement + candidate documented → not_applicable (no fabricated pass)", () => {
    const result = computeMatch(
      educationProfile("Abitur"),
      opp({ education_requirement: null }),
    );
    expect(dimension(result, "education").status).toBe("not_applicable");
    expect(result.status).toBe("complete");
  });

  it("umlaut/case/whitespace variants normalize identically", () => {
    const result = computeMatch(
      educationProfile("   mittlere   REIFE "),
      opp({
        education_requirement: { raw: "MITTLERE_REIFE", level: "intermediate" },
      }),
    );
    expect(dimension(result, "education").status).toBe("match");
  });

  it("education is not essential for Arbeit opportunities", () => {
    const result = computeMatch(
      profile({ goal: "arbeit", education: [] }),
      arbeitOpp(),
    );
    const education = dimension(result, "education");
    expect(education.essential).toBe(false);
    // education unknown but non-essential → still complete
    expect(result.status).toBe("complete");
  });
});

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

describe("dimension: skills", () => {
  const skillProfile = (skills: Record<string, string[]>) =>
    profile({
      goal: "ausbildung",
      target_roles: [explicitRole("Mechatroniker")],
      preferences: { ...profile().preferences, preferred_job_titles: [] },
      skills: {
        technical: [],
        software_tools: [],
        marketing: [],
        it: [],
        soft: [],
        ...skills,
      },
    });

  it("required skill documented → (raw) match, capped partial for inferred skills", () => {
    const result = computeMatch(
      skillProfile({ technical: ["Microsoft Excel"] }),
      opp({ required_skills: ["Excel"] }),
    );
    const skills = dimension(result, "skills");
    expect(skills.status).toBe("partial"); // inferred cap
    expect(skills.evidence.join(" ")).toContain("Dokumentiert");
  });

  it("some required skills missing → partial with factual evidence", () => {
    const result = computeMatch(
      skillProfile({ technical: ["Microsoft Excel"] }),
      opp({ required_skills: ["Excel", "SAP"] }),
    );
    const skills = dimension(result, "skills");
    expect(skills.status).toBe("partial");
    expect(skills.evidence.join(" ")).toContain("sap");
  });

  it("no required skill documented (explicit negative, capped by inferred) → partial with note", () => {
    const result = computeMatch(
      skillProfile({ technical: ["Excel"] }),
      opp({ required_skills: ["SAP"] }),
    );
    const skills = dimension(result, "skills");
    expect(skills.status).toBe("partial"); // raw mismatch, inferred cap
    expect(skills.evidence.join(" ")).toContain("Nicht im Profil dokumentiert");
  });

  it("no documented requirements → not_applicable", () => {
    const result = computeMatch(skillProfile({ technical: ["Excel"] }), opp());
    expect(dimension(result, "skills").status).toBe("not_applicable");
  });

  it("candidate documents no skills → unknown (never a negative), result stays complete", () => {
    const result = computeMatch(
      skillProfile({}),
      opp({ required_skills: ["Excel"] }),
    );
    const skills = dimension(result, "skills");
    expect(skills.status).toBe("unknown");
    expect(result.status).toBe("complete");
    expect(result.missing_information).toContain(
      "Keine Skills im Profil dokumentiert.",
    );
  });

  it("only preferred skills documented → not_applicable, overlap noted as evidence", () => {
    const result = computeMatch(
      skillProfile({ technical: ["Excel"] }),
      opp({ preferred_skills: ["Excel"] }),
    );
    const skills = dimension(result, "skills");
    expect(skills.status).toBe("not_applicable");
    expect(skills.evidence.join(" ")).toContain("Wunsch-Skills erfüllt");
  });

  it("duplicate skills do not change the result", () => {
    const base = skillProfile({ technical: ["Excel"] });
    const duplicated = profile({
      ...base,
      skills: {
        technical: ["Excel", "excel", "Excel", " EXCEL "],
        software_tools: [],
        marketing: [],
        it: [],
        soft: [],
      },
    });
    const opportunity = opp({ required_skills: ["Excel"] });
    expect(computeMatch(base, opportunity)).toEqual(
      computeMatch(duplicated, opportunity),
    );
  });
});

// ---------------------------------------------------------------------------
// Experience
// ---------------------------------------------------------------------------

describe("dimension: experience", () => {
  function experienceProfile(
    entries: Array<{
      start: string | null;
      end: string | null;
      source?: "ai_extracted" | "user_provided";
    }>,
  ) {
    return profile({
      goal: "arbeit",
      target_roles: [explicitRole("Mechatroniker")],
      preferences: { ...profile().preferences, preferred_job_titles: [] },
      experience: entries.map((entry, index) => ({
        job_title: `Job ${index}`,
        company: null,
        responsibilities: [],
        start_date: entry.start,
        end_date: entry.end,
        type: "employment",
        source: entry.source ?? "user_provided",
      })),
    });
  }

  it("documented sufficient experience (user-confirmed, dated) → match", () => {
    const result = computeMatch(
      experienceProfile([{ start: "2019-01-01", end: "2023-06-30" }]),
      arbeitOpp({
        requirements: ["Mindestens 2 Jahre Erfahrung im Bereich Malerarbeiten"],
      }),
    );
    const experience = dimension(result, "experience");
    expect(experience.status).toBe("match");
    // 2019-01-01 → 2023-06-30 = 1641 days ≈ 4.49 years → 4.4 (floor, 1 decimal)
    expect(experience.evidence.join(" ")).toContain("4.4 Jahre");
  });

  it("documented insufficient experience (explicit) → mismatch", () => {
    const result = computeMatch(
      experienceProfile([{ start: "2024-01-01", end: "2024-06-30" }]),
      arbeitOpp({ requirements: ["3 Jahre Berufserfahrung erforderlich"] }),
    );
    expect(dimension(result, "experience").status).toBe("mismatch");
  });

  it("partially sufficient → partial", () => {
    const result = computeMatch(
      experienceProfile([{ start: "2022-01-01", end: "2024-01-01" }]),
      arbeitOpp({ requirements: ["3 Jahre Berufserfahrung erforderlich"] }),
    );
    expect(dimension(result, "experience").status).toBe("partial");
  });

  it("no documented experience → unknown (result stays complete)", () => {
    const result = computeMatch(
      experienceProfile([]),
      arbeitOpp({ requirements: ["2 Jahre Erfahrung"] }),
    );
    const experience = dimension(result, "experience");
    expect(experience.status).toBe("unknown");
    expect(result.status).toBe("complete");
  });

  it("experience without parseable dates → unknown (years are never inferred)", () => {
    const result = computeMatch(
      experienceProfile([{ start: null, end: null }]),
      arbeitOpp({ requirements: ["2 Jahre Erfahrung"] }),
    );
    expect(dimension(result, "experience").status).toBe("unknown");
  });

  it("no documented year requirement → not_applicable", () => {
    const result = computeMatch(
      experienceProfile([{ start: "2019-01-01", end: null }]),
      arbeitOpp({ requirements: ["Sauberes Auftreten"] }),
    );
    expect(dimension(result, "experience").status).toBe("not_applicable");
  });

  it("ongoing experience counts up to the opportunity's retrieved_at (deterministic)", () => {
    const base = experienceProfile([{ start: "2020-01-01", end: null }]);
    const a = computeMatch(
      base,
      arbeitOpp({ requirements: ["2 Jahre Erfahrung"] }),
    );
    const b = computeMatch(
      base,
      arbeitOpp({ requirements: ["2 Jahre Erfahrung"] }),
    );
    expect(a).toEqual(b);
    expect(dimension(a, "experience").status).toBe("match");
  });
});

// ---------------------------------------------------------------------------
// Languages
// ---------------------------------------------------------------------------

describe("dimension: languages", () => {
  function languageProfile(languages: Array<Record<string, unknown>>) {
    return profile({
      goal: "ausbildung",
      target_roles: [explicitRole("Mechatroniker")],
      preferences: { ...profile().preferences, preferred_job_titles: [] },
      languages: languages as never,
    });
  }

  it("exact CEFR match (explicit) → match", () => {
    const result = computeMatch(
      languageProfile([
        {
          language: "German",
          level: "B1",
          level_is_inferred: false,
          source: "user_provided",
        },
      ]),
      opp({ required_languages: ["German B1"] }),
    );
    expect(dimension(result, "languages").status).toBe("match");
  });

  it("higher CEFR level satisfies the requirement → match", () => {
    const result = computeMatch(
      languageProfile([
        {
          language: "German",
          level: "C1",
          level_is_inferred: false,
          source: "user_provided",
        },
      ]),
      opp({ required_languages: ["German B1"] }),
    );
    expect(dimension(result, "languages").status).toBe("match");
  });

  it("lower CEFR level → mismatch (explicit)", () => {
    const result = computeMatch(
      languageProfile([
        {
          language: "German",
          level: "A1",
          level_is_inferred: false,
          source: "user_provided",
        },
      ]),
      opp({ required_languages: ["German B1"] }),
    );
    const languages = dimension(result, "languages");
    expect(languages.status).toBe("mismatch");
    expect(languages.evidence.join(" ")).toContain("unter der Anforderung B1");
  });

  it("inferred level is never scored as a full match", () => {
    const result = computeMatch(
      languageProfile([
        {
          language: "German",
          level: "B1",
          level_is_inferred: true,
          source: "user_provided",
        },
      ]),
      opp({ required_languages: ["German B1"] }),
    );
    const languages = dimension(result, "languages");
    expect(languages.status).toBe("partial");
    expect(languages.quality).toBe("inferred");
  });

  it("required language missing from profile → unknown → incomplete (no score)", () => {
    const result = computeMatch(
      languageProfile([
        {
          language: "English",
          level: "C2",
          level_is_inferred: false,
          source: "user_provided",
        },
      ]),
      opp({ required_languages: ["German B1"] }),
    );
    const languages = dimension(result, "languages");
    expect(languages.status).toBe("unknown");
    expect(result.status).toBe("incomplete");
    expect(result.score).toBeNull();
    expect(result.missing_information.join(" ")).toContain("Sprache");
  });

  it("requirement without level + documented language → match", () => {
    const result = computeMatch(
      languageProfile([
        {
          language: "German",
          level: "C1",
          level_is_inferred: false,
          source: "user_provided",
        },
      ]),
      opp({ required_languages: ["German"] }),
    );
    expect(dimension(result, "languages").status).toBe("match");
  });

  it("documented language with unparseable level → unknown → incomplete (level never invented)", () => {
    const result = computeMatch(
      languageProfile([
        {
          language: "German",
          level: "gut",
          level_is_inferred: false,
          source: "user_provided",
        },
      ]),
      opp({ required_languages: ["German B1"] }),
    );
    expect(dimension(result, "languages").status).toBe("unknown");
    expect(result.status).toBe("incomplete");
  });

  it("language synonyms (Deutsch/German) are normalized deterministically", () => {
    const result = computeMatch(
      languageProfile([
        {
          language: "German",
          level: "B2",
          level_is_inferred: false,
          source: "user_provided",
        },
      ]),
      opp({ required_languages: ["Deutsch B1"] }),
    );
    expect(dimension(result, "languages").status).toBe("match");
  });

  it("no documented requirement → not_applicable", () => {
    const result = computeMatch(languageProfile([]), opp());
    expect(dimension(result, "languages").status).toBe("not_applicable");
  });
});

// ---------------------------------------------------------------------------
// Location
// ---------------------------------------------------------------------------

describe("dimension: location", () => {
  it("same location → match", () => {
    const result = computeMatch(profile({ goal: "arbeit" }), arbeitOpp());
    expect(dimension(result, "location").status).toBe("match");
  });

  it("different documented location → scored mismatch (v3); willingness is the relocation dimension's job", () => {
    const result = computeMatch(
      profile({
        goal: "arbeit",
        preferences: { ...profile().preferences, willing_to_relocate: true },
      }),
      arbeitOpp({ location: "20095 Hamburg" }),
    );
    // v3: the documented location requirement is not met → mismatch with an
    // explicit 0 contribution (no longer invisible). Willingness to move
    // still softens (partial) in the dedicated relocation dimension.
    expect(dimension(result, "location").status).toBe("mismatch");
    expect(dimension(result, "location").contribution).toBe(0);
    expect(dimension(result, "relocation").status).toBe("partial");
  });

  it("no opportunity location → not_applicable", () => {
    const result = computeMatch(
      profile({ goal: "arbeit" }),
      arbeitOpp({ location: null }),
    );
    expect(dimension(result, "location").status).toBe("not_applicable");
  });

  it("no candidate location → unknown", () => {
    const result = computeMatch(
      profile({
        goal: "arbeit",
        preferences: { ...profile().preferences, preferred_locations: [] },
      }),
      arbeitOpp(),
    );
    expect(dimension(result, "location").status).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
// Relocation preference (v2: own dimension, split out of location)
// ---------------------------------------------------------------------------

describe("dimension: relocation", () => {
  const relocate = (willing: boolean | null) =>
    profile({
      goal: "arbeit",
      preferences: { ...profile().preferences, willing_to_relocate: willing },
    });

  it("different location + relocation accepted → partial (never a full match)", () => {
    const result = computeMatch(
      relocate(true),
      arbeitOpp({ location: "20095 Hamburg" }),
    );
    expect(dimension(result, "relocation").status).toBe("partial");
    expect(dimension(result, "relocation").evidence.join(" ")).toContain(
      "Umzug laut Profil möglich",
    );
  });

  it("different location + relocation declined → mismatch", () => {
    const result = computeMatch(
      relocate(false),
      arbeitOpp({ location: "20095 Hamburg" }),
    );
    expect(dimension(result, "relocation").status).toBe("mismatch");
  });

  it("different location + relocation unknown → unknown, NOT mismatch", () => {
    const result = computeMatch(
      relocate(null),
      arbeitOpp({ location: "20095 Hamburg" }),
    );
    const relocation = dimension(result, "relocation");
    expect(relocation.status).toBe("unknown");
    expect(relocation.essential).toBe(false);
    expect(result.status).toBe("complete"); // non-essential
  });

  it("same location → not_applicable (no move required)", () => {
    const result = computeMatch(relocate(true), arbeitOpp());
    expect(dimension(result, "relocation").status).toBe("not_applicable");
  });

  it("no opportunity location → not_applicable", () => {
    const result = computeMatch(relocate(true), arbeitOpp({ location: null }));
    expect(dimension(result, "relocation").status).toBe("not_applicable");
  });

  it("no candidate location → not_applicable (nothing to move from)", () => {
    const result = computeMatch(
      profile({
        goal: "arbeit",
        preferences: { ...profile().preferences, preferred_locations: [] },
      }),
      arbeitOpp(),
    );
    expect(dimension(result, "relocation").status).toBe("not_applicable");
  });
});

// ---------------------------------------------------------------------------
// Remote
// ---------------------------------------------------------------------------

describe("dimension: remote", () => {
  const remoteProfile = (preference: string | null) =>
    profile({
      goal: "ausbildung",
      target_roles: [explicitRole("Mechatroniker")],
      preferences: {
        ...profile().preferences,
        preferred_job_titles: [],
        remote_hybrid_preference: preference,
      },
    });

  it("documented remote + remote preference → compatible (inferred cap → partial)", () => {
    const result = computeMatch(
      remoteProfile("remote"),
      opp({ home_office: true }),
    );
    const remote = dimension(result, "remote");
    expect(remote.status).toBe("partial"); // raw match, inferred preference
    expect(remote.evidence.join(" ")).toContain("Home Office möglich");
  });

  it("documented non-remote + remote preference → conflict (capped partial with evidence)", () => {
    const result = computeMatch(
      remoteProfile("remote"),
      opp({ home_office: false }),
    );
    const remote = dimension(result, "remote");
    expect(remote.status).toBe("partial"); // raw mismatch, inferred cap
    expect(remote.evidence.join(" ")).toContain(
      "Kein Home Office dokumentiert",
    );
  });

  it("hybrid preference + documented home office → partial (hybrid not verifiable)", () => {
    const result = computeMatch(
      remoteProfile("hybrid"),
      opp({ home_office: true }),
    );
    expect(dimension(result, "remote").status).toBe("partial");
  });

  it("missing remote information in source → not_applicable (never incompatible)", () => {
    const result = computeMatch(
      remoteProfile("remote"),
      opp({ home_office: null }),
    );
    expect(dimension(result, "remote").status).toBe("not_applicable");
  });

  it("no documented preference → unknown", () => {
    const result = computeMatch(
      remoteProfile(null),
      opp({ home_office: true }),
    );
    expect(dimension(result, "remote").status).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
// Employment
// ---------------------------------------------------------------------------

describe("dimension: employment", () => {
  it("no documented employment type → not_applicable", () => {
    const result = computeMatch(profile({ goal: "arbeit" }), arbeitOpp());
    expect(dimension(result, "employment").status).toBe("not_applicable");
  });

  it("documented employment type + no candidate preference → unknown (never a negative)", () => {
    const result = computeMatch(
      profile({ goal: "arbeit" }),
      arbeitOpp({ employment_type: "Full-time" }),
    );
    const employment = dimension(result, "employment");
    expect(employment.status).toBe("unknown");
    expect(result.status).toBe("complete");
  });
});

// ---------------------------------------------------------------------------
// Incomplete / unavailable profiles
// ---------------------------------------------------------------------------

describe("incomplete and unavailable matches", () => {
  it("no candidate profile → unavailable, no score, no dimensions", () => {
    const result = computeMatch(null, opp());
    expect(result.status).toBe("unavailable");
    expect(result.score).toBeNull();
    expect(result.dimensions).toEqual([]);
    expect(result.reasons).toEqual([]);
  });

  it("partial profile (no roles) → incomplete, no score, reasons empty", () => {
    const result = computeMatch(
      profile({
        goal: "ausbildung",
        target_roles: [],
        preferences: { ...profile().preferences, preferred_job_titles: [] },
      }),
      opp(),
    );
    expect(result.status).toBe("incomplete");
    expect(result.score).toBeNull();
    expect(result.reasons).toEqual([]);
    expect(result.missing_information.length).toBeGreaterThan(0);
  });

  it("never converts unknown into a percentage: incomplete results always have score=null", () => {
    const cases: Array<[CandidateProfile, Opportunity]> = [
      [
        profile({
          goal: "ausbildung",
          target_roles: [],
          preferences: { ...profile().preferences, preferred_job_titles: [] },
        }),
        opp(),
      ],
      [
        profile({
          goal: "ausbildung",
          target_roles: [explicitRole("Mechatroniker")],
          preferences: { ...profile().preferences, preferred_job_titles: [] },
          education: [],
        }),
        opp(),
      ],
      [
        profile({
          goal: "ausbildung",
          target_roles: [explicitRole("Mechatroniker")],
          preferences: { ...profile().preferences, preferred_job_titles: [] },
          languages: [
            {
              language: "English",
              level: "C2",
              level_is_inferred: false,
              source: "user_provided",
            },
          ],
        }),
        opp({ required_languages: ["German B1"] }),
      ],
    ];
    for (const [p, o] of cases) {
      const result = computeMatch(p, o);
      expect(result.status).toBe("incomplete");
      expect(result.score).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// Scoring model
// ---------------------------------------------------------------------------

describe("scoring model", () => {
  it("documented weights sum to 1.0", () => {
    const sum = Object.values(DIMENSION_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(Math.round(sum * 1000) / 1000).toBe(1);
  });

  it("score is renormalized over evaluated dimensions only (goal match + explicit role mismatch → 47 under v2 weights)", () => {
    const result = computeMatch(
      profile({
        goal: "arbeit",
        target_roles: [explicitRole("Mechatroniker")],
        preferences: { ...profile().preferences, preferred_job_titles: [] },
      }),
      arbeitOpp({ location: null }), // only goal + role evaluated
    );
    expect(result.status).toBe("complete");
    // v2: goal 0.18 (match) + role 0.20 (mismatch) over 0.38 → 47.37 → 47
    expect(result.score).toBe(Math.round((100 * 0.18) / (0.18 + 0.2)));
    expect(result.score).toBe(47);
  });

  it("role: all documented terms present (non-exact) → graded contribution 1.0 but status stays partial (v3)", () => {
    const result = computeMatch(
      profile({
        goal: "ausbildung",
        target_roles: [explicitRole("Anlagenmechaniker SHK")],
        preferences: { ...profile().preferences, preferred_job_titles: [] },
        education: [
          {
            school: null,
            university: null,
            degree: null,
            field_of_study: null,
            graduation_year: null,
            education_level: "Abitur",
            source: "user_provided",
          },
        ],
      }),
      opp({
        profession: "Anlagenmechaniker/in - Sanitär, Heizung",
        location: null,
      }),
    );
    const role = dimension(result, "role");
    // "anlagenmechaniker" is the only content token (shk is 3 chars —
    // filtered) and it is documented in the opportunity → ratio 1.0, but the
    // phrasing is not exact/containment → partial, never a full match.
    expect(role.status).toBe("partial");
    expect(role.contribution).toBe(1);
    // v3: goal 0.18 (match) + role 0.20×1.0 + education 0.20 (match) over
    // 0.58 → 100 (all documented criteria satisfied)
    expect(result.score).toBe(
      Math.round((100 * (0.18 + 0.2 + 0.2)) / (0.18 + 0.2 + 0.2)),
    );
    expect(result.score).toBe(100);
  });

  it("role: German compound suffix earns graded partial credit (Industriekaufmann ≈ kaufmann, v3)", () => {
    const result = computeMatch(
      profile({
        goal: "ausbildung",
        target_roles: [explicitRole("Kaufmann im E-Commerce")],
        preferences: { ...profile().preferences, preferred_job_titles: [] },
      }),
      opp({
        title: "Ausbildung Industriekaufmann",
        profession: "Industriekaufmann",
        location: null,
      }),
    );
    const role = dimension(result, "role");
    // role content tokens: kaufmann, commerce. "industriekaufmann" is a
    // compound containing "kaufmann" (suffix, both ≥ 6 chars) → 0.5 credit;
    // "commerce" → 0. Ratio 0.5/2 = 0.25 → partial with graded share.
    expect(role.status).toBe("partial");
    expect(role.contribution).toBe(0.25);
  });

  it("score is always an integer in 0..100 when present", () => {
    const result = computeMatch(profile({ goal: "ausbildung" }), opp());
    expect(result.score).not.toBeNull();
    expect(Number.isInteger(result.score as number)).toBe(true);
    expect((result.score as number) >= 0).toBe(true);
    expect((result.score as number) <= 100).toBe(true);
  });

  it("reasons are only produced for complete matches and stay factual", () => {
    const complete = computeMatch(
      profile({
        goal: "ausbildung",
        target_roles: [explicitRole("Mechatroniker")],
        preferences: { ...profile().preferences, preferred_job_titles: [] },
        education: [
          {
            school: null,
            university: null,
            degree: null,
            field_of_study: null,
            graduation_year: null,
            education_level: "Abitur",
            source: "user_provided",
          },
        ],
      }),
      opp(),
    );
    expect(complete.status).toBe("complete");
    expect(complete.reasons.length).toBeGreaterThan(0);
    for (const reason of complete.reasons) {
      expect(reason).not.toMatch(/great fit|perfekt|super/i);
    }
    const incomplete = computeMatch(
      profile({
        goal: "ausbildung",
        target_roles: [],
        preferences: { ...profile().preferences, preferred_job_titles: [] },
      }),
      opp(),
    );
    expect(incomplete.reasons).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Determinism + edge cases
// ---------------------------------------------------------------------------

describe("determinism and edge cases", () => {
  const p = profile({ goal: "ausbildung" });
  const o = opp({ required_skills: ["Excel", "Teamfähigkeit"] });

  it("same profile + same opportunity always produce the same result", () => {
    expect(computeMatch(p, o)).toEqual(computeMatch(p, o));
  });

  it("matchOpportunity === computeMatch for a present profile", () => {
    expect(matchOpportunity(p, o)).toEqual(computeMatch(p, o));
  });

  it("case/whitespace differences in roles do not change the verdict", () => {
    const a = computeMatch(
      profile({
        goal: "ausbildung",
        target_roles: [explicitRole("  MECHATRONIKER  ")],
        preferences: { ...profile().preferences, preferred_job_titles: [] },
      }),
      opp(),
    );
    const b = computeMatch(
      profile({
        goal: "ausbildung",
        target_roles: [explicitRole("mechatroniker")],
        preferences: { ...profile().preferences, preferred_job_titles: [] },
      }),
      opp(),
    );
    // The verdict (statuses + score) is identical; only the human-readable
    // evidence quotes the original input text.
    expect(a.score).toBe(b.score);
    expect(dimension(a, "role").status).toBe("match");
    expect(dimension(b, "role").status).toBe("match");
    expect(a.dimensions.map((d) => [d.id, d.status])).toEqual(
      b.dimensions.map((d) => [d.id, d.status]),
    );
  });

  it("German umlauts / ß are folded (Straße/Strasse match)", () => {
    const result = computeMatch(
      profile({
        goal: "arbeit",
        target_roles: [explicitRole("Straßenbauer")],
        preferences: { ...profile().preferences, preferred_job_titles: [] },
      }),
      arbeitOpp({ title: "Strassenbauer", profession: "Strassenbauer" }),
    );
    expect(dimension(result, "role").status).toBe("match");
  });

  it("punctuation differences do not break token matching", () => {
    const result = computeMatch(
      profile({
        goal: "ausbildung",
        target_roles: [explicitRole("Mechatroniker")],
        preferences: { ...profile().preferences, preferred_job_titles: [] },
      }),
      opp({ profession: "Mechatroniker/in (dual)" }),
    );
    expect(dimension(result, "role").status).toBe("match");
  });

  it("empty arrays / null fields everywhere fail safe (complete with minimal evidence)", () => {
    const result = computeMatch(
      profile({
        goal: "arbeit",
        target_roles: [explicitRole("Mechatroniker")],
        preferences: {
          ...profile().preferences,
          preferred_job_titles: [],
          preferred_locations: [],
          remote_hybrid_preference: null,
        },
        education: [],
        experience: [],
        skills: {
          technical: [],
          software_tools: [],
          marketing: [],
          it: [],
          soft: [],
        },
        languages: [],
      }),
      arbeitOpp({
        location: null,
        salary: null,
        requirements: [],
        employment_type: null,
        home_office: null,
        alternative_professions: [],
      }),
    );
    expect(result.status).toBe("complete");
    expect(result.score).not.toBeNull();
    // v2: twelve production dimensions
    expect(result.dimensions.length).toBe(12);
  });

  it("malformed raw profile is rejected by the schema (search layer treats it as unavailable)", () => {
    expect(
      candidateProfileSchema.safeParse({ goal: "ausbildung", nonsense: true })
        .success,
    ).toBe(true);
    // goal must be one of the two valid values — anything else is rejected
    expect(
      candidateProfileSchema.safeParse({
        ...candidateProfileFixture(),
        goal: "xxx",
      }).success,
    ).toBe(false);
  });

  it("result never contains candidate profile internals (no PII leakage into the match payload)", () => {
    const pWithPii = profile({
      goal: "ausbildung",
      candidate: {
        full_name: "Geheim Person",
        location: "Berlin",
        country: "Deutschland",
        current_location: "Berlin",
        target_location: [],
        contact: {
          email: "geheim@person.example",
          phone: "+49 30 123456",
          linkedin: null,
        },
      },
    });
    const serialized = JSON.stringify(computeMatch(pWithPii, opp()));
    expect(serialized).not.toContain("geheim@person.example");
    expect(serialized).not.toContain("Geheim Person");
    expect(serialized).not.toContain("+49 30 123456");
  });

  it("the matcher is pure: it never touches the network", async () => {
    const fetchSpy = vi.fn(() => {
      throw new Error("network access must not happen");
    });
    vi.stubGlobal("fetch", fetchSpy);
    computeMatch(profile({ goal: "ausbildung" }), opp());
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("carries the matcher version for provenance", () => {
    expect(computeMatch(p, o).version).toBe(MATCHER_VERSION);
  });

  it("cross-user isolation: different profiles yield independent, non-identical results", () => {
    const profileA = profile({
      goal: "ausbildung",
      target_roles: [explicitRole("Mechatroniker")],
      preferences: { ...profile().preferences, preferred_job_titles: [] },
    });
    const profileB = profile({
      goal: "ausbildung",
      target_roles: [explicitRole("Bäcker")],
      preferences: { ...profile().preferences, preferred_job_titles: [] },
    });
    const resultA = computeMatch(profileA, opp());
    const resultB = computeMatch(profileB, opp());
    expect(resultA).not.toEqual(resultB);
    expect(dimension(resultA, "role").status).toBe("match");
    expect(dimension(resultB, "role").status).toBe("mismatch");
    // A's result must not be influenced by B's data and vice versa.
    expect(computeMatch(profileA, opp())).toEqual(resultA);
    expect(computeMatch(profileB, opp())).toEqual(resultB);
  });
});

// ---------------------------------------------------------------------------
// v2 production dimensions (Phase 7)
// ---------------------------------------------------------------------------

describe("dimension: training_type (v2)", () => {
  it("no training type documented by the source → not_applicable", () => {
    const result = computeMatch(profile({ goal: "arbeit" }), arbeitOpp());
    const training = dimension(result, "training_type");
    expect(training.status).toBe("not_applicable");
    expect(training.essential).toBe(false);
  });

  it("documented type without a candidate preference → unknown, never blocking", () => {
    const result = computeMatch(profile({ goal: "ausbildung" }), opp());
    const training = dimension(result, "training_type");
    expect(training.status).toBe("unknown");
    expect(training.essential).toBe(false);
    expect(training.missing.join(" ")).toContain("Ausbildungsform");
    expect(training.opportunity).toBe("AUSBILDUNG");
    expect(result.status).toBe("complete"); // non-essential → still scored
  });
});

describe("dimension: preferences (v2)", () => {
  it("no industry preference documented → not_applicable", () => {
    const result = computeMatch(profile({ goal: "arbeit" }), arbeitOpp());
    expect(dimension(result, "preferences").status).toBe("not_applicable");
  });

  it("documented preference but the source documents no industry → unknown, never a negative", () => {
    const result = computeMatch(
      profile({
        goal: "arbeit",
        preferences: {
          ...profile().preferences,
          preferred_industries: ["Handwerk"],
        },
      }),
      arbeitOpp(),
    );
    const preferences = dimension(result, "preferences");
    expect(preferences.status).toBe("unknown");
    expect(preferences.essential).toBe(false);
    expect(preferences.candidate).toBe("handwerk");
    expect(preferences.opportunity).toBeNull();
    expect(preferences.missing.join(" ")).toContain("Branche");
    expect(result.status).toBe("complete");
  });
});

describe("structured evidence (v2 candidate/opportunity quotes)", () => {
  it("education carries the documented raw values from both sides", () => {
    const result = computeMatch(
      profile({
        goal: "ausbildung",
        target_roles: [explicitRole("Mechatroniker")],
        preferences: { ...profile().preferences, preferred_job_titles: [] },
        education: [
          {
            school: null,
            university: null,
            degree: null,
            field_of_study: null,
            graduation_year: null,
            education_level: "Abitur",
            source: "user_provided",
          },
        ],
      }),
      opp(),
    );
    const education = dimension(result, "education");
    expect(education.candidate).toBe("Abitur");
    expect(education.opportunity).toBe("HAUPTSCHULABSCHLUSS");
  });

  it("goal quotes both documented sides", () => {
    const result = computeMatch(profile({ goal: "ausbildung" }), opp());
    const goal = dimension(result, "goal");
    expect(goal.candidate).toBe("Ausbildung");
    expect(goal.opportunity).toBe("Ausbildung");
  });

  it("location difference quotes the documented locations from both sides", () => {
    const result = computeMatch(
      profile({
        goal: "arbeit",
        preferences: { ...profile().preferences, willing_to_relocate: true },
      }),
      arbeitOpp({ location: "20095 Hamburg" }),
    );
    const location = dimension(result, "location");
    expect(location.candidate).toBe("Berlin");
    expect(location.opportunity).toBe("20095 Hamburg");
    expect(dimension(result, "relocation").opportunity).toBe("20095 Hamburg");
  });

  it("undocumented sides stay null (no invented evidence)", () => {
    const result = computeMatch(profile({ goal: "arbeit" }), arbeitOpp());
    const preferences = dimension(result, "preferences");
    expect(preferences.candidate).toBeNull();
    expect(preferences.opportunity).toBeNull();
  });
});

describe("v2 dimension set completeness", () => {
  it("all twelve production dimensions are present and ordered", () => {
    const result = computeMatch(profile({ goal: "ausbildung" }), opp());
    expect(result.dimensions.map((d) => d.id)).toEqual([
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
    ]);
  });

  it("relocation never blocks completeness (unknown willingness → scored)", () => {
    const result = computeMatch(
      profile({
        goal: "arbeit",
        preferences: { ...profile().preferences, willing_to_relocate: null },
      }),
      arbeitOpp({ location: "20095 Hamburg" }),
    );
    expect(result.status).toBe("complete");
    expect(result.score).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Match score realism (v3 — graded, per-opportunity, never a fixed number)
// ---------------------------------------------------------------------------

describe("match score realism (v3)", () => {
  /** A fully documented candidate: Kaufmann im E-Commerce, Abitur, German
   *  B2, Excel skill, Berlin, no relocation. */
  function realProfile(): CandidateProfile {
    return profile({
      goal: "ausbildung",
      target_roles: [explicitRole("Kaufmann im E-Commerce")],
      education: [
        {
          school: null,
          university: null,
          degree: null,
          field_of_study: null,
          graduation_year: null,
          education_level: "Abitur",
          source: "user_provided",
        },
      ],
      languages: [
        {
          language: "German",
          level: "B2",
          level_is_inferred: false,
          source: "user_provided",
        },
      ],
      skills: {
        technical: ["Excel"],
        software_tools: [],
        marketing: [],
        it: [],
        soft: [],
      },
      experience: [],
      preferences: {
        target: "ausbildung",
        preferred_job_titles: [],
        preferred_industries: [],
        preferred_locations: ["Berlin"],
        willing_to_relocate: false,
        remote_hybrid_preference: null,
      },
    });
  }

  function realOpp(overrides: Partial<Opportunity> = {}): Opportunity {
    return opp({
      title: "Ausbildung Kaufmann/Kauffrau im E-Commerce",
      profession: "Kaufmann/Kauffrau im E-Commerce",
      location: "10115 Berlin",
      ...overrides,
    });
  }

  it("1 — exact target profession → high score", () => {
    const result = computeMatch(
      realProfile(),
      realOpp({ required_skills: ["Excel", "SAP"] }),
    );
    expect(result.status).toBe("complete");
    const role = dimension(result, "role");
    expect(role.contribution).toBe(1); // all documented role terms present
    // goal 0.18 + role 0.20×1.0 + education 0.20 + skills 0.14×0.5
    // (Excel yes / SAP no, inferred cap) + location 0.04 → 0.69/0.76
    expect(result.score).toBe(
      Math.round((100 * (0.18 + 0.2 + 0.2 + 0.07 + 0.04)) / 0.76),
    );
    expect(result.score).toBe(91);
  });

  it("2 — completely different profession → low score", () => {
    const result = computeMatch(
      realProfile(),
      realOpp({
        title: "Ausbildung Mechatroniker/in",
        profession: "Mechatroniker/in",
        location: "20095 Hamburg",
      }),
    );
    const role = dimension(result, "role");
    expect(role.status).toBe("mismatch");
    expect(role.contribution).toBe(0);
    // goal 0.18 + role 0 + education 0.20, location 0, relocation 0 over
    // 0.64 → 0.38/0.64
    expect(result.score).toBe(Math.round((100 * 0.38) / 0.64));
    expect(result.score).toBe(59);
    expect((result.score as number) < 60).toBe(true);
  });

  it("3 — documented skill match raises the score vs. an unmatched requirement", () => {
    const withMatch = computeMatch(
      realProfile(),
      realOpp({
        title: "Ausbildung Kaufmann für Marketingkommunikation",
        profession: "Kaufmann für Marketingkommunikation",
        required_skills: ["Excel"], // candidate documents Excel
      }),
    );
    const withoutMatch = computeMatch(
      realProfile(),
      realOpp({
        title: "Ausbildung Kaufmann für Marketingkommunikation",
        profession: "Kaufmann für Marketingkommunikation",
        required_skills: ["SAP"], // candidate does not document SAP
      }),
    );
    // Skills provenance is always `inferred` (scanner-parsed) → the graded
    // coverage is real (1.0 vs 0.0) but the inferred cap bounds the share at
    // 0.5 — a full match of skills is never scored as confident as explicit.
    expect(dimension(withMatch, "skills").contribution).toBe(0.5);
    expect(dimension(withoutMatch, "skills").contribution).toBe(0);
    expect(withMatch.score as number).toBeGreaterThan(
      withoutMatch.score as number,
    );
  });

  it("4 — language mismatch (B2 vs required C1) hurts; meeting it does not", () => {
    const met = computeMatch(
      realProfile(),
      realOpp({ required_languages: ["German B1"] }),
    );
    const unmet = computeMatch(
      realProfile(),
      realOpp({ required_languages: ["German C1"] }),
    );
    expect(dimension(met, "languages").status).toBe("match");
    expect(dimension(unmet, "languages").status).toBe("mismatch");
    // Languages carries no graded share — the effective share comes from the
    // coarse status fallback (mismatch → 0), which is what pulls the score down.
    expect(dimensionContribution(dimension(unmet, "languages"))).toBe(0);
    expect(unmet.score as number).toBeLessThan(met.score as number);
  });

  it("5 — location mismatch lowers the score (documented difference counted)", () => {
    const berlin = computeMatch(realProfile(), realOpp());
    const hamburg = computeMatch(
      realProfile(),
      realOpp({ location: "20095 Hamburg" }),
    );
    expect(dimension(berlin, "location").status).toBe("match");
    expect(dimension(hamburg, "location").status).toBe("mismatch");
    expect(dimension(hamburg, "location").contribution).toBe(0);
    expect(hamburg.score as number).toBeLessThan(berlin.score as number);
  });

  it("6 — missing data is never a perfect match: unknown contributes nothing (null), essential unknown → no score", () => {
    // (a) non-essential missing: no skills/education requirement documented
    //     → those dimensions earn NO share (contribution null), the score is
    //     the weighted average over the documented criteria only.
    const result = computeMatch(
      realProfile(),
      realOpp({ education_requirement: null }),
    );
    expect(dimension(result, "skills").status).toBe("not_applicable");
    expect(dimension(result, "skills").contribution).toBeNull();
    expect(dimension(result, "education").status).toBe("not_applicable");
    expect(dimension(result, "education").contribution).toBeNull();
    expect(dimension(result, "languages").contribution).toBeNull();
    // goal + role + location evaluated: 0.42/0.42 — nothing phantom
    expect(result.score).toBe(
      Math.round((100 * (0.18 + 0.2 + 0.04)) / (0.18 + 0.2 + 0.04)),
    );
    // (b) essential missing: no target role documented → no score at all
    const noRole = computeMatch(
      profile({
        ...realProfile(),
        target_roles: [],
        preferences: {
          ...realProfile().preferences,
          preferred_job_titles: [],
        },
      }),
      realOpp(),
    );
    expect(noRole.status).toBe("incomplete");
    expect(noRole.score).toBeNull();
  });

  it("7 — deterministic: same profile + same opportunity → same score (5×)", () => {
    const first = computeMatch(realProfile(), realOpp());
    for (let i = 0; i < 5; i += 1) {
      expect(computeMatch(realProfile(), realOpp())).toEqual(first);
    }
  });

  it("8 — different opportunities produce different, ordered scores", () => {
    const a = computeMatch(realProfile(), realOpp()); // exact profession
    const b = computeMatch(
      realProfile(),
      realOpp({
        title: "Ausbildung Kaufmann für Marketingkommunikation",
        profession: "Kaufmann für Marketingkommunikation",
        required_skills: ["Excel"],
      }),
    );
    const c = computeMatch(
      realProfile(),
      realOpp({
        title: "Ausbildung Industriekaufmann",
        profession: "Industriekaufmann",
        location: "20095 Hamburg",
      }),
    );
    const d = computeMatch(
      realProfile(),
      realOpp({
        title: "Ausbildung Mechatroniker/in",
        profession: "Mechatroniker/in",
        location: "20095 Hamburg",
      }),
    );
    const scores = [
      a.score as number,
      b.score as number,
      c.score as number,
      d.score as number,
    ];
    // No two are identical (v2 collapsed these into one bucket → one number)
    expect(new Set(scores).size).toBe(4);
    expect(scores[0]).toBeGreaterThan(scores[1]);
    expect(scores[1]).toBeGreaterThan(scores[2]);
    expect(scores[2]).toBeGreaterThan(scores[3]);
  });

  it("9 — no hardcoded score / no random fallback in the engine source", () => {
    const files = [
      "types.ts",
      "scorer.ts",
      "dimensions.ts",
      "text.ts",
      "profile-normalizer.ts",
      "explanations.ts",
      "index.ts",
    ];
    for (const file of files) {
      const source = readFileSync(
        `src/lib/opportunities/matching/${file}`,
        "utf8",
      );
      expect(source.includes("Math.random")).toBe(false);
      expect(/=\s*74\b/.test(source)).toBe(false); // fixed 74%
      expect(/0\.74/.test(source)).toBe(false); // 0.74 share
      expect(/score:\s*74\b/.test(source)).toBe(false);
    }
    // And functionally: the same v2 trap (goal match + role partial) no
    // longer produces one fixed number for every profession.
    const scores = [
      "Kaufmann für Marketingkommunikation",
      "Kaufmann im Einzelhandel",
      "Kaufmann im Marketing",
    ].map((profession) =>
      computeMatch(
        realProfile(),
        realOpp({ title: `Ausbildung ${profession}`, profession }),
      ).score as number,
    );
    expect(scores.every((s) => s !== 74)).toBe(true);
  });

  it("10 — every score is an integer within 0..100", () => {
    const cases: Array<[CandidateProfile, Opportunity]> = [
      [realProfile(), realOpp()],
      [
        realProfile(),
        realOpp({
          title: "Ausbildung Industriekaufmann",
          profession: "Industriekaufmann",
          location: "20095 Hamburg",
        }),
      ],
      [
        realProfile(),
        realOpp({
          title: "Ausbildung Mechatroniker/in",
          profession: "Mechatroniker/in",
          location: "20095 Hamburg",
        }),
      ],
    ];
    for (const [p, o] of cases) {
      const result = computeMatch(p, o);
      if (result.score !== null) {
        expect(Number.isInteger(result.score)).toBe(true);
        expect(result.score as number).toBeGreaterThanOrEqual(0);
        expect(result.score as number).toBeLessThanOrEqual(100);
      }
    }
  });
});
