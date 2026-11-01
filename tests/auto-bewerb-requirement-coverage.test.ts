/**
 * AUTO BEWERB — full requirement coverage: ad → tailored CV → verification.
 *
 * The end-to-end guarantee (deterministic, no LLM in the loop):
 *  1. EVERY skill-like requirement of the ad (technical, soft, skill-like
 *     qualification) lands in the tailored CV — added by the platform when
 *     missing, flagged in `tailoring.addedFromAd`;
 *  2. NOTHING of the original CV is lost (personal, experience, education,
 *     languages, certificates, original skills, template, appearance) even
 *     under a hostile model answer;
 *  3. PROFIL is never lost: the original summary is kept verbatim (never
 *     capped); a grounded generated summary (ad position facts allowed) is
 *     adopted; otherwise a deterministic fallback from verified facts +
 *     the ad's position identity fills it — the section is never empty;
 *  4. honesty: language levels, education and experience claims are
 *     reported, NEVER auto-added (no fabricated facts);
 *  5. dedup: symbol-aware ("C" ≠ "C++" ≠ "C#") while German compounds
 *     still merge; terms covered elsewhere are not duplicated into skills;
 *  6. no caps: a 40-term requirement list survives intact;
 *  7. PDF parity: the rendered PDF carries the PROFIL + every skill
 *     (preview == export, same renderer), and the export path falls back
 *     to the renderer's multi-page overflow mode instead of deleting
 *     content when the one-page tiers overflow.
 *
 * Fixtures: long CV (many skills, no PROFIL — the scanner profile has no
 * summary), short CV (minimal), different languages/structures.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import { candidateProfileSchema } from "@/lib/bewerbung-schema";
import { adExtractSchema, type AdExtract } from "@/lib/studio/schema";
import { formatProfileForPrompt } from "@/lib/templates/cover-letter";
import {
  buildFallbackSummary,
  mergeTailoredCvDocument,
  type AdTailoringInput,
} from "@/lib/auto-bewerb/tailored-cv";
import {
  collectAddableSkillTerms,
  verifyCvAgainstAd,
} from "@/lib/auto-bewerb/cv-verification";
import {
  importCandidateProfileToCv,
  sanitizeCvDocument,
  type CvDocument,
} from "@/lib/templates/cv";
import { CvPdfOverflowError, generateCvPdf } from "@/lib/auto-bewerb/cv-pdf";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative: string): string => readFileSync(join(root, relative), "utf8");

/* ------------------------------------------------------------------ */
/* Fixtures — the REAL pipeline shape (profile → prompt → original CV) */
/* ------------------------------------------------------------------ */

/** LONG CV: 40 skills across all groups, experience, education, 3
 *  languages, a certificate — and NO summary (the scanner profile does
 *  not store one: this is the exact PROFIL-disappearing scenario). */
const PROFILE_LONG = candidateProfileSchema.parse({
  goal: "ausbildung",
  candidate: {
    full_name: "Alex Muster",
    location: "Bremen, Deutschland",
    country: "Deutschland",
    contact: { email: "alex.muster@example.de", phone: "+49 160 11122233", linkedin: "" },
  },
  target_roles: [{ role: "Auszubildende:r Webdesign", reason: "Zielposition" }],
  education: [
    { school: "Gesamtschule an der Weser", degree: "Abitur", field_of_study: "", graduation_year: 2025 },
    { school: "Berufsschule Bremen", degree: "IT-Grundkurs", graduation_year: 2024 },
  ],
  training: [{ name: "HTML & CSS-Grundlagen", provider: "Volkshochschule Bremen", year: "2024" }],
  experience: [
    {
      job_title: "Web-Praktikant",
      company: "Pixelwerk Studio",
      responsibilities: ["Webseiten-Pflege mit WordPress", "Erstellung von Grafiken"],
      start_date: "06/2024",
      end_date: "08/2024",
      type: "internship",
    },
    {
      job_title: "Hilfskraft im Einzelhandel",
      company: "Markt Nord GmbH",
      responsibilities: ["Kassenarbeit", "Lagerpflege"],
      start_date: "09/2022",
      end_date: "05/2023",
      type: "employment",
    },
  ],
  skills: {
    technical: [
      "Webdesign", "Layout", "WordPress", "Grafikdesign", "HTML",
      "CSS", "JavaScript-Grundlagen", "Photoshop", "Illustrator", "InDesign",
      "Responsive Design", "Usability", "Typografie", "Farbtheorie", "Skizzen",
    ],
    software_tools: [
      "MS Word", "MS PowerPoint", "MS Outlook", "Figma", "Canva",
      "Lightroom", "After Effects", "CapCut", "Notion", "Trello",
    ],
    marketing: ["Social-Media-Basics", "Content-Erstellung", "Bilder-Bearbeitung", "Storytelling", "Präsentation"],
    it: ["Windows", "macOS", "Linux-Grundlagen", "Datei-Organisation", "Sicherungskonzepte"],
    soft: ["Zuverlässigkeit", "Pünktlichkeit", "Kreativität", "Sorgfalt", "Lernbereitschaft"],
  },
  languages: [
    { language: "Deutsch", level: "C1" },
    { language: "Englisch", level: "B2" },
    { language: "Französisch", level: "A2" },
  ],
});

