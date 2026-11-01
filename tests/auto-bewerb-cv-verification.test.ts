/**
 * AUTO BEWERB — exhaustive requirement coverage (cv-verification.ts).
 *
 * The deterministic layer behind the pre-export guarantee: EVERY
 * requirement of the ad is collected (no per-list cap), matched against
 * the final CV section by section, and reported (present / in which
 * section / auto-added from the ad / gap). Honesty: level gaps and
 * missing languages are reported, never "covered" or invented.
 */
import { describe, expect, it } from "vitest";
import { adExtractSchema, type AdExtract } from "@/lib/studio/schema";
import { cvEmpty, type CvDocument } from "@/lib/templates/cv";
import {
  CV_SECTION_LABELS,
  collectAddableSkillTerms,
  collectAdRequirements,
  isTermCoveredInCv,
  looksLikeEducationClaim,
  normalizeTerm,
  parseLanguageRequirement,
  termDedupeKey,
  termInText,
  verifyCvAgainstAd,
} from "@/lib/auto-bewerb/cv-verification";

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

const extractOf = (partial: Partial<AdExtract>): AdExtract =>
  adExtractSchema.parse(partial);

const cvWith = (patch: Partial<CvDocument>): CvDocument => ({
  ...cvEmpty(),
  ...patch,
});

/* ------------------------------------------------------------------ */
/* Term normalization (symbol-aware)                                   */
/* ------------------------------------------------------------------ */

describe("normalizeTerm / termDedupeKey — symbol-aware de-duplication", () => {
  it("keeps symbols: C, C++ and C# are DISTINCT terms (no false merge)", () => {
    expect(termDedupeKey("C")).not.toBe(termDedupeKey("C++"));
    expect(termDedupeKey("C++")).not.toBe(termDedupeKey("C#"));
    expect(termDedupeKey("C")).not.toBe(termDedupeKey("C#"));
  });

  it("still merges German compound variants (hyphen/space/case/ß/umlaut)", () => {
    expect(termDedupeKey("Netzwerktechnik")).toBe(termDedupeKey("Netzwerk-Technik"));
    expect(termDedupeKey("Netzwerk-Technik")).toBe(termDedupeKey("netzwerk technik"));
    expect(termDedupeKey("MS Excel")).toBe(termDedupeKey("ms-excel"));
    expect(termDedupeKey("Großes Können")).toBe(termDedupeKey("grosses konnen"));
  });

  it("distinct terms that differ in a word never merge", () => {
    expect(termDedupeKey("Excel")).not.toBe(termDedupeKey("MS Excel"));
    expect(termDedupeKey("SEO")).not.toBe(termDedupeKey("SEOOptimierung"));
  });
});

/* ------------------------------------------------------------------ */
/* termInText — word-based, German-compound-aware matching             */
/* ------------------------------------------------------------------ */

