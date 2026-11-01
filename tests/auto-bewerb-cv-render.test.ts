/**
 * AUTO BEWERB — tailored CV renderer: the PHOTO + multi-page contract of the
 * rewritten A4 document (complements tests/auto-bewerb-cv-pdf.test.ts).
 *
 * The generated-CV photo path is different from the legacy CV-Builder path:
 * the stored document carries the opaque `abphoto:v1:` reference, and ONLY
 * the server resolves it (ownership-checked) into a data URL passed via
 * `options.photoDataUrl`. This suite pins:
 *  - the platform-resolved `photoDataUrl` option embeds the photograph,
 *  - the raw `abphoto:` token in `personal.photo` is NEVER interpreted by
 *    the renderer (an owner-less render must simply have no photo),
 *  - the option wins over a legacy inline data URL (platform injection),
 *  - continuation pages carry the running header (`<Name> — Lebenslauf`),
 *  - long wrapping entry leads + right-aligned date ranges render with the
 *    date intact (overlap-safe reservation),
 *  - every page stays true A4.
 */
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import { CvPdfOverflowError, generateCvPdf } from "@/lib/auto-bewerb/cv-pdf";
import { cvEmpty, emptyExperience, type CvDocument } from "@/lib/templates/cv";

/** Smallest valid 1×1 PNG (data-URI) — stands in for the resolved photo. */
const TINY_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const A_HASH = "a".repeat(64);

/** True when the PDF bytes carry an embedded image XObject. */
function hasImage(bytes: Uint8Array): boolean {
  return new TextDecoder("latin1").decode(bytes).includes("/Image");
}

/**
 * The text pdf-lib actually DREW on one page. pdf-lib 1.x writes page
 * content Flate-compressed with hex-string text runs, so the rendered text
 * is recovered by inflating the content stream and decoding its <hex> runs
 * (latin1 — WinAnsi-encoded glyph bytes).
 */
