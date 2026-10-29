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
import { CV_TEMPLATE_IDS, cvEmpty, sanitizeCvDocument } from "@/lib/templates/cv";
import type { CvDocument } from "@/lib/templates/cv";
import type { CandidateProfile } from "@/lib/bewerbung-schema";

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
// Production incident (2nd round): the candidate's OWN verified identity
// (fullName / email / phone) was rejected whenever the browser CV's personal
// section DISAGREES with the scanner profile. The model only SEES the
// profile's contacts (formatCvForPrompt omits the CV's), so its faithful
// output must be accepted against ANY verified source.
// ---------------------------------------------------------------------------

const PROFILE_CANDIDATE = {
  candidate: {
    full_name: "Mustapha Drif",
    location: "Berlin",
    country: "Deutschland",
    contact: { email: "mustapha.drif@example.de", phone: "+49 151 2345678" },
  },
} as unknown as CandidateProfile;

const staleCv = (): CvDocument => {
  const cv = JSON.parse(JSON.stringify(BASE_CV)) as CvDocument;
  cv.personal.fullName = "M. Drif";
  cv.personal.email = "old.person@example.de";
  cv.personal.phone = "+49 170 1234567";
  return cv;
};

describe("identity: the candidate's own verified values are accepted", () => {
  // CV and profile are BOTH the candidate's own verified data, but they
  // disagree (stale CV personal section). The model echoes the profile —
  // the only identity it can see.
  const facts = collectVerifiedFacts(sanitizeCvDocument(staleCv()), PROFILE_CANDIDATE, null);

  it("accepts faithful output echoing the PROFILE identity (re-formatted phone included)", () => {
    // BASE_CV personal === profile identity; phone written domestic-style
    const v = validateGeneratedCv(facts, generatedVariant({ phone: "0151 2345678" }));
    expect(v, JSON.stringify(v)).toEqual([]);
  });

  it("accepts the CV-side identity too (any verified source is grounded)", () => {
    const v = validateGeneratedCv(facts, sanitizeCvDocument(staleCv())!);
    expect(v, JSON.stringify(v)).toEqual([]);
  });

  it("still rejects a name/email/phone present in NEITHER source", () => {
    const generated = generatedVariant();
    generated.personal.fullName = "Ergänzt Person";
    generated.personal.email = "nobody@unknown.de";
    generated.personal.phone = "0170 999 888 77";
    const v = validateGeneratedCv(facts, generated);
    expect(v.map((x) => x.field).sort()).toEqual(["personal.email", "personal.fullName", "personal.phone"]);
  });

  it("rejects generated identity when NO source has one (no-fabrication kept)", () => {
    const f = collectVerifiedFacts(cvEmpty(), { candidate: {} } as unknown as CandidateProfile, null);
    const v = validateGeneratedCv(f, generatedVariant());
    for (const field of ["personal.fullName", "personal.email", "personal.phone"]) {
      expect(v.some((x) => x.field === field), field).toBe(true);
    }
  });

  it("email: case and whitespace variants of a verified address are equivalent", () => {
    const f = collectVerifiedFacts(sanitizeCvDocument(BASE_CV), null, null);
    for (const email of ["MUSTAPHA.DRIF@example.de", "mustapha.drif @ example.de "]) {
      const g = generatedVariant();
      g.personal.email = email;
      expect(validateGeneratedCv(f, g).some((x) => x.field === "personal.email"), email).toBe(false);
    }
    const g = generatedVariant();
    g.personal.email = "mustapha.drif@other-domain.de";
    expect(validateGeneratedCv(f, g).some((x) => x.field === "personal.email")).toBe(true);
  });

  it("phone: local ↔ international equivalence for non-DE country codes (+212)", () => {
    const src = cvEmpty();
    src.personal.phone = "+212 612 345 678";
    const f = collectVerifiedFacts(src, null, null);
    const ok = cvEmpty();
    ok.personal.phone = "0612 345 678";
    expect(validateGeneratedCv(f, ok).some((x) => x.field === "personal.phone")).toBe(false);
    const bad = cvEmpty();
    bad.personal.phone = "0699 888 777";
    expect(validateGeneratedCv(f, bad).some((x) => x.field === "personal.phone")).toBe(true);
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
