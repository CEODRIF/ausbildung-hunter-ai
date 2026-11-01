/**
 * AUTO BEWERB — Step 4: the CONTROLLED TRANSFORMATION (tailored-cv.ts).
 *
 * mergeTailoredCvDocument() is the code-enforced protection of the
 * candidate's CV: the ORIGINAL document is the base, and ONLY the four
 * tailored sections (PROFIL → summary, KENNTNISSE + EDV-KENNTNISSE →
 * skills, HOBBYS → interests) are taken from the (untrusted) model
 * output. Everything else — personal data incl. photo, education,
 * experience, languages, certificates, projects, template, appearance —
 * is copied 1:1 no matter what the model returns.
 *
 * Inside the whitelist:
 *  - GROUNDING — deterministic token traceability to the candidate's own
 *    profile text (the ONLY facts the model saw): whole word, compound
 *    edge (prefix/suffix), short inflection, or 2–3-part compound
 *    decomposition. NEVER an arbitrary inner substring.
 *  - PROFIL (summary) verification — every fact-carrying token (nouns,
 *    proper names, technical terms, degree/certificate words) must be
 *    traceable, and EVERY number (years/dates/counts) must occur in the
 *    profile. Unverifiable statements → the ORIGINAL summary is kept.
 *  - COMPLETENESS — no verified skill/hobby is ever dropped.
 *  - NO DUPLICATES — German-compound-aware de-duplication.
 *
 * The fixtures use the REAL pipeline shape: a zod-parsed CandidateProfile
 * → formatProfileForPrompt (what the model sees) → importCandidateProfileToCv
 * (the original CV) — exactly the route's wiring.
 */
import { describe, expect, it } from "vitest";
import { candidateProfileSchema } from "@/lib/bewerbung-schema";
import { formatProfileForPrompt } from "@/lib/templates/cover-letter";
import {
  checkSummaryGrounding,
  isGroundedTerm,
  isSummaryGrounded,
  mergeTailoredCvDocument,
  normalizeSkillTerm,
  TAILORED_SUMMARY_MAX_CHARS,
  TAILORABLE_CV_FIELDS,
} from "@/lib/auto-bewerb/tailored-cv";
import {
  cvEmpty,
  emptyExperience,
  importCandidateProfileToCv,
  sanitizeCvDocument,
  type CvDocument,
} from "@/lib/templates/cv";
import { defaultCvCustomization } from "@/lib/templates/cv-customization";

/* ------------------------------------------------------------------ */
/* Real pipeline fixture (parsed profile → prompt text → original CV)  */
/* ------------------------------------------------------------------ */

const PROFILE = candidateProfileSchema.parse({
  goal: "ausbildung",
  candidate: {
    full_name: "Mustapha Drif",
    location: "Düsseldorf, Deutschland",
    country: "Deutschland",
    contact: {
      email: "mustapha.drif@example.de",
      phone: "+49 151 23456789",
      linkedin: "linkedin.com/in/mustapha-drif",
    },
  },
  target_roles: [
    { role: "Auszubildender Fachinformatiker für Systemintegration", reason: "Zielposition" },
  ],
  education: [{ school: "Berthold-Brecht-Schule", degree: "Abitur", graduation_year: 2025 }],
  training: [{ name: "Erste-Hilfe-Schulung", provider: "DRK", year: "2024" }],
  experience: [
    {
      job_title: "Auszubildender Fachinformatiker",
      company: "Tech Süd AG",
      responsibilities: [
        "Systemintegration kleiner Netzwerke",
        "Kubernetes-Administration",
        "Support der Endanwender",
        "Linux-Betriebssysteme",
      ],
      start_date: "09/2023",
      type: "internship",
    },
  ],
  skills: {
    technical: ["Systemintegration"],
    software_tools: ["Kubernetes", "Linux", "MS Excel", "Python"],
    marketing: [],
    it: ["Java", "Netzwerktechnik"],
    soft: ["Teamarbeit", "Strukturierte Arbeitsweise"],
  },
  languages: [
    { language: "Deutsch", level: "verhandlungssicher" },
    { language: "Englisch", level: "sehr gut" },
  ],
});

