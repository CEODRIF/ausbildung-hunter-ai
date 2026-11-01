/**
 * AUTO BEWERB — Step 4: the CONTROLLED TRANSFORMATION (tailored-cv.ts).
 *
 * mergeTailoredCvDocument() is the code-enforced protection of the
 * candidate's CV: the ORIGINAL document is the base, and ONLY the four
 * tailored sections (PROFIL → summary, KENNTNISSE + EDV-KENNTNISSE →
 * skills, HOBBYS → interests) are taken from the (untrusted) model
 * output. Everything else — personal data incl. photo, education,
 * experience, languages, certificates, projects, template, appearance —
 * is copied 1:1 no matter what the model returns. Inside the whitelist:
 * grounding (no invented qualifications), completeness (no verified fact
 * is dropped), de-duplication and a layout-safe summary cap.
 */
import { describe, expect, it } from "vitest";
import {
  TAILORED_SUMMARY_MAX_CHARS,
  TAILORABLE_CV_FIELDS,
  isGroundedTerm,
  mergeTailoredCvDocument,
  normalizeSkillTerm,
} from "@/lib/auto-bewerb/tailored-cv";
import {
  cvEmpty,
  emptyCertificate,
  emptyEducation,
  emptyExperience,
  emptyProject,
  sanitizeCvDocument,
  type CvDocument,
} from "@/lib/templates/cv";
import { defaultCvCustomization } from "@/lib/templates/cv-customization";

/**
 * The formatted candidate profile exactly as the model sees it
 * (formatProfileForPrompt output shape) — the ONLY allowed source for
 * new skills/hobbies.
 */
const PROFILE_TEXT = [
  "KANDIDATENPROFIL (verifizierte Fakten — das EINDZIGE Faktenfundament)",
  "Name: Mustapha Drif",
  "Tätigkeit: Fachinformatiker für Systemintegration",
  "Erfahrung:",
  "Auszubildender Fachinformatiker, Tech Süd AG, Düsseldorf, 09/2023 – heute: Systemintegration kleiner Netzwerke, Kubernetes-Administration, Linux-Betriebssysteme, Support der Endanwender.",
  "Ausbildung:",
  "Abitur — Gymnasium, Berthold-Brecht-Schule, Düsseldorf, 2022 – 2025.",
  "Kenntnisse: Java, Netzwerktechnik, Systemintegration, Kubernetes, Linux, Teamarbeit, Schaltpläne lesen.",
  "Sprachen: Deutsch (verhandlungssicher), Englisch (sehr gut).",
  "Interessen: IT-Projekte, Fußball, Musik.",
].join("\n");

const TINY_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/** The candidate's ORIGINAL CV (the deterministic profile import). */
function originalCv(): CvDocument {
  const cv = cvEmpty();
  cv.personal = {
    ...cv.personal,
    fullName: "Mustapha Drif",
    professionalTitle: "Fachinformatiker — Bewerbung bei Tech GmbH",
    email: "mustapha.drif@example.de",
    phone: "+49 151 23456789",
    location: "Düsseldorf, Deutschland",
    nationality: "deutscher",
    linkedin: "linkedin.com/in/mustapha-drif",
    website: "www.mustapha-drif.de",
    dateOfBirth: "04.06.2007",
    availability: "ab 01.09.2026",
    photo: TINY_PNG,
  };
  cv.summary = "Zuverlässiger und strukturierter Auszubildender im Bereich IT.";
  cv.skills = ["Java", "Netzwerktechnik", "Kubernetes", "Teamarbeit"];
  cv.interests = ["Fußball", "IT-Projekte"];
  const e = emptyExperience();
  e.jobTitle = "Auszubildender Fachinformatiker";
  e.company = "Tech Süd AG";
  e.location = "Düsseldorf";
  e.start = "09/2023";
  e.isCurrent = true;
  e.responsibilities = ["Systemintegration kleiner Netzwerke", "Support der Endanwender"];
  cv.experience = [e];
  const ed = emptyEducation();
  ed.degree = "Abitur — Gymnasium";
  ed.institution = "Berthold-Brecht-Schule";
  ed.location = "Düsseldorf";
  ed.start = "2022";
  ed.end = "2025";
  cv.education = [ed];
  cv.languages = [
    { id: "l1", language: "Deutsch", level: "verhandlungssicher" },
    { id: "l2", language: "Englisch", level: "sehr gut" },
  ];
  const c = emptyCertificate();
  c.name = "IT-Support-Zertifikat";
  c.issuer = "Tech Süd AG";
  c.date = "2025";
  cv.certificates = [c];
  const p = emptyProject();
  p.name = "Heimnetzwerk";
  p.role = "Eigenbau";
  p.date = "2024";
  p.description = "Aufbau und Konfiguration eines Heimnetzwerks.";
  cv.projects = [p];
  return cv;
}

