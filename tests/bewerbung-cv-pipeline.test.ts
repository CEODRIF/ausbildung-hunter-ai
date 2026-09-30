import { describe, expect, it } from "vitest";
import { extractPdfText } from "@/lib/pdf-extract";
import {
  buildScannerPrompt,
  buildSparseRetryPrompt,
} from "@/lib/bewerbung-scanner-prompt";
import { candidateProfileSchema } from "@/lib/bewerbung-schema";
import { normalizeAiProfileResponse } from "@/lib/bewerbung-profile-normalize";
import {
  DE_CV_LINES,
  MESSY_CAMEL_PROFILE,
  REALISTIC_PROFILE,
  buildGermanCvPdf,
} from "./fixtures/de-cv";

/**
 * End-to-end pipeline regression for a REALISTIC GERMAN LEbenslauf:
 *
 *   PDF → text extraction → scanner prompt (mocked AI response) →
 *   normalization → candidateProfileSchema → complete profile.
 *
 * The AI model is mocked with deterministic, realistic responses (see
 * fixtures/de-cv.ts): the live model is non-deterministic, these pin the
 * CONTRACT the prompt must produce and the pipeline must preserve.
 */

type ParsedProfile = {
  candidate: {
    full_name: string | null;
    contact: { email: string | null; phone: string | null };
  };
  goal: string;
  education: Array<Record<string, unknown>>;
  training: Array<{ name: string; provider: string | null; year: string | null }>;
  experience: Array<{
    job_title: string;
    company: string | null;
    responsibilities: string[];
    start_date: string | null;
    end_date: string | null;
    type: string;
  }>;
  skills: Record<string, string[]>;
  languages: Array<{
    language: string;
    level: string | null;
    level_is_inferred: boolean;
  }>;
  target_roles: Array<{ role: string; reason: string }>;
  strengths: string[];
  missing_information: string[];
  potential_concerns: string[];
  keywords: string[];
};

function runPipeline(raw: string, goal: "ausbildung" | "arbeit"): ParsedProfile {
  const normalized = normalizeAiProfileResponse(raw, goal);
  const parsed = candidateProfileSchema.safeParse(normalized);
  if (!parsed.success) {
    throw new Error(
      "schema failed: " +
        parsed.error.issues
          .slice(0, 8)
          .map((i) => `${i.path.join(".")}: ${i.code}`)
          .join(", "),
    );
  }
  return parsed.data as unknown as ParsedProfile;
}

