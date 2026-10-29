/**
 * AI Bewerbung Studio — CV fact-guard (no-fabrication validator).
 *
 * Reproduces the production failure: a fully legitimate model output
 * (year-only source dates, re-formatted phone, normalized language
 * levels) was rejected with "Angaben, die sich nicht aus Ihren Daten
 * ableiten lassen", because the validator compared dates/phones/levels
 * with formatting-sensitive exact rules.
 *
 * Also pins the PROTECTION: genuinely unsupported claims (invented
 * years/months, level inflation, invented skills/contacts) must still
 * be rejected.
 */
import { describe, expect, it } from "vitest";
import {
  collectVerifiedFacts,
  dateTokens,
  validateGeneratedCv,
} from "@/lib/studio/facts";
import { CV_TEMPLATE_IDS, sanitizeCvDocument } from "@/lib/templates/cv";
import type { CvDocument } from "@/lib/templates/cv";

// ---------------------------------------------------------------------------
// Test candidate (mirrors the screenshot profile: year-only German CV dates)
// ---------------------------------------------------------------------------

const BASE_CV: CvDocument = {
  version: 1,
  templateId: "classic",
  personal: {
    fullName: "Mustapha Drif",
    professionalTitle: "",
    email: "mustapha.drif@example.de",
    phone: "+49 151 2345678",
    location: "Berlin",
    linkedin: "https://www.linkedin.com/in/mustaphadrif",
    website: "",
    nationality: "",
    dateOfBirth: "",
    availability: "",
    photo: null,
  },
  summary: "Motivierter Ausbildungskandidat mit Erfahrung im IT-Bereich.",
  education: [
    {
      id: "e1",
      degree: "Abitur",
      institution: "Gymnasium Berlin-Mitte",
      location: "Berlin",
      start: "2019",
      end: "2024",
      description: "",
    },
  ],
  experience: [
    {
      id: "x1",
      jobTitle: "Auszubildender Fachinformatiker",
      company: "Muster AG",
      location: "Berlin",
      start: "2024",
      end: "",
      isCurrent: true,
      responsibilities: ["Pflege von Webanwendungen"],
      achievements: [],
    },
  ],
  skills: ["JavaScript", "SQL", "Teamwork"],
  languages: [
    { id: "l1", language: "Deutsch", level: "Muttersprache" },
    { id: "l2", language: "Englisch", level: "C1" },
  ],
  certificates: [],
  projects: [],
  interests: [],
};

/** What the model actually returns: same facts, standard German formatting
 *  (month/year date style, domestic phone style, CEFR level letters). */
function generatedVariant(over: {
  phone?: string;
  eduStart?: string;
  eduEnd?: string;
  expStart?: string;
  deLevel?: string;
  enLevel?: string;
} = {}): CvDocument {
  const doc = JSON.parse(JSON.stringify(BASE_CV)) as CvDocument;
  if (over.phone !== undefined) doc.personal.phone = over.phone;
  if (over.eduStart !== undefined) doc.education[0].start = over.eduStart;
  if (over.eduEnd !== undefined) doc.education[0].end = over.eduEnd;
  if (over.expStart !== undefined) doc.experience[0].start = over.expStart;
  if (over.deLevel !== undefined) doc.languages[0].level = over.deLevel;
  if (over.enLevel !== undefined) doc.languages[1].level = over.enLevel;
  return doc;
}

const facts = collectVerifiedFacts(sanitizeCvDocument(BASE_CV), null, null);

// ---------------------------------------------------------------------------
// The production failure: legitimate formatting differences, no invention
// ---------------------------------------------------------------------------