/**
 * A maximally hostile model answer: the four sections are tailored AND
 * every platform-owned field is corrupted in the same breath.
 */
function hostileGenerated(): Record<string, unknown> {
  const g = sanitizeCvDocument(originalCv())!;
  g.personal.fullName = "Jemand Anderer";
  g.personal.professionalTitle = "Compliance-Officer — erfundene Position";
  g.personal.email = "fake@evil.example";
  g.personal.phone = "+49 999 00000000";
  g.personal.location = "Mars";
  g.personal.nationality = "anderer";
  g.personal.linkedin = "linkedin.com/in/jemand-anders";
  g.personal.website = "www.evil.example";
  g.personal.dateOfBirth = "01.01.1999";
  g.personal.availability = "sofort";
  g.personal.photo = "data:image/png;base64,AAAANICHERDASSELBE";
  const fakeJob = emptyExperience();
  fakeJob.jobTitle = "Erfindung von CEO";
  fakeJob.company = "Phantom AG";
  fakeJob.start = "2020";
  fakeJob.end = "2021";
  fakeJob.responsibilities = ["Nichts Bewiesenes"];
  g.experience = [fakeJob];
  const fakeEdu = emptyEducation();
  fakeEdu.degree = "PhD Quantenphysik";
  fakeEdu.institution = "Phantom-Universität";
  g.education = [fakeEdu];
  g.languages = [{ id: "x", language: "Englisch", level: "C2 — erfunden" }];
  const fakeCert = emptyCertificate();
  fakeCert.name = "ISO-27001-Auditor";
  fakeCert.issuer = "Phantom-Registry";
  g.certificates = [fakeCert];
  g.projects = [];
  g.summary =
    "IT-Auszubildender mit Kubernetes- und Netzwerk-Erfahrung: bringe Systemintegration, " +
    "Linux und Java in die Bewerbung ein — zuverlässig und teamfähig.";
  // KENNTNISSE + EDV-KENNTNISSE (the model's single skills list): reordered by
  // job relevance + one grounded term surfaced from the experience + one
  // re-spelled compound + one INVENTED term.
  g.skills = [
    "Kubernetes-Administration",
    "Java",
    "Kubernetes",
    "Netzwerk-Technik",
    "CI/CD-Pipeline-Automatisierung",
    "Teamarbeit",
  ];
  // HOBBYS: one grounded addition, one INVENTED hobby, two re-spelled originals.
  g.interests = ["Musik", "Drachensteigen", "Fußball", "IT-Projekte"];
  g.templateId = "classic";
  const c = g.customization ?? defaultCvCustomization();
  g.customization = { ...c, colors: { ...c.colors, primary: "#ff0000" } };
  return g as unknown as Record<string, unknown>;
}

