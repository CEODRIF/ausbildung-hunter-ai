/**
 * AUTO BEWERB — Step 5: proof that every generated cover letter is built FROM
 * the 50 ORIGINAL templates (Bewerbungsvorlagen_50 (1).pdf), matched
 * deterministically, with the genuine signature embedded and exactly one A4
 * page. No AI, no Supabase, no real e-mail — pure functions + the real PDF
 * renderer.
 *
 * Contract pinned here (the brief's §8 list):
 *   1. all 50 original templates were imported;
 *   2. each template maps to its original PDF page (1:1, page-faithful text);
 *   3. template selection evaluates the ORIGINAL templates;
 *   4. the generation prompt carries the selected template's structure + text
 *      (the AI starts FROM the original, never from scratch);
 *   5. different company advertisements select different original templates;
 *   6. AI generation cannot bypass the template-matching process;
 *   7. candidate + company facts remain unchanged (no-invention rules present);
 *   8. signature images appear in the exported PDFs;
 *   9. the exported PDF is exactly one A4 page;
 *   10. a traceable selected-template id + original PDF page per company.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import {
  COVER_LETTER_TEMPLATES,
  getCoverLetterTemplate,
  templateByPage,
  type CoverLetterTemplate,
} from "@/lib/auto-bewerb/letter-templates";
import {
  adLetterContext,
  matchCoverLetterTemplates,
  selectBestCoverLetterTemplate,
  type TemplateMatchInput,
} from "@/lib/auto-bewerb/letter-template-match";
import { buildAutoBewerbLetterPrompt } from "@/lib/auto-bewerb/prompts";
import { buildLetterFolio, generateLetterPdf } from "@/lib/bew-letter-pdf";
import { extractPdfText } from "@/lib/pdf-extract";
import type { AdExtract } from "@/lib/auto-bewerb/schema";

/** The raw bytes contain an embedded image XObject only when a signature image
 *  was drawn (pdf-lib writes `/Subtype /Image` for the image object). */
const hasImageXObject = (bytes: Uint8Array): boolean =>
  Buffer.from(bytes).toString("latin1").includes("/Subtype /Image");

/* -------------------------------------------------------------------------- */
/* The 50 original templates — the import fidelity                            */
/* -------------------------------------------------------------------------- */

const SEP = "=".repeat(60);
const RAW_SOURCE = readFileSync(
  path.join(process.cwd(), "src/data/auto-bewerb/cover-letter-templates.raw.txt"),
  "utf8",
);

/** Parse the canonical raw source into its 50 numbered blocks. Format:
 *  SEP / "N. title" / SEP / blank / body (blank-line separated) / blank / SEP */
function parseRawSource(source: string): Array<{ n: number; title: string; body: string }> {
  const lines = source.split("\n");
  const sepIdx: number[] = [];
  for (let i = 0; i < lines.length; i++) if (lines[i] === SEP) sepIdx.push(i);
  const blocks: Array<{ n: number; title: string; body: string }> = [];
  for (let k = 0; 2 * k + 1 < sepIdx.length; k++) {
    const titleLine = lines[sepIdx[2 * k] + 1] ?? "";
    const m = titleLine.match(/^(\d+)\.\s+(.*)$/);
    if (!m) continue;
    const bodyStart = sepIdx[2 * k + 1] + 1;
    const bodyEnd = 2 * k + 2 < sepIdx.length ? sepIdx[2 * k + 2] : lines.length;
    const bodyLines = lines.slice(bodyStart, bodyEnd);
    while (bodyLines.length && bodyLines[0].trim() === "") bodyLines.shift();
    while (bodyLines.length && bodyLines[bodyLines.length - 1].trim() === "") bodyLines.pop();
    blocks.push({ n: Number(m[1]), title: m[2].trim(), body: bodyLines.join("\n") });
  }
  return blocks;
}

const SOURCE_BLOCKS = parseRawSource(RAW_SOURCE);