/** SHORT CV: minimal candidate, one skill, no experience/education/level. */
const PROFILE_SHORT = candidateProfileSchema.parse({
  goal: "arbeit",
  candidate: { full_name: "Sara Ahmed", location: "Köln", country: "Deutschland", contact: { email: "sara@example.de", phone: "", linkedin: "" } },
  target_roles: [{ role: "Kaufleute im Einzelhandel", reason: "Ziel" }],
  skills: { technical: ["Kassenarbeit"], software_tools: [], marketing: [], it: [], soft: [] },
  languages: [{ language: "Deutsch", level: null }],
});

/** Different structure: English skills + English work context. */
const PROFILE_EN = candidateProfileSchema.parse({
  goal: "arbeit",
  candidate: { full_name: "John Smith", location: "Munich", country: "Deutschland", contact: { email: "john@example.com", phone: "", linkedin: "linkedin.com/in/jsmith" } },
  target_roles: [{ role: "Auszubildende:r IT-System-Electroniker", reason: "Ziel" }],
  experience: [{ job_title: "IT Support Assistant", company: "TechHelp GmbH", responsibilities: ["Customer Service", "Helpdesk"], start_date: "01/2024", end_date: null, type: "employment" }],
  skills: { technical: ["Networking"], software_tools: ["Python"], marketing: [], it: ["Windows", "Linux"], soft: ["Communication"] },
  languages: [{ language: "English", level: "C2" }, { language: "Deutsch", level: "B1" }],
});

const LONG_ORIGINAL = importCandidateProfileToCv(PROFILE_LONG);
const SHORT_ORIGINAL = importCandidateProfileToCv(PROFILE_SHORT);
const EN_ORIGINAL = importCandidateProfileToCv(PROFILE_EN);

/** The user's example ad (marketing/web job): every one of these
 *  requirements must appear in the tailored CV. */
const AD_MARKETING = adExtractSchema.parse({
  company: "Nord Media GmbH",
  jobTitle: "Auszubildende:r Webdesign",
  occupation: "Mediengestalterin Digital Media",
  location: "Bremen",
  startDate: "01.08.2027",
  technicalSkills: ["SEO", "Google Ads", "Excel"],
  softSkills: ["Teamfähigkeit", "Kommunikationsfähigkeit", "Eigeninitiative", "Organisationstalent", "Analytisches Denken"],
  languageRequirements: ["Deutsch C1"],
  educationRequirement: "Abitur",
  requestedDocuments: ["letzte Zeugnisse"],
});

/** Ad with requirements the long CV does NOT have (missing-skill handling). */
const AD_MISSING = adExtractSchema.parse({
  company: "Gastro Süd KG",
  jobTitle: "Auszubildende:r Hotelfachmann",
  occupation: "Hotelfachmann/-frau",
  technicalSkills: ["SAP"],
  softSkills: ["Verantwortungsbewusstsein", "Belastbarkeit"],
  requiredQualifications: ["2 Jahre Erfahrung in der Gastronomie", "Meisterbrief"],
  languageRequirements: ["Englisch C2"],
});

/** Ad with a huge requirement list (no-cap check). */
const AD_HUGE = adExtractSchema.parse({
  company: "MegaTech AG",
  jobTitle: "Azubi",
  technicalSkills: Array.from({ length: 40 }, (_, i) => `Tool ${String.fromCharCode(65 + (i % 26))}${i}`),
});

/** A maximally hostile model answer: tailored sections AND every
 *  platform-owned field corrupted in the same breath. */
