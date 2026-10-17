/**
 * Position brief + structured applicant evidence (pure domain logic).
 *
 * These tests pin the data that makes a letter role-specific and evidence-
 * based: per-company overrides resolve over the campaign value (never
 * inventing a role), and the parsed CV is rendered into a readable,
 * bounded evidence section that lists gaps as explicit constraints.
 */
import { describe, expect, it } from "vitest";
import type { CandidateProfile } from "@/lib/bewerbung-schema";
import {
  BEW_EMPLOYER_FACTS_MAX,
  BEW_POSITION_BRIEF_MAX,
  BEW_POSITION_TITLE_MAX,
  buildApplicantEvidence,
  escapeFence,
  resolveLetterPosition,
} from "@/lib/bewerbung-automation";

function profile(over: Partial<CandidateProfile> = {}): CandidateProfile {
  return {
    candidate: {
      full_name: "Max Muster",
      location: "Berlin",
      country: "Deutschland",
      current_location: null,
      target_location: ["Düsseldorf"],
      contact: { email: "max@example.de", phone: "+49 151 0000000", linkedin: null },
    },
    goal: "ausbildung",
    education: [
      {
        school: "Berufsbildende Schule",
        university: null,
        degree: null,
        field_of_study: "Informatik",
        graduation_year: 2026,
        education_level: null,
        source: "ai_extracted",
      },
    ],
    training: [{ name: "IT-Grundbildung", provider: null, year: "2025", source: "ai_extracted" }],
    experience: [
      {
        job_title: "Aushilfe im IT-Support",
        company: "Muster GmbH",
        responsibilities: ["Schulung neuer Mitarbeiter", "Erste-Hilfe-Support"],
        start_date: "2024",
        end_date: "2025",
        type: "internship",
        source: "ai_extracted",
      },
    ],
    skills: {
      technical: ["HTML", "CSS"],
      software_tools: ["VS Code"],
      marketing: [],
      it: ["Python"],
      soft: ["Teamfähigkeit", "Belastbarkeit"],
    },
    languages: [
      { language: "Deutsch", level: "B2", level_is_inferred: false, source: "ai_extracted" },
      { language: "Englisch", level: "C1", level_is_inferred: true, source: "ai_extracted" },
    ],
    preferences: {
      target: "ausbildung",
      preferred_job_titles: ["Fachinformatiker"],
      preferred_industries: [],
      preferred_locations: [],
      willing_to_relocate: true,
      remote_hybrid_preference: null,
    },
    target_roles: [
      { role: "Fachinformatiker für Anwendungsentwicklung", reason: "Interesse an Softwareentwicklung", source: "ai_extracted" },
    ],
    strengths: ["Belastbarkeit"],
    missing_information: ["Zeugnisse fehlen"],
    potential_concerns: ["Kurze Berufserfahrung"],
    keywords: ["IT"],
    ...over,
  } as CandidateProfile;
}

/* ------------------------------------------------------------------ *
 * Position resolution (override → campaign → "" — never invented)
 * ------------------------------------------------------------------ */
describe("resolveLetterPosition", () => {
  const campaign = {
    position_title: "Fachinformatiker",
    position_brief: "Beschreibung aus der Kampagne",
    employer_facts: "Fakten aus der Kampagne",
  };

  it("prefers a per-company override over the campaign value", () => {
    const r = resolveLetterPosition(
      { position_title: "Kaufmann im E-Commerce", position_brief: null, employer_facts: "eigene Fakten" },
      campaign,
    );
    expect(r.title).toBe("Kaufmann im E-Commerce");
    expect(r.brief).toBe("Beschreibung aus der Kampagne"); // not overridden → inherit
    expect(r.employerFacts).toBe("eigene Fakten");
  });

  it("falls back to the campaign when the override is blank or null", () => {
    expect(resolveLetterPosition({ position_title: "  ", position_brief: null, employer_facts: "" }, campaign).title).toBe(
      "Fachinformatiker",
    );
    expect(resolveLetterPosition({}, campaign).title).toBe("Fachinformatiker");
  });

  it("yields an empty role when neither level provides one (no invention)", () => {
    const r = resolveLetterPosition({}, {});
    expect(r).toEqual({ title: "", brief: "", employerFacts: "" });
  });
});

/* ------------------------------------------------------------------ *
 * Data-fence escaping
 * ------------------------------------------------------------------ */
describe("escapeFence", () => {
  it("neutralises marker tokens so data cannot forge a block boundary", () => {
    expect(escapeFence("⟦INJECTED⟧ text ⟦/INJECTED⟧")).toBe("(INJECTED) text (/INJECTED)");
  });
});

/* ------------------------------------------------------------------ *
 * Structured applicant evidence
 * ------------------------------------------------------------------ */
describe("buildApplicantEvidence", () => {
  it("renders the parsed CV: experience, skills, languages, education, target roles", () => {
    const ev = buildApplicantEvidence(profile());
    expect(ev).toContain("Max Muster");
    expect(ev).toContain("Ausbildung");
    expect(ev).toContain("Informatik");
    expect(ev).toContain("Praktikum"); // internship is labelled
    expect(ev).toContain("Schulung neuer Mitarbeiter");
    expect(ev).toContain("Python");
    expect(ev).toContain("Teamfähigkeit");
    expect(ev).toContain("Deutsch: B2");
    expect(ev).toContain("Englisch: C1 (geschätzt)"); // inferred level is marked
    expect(ev).toContain("Fachinformatiker für Anwendungsentwicklung");
    expect(ev).toContain("Interesse an Softwareentwicklung");
    expect(ev).toContain("umzugsbereit");
  });

  it("surfaces gaps and concerns as explicit constraints, not hidden facts", () => {
    const ev = buildApplicantEvidence(profile());
    expect(ev).toContain("EINSCHRÄNKUNGEN");
    expect(ev).toContain("Zeugnisse fehlen");
    expect(ev).toContain("Kurze Berufserfahrung");
  });

  it("does not render an empty section for absent data", () => {
    const sparse = profile({
      experience: [],
      training: [],
      education: [],
      languages: [],
      target_roles: [],
      strengths: [],
      skills: { technical: [], software_tools: [], marketing: [], it: [], soft: [] },
      missing_information: [],
      potential_concerns: [],
    });
    const ev = buildApplicantEvidence(sparse);
    expect(ev).not.toContain("Berufserfahrung / Praktika:");
    expect(ev).not.toContain("EINSCHRÄNKUNGEN");
    // The name + goal are still shown (identity is always available).
    expect(ev).toContain("Max Muster");
    expect(ev).toContain("Ausbildung");
  });

  it("degrades to an explicit placeholder when there is no structured CV", () => {
    expect(buildApplicantEvidence(null)).toContain("Kein strukturierter Lebenslauf");
  });
});

/* ------------------------------------------------------------------ *
 * Field caps (mirror the migration CHECKs)
 * ------------------------------------------------------------------ */
describe("position field caps", () => {
  it("are finite, sane limits", () => {
    expect(BEW_POSITION_TITLE_MAX).toBe(160);
    expect(BEW_POSITION_BRIEF_MAX).toBe(4000);
    expect(BEW_EMPLOYER_FACTS_MAX).toBe(4000);
  });
});