describe("German CV pipeline: extraction → prompt → (mocked AI) → normalize → schema", () => {
  it("embeds the ENTIRE extracted CV in the prompt — no truncation (§16)", async () => {
    const text = await extractPdfText(buildGermanCvPdf());
    // Simulates buildFileContext's per-file block exactly.
    const context = `FILE Lebenslauf_Lara_Müller.pdf\n${text}`;
    const prompt = buildScannerPrompt("ausbildung", context);

    // Every line of the CV must reach the model. PDF text extraction may
    // collapse runs of spaces (alignment), so compare on whitespace-
    // normalized text — the invariant under test is COMPLETENESS, not the
    // exact inter-column spacing.
    const normWs = (s: string) => s.replace(/\s+/g, " ").trim();
    const promptNorm = normWs(prompt);
    for (const line of DE_CV_LINES) {
      if (!line.text) continue;
      expect(promptNorm, `CV line must be in the prompt: "${line.text}"`).toContain(
        normWs(line.text),
      );
    }
    // The context block appears verbatim and ends the prompt.
    expect(prompt.endsWith(context)).toBe(true);
    expect(prompt).toContain("Goal: ausbildung");
    expect(prompt).toContain('"goal": "ausbildung"');

    // §16 measurement: a realistic CV stays far below any modern context.
    // (logged for the record, asserted as a hard ceiling)
    const approxTokens = Math.ceil(prompt.length / 4);
    expect(prompt.length).toBeGreaterThan(2000); // full CV + full prompt
    expect(prompt.length).toBeLessThan(30_000);
    expect(approxTokens).toBeLessThan(10_000);
  }, 30000);

  it("prompt instructs a real CV analysis, not a summary (§3–§11)", () => {
    const prompt = buildScannerPrompt("ausbildung", "FILE cv.pdf\nTest");
    // comprehensiveness
    expect(prompt).toContain("Reconstruct a COMPLETE structured candidate profile");
    expect(prompt).toContain("Read the ENTIRE document");
    expect(prompt).toContain("Do not stop after finding education, skills, or languages");
    // language handling
    for (const lang of ["German, English, French, Arabic"])
      expect(prompt).toContain(lang);
    // German terminology glossaries
    for (const term of [
      "Schulbildung",
      "Berufsausbildung",
      "Werkstudent",
      "Praktikum",
      "Sprachkenntnisse",
      "IT-Kenntnisse",
      "Muttersprache",
      "Verhandlungssicher",
    ])
      expect(prompt).toContain(term);
    // never drop an entry for unclear dates
    expect(prompt).toContain(
      "NEVER drop an entry just because dates are unclear",
    );
    // Ausbildung is its own category
    expect(prompt).toContain("do NOT confuse it with Schulbildung");
    // target roles evidence rule
    expect(prompt).toContain("ONLY roles supported by the candidate's actual facts");
    // no generic strengths
    expect(prompt).toContain("NO generic personality claims");
    // concerns only with evidence
    expect(prompt).toContain("NEVER manufacture negative concerns");
    // security model intact
    expect(prompt).toContain("UNTRUSTED REFERENCE MATERIAL");
    expect(prompt).toContain("Never invent");
  });

  it("sparse retry prompt names the empty sections and forbids invention (§17)", () => {
    const prompt = buildSparseRetryPrompt(
      "ausbildung",
      "FILE cv.pdf\nTest",
      ["experience (Berufserfahrung)", "target_roles (Zielfunktionen)"],
    );
    expect(prompt).toContain("INCOMPLETE FIRST PASS (controlled retry)");
    expect(prompt).toContain("experience (Berufserfahrung)");
    expect(prompt).toContain("target_roles (Zielfunktionen)");
    expect(prompt).toContain("never invent");
  });

  it("perfect AI answer (fenced + commentary) → complete German profile", async () => {
    const raw =
      "Gerne analysiere ich den Lebenslauf.\n```json\n" +
      JSON.stringify(REALISTIC_PROFILE) +
      "\n```\n";
    const profile = runPipeline(raw, "ausbildung");

    // candidate
    expect(profile.candidate.full_name).toBe("Lara Müller");
    expect(profile.candidate.contact.email).toBe("lara.mueller@example.com");
    expect(profile.candidate.contact.phone).toBe("+49 151 23456789");
    // education: two SEPARATE entries, original qualification names kept
    expect(profile.education).toHaveLength(2);
    expect(profile.education[0].university).toBe("Universität zu Köln");
    expect(profile.education[0].field_of_study).toBe("English Studies");
    expect(profile.education[0].graduation_year).toBe(2026);
    expect(profile.education[1].school).toBe("Berthold-Schmidt-Gymnasium Köln");
    expect(profile.education[1].degree).toBe("Abitur");
    // training (Ausbildung/Weiterbildung) — first-class, separate from education
    expect(profile.training).toHaveLength(2);
    expect(profile.training[0].name).toBe("Zertifikat Online-Marketing");
    expect(profile.training[0].provider).toBe("IHK Köln");
    // experience: every entry incl. the one without end date
    expect(profile.experience).toHaveLength(3);
    expect(profile.experience[0].job_title).toBe("Werkstudentin Online-Marketing");
    expect(profile.experience[0].company).toBe("Muster E-Commerce GmbH, Köln");
    expect(profile.experience[0].responsibilities).toHaveLength(3);
    expect(profile.experience[1].job_title).toBe(
      "Praktikum E-Commerce & Affiliate Marketing",
    );
    expect(profile.experience[2].start_date).toBe("2024");
    expect(profile.experience[2].end_date).toBeNull();
    // skills across groups
    expect(profile.skills.technical).toEqual(
      expect.arrayContaining(["E-Commerce", "SEO", "SEA", "Affiliate Marketing"]),
    );
    expect(profile.skills.software_tools).toEqual(
      expect.arrayContaining(["MS Excel", "MS PowerPoint"]),
    );
    // languages: exact document wording kept, not "normalized"
    expect(profile.languages).toHaveLength(3);
    const byLang = Object.fromEntries(
      profile.languages.map((l) => [l.language, l.level]),
    );
    expect(byLang["Arabisch"]).toBe("Muttersprache");
    expect(byLang["Englisch"]).toBe("B2");
    expect(byLang["Deutsch"]).toBe("B1");
    expect(profile.languages.every((l) => l.level_is_inferred === false)).toBe(
      true,
    );
    // target roles: evidence-based, each with a reason
    expect(profile.target_roles.length).toBeGreaterThanOrEqual(3);
    for (const role of profile.target_roles) {
      expect(role.role.length).toBeGreaterThan(0);
      expect(role.reason.length).toBeGreaterThan(10);
    }
    // strengths: evidence-based (cite document facts), not generic
    expect(profile.strengths.length).toBeGreaterThanOrEqual(3);
    expect(profile.strengths.join(" ")).toMatch(/Praktikum|Werkstudent/);
    // missing info + concerns + keywords populated
    expect(profile.missing_information.length).toBeGreaterThanOrEqual(1);
    expect(profile.potential_concerns.length).toBeGreaterThanOrEqual(1);
    expect(profile.keywords.length).toBeGreaterThanOrEqual(10);
    expect(profile.keywords).toEqual(expect.arrayContaining(["SEO", "E-Commerce"]));
  }, 30000);

  it("messy real-world answer (wrapper + camelCase + malformed bits) → same complete profile (§15)", () => {
    const raw = JSON.stringify(MESSY_CAMEL_PROFILE);
    const profile = runPipeline(raw, "ausbildung");

    // goal is the SERVER row's goal — never the model's
    expect(profile.goal).toBe("ausbildung");
    // education survives camelCase conversion
    expect(profile.education).toHaveLength(2);
    expect(profile.education[0].field_of_study).toBe("English Studies");
    expect(profile.education[0].graduation_year).toBe(2026); // "2026" → 2026
    // ALL three jobs survive, incl. entries with NO dates
    expect(profile.experience).toHaveLength(3);
    expect(profile.experience[0].job_title).toBe("Werkstudentin Online-Marketing");
    // comma-string responsibilities became an array
    expect(profile.experience[0].responsibilities).toHaveLength(3);
    // invalid type "job" normalized, valid "internship" kept
    expect(profile.experience[0].type).toBe("employment");
    expect(profile.experience[1].type).toBe("internship");
    expect(profile.experience[1].start_date).toBeNull();
    // skills: comma-string group became an array
    expect(profile.skills.technical).toEqual([
      "E-Commerce",
      "SEO",
      "SEA",
      "Affiliate Marketing",
    ]);
    // languages: numeric flag → boolean, levels kept verbatim
    expect(profile.languages).toHaveLength(3);
    expect(
      profile.languages.find((l) => l.language === "Arabisch")?.level,
    ).toBe("Muttersprache");
    expect(
      profile.languages.every((l) => typeof l.level_is_inferred === "boolean"),
    ).toBe(true);
    // target role with missing reason → backfilled from role
    const om = profile.target_roles.find((r) =>
      r.role.includes("Online-Marketing-Fachkraft"),
    );
    expect(om?.reason).toBe("Online-Marketing-Fachkraft");
    // German values with umlauts survive untouched
    expect(profile.experience[0].company).toBe("Muster E-Commerce GmbH, Köln");
    expect(profile.skills.soft).toEqual(
      expect.arrayContaining(["Übersetzungen Deutsch / Englisch / Arabisch"]),
    );
  });

  it("long German compound job title with umlauts survives the whole pipeline", () => {
    const raw = JSON.stringify({
      ...REALISTIC_PROFILE,
      experience: [
        {
          job_title: "Mechatroniker für Kälte-, Klima- und Wärmetechnik",
          company: "Kältebau Beispiel AG, Düsseldorf",
          responsibilities: ["Montage und Instandhaltung von Kälteanlagen"],
          start_date: "2018",
          end_date: "2021",
          type: "employment",
          source: "ai_extracted",
        },
      ],
    });
    const profile = runPipeline(raw, "arbeit");
    expect(profile.experience[0].job_title).toBe(
      "Mechatroniker für Kälte-, Klima- und Wärmetechnik",
    );
    expect(profile.experience[0].company).toBe(
      "Kältebau Beispiel AG, Düsseldorf",
    );
  });

  it("mixed German/English terminology passes through untranslated", () => {
    const raw = JSON.stringify({
      ...REALISTIC_PROFILE,
      experience: [
        {
          job_title: "Marketing Intern (Werkstudentin)",
          company: "Example Retail GmbH, Köln",
          responsibilities: ["Support for SEO campaigns and social media"],
          start_date: "2024",
          end_date: "2025",
          type: "internship",
          source: "ai_extracted",
        },
      ],
      keywords: ["Digital Marketing", "Social Media", "SEO", "Werkstudentin"],
    });
    const profile = runPipeline(raw, "ausbildung");
    expect(profile.experience[0].job_title).toBe("Marketing Intern (Werkstudentin)");
    expect(profile.keywords).toEqual(
      expect.arrayContaining(["Digital Marketing", "Werkstudentin"]),
    );
  });
});