function hostileGenerated(): Record<string, unknown> {
  const g = sanitizeCvDocument(LONG_ORIGINAL)!;
  g.personal.fullName = "Jemand Anderer";
  g.personal.email = "fake@evil.example";
  g.personal.phone = "+49 999 00000000";
  g.personal.location = "Mars";
  g.personal.photo = "data:image/png;base64,AAAANICHERDASSELBE";
  g.education = [{ id: "fake", degree: "PhD Quantenphysik", institution: "Phantom-Universität", location: "", start: "", end: "2099", description: "" }];
  g.experience = [];
  g.languages = [{ id: "x", language: "Englisch", level: "C2 — erfunden" }];
  g.certificates = [{ id: "fake", name: "ISO-27001-Auditor", issuer: "Phantom", date: "2026", description: "" }];
  g.projects = [{ id: "fake", name: "Quanten-Reaktor", role: "Lead", date: "", description: "", technologies: "" }];
  g.summary = "Erfahrener Cloud-Architekt mit 10 Jahren Erfahrung bei Google und Azure-Zertifizierung C2.";
  g.skills = ["Azure-Cloud", "Kubernetes-Administration", "Python-Entwicklung"];
  g.interests = ["Quantenphysik"];
  return g as unknown as Record<string, unknown>;
}

function adInput(extract: AdExtract): AdTailoringInput {
  return {
    skillTerms: collectAddableSkillTerms(extract),
    summaryContext: {
      jobTitle: extract.jobTitle,
      occupation: extract.occupation,
      company: extract.company,
      location: extract.location,
      startDate: extract.startDate,
    },
  };
}

function mergeLong(extract: AdExtract, generated: unknown = hostileGenerated()): CvDocument {
  return mergeTailoredCvDocument({
    original: LONG_ORIGINAL,
    generated,
    profileText: formatProfileForPrompt(PROFILE_LONG),
    ad: adInput(extract),
  })!;
}

/* ------------------------------------------------------------------ */
/* 1. EVERY ad requirement lands in the tailored CV (the user's case)  */
/* ------------------------------------------------------------------ */

describe("full requirement coverage — every extracted requirement is in the CV", () => {
  it("adds ALL missing technical + soft skills of the ad (the example case)", () => {
    const result = mergeLong(AD_MARKETING);
    for (const term of [
      "SEO", "Google Ads", "Excel",
      "Teamfähigkeit", "Kommunikationsfähigkeit", "Eigeninitiative",
      "Organisationstalent", "Analytisches Denken",
    ]) {
      expect(result.skills, `missing: ${term}`).toContain(term);
    }
    // …and every one of them is flagged for the user (auto-added).
    expect(result.tailoring?.addedFromAd).toEqual(
      expect.arrayContaining([
        "SEO", "Google Ads", "Excel",
        "Teamfähigkeit", "Kommunikationsfähigkeit", "Eigeninitiative",
        "Organisationstalent", "Analytisches Denken",
      ]),
    );
    expect(result.tailoring?.addedFromAd).toHaveLength(8);
  });

  it("the verification report then confirms 100% coverage of the hard requirements", () => {
    const result = mergeLong(AD_MARKETING);
    const report = verifyCvAgainstAd({ cv: result, extract: AD_MARKETING });
    // SEO/Google Ads/Excel/soft skills → covered (Kenntnisse);
    // Deutsch C1 → covered (Sprachen); Abitur → covered (Ausbildung & Studium);
    // "letzte Zeugnisse" → info (document, not a CV section).
    expect(report.allCovered).toBe(true);
    expect(report.items.filter((i) => i.status === "missing")).toHaveLength(0);
    expect(report.items.find((i) => i.requirement === "SEO")?.section).toBe("Kenntnisse");
    expect(report.items.find((i) => i.requirement === "Deutsch C1")?.section).toBe("Sprachen");
    expect(report.items.find((i) => i.requirement === "Abitur")?.section).toBe("Ausbildung & Studium");
    expect(report.items.find((i) => i.requirement === "letzte Zeugnisse")?.status).toBe("info");
    expect(report.addedFromAd).toHaveLength(8);
  });

  it("missing skills (SAP, Verantwortungsbewusstsein, Belastbarkeit) are auto-added + flagged", () => {
    const result = mergeLong(AD_MISSING);
    for (const term of ["SAP", "Verantwortungsbewusstsein", "Belastbarkeit"]) {
      expect(result.skills).toContain(term);
    }
    expect(result.tailoring?.addedFromAd).toEqual(
      expect.arrayContaining(["SAP", "Verantwortungsbewusstsein", "Belastbarkeit"]),
    );
  });

  it("a 40-term requirement list is added COMPLETELY (no arbitrary cap)", () => {
    const result = mergeLong(AD_HUGE);
    for (const term of AD_HUGE.technicalSkills) {
      expect(result.skills, `missing: ${term}`).toContain(term);
    }
  });
});