describe("fact guard — legitimate outputs must PASS (regression)", () => {
  it("accepts month-precision dates when the source only has years", () => {
    // source: "2019" / "2024" (year-only) → model writes "09/2019" / "07/2024"
    const v = validateGeneratedCv(
      facts,
      generatedVariant({ eduStart: "09/2019", eduEnd: "07/2024", expStart: "08/2024" }),
    );
    expect(v, JSON.stringify(v)).toEqual([]);
  });

  it("accepts a re-formatted phone (international ↔ domestic German)", () => {
    // source: "+49 151 2345678" → model writes "0151 2345678"
    expect(validateGeneratedCv(facts, generatedVariant({ phone: "0151 2345678" }))).toEqual([]);
    // and the other direction
    expect(validateGeneratedCv(facts, generatedVariant({ phone: "+49 151 2345 678" }))).toEqual([]);
  });

  it("accepts normalized language levels (same or weaker claim)", () => {
    // "Muttersprache" → "C2" (weaker, entailed) and "C1" → "Verhandlungssicher" (equal)
    const v = validateGeneratedCv(facts, generatedVariant({ deLevel: "C2", enLevel: "Verhandlungssicher" }));
    expect(v, JSON.stringify(v)).toEqual([]);
  });

  it("accepts the base CV itself unchanged (template round-trip)", () => {
    for (const templateId of CV_TEMPLATE_IDS) {
      const doc = { ...sanitizeCvDocument(BASE_CV), templateId } as CvDocument;
      expect(validateGeneratedCv(facts, doc), templateId).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// Protection: genuine inventions must still FAIL
// ---------------------------------------------------------------------------

describe("fact guard — genuine fabrications must be REJECTED (protection kept)", () => {
  it("rejects an invented year", () => {
    const v = validateGeneratedCv(facts, generatedVariant({ eduStart: "2017" }));
    expect(v.some((x) => x.reason === "date_not_in_source" && x.value.includes("2017"))).toBe(true);
  });

  it("rejects an invented month when the source has month precision", () => {
    const monthSource = JSON.parse(JSON.stringify(BASE_CV)) as CvDocument;
    monthSource.education[0] = { ...monthSource.education[0], start: "09/2019", end: "07/2024" };
    const monthFacts = collectVerifiedFacts(monthSource, null, null);
    const generated = JSON.parse(JSON.stringify(generatedVariant({ eduStart: "10/2019" }))) as CvDocument;
    const v = validateGeneratedCv(monthFacts, generated);
    expect(v.some((x) => x.reason === "date_not_in_source" && x.value.includes("10/2019"))).toBe(true);
  });

  it("rejects language level inflation (source A2 → generated C1)", () => {
    const weak = JSON.parse(JSON.stringify(BASE_CV)) as CvDocument;
    weak.languages[1] = { id: "l2", language: "Englisch", level: "Grundkenntnisse" };
    const weakFacts = collectVerifiedFacts(weak, null, null);
    const generated = generatedVariant({ enLevel: "C1" });
    const v = validateGeneratedCv(weakFacts, generated);
    expect(v.some((x) => x.field === "languages")).toBe(true);
  });

  it("rejects an invented skill, contact and name", () => {
    const doc = generatedVariant();
    doc.skills.push("Piano");
    doc.personal.email = "someone-else@example.de";
    doc.personal.fullName = "Ergänzt Person";
    const v = validateGeneratedCv(facts, doc);
    expect(v.some((x) => x.field === "skills" && x.value === "Piano")).toBe(true);
    expect(v.some((x) => x.field === "personal.email")).toBe(true);
    expect(v.some((x) => x.field === "personal.fullName")).toBe(true);
  });

  it("rejects a different phone number", () => {
    const v = validateGeneratedCv(facts, generatedVariant({ phone: "0170 999 888 77" }));
    expect(v.some((x) => x.field === "personal.phone")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// dateTokens sanity (shared normalization)
// ---------------------------------------------------------------------------

describe("dateTokens", () => {
  it("extracts years and month tokens", () => {
    expect([...dateTokens("09/2019 – 07/2024")].sort()).toEqual(["m07", "m09", "y2019", "y2024"]);
    expect([...dateTokens("september 2022")].sort()).toEqual(["mseptember", "y2022"]);
    expect(dateTokens("heute").size).toBe(0);
  });
});