function pageText(pdf: PDFDocument, pageIndex: number): string {
  const node = pdf.getPage(pageIndex).node as unknown as { Contents: () => unknown };
  const arr = node.Contents() as unknown as { size: () => number; get: (i: number) => unknown };
  const ctx = (pdf as unknown as { context: { lookup: (r: unknown) => unknown } }).context;
  let stream = "";
  for (let i = 0; i < arr.size(); i += 1) {
    const item = arr.get(i);
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
  return [...stream.matchAll(/<([0-9A-Fa-f]+)>/g)].map((m) => Buffer.from(m[1], "hex").toString("latin1")).join("\n");
}

function baseCv(): CvDocument {
  const cv = cvEmpty();
  cv.personal = {
    ...cv.personal,
    fullName: "Mustapha Drif",
    professionalTitle: "Auszubildende:r Anlagenmechaniker SHK",
    email: "mustapha.drif@example.de",
    phone: "+49 151 23456789",
    location: "Düsseldorf, Deutschland",
  };
  cv.summary =
    "Motivierter technischer Azubi mit Praktikum im Anlagenbau (Kältetechnik) — zuverlässig, strukturiert, teamfähig.";
  cv.skills = ["Schaltpläne lesen", "Montage", "Löten", "Kältemittel-Grundlagen"];
  cv.languages = [
    { id: "l1", language: "Deutsch", level: "C1" },
    { id: "l2", language: "Arabisch", level: "Muttersprache" },
  ];
  return cv;
}

describe("tailored CV renderer — profile photo contract", () => {
  it("embeds the photograph when the platform passes a resolved photoDataUrl", async () => {
    const bytes = await generateCvPdf(baseCv(), { photoDataUrl: TINY_PNG });
    expect(hasImage(bytes)).toBe(true);
  });

  it("NEVER renders the raw abphoto token (the server must resolve it — no owner-less image)", async () => {
    const cv = baseCv();
    cv.personal.photo = `abphoto:v1:${A_HASH}:png`;
    const bytes = await generateCvPdf(cv);
    expect(hasImage(bytes)).toBe(false);
    // The document still renders completely without the photo.
    const pdf = await PDFDocument.load(bytes);
    expect(pdf.getPageCount()).toBeGreaterThanOrEqual(1);
  });

  it("a resolved photoDataUrl wins over a legacy (even unreadable) inline data URL", async () => {
    const cv = baseCv();
    cv.personal.photo = "data:image/png;base64,not-a-real-png";
    const bytes = await generateCvPdf(cv, { photoDataUrl: TINY_PNG });
    expect(hasImage(bytes)).toBe(true);
  });

  it("photo + long content: every page stays true A4 and the photo is present", async () => {
    const cv = baseCv();
    // Genuinely overflows even the densest tier → multi-page contract.
    cv.summary = "Langes Kurzprofil über Anlagenbau und Kältetechnik. ".repeat(80);
    cv.experience = Array.from({ length: 8 }, (_, i) => {
      const e = emptyExperience();
      e.jobTitle = `Praktikant Kältetechnik (${i + 1})`;
      e.company = "Kältebau Nord GmbH";
      e.location = "Hamburg";
      e.start = "03/2025";
      e.end = "08/2025";
      e.responsibilities = [
        "Unterstützung bei Installation und Wartung von Kälteanlagen",
        "Montage und Inbetriebnahme von Kältekreisläufen",
      ];
      return e;
    });
    // ONE-PAGE POLICY: the default render of an overflowing document is an
    // explicit, actionable error — never a silent multi-page file.
    await expect(generateCvPdf(cv, { photoDataUrl: TINY_PNG })).rejects.toBeInstanceOf(CvPdfOverflowError);
    // …and with the explicit opt-in the legacy overflow render applies.
    const bytes = await generateCvPdf(cv, { photoDataUrl: TINY_PNG, allowMultiPage: true });
    const pdf = await PDFDocument.load(bytes);
    expect(pdf.getPageCount()).toBeGreaterThanOrEqual(2);
    for (let i = 0; i < pdf.getPageCount(); i += 1) {
      const { width, height } = pdf.getPage(i).getSize();
      expect(width).toBeCloseTo(595.28, 0);
      expect(height).toBeCloseTo(841.89, 0);
    }
    expect(hasImage(bytes)).toBe(true);
  });
});

describe("tailored CV renderer — multi-page continuation", () => {
  it("continuation pages carry the running header '<Name> — Lebenslauf'", async () => {
    const cv = baseCv();
    cv.summary = "Langes Kurzprofil. ".repeat(40);
    cv.experience = Array.from({ length: 10 }, (_, i) => {
      const e = emptyExperience();
      e.jobTitle = `Erfahrungseintrag ${i + 1}`;
      e.company = "Firma GmbH";
      e.start = "01/2020";
      e.end = "12/2024";
      e.responsibilities = Array.from({ length: 4 }, (_, j) => `Tätigkeit ${j + 1}: Wartung, Betrieb und Ausbau der Anlagen.`);
      return e;
    });
    const pdf = await PDFDocument.load(await generateCvPdf(cv, { photoDataUrl: TINY_PNG, allowMultiPage: true }));
    const pages = pdf.getPageCount();
    expect(pages).toBeGreaterThanOrEqual(2);
    // Page 1: the header block + sections, NO running header line.
    // (The redesign renders the name in normal case, per the reference.)
    const page1 = pageText(pdf, 0);
    expect(page1).toContain("Mustapha Drif");
    expect(page1).not.toMatch(/^Mustapha Drif.*Lebenslauf$/m);
    // Every continuation page: the name + "Lebenslauf" running header.
    for (let i = 1; i < pages; i += 1) {
      expect(pageText(pdf, i), `page ${i + 1}`).toContain("Lebenslauf");
    }
  });

  it("section titles exist exactly once per rendered page flow (no missing sections)", async () => {
    const cv = baseCv();
    cv.summary = "Profil. ";
    const pdf = await PDFDocument.load(await generateCvPdf(cv));
    const all = Array.from({ length: pdf.getPageCount() }, (_, i) => pageText(pdf, i)).join("\n");
    for (const section of ["Profil", "Kenntnisse", "Sprachen"]) {
      expect(all, `missing section ${section}`).toContain(section);
    }
  });
});

describe("tailored CV renderer — overlap-safe dates", () => {
  it("renders a very long wrapping entry lead WITH its right-aligned date range intact", async () => {
    const cv = baseCv();
    const e = emptyExperience();
    e.jobTitle =
      "Mechatroniker für Kältetechnik mit Schwerpunkt Kälteanlagenbau, Klimatisierung und Wärmepumpensysteme";
    e.company = "Kältebau Nord GmbH & Co. KG";
    e.location = "Hamburg";
    e.start = "09/2023";
    e.end = "08/2025";
    e.responsibilities = ["Installation und Instandhaltung von Kälteanlagen"];
    cv.experience = [e];
    const pdf = await PDFDocument.load(await generateCvPdf(cv, { photoDataUrl: TINY_PNG }));
    // Join page text and collapse the NEWLINES the renderer inserts for
    // wrapped lines, so assertions test the CONTENT, not the wrap points.
    const all = Array.from({ length: pdf.getPageCount() }, (_, i) => pageText(pdf, i)).join("\n")
      .replace(/[\s\u00ad]+/g, " ");
    // Both date ends survived the wrap (the lead reserved the date width).
    expect(all).toContain("09/2023");
    expect(all).toContain("08/2025");
    // The lead itself wrapped (long title) — nothing clipped.
    expect(all).toContain("Mechatroniker für Kältetechnik");
    expect(all).toContain("Kältebau Nord GmbH & Co. KG");
  });

  it("marks current positions with 'heute' (date text as stored, never re-interpreted)", async () => {
    const cv = baseCv();
    const e = emptyExperience();
    e.jobTitle = "Auszubildende:r Anlagenmechaniker";
    e.company = "Kältebau Nord GmbH";
    e.start = "09/2026";
    e.isCurrent = true;
    cv.experience = [e];
    const pdf = await PDFDocument.load(await generateCvPdf(cv));
    const all = Array.from({ length: pdf.getPageCount() }, (_, i) => pageText(pdf, i)).join("\n");
    expect(all).toContain("09/2026");
    expect(all).toContain("heute");
  });
});