/** The formatted profile — the ONLY candidate facts the model ever sees. */
const PROFILE_TEXT = formatProfileForPrompt(PROFILE);
/** The candidate's ORIGINAL CV (the route's deterministic import). */
const ORIGINAL_CV = importCandidateProfileToCv(PROFILE);

/**
 * A maximally hostile model answer: the four sections are tailored AND
 * every platform-owned field is corrupted in the same breath.
 */
function hostileGenerated(): Record<string, unknown> {
  const g = sanitizeCvDocument(ORIGINAL_CV)!;
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
  g.education = [
    {
      id: "fake",
      degree: "PhD Quantenphysik",
      institution: "Phantom-Universität",
      location: "Berlin",
      start: "2019",
      end: "2023",
      description: "",
    },
  ];
  g.languages = [{ id: "x", language: "Englisch", level: "C2 — erfunden" }];
  g.certificates = [
    { id: "fake", name: "ISO-27001-Auditor", issuer: "Phantom-Registry", date: "2026", description: "" },
  ];
  g.projects = [
    { id: "fake", name: "Quanten-Reaktor", role: "Lead", date: "2026", description: "", technologies: "" },
  ];
  // PROFIL — grounded (every claim traceable to the profile) → applied.
  g.summary =
    "Motivierter Auszubildender Fachinformatiker mit Erfahrung in Systemintegration, " +
    "Netzwerktechnik und Kubernetes-Administration — strukturiert, zuverlässig und teamfähig.";
  // KENNTNISSE + EDV-KENNTNISSE: reordered by job relevance + one re-spelled
  // compound + one INVENTED term (Python-Entwicklung — "Entwicklung" has no
  // basis in this profile).
  g.skills = [
    "Kubernetes-Administration",
    "Java",
    "Kubernetes",
    "Netzwerk-Technik",
    "MS Excel",
    "Python-Entwicklung",
    "Teamarbeit",
  ];
  // HOBBYS: the profile carries no interests — every generated hobby is
  // unverifiable and must be dropped (original interests: none).
  g.interests = ["Fußball", "IT-Projekte"];
  g.templateId = "classic";
  const c = defaultCvCustomization();
  g.customization = { ...c, colors: { ...c.colors, primary: "#ff0000" } };
  return g as unknown as Record<string, unknown>;
}

describe("mergeTailoredCvDocument — the whitelist (only four sections are writable)", () => {
  it("exposes exactly the tailorable field set (PROFIL/KENNTNISSE/EDV/HOBBYS)", () => {
    expect(TAILORABLE_CV_FIELDS).toEqual(["summary", "skills", "interests"]);
  });

  it("keeps EVERY platform-owned field 1:1 from the original, even under a hostile model answer", () => {
    const result = mergeTailoredCvDocument({ original: ORIGINAL_CV, generated: hostileGenerated(), profileText: PROFILE_TEXT });
    expect(result).toBeTruthy();
    const base = sanitizeCvDocument(ORIGINAL_CV)!;
    expect(result!.personal).toEqual(base.personal);
    expect(result!.personal.fullName).toBe("Mustapha Drif");
    expect(result!.personal.professionalTitle).toBe("Auszubildender Fachinformatiker für Systemintegration");
    expect(result!.experience).toEqual(base.experience);
    expect(result!.education).toEqual(base.education);
    expect(result!.languages).toEqual(base.languages);
    expect(result!.certificates).toEqual(base.certificates);
    expect(result!.projects).toEqual(base.projects);
    expect(result!.templateId).toBe(base.templateId);
    expect(result!.customization).toEqual(base.customization);
  });

  it("applies the grounded tailored sections", () => {
    const result = mergeTailoredCvDocument({ original: ORIGINAL_CV, generated: hostileGenerated(), profileText: PROFILE_TEXT })!;
    // PROFIL — the grounded paraphrase is adopted
    expect(result.summary).toBe(String(hostileGenerated().summary));
    // KENNTNISSE + EDV-KENNTNISSE — grounded, de-duped, complete:
    // the model's relevance order first, then the original skills it
    // dropped; "Python-Entwicklung" (no basis) is gone.
    expect(result.skills).toEqual([
      "Kubernetes-Administration",
      "Java",
      "Kubernetes",
      "Netzwerk-Technik",
      "MS Excel",
      "Teamarbeit",
      "Systemintegration",
      "Linux",
      "Python",
      "Strukturierte Arbeitsweise",
    ]);
    // HOBBYS — the profile has no interests: nothing may be invented
    expect(result.interests).toEqual([]);
  });
});