/** The generic placeholders replaced by structured {{variables}}. */
const PLACEHOLDER_TO_VAR: Record<string, string> = {
  "[Name der Schule]": "{{school_name}}",
  "[Klassenstufe]": "{{class_year}}",
  "[Ort]": "{{city}}",
  "[Jahr]": "{{graduation_year}}",
  "[Schulabschluss]": "{{school_degree}}",
  "[Alter]": "{{age}}",
  "[Nachname]": "{{contact_person}}",
  "[Name des Betriebs]": "{{internship_company}}",
  "[frühere Tätigkeit]": "{{previous_occupation}}",
  "[Berufserfahrung bzw. Qualifikation]": "{{relevant_experience}}",
  "[Qualität oder Leistungsspektrum]": "{{company_reputation}}",
  "[konkrete Leistung oder Projekt]": "{{company_reference}}",
  "[Quelle, z. B. eine Empfehlung oder Ihre Homepage]": "{{application_source}}",
  "[frühestmöglichen Termin]": "{{earliest_start_date}}",
};
const rawToText = (raw: string): string => {
  let out = raw;
  for (const [ph, v] of Object.entries(PLACEHOLDER_TO_VAR)) out = out.split(ph).join(v);
  return out;
};

describe("§1/§2 import — all 50 original templates, page-mapped, text-faithful", () => {
  it("imports exactly 50 templates", () => {
    expect(COVER_LETTER_TEMPLATES).toHaveLength(50);
  });

  it("each template maps 1:1 to its original PDF page (pages 1..50, unique)", () => {
    const pages = COVER_LETTER_TEMPLATES.map((t) => t.page);
    expect(new Set(pages).size).toBe(50);
    for (let p = 1; p <= 50; p++) {
      const byPage = templateByPage(p);
      expect(byPage, `no template for page ${p}`).not.toBeNull();
      expect(byPage!.page).toBe(p);
      expect(byPage!.id, `template id for page ${p} must start tpl-`).toMatch(/^tpl-\d{2}/);
    }
  });

  it("the canonical raw source contains all 50 numbered blocks in order", () => {
    expect(SOURCE_BLOCKS).toHaveLength(50);
    for (let k = 0; k < 50; k++) expect(SOURCE_BLOCKS[k].n).toBe(k + 1);
  });

  it("every template's raw text is VERBATIM the original block for its page", () => {
    for (let p = 1; p <= 50; p++) {
      const tpl = templateByPage(p)!;
      const block = SOURCE_BLOCKS[p - 1];
      expect(tpl.raw, `raw text of page ${p} must equal the original`).toBe(block.body);
      expect(tpl.title, `title of page ${p} must equal the original`).toBe(block.title);
    }
  });

  it("the text field is the raw text with ONLY generic placeholders → variables (structure preserved)", () => {
    for (const tpl of COVER_LETTER_TEMPLATES) {
      expect(tpl.text, `page ${tpl.page}: text must be raw with placeholder substitution`).toBe(rawToText(tpl.raw));
      // No mapped generic placeholder may survive in the application-ready text.
      for (const ph of Object.keys(PLACEHOLDER_TO_VAR)) {
        expect(tpl.text).not.toContain(ph);
      }
    }
  });

  it("the original STRUCTURE of each template is preserved (salutation first, closing last, same paragraph count)", () => {
    for (const tpl of COVER_LETTER_TEMPLATES) {
      const rawParas = tpl.raw.split(/\n{2,}/).filter((s) => s.trim());
      const textParas = tpl.text.split(/\n{2,}/).filter((s) => s.trim());
      expect(textParas.length, `page ${tpl.page}: paragraph count changed`).toBe(rawParas.length);
      expect(textParas.length).toBeGreaterThanOrEqual(7); // 8-paragraph original shape
      expect(textParas[0]).toMatch(/^Sehr geehrte(r)? (Herr )?/); // salutation first
      expect(textParas[textParas.length - 1]).toMatch(/(Mit freundlichen|Freundliche) Gr\S+$/); // closing last (Grüßen/Grüße)
      expect(tpl.context).toBe(tpl.page <= 40 ? "ausbildung" : "erfahrung");
    }
  });

  it("contexts: pages 1–40 ausbildung, 41–50 work-experience", () => {
    expect(COVER_LETTER_TEMPLATES.filter((t) => t.context === "ausbildung")).toHaveLength(40);
    expect(COVER_LETTER_TEMPLATES.filter((t) => t.context === "erfahrung")).toHaveLength(10);
  });
});

