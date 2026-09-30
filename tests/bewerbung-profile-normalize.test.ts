import { describe, expect, it } from "vitest";
import { candidateProfileSchema } from "@/lib/bewerbung-schema";
import {
  SPARSE_MAX_ENTRIES,
  SPARSE_MIN_DOC_CHARS,
  emptyPrimarySections,
  extractJsonObject,
  isSuspiciouslySparse,
  normalizeAiProfileResponse,
  normalizeProfile,
  pickMoreComplete,
  primaryEntryCount,
} from "@/lib/bewerbung-profile-normalize";

/**
 * Regression tests for the AI → CandidateProfile normalization layer
 * (Bewerbung Scanner). The production failure was:
 *   "The AI response did not match the required profile schema."
 * i.e. the model returned JSON that parsed but whose shape deviated from
 * the strict schema (fences, wrappers, camelCase, comma-strings, invalid
 * enums, missing required entry keys). The schema must stay the final
 * boundary — these tests prove the normalizer makes the realistic
 * deviation class pass AND that garbage still fails safely.
 */

const VALID_PROFILE = {
  candidate: {
    full_name: "Max Mustermann",
    location: "Berlin",
    country: "Germany",
    current_location: "Berlin",
    target_location: ["Berlin", "Hamburg"],
    contact: { email: "max@example.com", phone: null, linkedin: null },
  },
  goal: "ausbildung",
  education: [
    {
      school: "Berthold-Schmidt-Gymnasium",
      university: null,
      degree: null,
      field_of_study: null,
      graduation_year: 2026,
      education_level: "Abitur",
      source: "ai_extracted",
    },
  ],
  training: [
    { name: "Büromanagement", provider: "IHK", year: "2024", source: "ai_extracted" },
  ],
  experience: [
    {
      job_title: "Auszubildende Verwaltung",
      company: "Muster GmbH",
      responsibilities: ["Posteingang"],
      start_date: "2024-08",
      end_date: "2025-07",
      type: "employment",
      source: "ai_extracted",
    },
  ],
  skills: {
    technical: ["MS Excel"],
    software_tools: ["SAP"],
    marketing: [],
    it: [],
    soft: ["Teamfähigkeit"],
  },
  languages: [
    { language: "Deutsch", level: "C2", level_is_inferred: false, source: "ai_extracted" },
    { language: "Englisch", level: "B1", level_is_inferred: true, source: "ai_extracted" },
  ],
  preferences: {
    target: "ausbildung",
    preferred_job_titles: ["Verwaltung"],
    preferred_industries: [],
    preferred_locations: ["Berlin"],
    willing_to_relocate: false,
    remote_hybrid_preference: null,
  },
  target_roles: [
    { role: "Verwaltungsfachangestellte", reason: "Passender Abschluss", source: "ai_extracted" },
  ],
  strengths: ["Sorgfältig"],
  missing_information: ["Keine"],
  potential_concerns: [],
  keywords: ["Verwaltung", "Excel"],
};

const pipeline = (raw: string, goal: "ausbildung" | "arbeit" = "ausbildung") =>
  normalizeAiProfileResponse(raw, goal);

/** Assert the normalized output passes the FINAL schema boundary. */
const assertSchemaPass = (raw: string, goal: "ausbildung" | "arbeit" = "ausbildung") => {
  const result = candidateProfileSchema.safeParse(pipeline(raw, goal));
  expect(result.success, `schema must pass, issues: ${result.success ? "" : JSON.stringify(result.error.issues)}`).toBe(true);
  return result.success ? result.data : null;
};