/* ------------------------------------------------------------------ */
/* 2. NOTHING original is lost (preservation under a hostile model)    */
/* ------------------------------------------------------------------ */

describe("original CV data — preserved 1:1 (never deleted)", () => {
  const result = mergeLong(AD_MARKETING);
  const base = sanitizeCvDocument(LONG_ORIGINAL)!;

  it("keeps EVERY platform-owned field 1:1 despite the corrupted model output", () => {
    expect(result.personal).toEqual(base.personal);
    expect(result.education).toEqual(base.education);
    expect(result.experience).toEqual(base.experience);
    expect(result.languages).toEqual(base.languages);
    expect(result.certificates).toEqual(base.certificates);
    expect(result.projects).toEqual(base.projects);
    expect(result.templateId).toBe(base.templateId);
    expect(result.customization).toEqual(base.customization);
  });

  it("keeps EVERY original skill (all 40 — none dropped for the job)", () => {
    for (const skill of base.skills) {
      expect(result.skills, `lost: ${skill}`).toContain(skill);
    }
    expect(result.skills.length).toBeGreaterThanOrEqual(base.skills.length + 8);
  });

  it("keeps company names, dates and job titles verbatim", () => {
    expect(result.experience.map((x) => [x.company, x.start, x.end])).toEqual([
      ["Pixelwerk Studio", "06/2024", "08/2024"],
      ["Markt Nord GmbH", "09/2022", "05/2023"],
    ]);
    expect(result.education[0]?.institution).toBe("Gesamtschule an der Weser");
  });
});

/* ------------------------------------------------------------------ */
/* 3. PROFIL — never disappears                                        */
/* ------------------------------------------------------------------ */

describe("PROFIL (summary) — detection, preservation, fallback", () => {
  it("FALLBACK: no original PROFIL + ungrounded model PROFIL → a deterministic, non-empty summary (never the section-less document)", () => {
    const result = mergeLong(AD_MARKETING); // hostile summary is ungrounded (10 Jahre, Google, Azure, C2)
    expect(result.summary.trim().length).toBeGreaterThan(0);
    // Names the applied-for position + company (ad facts — allowed).
    expect(result.summary).toContain("Mediengestalterin Digital Media");
    expect(result.summary).toContain("Nord Media GmbH");
    // Built from VERIFIED data only: the candidate's real experience/skills/education.
    expect(result.summary).toContain("Web-Praktikant");
    expect(result.summary).toContain("Abitur");
    // …and never from the hostile (unverified) model answer.
    expect(result.summary).not.toContain("Quantenphysik");
    expect(result.summary).not.toContain("10 Jahre");
    expect(result.summary).not.toContain("Azure");
  });

  it("keeps the ORIGINAL summary verbatim (any name/language of the section — here: the summary field) — never capped, never replaced by an ungrounded answer", () => {
    const originalWithProfil: CvDocument = {
      ...sanitizeCvDocument(LONG_ORIGINAL)!,
      summary:
        "Mein eigenes Profil: seit zwei Jahren im Webdesign aktiv — zuverlässig, kreativ und lernbereit. " +
        "Ich bringe Webdesign, Layout und WordPress mit und suche einen Ausbildungsplatz im Medienbereich, " +
        "in dem ich meine Kreativität und Sorgfalt einbringen kann und langfristig wachsen möchte.".repeat(3),
    };
    const result = mergeTailoredCvDocument({
      original: originalWithProfil,
      generated: hostileGenerated(),
      profileText: formatProfileForPrompt(PROFILE_LONG),
      ad: adInput(AD_MARKETING),
    })!;
    expect(result.summary).toBe(originalWithProfil.summary); // verbatim, even > 900 chars
  });

  it("accepts a GENERATED summary that names the ad's position (ad-grounded) while keeping candidate facts profile-grounded", () => {
    const generated = {
      ...hostileGenerated(),
      summary:
        "Motivierte Auszubildende für eine Ausbildung als Mediengestalterin Digital Media bei Nord Media GmbH " +
        "— mit Erfahrung in Webdesign, Layout und Kreativität, zuverlässig und teamorientiert.",
    };
    const result = mergeLong(AD_MARKETING, generated);
    expect(result.summary).toBe(generated.summary);
  });

  it("SHADOW TEST (fallback builder): a minimal candidate gets a minimal, honest summary (no experience/education claims)", () => {
    const short = importCandidateProfileToCv(PROFILE_SHORT);
    const s = buildFallbackSummary(short, {
      jobTitle: AD_MISSING.jobTitle,
      occupation: AD_MISSING.occupation,
      company: AD_MISSING.company,
    });
    expect(s).toContain("Hotelfachmann");
    expect(s).toContain("Gastro Süd KG");
    expect(s).toContain("Kassenarbeit");
    // No experience/education in the profile → no such claims.
    expect(s).not.toContain("Erfahrung als");
    expect(s).not.toContain("Abschluss");
  });
});