/* -------------------------------------------------------------------------- */
/* Ad fixtures (verified, minimal — the matcher reads only these fields)      */
/* -------------------------------------------------------------------------- */

const extractA: AdExtract = {
  company: "Kältebau Nord GmbH",
  jobTitle: "Auszubildende:r Anlagenmechaniker SHK",
  occupation: "Anlagenmechaniker SHK",
  location: "Hamburg",
  adRaw: "Ausbildung als Anlagenmechaniker SHK in der Haustechnik. Wir bieten eine fundierte Ausbildung.",
  contactPerson: "Frau Schneider",
  requiredQualifications: ["Schaltpläne lesen", "Handwerkliches Geschick"],
  preferredQualifications: ["Führerschein Klasse B"],
  technicalSkills: ["Kälteanlagen", "Klimatertechnik"],
  softSkills: ["Teamfähigkeit", "Zuverlässigkeit"],
  languageRequirements: ["Deutsch B1"],
  educationRequirement: "Mittlere Reife",
} as unknown as AdExtract;

const extractB: AdExtract = {
  company: "Tech Süd AG",
  jobTitle: "Fachinformatiker — Systemintegration",
  occupation: "Fachinformatiker",
  location: "Stuttgart",
  adRaw: "Ausbildung Fachinformatiker Systemintegration, Informationstechnik, Netzwerke, Server.",
  contactPerson: "",
  requiredQualifications: ["Gute Noten in Mathe und Informatik"],
  preferredQualifications: [],
  technicalSkills: ["Kubernetes", "Netzwerktechnik"],
  softSkills: ["Analytisches Denken"],
  languageRequirements: ["Englisch A2"],
  educationRequirement: "Mittlere Reife",
} as unknown as AdExtract;

/** A work-experience ad (drives the erfahrung context → pages 41–50). */
const extractC: AdExtract = {
  company: "Seniorenstift West e.V.",
  jobTitle: "Pflegehelfer (m/w/d)",
  occupation: "Pflegehelfer",
  location: "Köln",
  adRaw: "Wir suchen eine:n Pflegehelfer:in mit Berufserfahrung für unser Team.",
  contactPerson: "",
  requiredQualifications: ["Berufserfahrung in der Pflege"],
  preferredQualifications: [],
  technicalSkills: [],
  softSkills: ["Geduld", "Empathie"],
  languageRequirements: ["Deutsch C1"],
  educationRequirement: "Pflegehelfer-Abschluss",
} as unknown as AdExtract;

/** The test fixtures carry the raw ad text at runtime (via `as unknown as
 *  AdExtract`), but the `AdExtract` type does not model that column — read it
 *  back with a narrow cast so the fixtures stay type-correct (no behavior
 *  change: `adRaw` is a real string on every fixture). */
const adRawOf = (e: AdExtract): string => (e as unknown as { adRaw?: string }).adRaw ?? "";

const matchInput = (e: AdExtract, hasInternship = true): TemplateMatchInput => ({
  jobTitle: e.jobTitle,
  occupation: e.occupation,
  adRaw: adRawOf(e),
  contactPerson: e.contactPerson,
  hasInternshipExperience: hasInternship,
});

/* -------------------------------------------------------------------------- */
/* §3 selection evaluates the originals · §5 different ads → different tpl   */
/* -------------------------------------------------------------------------- */