describe("AI → CandidateProfile normalization (Bewerbung Scanner)", () => {
  it("1. perfect valid JSON passes unchanged in substance", () => {
    const data = assertSchemaPass(JSON.stringify(VALID_PROFILE));
    expect(data?.candidate.full_name).toBe("Max Mustermann");
    expect(data?.experience[0].job_title).toBe("Auszubildende Verwaltung");
    expect(data?.languages[1].level_is_inferred).toBe(true);
  });

  it("2. JSON inside a ```json fence", () => {
    assertSchemaPass("```json\n" + JSON.stringify(VALID_PROFILE) + "\n```");
  });

  it("3. JSON surrounded by explanatory text (before and after)", () => {
    assertSchemaPass(
      "Here is the extracted profile as requested:\n" +
        JSON.stringify(VALID_PROFILE) +
        "\n\nLet me know if you need anything else.",
    );
  });

  it("4. camelCase AI output is mapped to schema keys", () => {
    const data = assertSchemaPass(
      JSON.stringify({
        candidate: {
          fullName: "Anna Beispiel",
          currentLocation: "Köln",
          contact: { email: "anna@example.com", linkedIn: "x" },
        },
        goal: "arbeit",
        skills: { softwareTools: ["Figma"], soft: ["Kommunikation"] },
        experience: [
          {
            jobTitle: "Mediengestalterin",
            company: "Studio X",
            type: "job",
            startDate: "2023-01",
          },
        ],
        languages: [{ language: "Englisch", level: "B1", levelIsInferred: "true" }],
        preferences: { willingToRelocate: "yes", target: "Arbeit" },
        targetRoles: [{ title: "UX Designerin" }],
        strengths: "Kreativ, zuverlässig",
        keywords: "Design; UX",
      }),
    );
    expect(data?.candidate.full_name).toBe("Anna Beispiel");
    expect(data?.candidate.current_location).toBe("Köln");
    expect(data?.skills.software_tools).toContain("Figma");
    expect(data?.experience[0].job_title).toBe("Mediengestalterin");
    expect(data?.experience[0].type).toBe("employment"); // "job" normalized
    expect(data?.languages[0].level_is_inferred).toBe(true);
    expect(data?.preferences.willing_to_relocate).toBe(true);
    expect(data?.preferences.target).toBeNull(); // "Arbeit" invalid → null
    expect(data?.strengths).toEqual(["Kreativ", "zuverlässig"]);
    expect(data?.keywords).toEqual(["Design", "UX"]);
    // "title" is not a valid role key → entry dropped (role required).
    expect(data?.target_roles).toEqual([]);
  });

  it("5. missing optional fields fall back to schema defaults", () => {
    const data = assertSchemaPass(
      JSON.stringify({
        candidate: { fullName: "Lena" },
        goal: "ausbildung",
      }),
    );
    expect(data?.candidate.full_name).toBe("Lena");
    expect(data?.candidate.target_location).toEqual([]);
    expect(data?.candidate.contact).toEqual({
      email: null,
      phone: null,
      linkedin: null,
    });
    expect(data?.education).toEqual([]);
    expect(data?.skills).toEqual({
      technical: [],
      software_tools: [],
      marketing: [],
      it: [],
      soft: [],
    });
    expect(data?.preferences.willing_to_relocate).toBeNull();
  });

  it("6. invalid/malformed target role entries are dropped, valid ones kept", () => {
    const data = assertSchemaPass(
      JSON.stringify({
        candidate: {},
        goal: "arbeit",
        target_roles: [
          { role: "Verkäuferin", reason: "Berufserfahrung" },
          "Nur ein String",
          { title: "Falscher Key" },
          { role: "", reason: "Leere Rolle" },
          { role: "Kassiererin" },
        ],
      }),
    );
    expect(data?.target_roles).toEqual([
      { role: "Verkäuferin", reason: "Berufserfahrung", source: "ai_extracted" },
      // reason backfilled from the existing role value (no invention):
      { role: "Kassiererin", reason: "Kassiererin", source: "ai_extracted" },
    ]);
  });

  it("7. invalid experience types normalize to employment; entries without job_title drop", () => {
    const data = assertSchemaPass(
      JSON.stringify({
        candidate: {},
        goal: "ausbildung",
        experience: [
          { job_title: "Bartender", type: "side_job" },
          { company: "Ohne Titel", type: "employment" },
          { job_title: "Aushilfe", type: "internship" },
          "nicht-objekt",
        ],
      }),
    );
    expect(data?.experience).toEqual([
      {
        job_title: "Bartender",
        company: null,
        responsibilities: [],
        start_date: null,
        end_date: null,
        type: "employment",
        source: "ai_extracted",
      },
      {
        job_title: "Aushilfe",
        company: null,
        responsibilities: [],
        start_date: null,
        end_date: null,
        type: "internship",
        source: "ai_extracted",
      },
    ]);
  });

  it("8. nested candidateProfile / data wrappers are unwrapped", () => {
    assertSchemaPass(JSON.stringify({ candidateProfile: VALID_PROFILE }));
    assertSchemaPass(JSON.stringify({ data: { profile: VALID_PROFILE } }));
  });

  it("9. completely invalid AI output still fails safely (no JSON object)", () => {
    expect(() => pipeline("Sorry, I cannot process that document.")).toThrow();
    expect(() => pipeline("{ this is not valid json !!!")).toThrow();
    expect(() => pipeline("[1, 2, 3]")).toThrow();
    // each internal stage fails loudly on garbage (no silent pass-through):
    expect(() => extractJsonObject("not json")).toThrow();
    expect(() => normalizeProfile("not an object", "ausbildung")).toThrow();
  });

  it("10. final output always passes candidateProfileSchema (all cases above)", () => {
    // assertSchemaPass already enforced safeParse success in cases 1-8;
    // this pins the contract explicitly on the canonical sample:
    const result = candidateProfileSchema.safeParse(
      pipeline(JSON.stringify(VALID_PROFILE)),
    );
    expect(result.success).toBe(true);
  });

  it("server scan goal overrides any conflicting AI-generated goal", () => {
    const fromAiArbeit = assertSchemaPass(JSON.stringify({ ...VALID_PROFILE, goal: "arbeit" }), "ausbildung");
    expect(fromAiArbeit?.goal).toBe("ausbildung");
    const fromAiAusbildung = assertSchemaPass(JSON.stringify({ ...VALID_PROFILE, goal: "ausbildung" }), "arbeit");
    expect(fromAiAusbildung?.goal).toBe("arbeit");
  });

  it("never invents facts: unknown/missing values become null or [], not guesses", () => {
    const data = assertSchemaPass(
      JSON.stringify({ candidate: { contact: { phone: 12345 } }, goal: "ausbildung" }),
    );
    // numeric phone is coerced to its existing string form (not invented)
    expect(data?.candidate.contact.phone).toBe("12345");
    expect(data?.candidate.full_name).toBeNull();
    expect(data?.keywords).toEqual([]);
    // zod's .default([]) fills omitted optional arrays — never undefined
    expect(data?.experience).toEqual([]);
  });
});