/* ------------------------------------------------------------------ */
/* 4. Honesty — levels/degrees/experience claims are reported, not added */
/* ------------------------------------------------------------------ */

describe("honesty guards — no fabricated facts", () => {
  const result = mergeLong(AD_MISSING);

  it("NEVER adds a language level (Englisch C2 not in profile → no Englisch/C2 anywhere new)", () => {
    expect(result.skills).not.toContain("Englisch C2");
    expect(result.skills).not.toContain("C2");
    expect(result.languages).toEqual(sanitizeCvDocument(LONG_ORIGINAL)!.languages); // 1:1
  });

  it("NEVER adds an education claim (Meisterbrief) or an experience claim (2 Jahre Erfahrung)", () => {
    expect(result.skills).not.toContain("Meisterbrief");
    expect(result.skills.filter((s) => /2 Jahre/.test(s))).toHaveLength(0);
  });

  it("the verification report exposes the honest gaps (partial level, missing degree)", () => {
    const report = verifyCvAgainstAd({ cv: result, extract: AD_MISSING });
    const en = report.items.find((i) => i.requirement === "Englisch C2")!;
    expect(en.status).toBe("partial");
    expect(en.detail).toContain("C2");
    expect(report.items.find((i) => i.requirement === "Meisterbrief")?.status).toBe("missing");
    expect(report.allCovered).toBe(false);
  });

  it("a model-invented skill without profile basis is still dropped (grounding intact)", () => {
    expect(result.skills).not.toContain("Azure-Cloud");
    expect(result.skills).not.toContain("Python-Entwicklung");
  });
});

/* ------------------------------------------------------------------ */
/* 5. De-duplication — symbol-aware, compound-aware, no duplicates     */
/* ------------------------------------------------------------------ */

describe("deduplication — distinct terms stay, variants merge once", () => {
  it("C, C++ and C# remain DISTINCT skills (no false merge)", () => {
    const original: CvDocument = { ...sanitizeCvDocument(LONG_ORIGINAL)!, skills: ["C", "C++", "C#"] };
    const result = mergeTailoredCvDocument({
      original,
      generated: { ...hostileGenerated(), summary: "" },
      profileText: "C, C++ und C# Programmierung",
      ad: { skillTerms: ["C"], summaryContext: {} }, // ad re-asks for C → already present
    })!;
    expect(result.skills).toContain("C");
    expect(result.skills).toContain("C++");
    expect(result.skills).toContain("C#");
    expect(result.skills.filter((s) => termKey(s) === termKey("C"))).toHaveLength(1);
    expect(result.tailoring?.addedFromAd).toBeUndefined(); // C was covered → nothing added
  });

  it("German compound variants merge (Netzwerktechnik ≡ Netzwerk-Technik — one entry, no added flag)", () => {
    const original: CvDocument = { ...sanitizeCvDocument(LONG_ORIGINAL)!, skills: ["Netzwerktechnik"] };
    const result = mergeTailoredCvDocument({
      original,
      generated: { ...hostileGenerated(), summary: "" },
      profileText: "Netzwerktechnik",
      ad: { skillTerms: ["Netzwerk-Technik"], summaryContext: {} },
    })!;
    expect(result.skills.filter((s) => s.toLowerCase().includes("netzwerk"))).toHaveLength(1);
    expect(result.tailoring?.addedFromAd).toBeUndefined();
  });

  it("a requirement covered in ANOTHER section is not duplicated into skills", () => {
    // "Kassenarbeit" is a skill of the SHORT profile; the ad asks for it → covered, no add.
    const result = mergeTailoredCvDocument({
      original: SHORT_ORIGINAL,
      generated: { ...hostileGenerated(), summary: "", skills: [] },
      profileText: formatProfileForPrompt(PROFILE_SHORT),
      ad: { skillTerms: ["Kassenarbeit", "Lagerlogistik"], summaryContext: adInput(AD_MISSING).summaryContext },
    })!;
    expect(result.skills.filter((s) => s === "Kassenarbeit")).toHaveLength(1);
    expect(result.skills).toContain("Lagerlogistik");
    expect(result.tailoring?.addedFromAd).toEqual(["Lagerlogistik"]);
  });
});