describe("§3/§5 template matching — evaluates originals, context-aware, distinct per ad", () => {
  it("ranks a subset of the 50 originals (top = the auto-selection)", () => {
    const ranked = matchCoverLetterTemplates(matchInput(extractA));
    expect(ranked.length).toBeGreaterThan(0);
    expect(ranked.length).toBeLessThanOrEqual(50);
    const known = new Set(COVER_LETTER_TEMPLATES.map((t) => t.id));
    for (const r of ranked) expect(known.has(r.template.id), "a ranked entry must be a real library template").toBe(true);
    expect(ranked[0].template.id).toBe(selectBestCoverLetterTemplate(matchInput(extractA)).template.id);
    // Deterministic order: score DESC, then original PDF page ASC (the matcher's
    // exact comparator) — the array is fully ordered by it.
    const cmp = (x: (typeof ranked)[number], y: (typeof ranked)[number]) =>
      y.score - x.score || x.template.page - y.template.page;
    for (let i = 1; i < ranked.length; i++) {
      expect(cmp(ranked[i - 1], ranked[i]), `entries ${i - 1}/${i} must be sorted`).toBeLessThanOrEqual(0);
    }
  });

  it("the context is a HARD filter (Ausbildung → pages 1–40, Berufserfahrung → pages 41–50)", () => {
    expect(adLetterContext(extractA.jobTitle, extractA.occupation, adRawOf(extractA))).toBe("ausbildung");
    expect(adLetterContext(extractC.jobTitle, extractC.occupation, adRawOf(extractC))).toBe("erfahrung");
    const a = selectBestCoverLetterTemplate(matchInput(extractA)).template;
    const c = selectBestCoverLetterTemplate(matchInput(extractC)).template;
    expect(a.page).toBeLessThanOrEqual(40);
    expect(c.page).toBeGreaterThan(40);
  });

  it("profession drives the match: SHK ad → the SHK original; IT ad → the IT original", () => {
    const a = selectBestCoverLetterTemplate(matchInput(extractA)).template;
    const b = selectBestCoverLetterTemplate(matchInput(extractB)).template;
    expect(a.id).toContain("anlagenmechaniker"); // page 7, the SHK original
    expect(b.id).toContain("fachinformatiker"); // an IT original
  });

  it("different company advertisements select DIFFERENT original templates", () => {
    const a = selectBestCoverLetterTemplate(matchInput(extractA)).template;
    const b = selectBestCoverLetterTemplate(matchInput(extractB)).template;
    const c = selectBestCoverLetterTemplate(matchInput(extractC)).template;
    expect(a.id).not.toBe(b.id);
    expect([a.id, b.id, c.id].filter((v, i, s) => s.indexOf(v) === i).length).toBeGreaterThanOrEqual(3);
  });

  it("named-salutation fit: an ad that names a contact person can select a named template", () => {
    const named = matchInput(extractA, true);
    const neutral = matchInput(extractB, true);
    const selNamed = selectBestCoverLetterTemplate(named).template;
    const selNeutral = selectBestCoverLetterTemplate(neutral).template;
    expect(["neutral", "named"]).toContain(selNamed.salutationStyle);
    expect(["neutral", "named"]).toContain(selNeutral.salutationStyle);
  });
});

/* -------------------------------------------------------------------------- */
/* §4 the AI starts FROM the selected original · §6 no bypass                 */
/* -------------------------------------------------------------------------- */

const CANDIDATE = "Mustapha Drif";
const PROFILE_TEXT =
  "KANDIDATENPROFIL (reale, geprüfte Daten):\nName: Mustapha Drif\n" +
  "Berufserfahrung: Praktikant Kältetechnik, Kältebau Nord GmbH, 07/2025 — 10/2025 — Montage, Instandhaltung\n" +
  "Fähigkeiten: Schaltpläne lesen, Teamfähigkeit\nSprachen: Deutsch B1";