describe("PROFIL (summary) verification — no invented statements, legitimate paraphrasing allowed", () => {
  it("accepts a legitimate paraphrase of the candidate's own facts", () => {
    expect(
      isSummaryGrounded(
        "Motivierter Auszubildender Fachinformatiker mit Erfahrung in Systemintegration, Netzwerktechnik und Kubernetes-Administration — strukturiert, zuverlässig und teamfähig.",
        PROFILE_TEXT,
      ),
    ).toBe(true);
    // dates that occur in the profile are fine
    expect(
      isSummaryGrounded("Seit 09/2023 in Ausbildung bei der Tech Süd AG mit Systemintegration kleiner Netzwerke.", PROFILE_TEXT),
    ).toBe(true);
    // compound decomposition: the profile's hyphenated term written as one word
    expect(isSummaryGrounded("Erfahrung in der Kubernetesadministration mit Linux-Betriebssystemen.", PROFILE_TEXT)).toBe(true);
  });

  it("rejects a fabricated qualification (invented certifying body / brand) → original summary kept", () => {
    const fabricated = "Zertifizierter Azure-Architekt mit Erfahrung in Cloud-Entwicklung und Kubernetes-Administration.";
    const check = checkSummaryGrounding(fabricated, PROFILE_TEXT);
    expect(check.grounded).toBe(false);
    expect(check.ungroundedToken).toBeTruthy();
    const result = mergeTailoredCvDocument({
      original: ORIGINAL_CV,
      generated: { ...hostileGenerated(), summary: fabricated },
      profileText: PROFILE_TEXT,
    })!;
    // the unverified PROFIL is NEVER adopted — the original stands
    expect(result.summary).toBe(ORIGINAL_CV.summary);
  });

  it("rejects invented years of experience (numbers must occur in the profile)", () => {
    const fabricated = "Erfahrener Fachinformatiker mit 10 Jahren Berufserfahrung in der Systemintegration.";
    const check = checkSummaryGrounding(fabricated, PROFILE_TEXT);
    expect(check).toEqual({ grounded: false, ungroundedToken: "10" });
    const result = mergeTailoredCvDocument({
      original: ORIGINAL_CV,
      generated: { ...hostileGenerated(), summary: fabricated },
      profileText: PROFILE_TEXT,
    })!;
    expect(result.summary).toBe(ORIGINAL_CV.summary);
    // …while the SAME claim with the profile's real dates passes
    expect(
      isSummaryGrounded("Fachinformatiker-Ausbildung seit 09/2023 bei der Tech Süd AG — Abitur 2025.", PROFILE_TEXT),
    ).toBe(true);
  });

  it("rejects unsupported language levels (e.g. C2 without basis)", () => {
    expect(checkSummaryGrounding("Verhandlungssicheres Englisch auf C2-Niveau.", PROFILE_TEXT).grounded).toBe(false);
    // the profile's own level wording is fine
    expect(isSummaryGrounded("Sprachkenntnisse: Deutsch verhandlungssicher, Englisch sehr gut.", PROFILE_TEXT)).toBe(true);
  });

  it("rejects an invented degree / university → original summary kept", () => {
    const fabricated = "Absolvent der Technischen Universität Berlin mit Master-Abschluss in Informatik.";
    expect(checkSummaryGrounding(fabricated, PROFILE_TEXT).grounded).toBe(false);
    const result = mergeTailoredCvDocument({
      original: ORIGINAL_CV,
      generated: { ...hostileGenerated(), summary: fabricated },
      profileText: PROFILE_TEXT,
    })!;
    expect(result.summary).toBe(ORIGINAL_CV.summary);
  });

  it("an EMPTY model answer is safe: the original document stands", () => {
    const result = mergeTailoredCvDocument({ original: ORIGINAL_CV, generated: {}, profileText: PROFILE_TEXT });
    expect(result).toBeTruthy();
    const base = sanitizeCvDocument(ORIGINAL_CV)!;
    expect(result!.personal).toEqual(base.personal);
    expect(result!.experience).toEqual(base.experience);
    expect(result!.summary).toBe(base.summary);
    expect(result!.skills).toEqual(base.skills);
    expect(result!.interests).toEqual(base.interests);
  });

  it("caps the PROFIL section at the layout-safe length", () => {
    const unit = "Motivierter Auszubildender Fachinformatiker mit Erfahrung in Systemintegration. ";
    const generated = { ...hostileGenerated(), summary: unit.repeat(20) }; // far beyond 900
    const result = mergeTailoredCvDocument({ original: ORIGINAL_CV, generated, profileText: PROFILE_TEXT })!;
    expect(result.summary.length).toBe(TAILORED_SUMMARY_MAX_CHARS);
    expect(TAILORED_SUMMARY_MAX_CHARS).toBe(900);
  });
});