function termKey(v: string): string {
  return v.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9+#.&%]+/g, " ").replace(/ /g, "");
}

/* ------------------------------------------------------------------ */
/* 6. Different CV shapes (short CV, English skills, no summary)       */
/* ------------------------------------------------------------------ */

describe("different structures — short CV, English skills, Arabic name", () => {
  it("short CV: ad requirements are added, the minimal original is kept", () => {
    const result = mergeTailoredCvDocument({
      original: SHORT_ORIGINAL,
      generated: { ...hostileGenerated(), summary: "" },
      profileText: formatProfileForPrompt(PROFILE_SHORT),
      ad: { skillTerms: collectAddableSkillTerms(AD_MARKETING), summaryContext: adInput(AD_MARKETING).summaryContext },
    })!;
    expect(result.skills).toContain("Kassenarbeit"); // original kept
    for (const term of ["SEO", "Google Ads", "Excel", "Teamfähigkeit"]) {
      expect(result.skills).toContain(term);
    }
    expect(result.summary.trim()).not.toBe(""); // PROFIL created (target exists)
    expect(result.summary).toContain("Nord Media GmbH");
  });

  it("English-skills CV: English requirements are matched and added", () => {
    const ad = adExtractSchema.parse({
      company: "TechHelp GmbH",
      jobTitle: "IT Support",
      technicalSkills: ["Networking", "Troubleshooting"],
      softSkills: ["Communication", "Teamwork"],
    });
    const result = mergeTailoredCvDocument({
      original: EN_ORIGINAL,
      generated: { ...hostileGenerated(), summary: "" },
      profileText: formatProfileForPrompt(PROFILE_EN),
      ad: adInput(ad),
    })!;
    expect(result.skills).toContain("Networking"); // original kept
    expect(result.skills).toContain("Communication"); // original kept
    expect(result.skills).toContain("Troubleshooting"); // added from ad
    expect(result.skills).toContain("Teamwork"); // added from ad
    expect(result.tailoring?.addedFromAd).toEqual(expect.arrayContaining(["Troubleshooting", "Teamwork"]));
    const report = verifyCvAgainstAd({ cv: result, extract: ad });
    expect(report.allCovered).toBe(true);
  });

  it("a non-Latin (Arabic) full name is preserved 1:1 (no normalization damage)", () => {
    const profile = candidateProfileSchema.parse({
      goal: "ausbildung",
      candidate: { full_name: "سارة أحمد", location: "Berlin", country: "Deutschland", contact: { email: "sara@example.de", phone: "", linkedin: "" } },
      skills: { technical: ["Design"], software_tools: [], marketing: [], it: [], soft: [] },
      languages: [{ language: "Deutsch", level: "B2" }],
    });
    const original = importCandidateProfileToCv(profile);
    const result = mergeTailoredCvDocument({
      original,
      generated: { ...hostileGenerated(), summary: "" },
      profileText: formatProfileForPrompt(profile),
      ad: { skillTerms: ["Kommunikation"], summaryContext: { jobTitle: "Auszubildende:r Grafik", company: "Studio X" } },
    })!;
    expect(result.personal.fullName).toBe("سارة أحمد");
    expect(result.skills).toContain("Kommunikation");
  });
});

/* ------------------------------------------------------------------ */
/* 7. PDF — content parity + the existing overflow policy              */
/* ------------------------------------------------------------------ */

