/**
 * AI Bewerbung Studio — no-fabrication contract (Section D).
 *
 * collectVerifiedFacts merges the candidate's real CV + scanner profile +
 * account facts into the ONLY pool a generated CV may draw from.
 * validateGeneratedCv then rejects every generated value that is not
 * grounded there (contacts, education, jobs, skills, languages, dates).
 *
 * These tests pin the guarantee the product promises: the generated CV
 * never invents experience, degrees, certificates or numbers.
 */
import { describe, expect, it } from "vitest";
import {
  collectVerifiedFacts,
  validateGeneratedCv,
  type VerifiedSourceProfile,
} from "@/lib/studio/facts";
import { candidateProfileFixture } from "./helpers";
import type { CandidateProfile } from "@/lib/bewerbung-schema";
import { cvEmpty, type CvDocument } from "@/lib/templates/cv";

const user: VerifiedSourceProfile = {
  fullName: "Mustapha Drif",
  email: "mustapha@example.de",
  phone: "+49 170 1234567",
  location: "Berlin",
  linkedin: "https://linkedin.com/in/mustapha-drif",
};

function baseCv(): CvDocument {
  const cv = cvEmpty();
  cv.personal.fullName = "Mustapha Drif";
  cv.personal.email = "mustapha@example.de";
  cv.personal.phone = "+49 170 1234567";
  cv.personal.location = "Berlin";
  cv.education = [
    {
      id: "e1",
      degree: "Mittlerer Schulabschluss",
      institution: "Gesamtschule Berlin",
      location: "Berlin",
      start: "08/2020",
      end: "06/2024",
      description: "",
    },
  ];
  cv.experience = [
    {
      id: "x1",
      jobTitle: "Mechatroniker (Praktikum)",
      company: "Industrie AG",
      location: "Berlin",
      start: "03/2023",
      end: "08/2023",
      isCurrent: false,
      responsibilities: ["Wartung von Anlagen"],
      achievements: [],
    },
  ];
  cv.skills = ["Wartung", "Teamfähigkeit"];
  cv.languages = [{ id: "l1", language: "German", level: "C1" }];
  return cv;
}

describe("collectVerifiedFacts", () => {
  it("builds pools from CV, profile and user facts", () => {
    const facts = collectVerifiedFacts(baseCv(), candidateProfileFixture() as unknown as CandidateProfile, user);
    expect(facts.name).toBe("Mustapha Drif");
    expect(facts.email).toBe("mustapha@example.de");
    expect(facts.education).toContain("Mittlerer Schulabschluss");
    expect(facts.experience).toContain("Industrie AG");
    expect(facts.skills).toContain("Wartung");
    expect(facts.languages).toContain("German C1");
  });

  it("leaves unknown fields empty (nothing is inferred)", () => {
    const cv = cvEmpty();
    const facts = collectVerifiedFacts(cv, null, null);
    expect(facts.name).toBe("");
    expect(facts.email).toBe("");
    expect(facts.education).toEqual([]);
    expect(facts.experience).toEqual([]);
  });
});

describe("validateGeneratedCv (fact guard)", () => {
  it("accepts a CV that only uses verified facts", () => {
    const facts = collectVerifiedFacts(baseCv(), candidateProfileFixture() as unknown as CandidateProfile, user);
    const violations = validateGeneratedCv(facts, baseCv());
    expect(violations).toEqual([]);
  });

  it("rejects an invented employer", () => {
    const facts = collectVerifiedFacts(baseCv(), null, user);
    const forged = baseCv();
    forged.experience[0].company = "Deutsche Telekom";
    const violations = validateGeneratedCv(facts, forged);
    expect(violations.some((v) => v.field === "experience.company")).toBe(true);
  });

  it("rejects an invented degree", () => {
    const facts = collectVerifiedFacts(baseCv(), null, user);
    const forged = baseCv();
    forged.education[0].degree = "Abitur";
    const violations = validateGeneratedCv(facts, forged);
    expect(violations.some((v) => v.field === "education.degree")).toBe(true);
  });

  it("rejects an invented skill", () => {
    const facts = collectVerifiedFacts(baseCv(), null, user);
    const forged = baseCv();
    forged.skills = ["Wartung", "Kubernetes-Administrator"];
    const violations = validateGeneratedCv(facts, forged);
    expect(violations.some((v) => v.field === "skills" && v.value === "Kubernetes-Administrator")).toBe(true);
  });

  it("rejects a date that never existed in the sources", () => {
    const facts = collectVerifiedFacts(baseCv(), null, user);
    const forged = baseCv();
    forged.experience[0].start = "01/2019";
    const violations = validateGeneratedCv(facts, forged);
    expect(violations.some((v) => v.field === "experience.date" && v.reason === "date_not_in_source")).toBe(true);
  });

  it("rejects an invented contact email (not the user's)", () => {
    const facts = collectVerifiedFacts(baseCv(), null, user);
    const forged = baseCv();
    forged.personal.email = "other@person.de";
    const violations = validateGeneratedCv(facts, forged);
    expect(violations.some((v) => v.field === "personal.email")).toBe(true);
  });

  it("rejects an upgraded language level (C1 → C2)", () => {
    const facts = collectVerifiedFacts(baseCv(), null, user);
    const forged = baseCv();
    forged.languages[0].level = "C2";
    const violations = validateGeneratedCv(facts, forged);
    expect(violations.some((v) => v.field === "languages")).toBe(true);
  });

  it("allows empty generated fields (missing info, never guessed)", () => {
    const facts = collectVerifiedFacts(null, null, user);
    const minimal = cvEmpty();
    minimal.personal.fullName = "Mustapha Drif";
    const violations = validateGeneratedCv(facts, minimal);
    expect(violations).toEqual([]);
  });
});