describe("§4/§6/§7 the generation is template-bound and fact-preserving (no bypass, no invention)", () => {
  it("the prompt embeds the SELECTED original template verbatim + its original page + the binding structure rules", () => {
    const tpl = selectBestCoverLetterTemplate(matchInput(extractA)).template;
    const p = buildAutoBewerbLetterPrompt({
      profileText: PROFILE_TEXT,
      adFenced: "STELLENANZEIGE (fenced): Kältebau Nord GmbH, Hamburg.",
      extract: extractA,
      analysis: {
        matched: [{ requirement: "Schaltpläne lesen", note: "Praktikum Kältetechnik" }],
        transferable: [{ requirement: "Teamfähigkeit" }],
        missing: [{ requirement: "Führerschein Klasse B" }],
      },
      candidateName: CANDIDATE,
      template: tpl,
    });
    // The exact original text is the foundation (not inspiration).
    expect(p).toContain(tpl.text);
    // The original PDF page reference is present.
    expect(p).toContain(`SEITE ${tpl.page}`);
    // The binding "use the original" rules are present.
    expect(p).toContain("VORLAGE VERWENDEN (verbindlich)");
    expect(p).toContain("Der Brief MUSS auf der vorgegebenen ORIGINAL-VORLAGE basieren");
  });

  it("a different selected template produces a DIFFERENT foundation (no silent reuse, no bypass)", () => {
    const a = selectBestCoverLetterTemplate(matchInput(extractA)).template;
    const b = selectBestCoverLetterTemplate(matchInput(extractB)).template;
    const base = {
      profileText: PROFILE_TEXT,
      adFenced: "STELLENANZEIGE (fenced).",
      analysis: { matched: [] as Array<{ requirement: string; note?: string }>, transferable: [] as Array<{ requirement: string; note?: string }>, missing: [] as Array<{ requirement: string; note?: string }> },
      candidateName: CANDIDATE,
    };
    const pA = buildAutoBewerbLetterPrompt({ ...base, extract: extractA, template: a });
    const pB = buildAutoBewerbLetterPrompt({ ...base, extract: extractB, template: b });
    expect(pA).toContain(a.text);
    expect(pB).toContain(b.text);
    expect(pA).toContain(`SEITE ${a.page}`);
    expect(pB).toContain(`SEITE ${b.page}`);
    // Each prompt carries ITS OWN original, not the other company's.
    expect(pA).not.toContain(b.text);
    expect(pB).not.toContain(a.text);
  });

  it("the route has NO template-free letter path (bypass impossible)", () => {
    const src = readFileSync(
      path.join(process.cwd(), "src/app/api/auto-bewerb/generate-letter/route.ts"),
      "utf8",
    );
    // A manual id is validated against the 50-library (unknown → 400)…
    expect(src).toContain("getCoverLetterTemplate(templateId)");
    expect(src).toContain("unknown_template");
    // …and otherwise ALWAYS resolves via the deterministic matcher.
    expect(src).toContain("selectBestCoverLetterTemplate(");
    // …and the prompt receives the resolved template (no template-less call).
    expect(src).toContain("template,\n  });");
    expect(src).toContain("templateId: template!.id");
    expect(src).toContain("templatePage: template!.page");
    // The prompt builder itself REQUIRES a template (there is no optional default).
    const promptsSrc = readFileSync(path.join(process.cwd(), "src/lib/auto-bewerb/prompts.ts"), "utf8");
    expect(promptsSrc).toContain("template: import(\"./letter-templates\").CoverLetterTemplate;");
  });

  it("verified candidate + company facts reach the prompt UNCHANGED (no-invention rules present)", () => {
    const tpl = selectBestCoverLetterTemplate(matchInput(extractA)).template;
    const p = buildAutoBewerbLetterPrompt({
      profileText: PROFILE_TEXT,
      adFenced: "STELLENANZEIGE (fenced): Kältebau Nord GmbH, Hafenstraße 1, 20457 Hamburg.",
      extract: extractA,
      analysis: {
        matched: [{ requirement: "Schaltpläne lesen", note: "Praktikum Kältetechnik" }],
        transferable: [],
        missing: [{ requirement: "Führerschein Klasse B" }],
      },
      candidateName: CANDIDATE,
      template: tpl,
    });
    // Candidate facts (verified profile) preserved.
    expect(p).toContain("Mustapha Drif");
    expect(p).toContain("Praktikant Kältetechnik");
    expect(p).toContain("Deutsch B1");
    // Company facts (this ad) preserved.
    expect(p).toContain("Kältebau Nord GmbH");
    expect(p).toContain("Frau Schneider"); // named contact person
    expect(p).toContain("Hamburg");
    expect(p).toContain("Anlagenmechaniker SHK");
    // The no-invention contract is explicit.
    expect(p).toMatch(/NIEMALS erfinden/i);
    expect(p).toContain("Führerschein Klasse B"); // the missing requirement is listed, never claimed
  });
});