describe("PDF rendering — PROFIL + every skill survive into the document", () => {
  it("the rendered PDF contains the PROFIL section and ALL (original + ad-added) skills", async () => {
    const result = mergeLong(AD_MARKETING);
    const bytes = await generateCvPdf(result, { photoDataUrl: null, allowMultiPage: true });
    const pdf = await PDFDocument.load(bytes as unknown as Uint8Array);
    const text = extractAllText(pdf);
    // PROFIL is rendered (the section that used to disappear).
    expect(text).toContain("Profil");
    // Every original skill is in the PDF.
    for (const skill of ["Webdesign", "WordPress", "Zuverlässigkeit", "Pünktlichkeit", "Sicherungskonzepte"]) {
      expect(text, `missing in PDF: ${skill}`).toContain(skill);
    }
    // Every ad-added requirement is in the PDF.
    for (const skill of ["SEO", "Google Ads", "Excel", "Teamfähigkeit", "Analytisches Denken"]) {
      expect(text, `missing in PDF: ${skill}`).toContain(skill);
    }
  });

  it("overflow policy: a very long CV still throws WITHOUT opt-in (renderer contract)…", async () => {
    const huge: CvDocument = {
      ...sanitizeCvDocument(LONG_ORIGINAL)!,
      skills: Array.from({ length: 120 }, (_, i) => `Skill Nummer ${i} zum Testen`),
      experience: Array.from({ length: 14 }, (_, i) => ({
        id: `x${i}`,
        jobTitle: `Tätigkeit ${i}`,
        company: `Firma ${i} GmbH`,
        location: "",
        start: `${2010 + i}`,
        end: `${2011 + i}`,
        isCurrent: false,
        responsibilities: ["Punkt eins", "Punkt zwei", "Punkt drei", "Punkt vier", "Punkt fünf"],
        achievements: [],
      })),
    };
    await expect(generateCvPdf(huge, { photoDataUrl: null })).rejects.toBeInstanceOf(CvPdfOverflowError);
  });

  it("…and renders EVERYTHING on multiple pages WITH the existing opt-in (nothing deleted)", async () => {
    const huge: CvDocument = {
      ...sanitizeCvDocument(LONG_ORIGINAL)!,
      skills: Array.from({ length: 120 }, (_, i) => `Skill Nummer ${i} zum Testen`),
      experience: Array.from({ length: 14 }, (_, i) => ({
        id: `x${i}`,
        jobTitle: `Tätigkeit ${i}`,
        company: `Firma ${i} GmbH`,
        location: "",
        start: `${2010 + i}`,
        end: `${2011 + i}`,
        isCurrent: false,
        responsibilities: ["Punkt eins", "Punkt zwei", "Punkt drei", "Punkt vier", "Punkt fünf"],
        achievements: [],
      })),
    };
    const bytes = await generateCvPdf(huge, { photoDataUrl: null, allowMultiPage: true });
    const pdf = await PDFDocument.load(bytes as unknown as Uint8Array);
    expect(pdf.getPageCount()).toBeGreaterThanOrEqual(2);
    const text = extractAllText(pdf);
    // The LAST skill + the LAST job survive (no truncation anywhere).
    expect(text).toContain("Skill Nummer 119 zum Testen");
    expect(text).toContain("Firma 13 GmbH");
  });
});

/** Extract every text run of every page from the PDF content streams
 *  (WinAnsi — latin1 with the 0x80–0x9F supplement mapped). */