describe("mergeTailoredCvDocument — lists: no invention, no duplicates, completeness", () => {
  it("drops skills without a basis in the profile (no invented qualifications)", () => {
    const result = mergeTailoredCvDocument({ original: ORIGINAL_CV, generated: hostileGenerated(), profileText: PROFILE_TEXT })!;
    expect(result.skills).not.toContain("Python-Entwicklung");
    // nothing invented anywhere else either
    expect(result.certificates[0]!.name).toBe("Erste-Hilfe-Schulung");
    expect(result.languages).toEqual(sanitizeCvDocument(ORIGINAL_CV)!.languages);
  });

  it("allows a term surfaced from ANY section of the profile (experience text)", () => {
    // "Kubernetes-Administration" is not a listed skill — it is a
    // responsibility bullet. Surfacing it as a skill is legitimate.
    expect(isGroundedTerm("Kubernetes-Administration", PROFILE_TEXT)).toBe(true);
    const result = mergeTailoredCvDocument({ original: ORIGINAL_CV, generated: hostileGenerated(), profileText: PROFILE_TEXT })!;
    expect(result.skills).toContain("Kubernetes-Administration");
  });

  it("never invents when the profile text is EMPTY (no basis at all)", () => {
    const result = mergeTailoredCvDocument({ original: ORIGINAL_CV, generated: hostileGenerated(), profileText: "" })!;
    expect(result.skills).toEqual(sanitizeCvDocument(ORIGINAL_CV)!.skills);
    expect(result.interests).toEqual([]);
    expect(result.summary).toBe(ORIGINAL_CV.summary);
  });

  it("de-duplicates across case/diacritic/ß/punctuation (German compounds)", () => {
    const result = mergeTailoredCvDocument({ original: ORIGINAL_CV, generated: hostileGenerated(), profileText: PROFILE_TEXT })!;
    const keys = result.skills.map((s) => normalizeSkillTerm(s).replace(/ /g, ""));
    expect(new Set(keys).size).toBe(keys.length); // unique
    // the re-spelled compound counts ONCE (the model's spelling, first seen)
    expect(result.skills.filter((s) => s.toLowerCase().includes("netzwerk"))).toHaveLength(1);
    expect(result.skills.filter((s) => s.toLowerCase().includes("excel"))).toHaveLength(1);
  });

  it("completeness: every verified original skill survives, appended after the model's order", () => {
    const generated = { ...hostileGenerated(), skills: ["Kubernetes-Administration", "Java", "Netzwerktechnik"] as string[] };
    const result = mergeTailoredCvDocument({ original: ORIGINAL_CV, generated, profileText: PROFILE_TEXT })!;
    // Linux, Systemintegration, MS Excel, Teamarbeit, Strukturierte
    // Arbeitsweise were dropped by the model — the platform re-adds them.
    expect(result.skills).toEqual([
      "Kubernetes-Administration",
      "Java",
      "Netzwerktechnik",
      "Systemintegration",
      "Kubernetes",
      "Linux",
      "MS Excel",
      "Python",
      "Teamarbeit",
      "Strukturierte Arbeitsweise",
    ]);
  });

  it("an empty generated list yields the original list (order preserved)", () => {
    const generated = { ...hostileGenerated(), skills: [] as string[] };
    const result = mergeTailoredCvDocument({ original: ORIGINAL_CV, generated, profileText: PROFILE_TEXT })!;
    expect(result.skills).toEqual(ORIGINAL_CV.skills);
  });

  it("interests completeness works for originals that HAVE interests (unit)", () => {
    const original: CvDocument = { ...sanitizeCvDocument(cvEmpty())!, interests: ["Fußball", "IT-Projekte"] };
    const generated = { ...hostileGenerated(), interests: ["Musik"] as string[] };
    // no basis in the profile → generated interests dropped, originals kept
    const result = mergeTailoredCvDocument({ original, generated, profileText: PROFILE_TEXT })!;
    expect(result.interests).toEqual(["Fußball", "IT-Projekte"]);
  });
});

