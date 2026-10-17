/**
 * Personalization of the letter prompt (pure).
 *
 * The product requirement: a letter must connect the ACTUAL applicant, the
 * ACTUAL position and the ACTUAL employer — never a generic template with the
 * company name swapped in. These tests pin that the prompt carries the right
 * data for each application, degrades honestly when data is missing, and
 * never leaks one applicant's data into another application.
 */
import { describe, expect, it } from "vitest";
import type { CandidateProfile } from "@/lib/bewerbung-schema";
import { buildApplicantEvidence, buildLetterPrompt, type LetterPromptInput } from "@/lib/bewerbung-automation";

function profile(name: string, extra: Partial<CandidateProfile> = {}): CandidateProfile {
  return {
    candidate: {
      full_name: name,
      location: "Berlin",
      country: "Deutschland",
      current_location: null,
      target_location: [],
      contact: { email: `${name.split(" ")[0].toLowerCase()}@example.de`, phone: null, linkedin: null },
    },
    goal: "ausbildung",
    education: [{ school: "BBS", university: null, degree: null, field_of_study: "Informatik", graduation_year: 2026, education_level: null, source: "ai_extracted" }],
    training: [],
    experience: [
      { job_title: "IT-Support-Aushilfe", company: "Firma X", responsibilities: ["Hardware-Einrichtung"], start_date: "2024", end_date: "2025", type: "employment", source: "ai_extracted" },
    ],
    skills: { technical: ["Python"], software_tools: [], marketing: [], it: ["Linux"], soft: [] },
    languages: [{ language: "Deutsch", level: "B2", level_is_inferred: false, source: "ai_extracted" }],
    preferences: { target: "ausbildung", preferred_job_titles: [], preferred_industries: [], preferred_locations: [], willing_to_relocate: null, remote_hybrid_preference: null },
    target_roles: [],
    strengths: [],
    missing_information: [],
    potential_concerns: [],
    keywords: [],
    ...extra,
  } as CandidateProfile;
}

const SPARSE = profile("Anna Klein", {
  experience: [],
  education: [],
  skills: { technical: [], software_tools: [], marketing: [], it: [], soft: [] },
  languages: [],
});

function promptFor(applicant: CandidateProfile, employer: Partial<LetterPromptInput["employer"]>, position: LetterPromptInput["position"] = { title: "Fachinformatikerin", brief: "Webentwicklung" }): LetterPromptInput {
  return {
    purpose: "ausbildung",
    position,
    employer: { companyName: "ACME GmbH", ...employer },
    applicant: { candidate: applicant, cvText: "" },
  };
}

describe("rich vs. sparse CV", () => {
  it("embeds the parsed evidence for a rich profile", () => {
    const p = buildLetterPrompt(promptFor(profile("Max Muster"), {}));
    expect(p).toContain("Max Muster");
    expect(p).toContain("Python");
    expect(p).toContain("Linux");
    expect(p).toContain("IT-Support-Aushilfe");
    expect(p).toContain("Deutsch: B2");
  });

  it("does NOT fabricate evidence for a sparse profile", () => {
    const p = buildLetterPrompt(promptFor(SPARSE, {}));
    expect(p).toContain("Anna Klein");
    expect(p).not.toContain("Python");
    expect(p).not.toContain("Berufserfahrung / Praktika:");
  });
});

describe("missing position data degrades honestly (no invention)", () => {
  it("declares an absent role and job description", () => {
    const p = buildLetterPrompt(promptFor(profile("Max Muster"), {}, { title: "", brief: "" }));
    expect(p).toContain("Bezeichnung: (nicht angegeben)");
    expect(p).toContain("Beschreibung: (nicht angegeben)");
    expect(p).toMatch(/KEINE konkrete Stellenbezeichnung/i);
  });
});

describe("missing employer data degrades honestly (no invention)", () => {
  it("omits the facts block and instructs general, honest interest", () => {
    const p = buildLetterPrompt(promptFor(profile("Max Muster"), { facts: "" }));
    expect(p).not.toContain("⟦UNTERNEHMEN_FAKTEN⟧");
    expect(p).toMatch(/KEINE überprüften Unternehmens-Fakten/i);
  });

  it("includes the facts block only when verified facts exist", () => {
    const p = buildLetterPrompt(promptFor(profile("Max Muster"), { facts: "ACME entwickelt Middleware." }));
    expect(p).toContain("⟦UNTERNEHMEN_FAKTEN⟧");
    expect(p).toContain("ACME entwickelt Middleware.");
  });
});

describe("company-specific difference for the same applicant", () => {
  const applicant = profile("Max Muster");

  it("produces distinct prompts for distinct employers", () => {
    const pA = buildLetterPrompt(promptFor(applicant, { companyName: "ACME GmbH", contactName: "Herr A" }));
    const pB = buildLetterPrompt(promptFor(applicant, { companyName: "Globex AG", contactName: "Frau B" }));
    expect(pA).not.toBe(pB);
    expect(pA).toContain("ACME GmbH");
    expect(pA).toContain("Herr A");
    expect(pB).toContain("Globex AG");
    expect(pB).toContain("Frau B");
  });

  it("a per-company position override changes the ROLLE block only for that application", () => {
    const base = buildLetterPrompt(promptFor(applicant, {}));
    const overridden = buildLetterPrompt(
      promptFor(applicant, {}, { title: "Kaufmann für E-Commerce", brief: "Online-Marketing und Vertrieb" }),
    );
    expect(base).toContain("Fachinformatikerin");
    expect(overridden).toContain("Kaufmann für E-Commerce");
    expect(overridden).not.toContain("Fachinformatikerin");
  });
});

describe("no cross-applicant data leakage", () => {
  it("one applicant's evidence never appears in another applicant's section", () => {
    const a = profile("Maximilian Muster", { skills: { technical: ["Kaffeesenfen"], software_tools: [], marketing: [], it: ["Espresso"], soft: [] } });
    const b = profile("Jasmin Weber", { skills: { technical: ["Backen"], software_tools: [], marketing: [], it: ["Ziegenkäse"], soft: [] } });
    const evA = buildApplicantEvidence(a);
    const evB = buildApplicantEvidence(b);
    expect(evA).toContain("Maximilian Muster");
    expect(evA).toContain("Espresso");
    expect(evA).not.toContain("Jasmin Weber");
    expect(evA).not.toContain("Ziegenkäse");
    expect(evB).toContain("Jasmin Weber");
    expect(evB).not.toContain("Maximilian Muster");
    expect(evB).not.toContain("Espresso");
  });

  it("an application prompt is built solely from that applicant's candidate", () => {
    const p = buildLetterPrompt(promptFor(profile("Maximilian Muster"), {}));
    expect(p).toContain("Maximilian Muster");
    expect(p).not.toContain("Jasmin Weber");
  });
});