function extractAllText(pdf: PDFDocument): string {
  const ctx = (pdf as unknown as { context: { lookup: (r: unknown) => unknown } }).context;
  let out = "";
  for (let i = 0; i < pdf.getPageCount(); i += 1) {
    const node = pdf.getPage(i).node as unknown as { Contents: () => unknown };
    const arr = node.Contents() as unknown as { size: () => number; get: (n: number) => unknown };
    let stream = "";
    for (let k = 0; k < arr.size(); k += 1) {
      const item = arr.get(k);
      const s =
        item && typeof item === "object" && (item as { constructor?: { name?: string } }).constructor?.name === "PDFRef"
          ? ctx.lookup(item)
          : item;
      const raw = (s as { getContents: () => Uint8Array }).getContents();
      try {
        stream += inflateSync(raw).toString("latin1");
      } catch {
        stream += Buffer.from(raw).toString("latin1");
      }
    }
    // Text runs: ( … ) Tj  and  <hex> Tj
    for (const m of stream.matchAll(/\(((?:[^()\\]|\\.)*)\)\s*Tj/g)) {
      out += m[1].replace(/\\([()\\])/g, "$1") + "\n";
    }
    for (const m of stream.matchAll(/<([0-9A-Fa-f\s]+)>\s*Tj/g)) {
      const buf = Buffer.from(m[1].replace(/\s+/g, ""), "hex");
      out += buf.toString("latin1").replace(/[\u0080-\u009f]/g, "") + "\n";
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 8. Source contracts — routes, UI, prompts, i18n (the wiring)        */
/* ------------------------------------------------------------------ */

describe("pipeline wiring — routes, UI and prompts carry the coverage contract", () => {
  it("generate-cv route: passes the ad requirements + position context to the merge and returns the verification report", () => {
    const route = read("src/app/api/auto-bewerb/generate-cv/route.ts");
    expect(route).toContain("collectAddableSkillTerms(extract)");
    expect(route).toContain("summaryContext: {");
    expect(route).toContain("verifyCvAgainstAd({ cv: doc, extract })");
    expect(route).toContain("{ cv: doc, photo: photoRef, verification }");
  });

  it("export-pdf route: overflow → the renderer's multi-page mode (content is never deleted)", () => {
    const route = read("src/app/api/auto-bewerb/export-pdf/route.ts");
    expect(route).toContain("generateCvPdf(cv, { photoDataUrl })");
    expect(route).toContain("allowMultiPage: true");
    // The 502 overflow dead-end for the CV is gone (the letter path is untouched).
    const cvPart = route.slice(route.indexOf("if (doc === \"cv\")"), route.indexOf("// letter"));
    expect(cvPart).not.toContain('code: error.code');
  });

  it("Step-4 UI: the requirement-coverage panel is wired into the preview (before export)", () => {
    const step4 = read("src/components/auto-bewerb/step4-cv-generation.tsx");
    expect(step4).toContain("RequirementVerificationPanel");
    expect(step4).toContain("verifyCvAgainstAd({ cv: previewDoc, extract: previewView.company.ad_extracted })");
    expect(step4).toContain("report.allCovered");
    expect(step4).toContain("i.addedFromAd");
  });

  it("the extraction prompt is exhaustive (no 10-item sample, explicit soft-skill categories)", () => {
    const src = read("src/lib/studio/prompts.ts");
    expect(src).toContain("VOLLSTÄNDIGKEIT (wichtigste Regel)");
    expect(src).toContain("Teamfähigkeit, Kommunikationsstärke/-fähigkeit, Eigeninitiative, Organisationstalent");
    expect(src).toContain("JEDE genannte Sprache zusammen mit ihrem Niveau");
    expect(src).toContain("klassifiziere ALLE extrahierten Anforderungen");
    expect(src).not.toContain("max. 10 Einträge pro Liste");
  });

  it("the CV prompt tells the model the platform auto-adds missing ad requirements (no model-side invention)", () => {
    const src = read("src/lib/auto-bewerb/prompts.ts");
    expect(src).toContain("die PLATFORM fügt fehlende, skill-artige Anforderungen der Anzeige automatisch in den Lebenslauf ein");
    expect(src).toContain("AUS DIESER ANZEIGE (ZIELSTELLE — das ist erlaubt und erwartet");
    // The match report reaches the model un-sampled.
    expect(src).not.toContain("analysis.matched.slice(0, 10)");
  });

  it("the letter prompt forbids unverified company claims (site visits, products, culture, contacts, sources)", () => {
    const src = read("src/lib/auto-bewerb/prompts.ts");
    expect(src).toContain("KEIN 'ich habe Ihre Website besucht'");
    expect(src).toContain("KEINE Aussagen über die Unternehmenskultur oder Team");
    expect(src).toContain("KEINE behaupteten Kontakte zu Mitarbeiter:innen");
    expect(src).toContain("KEIN 'über <Portal/Plattform> gesehen'");
    expect(src).toContain("Fit-Argumentation");
    expect(src).toContain("NUR diese über das Unternehmen behaupten");
  });

  it("the schema no longer caps language requirements at 10 (20 accepted)", () => {
    const extract = adExtractSchema.parse({
      languageRequirements: Array.from({ length: 20 }, (_, i) => `Sprache ${i}`),
    });
    expect(extract.languageRequirements).toHaveLength(20);
  });

  it("the i18n coverage keys ship in all four languages", () => {
    const dict = read("src/lib/i18n/dictionaries.ts");
    for (const key of [
      "cvVerifyTitle:",
      "cvVerifyCovered:",
      "cvVerifyAllCovered:",
      "cvVerifyGaps:",
      "cvVerifyAddedTitle:",
      "cvVerifyAddedHint:",
      "cvVerifyShowAll:",
      "cvVerifySection:",
      "cvVerifyAddedBadge:",
      "cvVerifyCategoryTechnical:",
    ]) {
      const count = dict.split(key).length - 1;
      expect(count, `i18n key "${key}" must exist in de+en+fr+ar (found ${count})`).toBeGreaterThanOrEqual(4);
    }
  });

  it("CvDocument persists the tailoring trace through sanitizeCvDocument (round-trip)", () => {
    const withTrace: CvDocument = { ...sanitizeCvDocument(LONG_ORIGINAL)!, skills: ["SEO"], tailoring: { addedFromAd: ["SEO", "Excel"] } };
    const back = sanitizeCvDocument(withTrace)!;
    expect(back.tailoring?.addedFromAd).toEqual(["SEO", "Excel"]);
    expect(sanitizeCvDocument({ ...LONG_ORIGINAL, tailoring: { addedFromAd: "not-an-array" } })!.tailoring).toBeUndefined();
  });
});