describe("mergeTailoredCvDocument — safety of garbage model output", () => {
  it("unparseable model output → null (the route maps that to invalid_ai_output / 502)", () => {
    for (const garbage of ["total garbage", 42, null, undefined, ["array"], "```json\n{}\n```"]) {
      expect(mergeTailoredCvDocument({ original: ORIGINAL_CV, generated: garbage, profileText: PROFILE_TEXT })).toBeNull();
    }
  });
});

describe("isGroundedTerm / normalizeSkillTerm — strict traceability, no substring false positives", () => {
  it("normalization: case, diacritics, ß→ss, punctuation, whitespace", () => {
    expect(normalizeSkillTerm("MS Excel")).toBe("ms excel");
    expect(normalizeSkillTerm("Team-Arbeit")).toBe("team arbeit");
    expect(normalizeSkillTerm("Größe")).toBe("grosse");
    expect(normalizeSkillTerm("  C++  ")).toBe("c");
    expect(normalizeSkillTerm("Netzwerktechnik")).toBe("netzwerktechnik");
    expect(normalizeSkillTerm("Netzwerk-Technik")).toBe("netzwerk technik");
    expect(normalizeSkillTerm("Düsseldorf")).toBe("dusseldorf");
  });

  it("whole words and legitimate compounds", () => {
    expect(isGroundedTerm("Java", PROFILE_TEXT)).toBe(true);
    expect(isGroundedTerm("MS Excel", PROFILE_TEXT)).toBe(true);
    expect(isGroundedTerm("Kubernetes-Administration", PROFILE_TEXT)).toBe(true);
    expect(isGroundedTerm("kubernetesadministration", PROFILE_TEXT)).toBe(true); // decomposition
    expect(isGroundedTerm("Netzwerktechnik", PROFILE_TEXT)).toBe(true);
    expect(isGroundedTerm("Netzwerk-Technik", PROFILE_TEXT)).toBe(true); // compound edges
    expect(isGroundedTerm("Strukturierte Arbeitsweise", PROFILE_TEXT)).toBe(true);
    expect(isGroundedTerm("Düsseldorf", PROFILE_TEXT)).toBe(true);
    expect(isGroundedTerm("Dusseldorf", PROFILE_TEXT)).toBe(true); // diacritics
  });

  it("NO false positives from arbitrary substring matches", () => {
    // "python" is in the profile — but "py" (an inner fragment) is NOT grounded
    expect(isGroundedTerm("Py", PROFILE_TEXT)).toBe(false);
    expect(isGroundedTerm("Pyth", PROFILE_TEXT)).toBe(false);
    // terms without any basis in the profile
    expect(isGroundedTerm("C++", PROFILE_TEXT)).toBe(false); // profile has no "C"
    expect(isGroundedTerm("Azure", PROFILE_TEXT)).toBe(false);
    expect(isGroundedTerm("CI/CD-Pipeline-Automatisierung", PROFILE_TEXT)).toBe(false);
    expect(isGroundedTerm("Drachensteigen", PROFILE_TEXT)).toBe(false);
    expect(isGroundedTerm("Quantenphysik", PROFILE_TEXT)).toBe(false);
    // …and against an empty profile: nothing is grounded
    expect(isGroundedTerm("Java", "")).toBe(false);
  });

  it("short/empty terms are conservatively rejected", () => {
    expect(isGroundedTerm("a", PROFILE_TEXT)).toBe(false);
    expect(isGroundedTerm("", PROFILE_TEXT)).toBe(false);
    expect(isGroundedTerm("OS", PROFILE_TEXT)).toBe(false); // no "OS" in this profile
  });
});