describe("termInText — matching without false positives", () => {
  it("matches full words (case/diacritic insensitive)", () => {
    expect(termInText("Teamfähigkeit", "Teamarbeit, Teamfähigkeit und mehr")).toBe(true);
    expect(termInText("teamfaehigkeit", "TEAMFAEHIGKEIT")).toBe(true);
  });

  it("multi-word terms require ALL words (order free)", () => {
    expect(termInText("Leseverständnis von Schaltplänen", "Schaltpläne lesen; Leseverständnis von Diagrammen")).toBe(true);
    expect(termInText("Leseverständnis von Schaltplänen", "Leseverständnis von Diagrammen")).toBe(false);
  });

  it("inflected forms match by stem (analytisches ≡ analytischem; distinct traits never merge)", () => {
    expect(termInText("Analytisches Denken", "analytischem Denken")).toBe(true);
    expect(termInText("Kommunikationsfähigkeit", "Kommunikation")).toBe(true);
    // "Teamfähigkeit" vs "Teamarbeit" — common prefix only 4 chars → NO match.
    expect(termInText("Teamfähigkeit", "Teamarbeit")).toBe(false);
  });

  it("German compounds: an edge (≥ 4 chars) of a section word counts", () => {
    expect(termInText("Netzwerk", "Netzwerktechnik")).toBe(true);
    expect(termInText("Netzwerktechnik", "Netzwerktechnik und Linux")).toBe(true);
    // …but a word that is NOT an edge never matches an inner substring.
    expect(termInText("werk", "Netzwerktechnik")).toBe(false);
    expect(termInText("python", "TypeScript-Grundlagen")).toBe(false);
  });

  it("short terms need the full word (no 2–3 char false positives)", () => {
    expect(termInText("C", "C++ und C#")).toBe(false); // "c" is not a word of "c++"
    expect(termInText("C", "C, C++ und C#")).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* collectAdRequirements — exhaustive, no caps                         */
/* ------------------------------------------------------------------ */

describe("collectAdRequirements — every requirement dimension, no sampling", () => {
  it("collects ALL entries from ALL dimensions (40+40+30+30+20+edu+5)", () => {
    const extract = extractOf({
      technicalSkills: Array.from({ length: 40 }, (_, i) => `Tech ${i}`),
      softSkills: Array.from({ length: 40 }, (_, i) => `Soft ${i}`),
      requiredQualifications: Array.from({ length: 30 }, (_, i) => `Req ${i}`),
      preferredQualifications: Array.from({ length: 30 }, (_, i) => `Pref ${i}`),
      languageRequirements: Array.from({ length: 20 }, (_, i) => `Sprache ${i}`),
      educationRequirement: "Fachhochschulreife",
      requestedDocuments: ["Zeugnisse", "Anschreiben", "Lebenslauf", "Fotos", "Kopien"],
    });
    const reqs = collectAdRequirements(extract);
    expect(reqs.length).toBe(40 + 40 + 30 + 30 + 20 + 1 + 5);
    const preferred = reqs.filter((r) => r.preferred);
    expect(preferred).toHaveLength(30);
    expect(reqs.filter((r) => r.category === "education")).toHaveLength(1);
    expect(reqs.filter((r) => r.category === "document")).toHaveLength(5);
  });

  it("empty dimensions contribute nothing (no phantom requirements)", () => {
    expect(collectAdRequirements(extractOf({ company: "X" }))).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* Ad-term classification (what may be auto-added to skills)           */
/* ------------------------------------------------------------------ */

describe("collectAddableSkillTerms — skill-like only; claims stay reported", () => {
  const extract = extractOf({
    technicalSkills: ["SEO", "Google Ads", "Excel"],
    softSkills: ["Teamfähigkeit", "Kommunikationsfähigkeit"],
    requiredQualifications: [
      "Realschulabschluss",
      "Fachabitur mit guter Note",
      "2 Jahre Berufserfahrung",
      "mindestens 12 Monate Praxis",
      "Führerschein Klasse B",
      "Kundenkontakt",
    ],
    preferredQualifications: ["Englischkenntnisse", "SEO"],
    languageRequirements: ["Deutsch C1"],
    educationRequirement: "Mittlere Reife",
  });
  const addable = collectAddableSkillTerms(extract);

  it("adds skill-like terms (technical, soft, license, customer contact)", () => {
    for (const term of ["SEO", "Google Ads", "Excel", "Teamfähigkeit", "Kommunikationsfähigkeit", "Führerschein Klasse B", "Kundenkontakt"]) {
      expect(addable, `missing ${term}`).toContain(term);
    }
  });

  it("NEVER auto-adds education claims (degrees/schools)", () => {
    expect(addable).not.toContain("Realschulabschluss");
    expect(addable).not.toContain("Fachabitur mit guter Note");
    expect(looksLikeEducationClaim("Mittlere Reife")).toBe(true);
    expect(looksLikeEducationClaim("Bachelor-Abschluss")).toBe(true);
  });

  it("NEVER auto-adds experience claims (years/months of experience)", () => {
    expect(addable).not.toContain("2 Jahre Berufserfahrung");
    expect(addable).not.toContain("mindestens 12 Monate Praxis");
  });

  it("de-duplicates variants (SEO appears once) and never adds languages", () => {
    expect(addable.filter((t) => termDedupeKey(t) === termDedupeKey("SEO"))).toHaveLength(1);
    expect(addable).not.toContain("Deutsch C1");
  });
});

/* ------------------------------------------------------------------ */
/* parseLanguageRequirement — language + level                         */
/* ------------------------------------------------------------------ */

describe("parseLanguageRequirement", () => {
  it("parses CEFR levels with fillers", () => {
    expect(parseLanguageRequirement("Deutsch C1")).toEqual({ language: "deutsch", level: "C1" });
    expect(parseLanguageRequirement("Englisch (mind. B1)")).toEqual({ language: "englisch", level: "B1" });
    expect(parseLanguageRequirement("Französisch auf mindestens Niveau B2")).toEqual({ language: "franzosisch", level: "B2" });
  });

  it("parses non-CEFR level phrases; keeps a level-less requirement level-free", () => {
    expect(parseLanguageRequirement("Spanisch Grundkenntnisse")).toEqual({ language: "spanisch", level: "grundkenntnisse" });
    // the stored name is normalized (diacritic-free) — matching is
    // case/diacritic-insensitive anyway (see matchLanguageRequirement).
    expect(parseLanguageRequirement("Türkisch")).toEqual({ language: "turkisch", level: null });
  });
});

/* ------------------------------------------------------------------ */
/* verifyCvAgainstAd — the report                                      */
/* ------------------------------------------------------------------ */

describe("verifyCvAgainstAd — per-requirement report", () => {
  const extract = extractOf({
    company: "Nord Media GmbH",
    jobTitle: "Auszubildende:r Webdesign",
    technicalSkills: ["SEO", "Google Ads", "Excel"],
    softSkills: ["Teamfähigkeit", "Analytisches Denken"],
    languageRequirements: ["Deutsch C1", "Englisch C2"],
    educationRequirement: "Abitur",
    requestedDocuments: ["letzte Zeugnisse"],
  });

  const cv: CvDocument = cvWith({
    summary: "Webdesign-Interesse mit Teamfähigkeit und analytischem Denken.",
    skills: ["SEO", "Google Ads", "MS Excel", "Teamfähigkeit"],
    languages: [
      { id: "l1", language: "Deutsch", level: "C1" },
      { id: "l2", language: "Englisch", level: "B2" },
    ],
    education: [{ id: "e1", degree: "Allgemeine Hochschulreife (Abitur)", institution: "Gesamtschule", location: "", start: "", end: "2025", description: "" }],
    experience: [],
  });

  it("reports EVERY requirement with its section", () => {
    const report = verifyCvAgainstAd({ cv, extract });
    expect(report.total).toBe(3 + 2 + 2 + 1 + 1); // tech + soft + lang + edu + docs
    const byReq = new Map(report.items.map((i) => [i.requirement, i]));
    expect(byReq.get("SEO")?.section).toBe(CV_SECTION_LABELS.skills);
    expect(byReq.get("Analytisches Denken")?.section).toBe(CV_SECTION_LABELS.summary); // compound edge
    expect(byReq.get("Abitur")?.section).toBe(CV_SECTION_LABELS.education);
    expect(byReq.get("Deutsch C1")?.status).toBe("covered");
    expect(byReq.get("letzte Zeugnisse")?.status).toBe("info");
  });

  it("flags language LEVEL GAPS as partial (never covered, never invented)", () => {
    const report = verifyCvAgainstAd({ cv, extract });
    const en = report.items.find((i) => i.requirement === "Englisch C2")!;
    expect(en.status).toBe("partial");
    expect(en.section).toBe(CV_SECTION_LABELS.languages);
    expect(en.detail).toContain("C2");
    expect(en.detail).toContain("B2");
    expect(report.allCovered).toBe(false);
  });

  it("missing language = missing (the level is never fabricated)", () => {
    const cvNoEnglish = cvWith({ ...cv, languages: [{ id: "l1", language: "Deutsch", level: "C1" }] });
    const report = verifyCvAgainstAd({ cv: cvNoEnglish, extract });
    const en = report.items.find((i) => i.requirement === "Englisch C2")!;
    expect(en.status).toBe("missing");
    expect(en.section).toBeNull();
  });

  it("marks auto-added ad requirements (cv.tailoring.addedFromAd)", () => {
    const flagged = cvWith({ ...cv, skills: [...cv.skills, "Kundenkontakt"], tailoring: { addedFromAd: ["Kundenkontakt"] } });
    const extract2 = extractOf({ ...extract.technicalSkills, softSkills: [...extract.softSkills, "Kundenkontakt"] });
    const report = verifyCvAgainstAd({ cv: flagged, extract: extract2 });
    const item = report.items.find((i) => i.requirement === "Kundenkontakt")!;
    expect(item.addedFromAd).toBe(true);
    expect(report.addedFromAd).toContain("Kundenkontakt");
  });

  it("allCovered: preferred + document items never block; missing hard items do", () => {
    const okExtract = extractOf({
      technicalSkills: ["SEO"],
      preferredQualifications: ["Kreativität"], // preferred only → never blocks
      requestedDocuments: ["Zeugnisse"], // documents → never blocks
    });
    const okCv = cvWith({ skills: ["SEO"] });
    expect(verifyCvAgainstAd({ cv: okCv, extract: okExtract }).allCovered).toBe(true);

    const badCv = cvWith({ skills: ["Nichts Passendes"] });
    expect(verifyCvAgainstAd({ cv: badCv, extract: okExtract }).allCovered).toBe(false);
  });

  it("a null extract yields an empty (allCovered) report", () => {
    const report = verifyCvAgainstAd({ cv, extract: null });
    expect(report.total).toBe(0);
    expect(report.allCovered).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* isTermCoveredInCv — the merge's duplication guard                   */
/* ------------------------------------------------------------------ */

describe("isTermCoveredInCv — covered anywhere ⇒ not duplicated into skills", () => {
  it("true when the term is a skill", () => {
    expect(isTermCoveredInCv("Excel", cvWith({ skills: ["MS Excel", "Excel"] }))).toBe(true);
  });

  it("true when the term only appears in experience text (no skills duplicate)", () => {
    const cv = cvWith({
      skills: [],
      experience: [
        {
          id: "x1",
          jobTitle: "Shop-Verkäufer",
          company: "Mode GmbH",
          location: "",
          start: "2024",
          end: "2025",
          isCurrent: false,
          responsibilities: ["Kundenberatung und Kassenabrechnung"],
          achievements: [],
        },
      ],
    });
    expect(isTermCoveredInCv("Kundenberatung", cv)).toBe(true);
    expect(isTermCoveredInCv("Führerschein Klasse B", cv)).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* normalizeTerm basics (shared with the grounding corpus)             */
/* ------------------------------------------------------------------ */

describe("normalizeTerm", () => {
  it("is case/diacritic/whitespace insensitive and keeps digits+symbols", () => {
    expect(normalizeTerm("  Google   ADS ")).toBe("google ads");
    // NFD decomposition: Ä → A + combining diaeresis → removed ("ahn").
    expect(normalizeTerm("Ähnlichkeit")).toBe("ahnlichkeit");
    expect(normalizeTerm("C++")).toBe("c++");
    expect(normalizeTerm("HTML5")).toBe("html5");
  });
});
