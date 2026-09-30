import { describe, expect, it } from "vitest";
import { candidateProfileSchema } from "@/lib/bewerbung-schema";
import {
  cvEmpty,
  cvHasContent,
  importCandidateProfileToCv,
  moveEntry,
  removeEntry,
  sanitizeCvDocument,
  type CvDocument,
} from "@/lib/templates/cv";

/**
 * Templates / CV Builder — pure model tests.
 *
 * Covers the data layer behind the "Professional Classic" template:
 *   - factories + content detection (empty states)
 *   - reorder/remove helpers (bounded, immutable)
 *   - defensive localStorage sanitization (corrupt storage must never
 *     crash the builder)
 *   - the profile→CV import contract: map what EXISTS in a scanner
 *     CandidateProfile, invent nothing, keep missing fields empty.
 */

// ---------------------------------------------------------------------------
// Factories + content detection
// ---------------------------------------------------------------------------

describe("cvEmpty / cvHasContent", () => {
  it("starts a document with all sections empty", () => {
    const cv = cvEmpty();
    expect(cv.version).toBe(1);
    expect(cv.personal.fullName).toBe("");
    expect(cv.personal.photo).toBeNull();
    expect(cv.summary).toBe("");
    expect(cv.education).toEqual([]);
    expect(cv.experience).toEqual([]);
    expect(cv.skills).toEqual([]);
    expect(cv.languages).toEqual([]);
    expect(cv.certificates).toEqual([]);
    expect(cv.projects).toEqual([]);
    expect(cv.interests).toEqual([]);
  });

  it("reports no content for a fresh document", () => {
    expect(cvHasContent(cvEmpty())).toBe(false);
  });

  it("detects content in each section kind", () => {
    expect(cvHasContent({ ...cvEmpty(), personal: { ...cvEmpty().personal, fullName: "A" } })).toBe(true);
    expect(cvHasContent({ ...cvEmpty(), summary: "  " })).toBe(false);
    expect(cvHasContent({ ...cvEmpty(), summary: "Motivated." })).toBe(true);
    expect(cvHasContent({ ...cvEmpty(), skills: ["Excel"] })).toBe(true);
    expect(cvHasContent({ ...cvEmpty(), skills: ["   "] })).toBe(false);
    expect(
      cvHasContent({
        ...cvEmpty(),
        languages: [{ id: "1", language: "", level: "B2" }],
      }),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Reorder / remove helpers
// ---------------------------------------------------------------------------

describe("moveEntry / removeEntry", () => {
  const list = ["a", "b", "c"];

  it("moves entries up and down", () => {
    expect(moveEntry(list, 1, -1)).toEqual(["b", "a", "c"]);
    expect(moveEntry(list, 1, 1)).toEqual(["a", "c", "b"]);
  });

  it("does not mutate the source list", () => {
    const before = list.join("");
    moveEntry(list, 0, 1);
    expect(list.join("")).toBe(before);
  });

  it("is a no-op (same reference) out of bounds", () => {
    expect(moveEntry(list, -1, 1)).toBe(list);
    expect(moveEntry(list, 3, -1)).toBe(list);
    expect(moveEntry(list, 0, -1)).toBe(list);
    expect(moveEntry(list, 2, 1)).toBe(list);
    expect(moveEntry([], 0, 1)).toEqual([]);
  });

  it("removes an entry and is a no-op out of bounds", () => {
    expect(removeEntry(list, 1)).toEqual(["a", "c"]);
    expect(removeEntry(list, -1)).toBe(list);
    expect(removeEntry(list, 3)).toBe(list);
  });
});

// ---------------------------------------------------------------------------
// Defensive storage sanitization
// ---------------------------------------------------------------------------

describe("sanitizeCvDocument", () => {
  it("rejects non-object input (corrupt storage)", () => {
    expect(sanitizeCvDocument(null)).toBeNull();
    expect(sanitizeCvDocument("text")).toBeNull();
    expect(sanitizeCvDocument(42)).toBeNull();
    expect(sanitizeCvDocument(["array"])).toBeNull();
  });

  it("fills a bare object with valid defaults", () => {
    const doc = sanitizeCvDocument({});
    expect(doc).not.toBeNull();
    if (!doc) return;
    expect(doc.version).toBe(1);
    expect(doc.personal.photo).toBeNull();
    expect(doc.education).toEqual([]);
    expect(doc.experience).toEqual([]);
  });

  it("keeps valid values and drops malformed entries", () => {
    const doc = sanitizeCvDocument({
      personal: { fullName: "M. Drif", photo: "http://evil.example/x.png" },
      summary: 123,
      education: [{ degree: "Abitur" }, "garbage", null],
      experience: [
        { jobTitle: "Auszubildender", responsibilities: "not-an-array" },
        "also-garbage",
      ],
      skills: ["SEO", 7, "Excel"],
      languages: [{ language: "Deutsch", level: "B1" }, 42],
      certificates: [{ name: "Führerschein" }],
      projects: [{ name: "Shop" }],
      interests: ["Fußball", true],
    });
    expect(doc).not.toBeNull();
    if (!doc) return;
    // photo: only data URLs are accepted — remote URLs are rejected
    expect(doc.personal.photo).toBeNull();
    expect(doc.summary).toBe("");
    expect(doc.education).toHaveLength(1);
    expect(doc.education[0].degree).toBe("Abitur");
    expect(typeof doc.education[0].id).toBe("string");
    // experience without a responsibilities array gets one empty bullet
    expect(doc.experience).toHaveLength(1);
    expect(doc.experience[0].responsibilities).toEqual([""]);
    expect(doc.skills).toEqual(["SEO", "Excel"]);
    expect(doc.languages.map(({ language, level }) => ({ language, level }))).toEqual([
      { language: "Deutsch", level: "B1" },
    ]);
    expect(doc.certificates).toHaveLength(1);
    expect(doc.projects).toHaveLength(1);
    expect(doc.interests).toEqual(["Fußball"]);
  });

  it("accepts a data-URL photo", () => {
    const photo = "data:image/png;base64,iVBORw0KGgo=";
    const doc = sanitizeCvDocument({ personal: { photo } });
    expect(doc?.personal.photo).toBe(photo);
  });

  it("round-trips a full document through JSON", () => {
    const doc: CvDocument = {
      ...cvEmpty(),
      personal: { ...cvEmpty().personal, fullName: "A", email: "a@b.c" },
      summary: "S",
      education: [
        { id: "e1", degree: "D", institution: "I", location: "L", start: "2020", end: "2024", description: "" },
      ],
      experience: [
        { id: "x1", jobTitle: "J", company: "C", location: "", start: "03/2024", end: "", isCurrent: true, responsibilities: ["r1"], achievements: [] },
      ],
      skills: ["SEO"],
      languages: [{ id: "l1", language: "Englisch", level: "B2" }],
      interests: ["Fußball"],
    };
    const restored = sanitizeCvDocument(JSON.parse(JSON.stringify(doc)));
    expect(restored).toEqual(doc);
  });
});

// ---------------------------------------------------------------------------
// Profile import (Bewerbung Scanner CandidateProfile → CV)
// ---------------------------------------------------------------------------

const REALISTIC_PROFILE = {
  goal: "ausbildung",
  candidate: {
    full_name: "Mustafa Drif",
    location: "Köln",
    country: "Deutschland",
    current_location: null,
    target_location: ["Berlin"],
    contact: {
      email: "mustafa.drif@example.com",
      phone: "+49 151 2345678",
      linkedin: "https://linkedin.com/in/mustafa-drif",
    },
  },
  education: [
    {
      school: "Berufskolleg am Schloss",
      university: null,
      degree: "Fachhochschulreife",
      field_of_study: "Wirtschaft",
      graduation_year: 2023,
    },
    {
      school: null,
      university: "FOM Hochschule",
      degree: null,
      field_of_study: null,
      graduation_year: null,
    },
  ],
  training: [
    {
      name: "Ausbildung zum E-Commerce-Spezialisten",
      provider: "Muster GmbH",
      year: "2023",
    },
  ],
  experience: [
    {
      job_title: "Auszubildender E-Commerce",
      company: "Muster GmbH",
      responsibilities: ["Betreuung der Online-Shops", "Pflege der Listings"],
      start_date: "03/2024",
      end_date: null,
    },
    {
      job_title: "Praktikant Online-Marketing",
      company: "Klein & Partner",
      responsibilities: ["Unterstützung bei SEA-Kampagnen"],
      start_date: "06/2023",
      end_date: "11/2023",
    },
  ],
  skills: {
    technical: ["Digital Marketing", "SEO"],
    software_tools: ["Excel", "SEO"],
    marketing: ["Google Ads", "Meta Ads"],
    it: [],
    soft: ["Zuverlässigkeit"],
  },
  languages: [
    { language: "Deutsch", level: "B1" },
    { language: "Englisch", level: "B2" },
    { language: "Arabisch", level: "Muttersprache" },
  ],
  target_roles: [
    { role: "E-Commerce-Auszubildende(r)", reason: "Ausbildung in Muster GmbH" },
    { role: "Online-Marketing-Fachkraft", reason: "Praktikumserfahrung" },
  ],
};

function parseProfile() {
  const parsed = candidateProfileSchema.parse(REALISTIC_PROFILE);
  return parsed;
}

describe("importCandidateProfileToCv", () => {
  it("maps personal data from the candidate block", () => {
    const cv = importCandidateProfileToCv(parseProfile());
    expect(cv.personal.fullName).toBe("Mustafa Drif");
    expect(cv.personal.email).toBe("mustafa.drif@example.com");
    expect(cv.personal.phone).toBe("+49 151 2345678");
    expect(cv.personal.linkedin).toBe("https://linkedin.com/in/mustafa-drif");
    expect(cv.personal.location).toBe("Köln");
  });

  it("uses the first target role as the professional title", () => {
    const cv = importCandidateProfileToCv(parseProfile());
    expect(cv.personal.professionalTitle).toBe("E-Commerce-Auszubildende(r)");
  });

  it("maps education entries (school/university → institution, degree+field joined, year → end)", () => {
    const cv = importCandidateProfileToCv(parseProfile());
    expect(cv.education).toHaveLength(2);
    expect(cv.education[0]).toMatchObject({
      degree: "Fachhochschulreife, Wirtschaft",
      institution: "Berufskolleg am Schloss",
      end: "2023",
    });
    expect(cv.education[1]).toMatchObject({
      institution: "FOM Hochschule",
      end: "",
    });
  });

  it("maps experience entries and flags ongoing jobs as current", () => {
    const cv = importCandidateProfileToCv(parseProfile());
    expect(cv.experience).toHaveLength(2);
    expect(cv.experience[0]).toMatchObject({
      jobTitle: "Auszubildender E-Commerce",
      company: "Muster GmbH",
      start: "03/2024",
      end: "",
      isCurrent: true,
      responsibilities: ["Betreuung der Online-Shops", "Pflege der Listings"],
      achievements: [],
    });
    expect(cv.experience[1]).toMatchObject({
      jobTitle: "Praktikant Online-Marketing",
      start: "06/2023",
      end: "11/2023",
      isCurrent: false,
    });
  });

  it("flattens and dedupes skills across all groups", () => {
    const cv = importCandidateProfileToCv(parseProfile());
    expect(cv.skills).toEqual([
      "Digital Marketing",
      "SEO",
      "Excel",
      "Google Ads",
      "Meta Ads",
      "Zuverlässigkeit",
    ]);
  });

  it("maps languages and training→certificates", () => {
    const cv = importCandidateProfileToCv(parseProfile());
    expect(cv.languages.map(({ language, level }) => ({ language, level }))).toEqual([
      { language: "Deutsch", level: "B1" },
      { language: "Englisch", level: "B2" },
      { language: "Arabisch", level: "Muttersprache" },
    ]);
    expect(cv.languages.every((l) => typeof l.id === "string" && l.id.length > 0)).toBe(true);
    expect(cv.certificates).toHaveLength(1);
    expect(cv.certificates[0]).toMatchObject({
      name: "Ausbildung zum E-Commerce-Spezialisten",
      issuer: "Muster GmbH",
      date: "2023",
    });
  });

  it("never invents summary, projects or interests", () => {
    const cv = importCandidateProfileToCv(parseProfile());
    expect(cv.summary).toBe("");
    expect(cv.projects).toEqual([]);
    expect(cv.interests).toEqual([]);
    expect(cv.personal.photo).toBeNull();
    expect(cv.personal.website).toBe("");
    expect(cv.personal.nationality).toBe("");
    expect(cv.personal.dateOfBirth).toBe("");
    expect(cv.personal.availability).toBe("");
  });

  it("handles an empty profile without crashing", () => {
    const empty = candidateProfileSchema.parse({ goal: "arbeit" });
    const cv = importCandidateProfileToCv(empty);
    expect(cv.personal.fullName).toBe("");
    expect(cv.education).toEqual([]);
    expect(cv.experience).toEqual([]);
    expect(cv.skills).toEqual([]);
    expect(cv.languages).toEqual([]);
    expect(cv.certificates).toEqual([]);
  });
});