/**
 * Completeness gate (§17) — deterministic backstop so a substantial CV can
 * never silently produce an almost-empty profile. The gate only TRIAGES;
 * it never fabricates data.
 */
describe("completeness gate (sparse-output backstop)", () => {
  type EmptyProfile = {
    education: unknown[];
    training: unknown[];
    experience: unknown[];
    languages: unknown[];
    target_roles: unknown[];
    skills: Record<string, unknown[]>;
  };
  const emptyProfile = (): EmptyProfile => ({
    education: [],
    training: [],
    experience: [],
    languages: [],
    target_roles: [],
    skills: {
      technical: [],
      software_tools: [],
      marketing: [],
      it: [],
      soft: [],
    },
  });

  it("flags a nearly-empty profile for a substantial document", () => {
    const p = emptyProfile();
    // 1 language + 1 skill = 2 entries → still at the sparse boundary
    p.languages = [{ language: "Deutsch", level: "B1" }];
    p.skills.soft = ["Kommunikation"];
    expect(primaryEntryCount(p)).toBe(2);
    expect(primaryEntryCount(p)).toBeLessThanOrEqual(SPARSE_MAX_ENTRIES);
    expect(isSuspiciouslySparse(p, 5000)).toBe(true);
    expect(emptyPrimarySections(p)).toEqual(
      expect.arrayContaining([
        "education (Bildung)",
        "experience (Berufserfahrung)",
        "target_roles (Zielfunktionen)",
      ]),
    );
  });

  it("does NOT flag a small document (legitimately sparse)", () => {
    expect(
      isSuspiciouslySparse(emptyProfile(), SPARSE_MIN_DOC_CHARS - 1),
    ).toBe(false);
  });

  it("does NOT flag a genuinely complete profile", () => {
    const p = emptyProfile();
    p.education = [{ degree: "Abitur" }, { degree: "Bachelor" }];
    p.experience = [
      { job_title: "Werkstudentin" },
      { job_title: "Praktikum" },
    ];
    p.languages = [{ language: "Deutsch" }, { language: "Englisch" }];
    p.skills.technical = ["SEO"];
    expect(isSuspiciouslySparse(p, 5000)).toBe(false);
  });

  it("pickMoreComplete keeps the richer genuine output (never invents)", () => {
    const sparse = emptyProfile();
    const rich = emptyProfile();
    rich.education = [{ degree: "Abitur" }];
    rich.experience = [{ job_title: "Werkstudentin" }];
    rich.languages = [{ language: "Deutsch" }];
    expect(pickMoreComplete(sparse, rich)).toBe(rich);
    expect(pickMoreComplete(rich, sparse)).toBe(rich);
    // equal → the first argument wins (stable)
    expect(pickMoreComplete(rich, rich)).toBe(rich);
  });
});