describe("mergeTailoredCvDocument — the whitelist (only four sections are writable)", () => {
  it("exposes exactly the tailorable field set (PROFIL/KENNTNISSE/EDV/HOBBYS)", () => {
    expect(TAILORABLE_CV_FIELDS).toEqual(["summary", "skills", "interests"]);
  });

  it("keeps EVERY platform-owned field 1:1 from the original, even under a hostile model answer", () => {
    const original = originalCv();
    const result = mergeTailoredCvDocument({ original, generated: hostileGenerated(), profileText: PROFILE_TEXT });
    expect(result).toBeTruthy();
    const base = sanitizeCvDocument(original)!;
    // personal (incl. photo) — not a single character may change
    expect(result!.personal).toEqual(base.personal);
    expect(result!.personal.photo).toBe(TINY_PNG);
    expect(result!.personal.fullName).toBe("Mustapha Drif");
    expect(result!.personal.dateOfBirth).toBe("04.06.2007");
    // education / experience / languages / certificates / projects — the
    // model's fake entries are ignored wholesale
    expect(result!.experience).toEqual(base.experience);
    expect(result!.education).toEqual(base.education);
    expect(result!.languages).toEqual(base.languages);
    expect(result!.certificates).toEqual(base.certificates);
    expect(result!.projects).toEqual(base.projects);
    // template + appearance — the user's choice wins over the model
    expect(result!.templateId).toBe(base.templateId);
    expect(result!.customization).toEqual(base.customization);
  });

  it("applies the four tailored sections from the model output", () => {
    const original = originalCv();
    const generated = hostileGenerated();
    const result = mergeTailoredCvDocument({ original, generated, profileText: PROFILE_TEXT })!;
    // PROFIL → summary
    expect(result.summary).toBe(String(generated.summary).trim());
    // KENNTNISSE + EDV-KENNTNISSE → skills (grounded, de-duped, complete)
    expect(result.skills).toEqual([
      "Kubernetes-Administration",
      "Java",
      "Kubernetes",
      "Netzwerk-Technik",
      "Teamarbeit",
    ]);
    // HOBBYS → interests
    expect(result.interests).toEqual(["Musik", "Fußball", "IT-Projekte"]);
  });
});

describe("mergeTailoredCvDocument — no invented qualifications (grounding)", () => {
  it("drops skills/hobbies without a basis in the candidate's profile", () => {
    const result = mergeTailoredCvDocument({ original: originalCv(), generated: hostileGenerated(), profileText: PROFILE_TEXT })!;
    expect(result.skills).not.toContain("CI/CD-Pipeline-Automatisierung");
    expect(result.interests).not.toContain("Drachensteigen");
    // nothing new may appear anywhere else either
    expect(result.certificates[0]!.name).toBe("IT-Support-Zertifikat");
  });

  it("allows a term surfaced from ANY section of the profile (experience text)", () => {
    // "Kubernetes-Administration" is not in the KENNTNISSE list — it is a
    // responsibility bullet of the experience. Surfacing it is legitimate.
    const result = mergeTailoredCvDocument({ original: originalCv(), generated: hostileGenerated(), profileText: PROFILE_TEXT })!;
    expect(result.skills).toContain("Kubernetes-Administration");
    expect(isGroundedTerm("Kubernetes-Administration", PROFILE_TEXT)).toBe(true);
  });

  it("never invents when the profile text is EMPTY (no basis at all)", () => {
    const generated = hostileGenerated();
    const result = mergeTailoredCvDocument({ original: originalCv(), generated, profileText: "" })!;
    // without grounding text every generated term is dropped — the lists
    // degrade to the original (deduplicated). (In the real pipeline the
    // route requires a parsed profile before generation, so this is a
    // defensive edge case; the summary is prompt-grounded free text.)
    expect(result.skills).toEqual(["Java", "Netzwerktechnik", "Kubernetes", "Teamarbeit"]);
    expect(result.interests).toEqual(["Fußball", "IT-Projekte"]);
  });
});

describe("mergeTailoredCvDocument — no duplicates + completeness", () => {
  it("de-duplicates across case/diacritic/ß/punctuation (German compounds)", () => {
    const result = mergeTailoredCvDocument({ original: originalCv(), generated: hostileGenerated(), profileText: PROFILE_TEXT })!;
    const keys = result.skills.map((s) => normalizeSkillTerm(s).replace(/ /g, ""));
    expect(new Set(keys).size).toBe(keys.length); // unique
    // the re-spelled compound counts ONCE (the model's spelling, first seen)
    expect(result.skills.filter((s) => s.toLowerCase().includes("netzwerk"))).toHaveLength(1);
    expect(result.interests.filter((s) => s.toLowerCase().includes("fußball"))).toHaveLength(1);
    expect(result.interests.filter((s) => s.toLowerCase().includes("it-projekt"))).toHaveLength(1);
  });

  it("completeness: every verified original skill/hobby survives, appended after the model's order", () => {
    // The model DROPS two original skills (Kubernetes, Teamarbeit) — the
    // platform re-adds them so no verified fact is lost.
    const original = originalCv();
    const generated = hostileGenerated();
    (generated.skills as string[]) = ["Kubernetes-Administration", "Java", "Netzwerktechnik"];
    (generated.interests as string[]) = ["Musik"];
    const result = mergeTailoredCvDocument({ original, generated, profileText: PROFILE_TEXT })!;
    expect(result.skills).toEqual([
      "Kubernetes-Administration",
      "Java",
      "Netzwerktechnik",
      "Kubernetes", // dropped by the model — re-added by the platform
      "Teamarbeit", // dropped by the model — re-added by the platform
    ]);
    expect(result.interests).toEqual(["Musik", "Fußball", "IT-Projekte"]);
  });

  it("an empty generated list yields the original list (order preserved)", () => {
    const original = originalCv();
    const generated = hostileGenerated();
    (generated.skills as string[]) = [];
    (generated.interests as string[]) = [];
    const result = mergeTailoredCvDocument({ original, generated, profileText: PROFILE_TEXT })!;
    expect(result.skills).toEqual(original.skills);
    expect(result.interests).toEqual(original.interests);
  });
});