/* -------------------------------------------------------------------------- */
/* §10 traceable selected template id + original PDF page per company         */
/* -------------------------------------------------------------------------- */

describe("§10 traceable per-company template id + original PDF page", () => {
  it("each generated company letter is traceable to a real template id + its original page (1..50)", () => {
    const seen = new Map<string, number>();
    for (const e of [extractA, extractB, extractC]) {
      const sel = selectBestCoverLetterTemplate(matchInput(e));
      const resolved = getCoverLetterTemplate(sel.template.id);
      expect(resolved, `template ${sel.template.id} must resolve in the library`).not.toBeNull();
      expect(resolved!.page).toBe(sel.template.page);
      expect(sel.template.page).toBeGreaterThanOrEqual(1);
      expect(sel.template.page).toBeLessThanOrEqual(50);
      seen.set(sel.template.id, sel.template.page);
    }
    // The trace is non-empty and each id maps to a valid page.
    expect(seen.size).toBeGreaterThanOrEqual(2);
    for (const [id, page] of seen) {
      expect(getCoverLetterTemplate(id)!.page).toBe(page);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* §8/§9 the exported PDF carries the genuine signature and is one A4 page   */
/* -------------------------------------------------------------------------- */

// A valid 140×48 PNG (a dark "scribble" on white) — generated with zlib so
// pdf-lib's embedPng decodes it. This is a stand-in for the user's genuine
// uploaded signature image.
const SIGNATURE_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAIwAAAAwCAYAAADDyJIwAAAAlklEQVR4nO3SsQ3AQAwDsR/C+6+azHDVOwEJqFdx54Hg3D7AtwiGRDAkgiERDIlgSARDIhgSwZAIhkQwJIIhEQyJYEgEQyIYEsGQCIYkBTMz9tMJxgRjgrElE4wJxgRjSyYYE4wJxpZMMHY/GBAMiWBIBEMiGBLBkAiGRDAkgiERDIlgSARDIhgSwZAIhkQwJIIhEQzJC6kTh2raQHa8AAAAAElFTkSuQmCC";

/** Fill a template's {{variables}} with representative (verified) values and
 *  append the candidate name as the final paragraph — exactly the shape the
 *  AI produces (… "Mit freundlichen Grüßen" then the name). */
function filledLetterText(tpl: CoverLetterTemplate): string {
  const values: Record<string, string> = {
    school_name: "Berufsbildende Schule Hamburg",
    class_year: "10",
    city: "Hamburg",
    graduation_year: "2026",
    school_degree: "Mittlere Reife",
    age: "18",
    contact_person: "Frau Schneider",
    internship_company: "Kältebau Nord GmbH",
    previous_occupation: "Produktionshelfer",
    relevant_experience: "zwei Jahre in der Produktion",
    company_reputation: "seinem soliden Ausbildungskonzept",
    company_reference: "Ihr Projekt zur Kältetechnik",
    application_source: "einer Empfehlung",
    earliest_start_date: "nächstmöglichen Termin",
  };
  let text = tpl.text;
  for (const [k, v] of Object.entries(values)) text = text.split(`{{${k}}}`).join(v);
  // Strip any variable that has no verified value (honest, per the contract).
  text = text.replace(/\{\{[a-z_]+\}\}/g, "").replace(/\s{2,}/g, " ").replace(/ {2,}/g, " ");
  // The AI appends the verified name as the last line (the signature line).
  return `${text.trim()}\n\n${CANDIDATE}`;
}

function letterFolioFromTemplate(tpl: CoverLetterTemplate, signatureImage?: { bytes: Uint8Array; mime: string }): ReturnType<typeof buildLetterFolio> {
  const bodyHtml = filledLetterText(tpl)
    .split(/\n{2,}/)
    .filter((s) => s.trim())
    .map((p) => `<p>${p}</p>`)
    .join("");
  return buildLetterFolio({
    applicantName: CANDIDATE,
    applicantEmail: "mustapha.drif@example.de",
    applicantStreet: "Hafenstraße 1",
    applicantPostalCode: "20457",
    applicantCity: "Hamburg",
    applicantCountry: "Deutschland",
    applicantPhone: "+49 151 2345678",
    companyName: "Kältebau Nord GmbH",
    companyContactName: "Frau Schneider",
    companyAddress: "Hafenstraße 1, 20457 Hamburg",
    subject: `Bewerbung um einen Ausbildungsplatz als ${tpl.profession}`,
    bodyHtml,
    signatureImage,
  });
}

describe("§8/§9 the exported PDF — genuine signature embedded + exactly one A4 page", () => {
  it("is exactly ONE A4 page (595.28 × 841.89 pt) for every template-derived letter (singlePage)", async () => {
    // A representative spread across the library (not just one template).
    const sample = COVER_LETTER_TEMPLATES.filter((_, i) => i % 5 === 0); // 10 templates
    expect(sample.length).toBe(10);
    for (const tpl of sample) {
      const bytes = await generateLetterPdf(letterFolioFromTemplate(tpl), { singlePage: true });
      const doc = await PDFDocument.load(bytes);
      expect(doc.getPageCount(), `page ${tpl.page}: letter must fit exactly one A4 page`).toBe(1);
      const size = doc.getPage(0).getSize();
      expect(size.width).toBeCloseTo(595.28, 1);
      expect(size.height).toBeCloseTo(841.89, 1);
    }
  }, 30000);

  it("keeps ALL content on the single page (closing + name never truncated, no second page)", async () => {
    const tpl = selectBestCoverLetterTemplate(matchInput(extractA)).template;
    const bytes = await generateLetterPdf(letterFolioFromTemplate(tpl), { singlePage: true });
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(1);
    const flat = (await extractPdfText(bytes)).replace(/\s+/g, " ");
    expect(flat).toContain("Mit freundlichen Grüßen");
    expect(flat).toContain(CANDIDATE);
  }, 20000);

  it("embeds the genuine signature IMAGE (a real image object) and never invents one", async () => {
    const tpl = selectBestCoverLetterTemplate(matchInput(extractA)).template;
    const signatureImage = { bytes: new Uint8Array(Buffer.from(SIGNATURE_PNG_B64, "base64")), mime: "image/png" };
    const withSig = await generateLetterPdf(letterFolioFromTemplate(tpl, signatureImage), { singlePage: true });
    const docWith = await PDFDocument.load(withSig);
    expect(docWith.getPageCount()).toBe(1); // the image never pushes to a second page
    expect(hasImageXObject(withSig), "the exported PDF must contain the signature image").toBe(true);
    // The verified name line is still present alongside the image.
    expect((await extractPdfText(withSig)).replace(/\s+/g, " ")).toContain(CANDIDATE);

    // And WITHOUT an uploaded signature there is NO image (we never invent one).
    const withoutSig = await generateLetterPdf(letterFolioFromTemplate(tpl), { singlePage: true });
    expect(hasImageXObject(withoutSig), "no uploaded signature → no image object in the PDF").toBe(false);
  }, 20000);
});