describe("mergeTailoredCvDocument — safety of empty / garbage model output", () => {
  it("unparseable model output → null (the route maps that to invalid_ai_output / 502)", () => {
    for (const garbage of ["total garbage", 42, null, undefined, ["array"], "```json\n{}\n```"]) {
      expect(mergeTailoredCvDocument({ original: originalCv(), generated: garbage, profileText: PROFILE_TEXT })).toBeNull();
    }
  });

  it("an EMPTY model answer is safe: the original document stands (deduplicated)", () => {
    const original = originalCv();
    const result = mergeTailoredCvDocument({ original, generated: {}, profileText: PROFILE_TEXT });
    expect(result).toBeTruthy();
    const base = sanitizeCvDocument(original)!;
    expect(result!.personal).toEqual(base.personal);
    expect(result!.experience).toEqual(base.experience);
    expect(result!.summary).toBe(base.summary); // empty generated summary → original kept
    expect(result!.skills).toEqual(original.skills);
    expect(result!.interests).toEqual(original.interests);
  });

  it("caps the PROFIL section at the layout-safe length", () => {
    const original = originalCv();
    const generated = hostileGenerated();
    (generated.summary as string) = "x".repeat(1500);
    const result = mergeTailoredCvDocument({ original, generated, profileText: PROFILE_TEXT })!;
    expect(result.summary.length).toBe(TAILORED_SUMMARY_MAX_CHARS);
    expect(TAILORED_SUMMARY_MAX_CHARS).toBe(900);
  });

  it("whitespace-only generated sections leave the original untouched", () => {
    const original = originalCv();
    const generated = hostileGenerated();
    (generated.summary as string) = "   ";
    const result = mergeTailoredCvDocument({ original, generated, profileText: PROFILE_TEXT })!;
    expect(result.summary).toBe(original.summary);
  });
});

describe("normalizeSkillTerm / isGroundedTerm — units", () => {
  it("normalization: case, diacritics, ß→ss, punctuation, whitespace", () => {
    expect(normalizeSkillTerm("MS Excel")).toBe("ms excel");
    expect(normalizeSkillTerm("Team-Arbeit")).toBe("team arbeit");
    expect(normalizeSkillTerm("Größe")).toBe("grosse");
    expect(normalizeSkillTerm("  C++  ")).toBe("c");
    expect(normalizeSkillTerm("Netzwerktechnik")).toBe("netzwerktechnik");
    expect(normalizeSkillTerm("Netzwerk-Technik")).toBe("netzwerk technik");
  });

  it("grounding: every significant word must occur in the profile text", () => {
    expect(isGroundedTerm("Java", PROFILE_TEXT)).toBe(true);
    expect(isGroundedTerm("Kubernetes-Administration", PROFILE_TEXT)).toBe(true);
    expect(isGroundedTerm("Netzwerktechnik", PROFILE_TEXT)).toBe(true);
    expect(isGroundedTerm("CI/CD-Pipeline-Automatisierung", PROFILE_TEXT)).toBe(false);
    expect(isGroundedTerm("Drachensteigen", PROFILE_TEXT)).toBe(false);
    // too short / no significant words / empty basis
    expect(isGroundedTerm("a", PROFILE_TEXT)).toBe(false);
    expect(isGroundedTerm("C++", PROFILE_TEXT)).toBe(false);
    expect(isGroundedTerm("Java", "")).toBe(false);
  });
});
