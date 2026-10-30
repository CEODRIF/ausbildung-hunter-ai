/**
 * AUTO BEWERB — A4 white CV document renderer (functional tests).
 *
 * `generateCvPdf` renders the saved CvDocument to a real PDF. The preview
 * (iframe) and the PDF export serve the SAME bytes, so the document
 * contract verified here holds for both: true A4 page size, multi-page
 * flow for long content, the embedded candidate photograph (when present),
 * and German characters (ä ö ü ß) without rendering errors.
 */
import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import { cvPdfFilename, generateCvPdf } from "@/lib/auto-bewerb/cv-pdf";
import {
  cvEmpty,
  emptyExperience,
  type CvDocument,
  type CvExperience,
} from "@/lib/templates/cv";

/** Smallest valid 1×1 PNG (data-URI) — the schema only accepts data: images. */
const TINY_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/** True when the PDF bytes carry an embedded image XObject. */
function hasImage(bytes: Uint8Array): boolean {
  return new TextDecoder("latin1").decode(bytes).includes("/Image");
}

function baseCv(): CvDocument {
  const cv = cvEmpty();
  cv.personal = {
    ...cv.personal,
    fullName: "Mustapha Drif",
    professionalTitle: "Fachinformatiker — Bewerbung bei Tech GmbH",
    email: "mustapha.drif@example.de",
    phone: "+49 151 23456789",
    location: "Düsseldorf, Deutschland",
    nationality: "deutscher",
  };
  cv.summary =
    "Motivierter Fachinformatiker mit Erfahrung in Systemintegration und Netzwerktechnik — zuverlässig, strukturiert, teamfähig.";
  cv.skills = ["Java", "Netzwerktechnik", "Systemintegration", "Kubernetes", "Bewerbung"];
  cv.languages = [
    { id: "l1", language: "Deutsch", level: "verhandlungssicher" },
    { id: "l2", language: "Englisch", level: "sehr gut" },
  ];
  return cv;
}

describe("AUTO BEWERB — A4 CV document renderer", () => {
  it("renders true A4 page dimensions with German document metadata", async () => {
    const bytes = await generateCvPdf(baseCv());
    const pdf = await PDFDocument.load(bytes);
    expect(pdf.getPageCount()).toBeGreaterThanOrEqual(1);
    const { width, height } = pdf.getPage(0).getSize();
    // A4 in PDF points: 210mm × 297mm
    expect(width).toBeCloseTo(595.28, 0);
    expect(height).toBeCloseTo(841.89, 0);
    expect(pdf.getTitle()).toBe("Lebenslauf");
    expect(pdf.getAuthor()).toBe("Mustapha Drif");
  });

  it("flows to multiple pages when the content is long", async () => {
    const cv = baseCv();
    cv.summary = "Langes Profil. ".repeat(60);
    const entries: CvExperience[] = Array.from({ length: 14 }, (_, i) => {
      const e = emptyExperience();
      e.jobTitle = `Systemadministrator (${i + 1})`;
      e.company = `Firma ${i + 1} GmbH`;
      e.location = "Berlin";
      e.start = "2020";
      e.end = "2024";
      e.responsibilities = Array.from({ length: 5 }, (_, j) => `Verantwortungsbereich ${j + 1}: Wartung, Betrieb und Ausweitung der IT-Infrastruktur inklusive Netzwerk, Server und Endgeräte.`);
      return e;
    });
    cv.experience = entries;
    const pdf = await PDFDocument.load(await generateCvPdf(cv));
    expect(pdf.getPageCount()).toBeGreaterThanOrEqual(2);
    // every page is A4
    for (let i = 0; i < pdf.getPageCount(); i++) {
      const { width, height } = pdf.getPage(i).getSize();
      expect(width).toBeCloseTo(595.28, 0);
      expect(height).toBeCloseTo(841.89, 0);
    }
  });

  it("embeds the candidate photograph top-right when present", async () => {
    const cv = baseCv();
    cv.personal.photo = TINY_PNG;
    const bytes = await generateCvPdf(cv);
    expect(hasImage(bytes)).toBe(true);
    const pdf = await PDFDocument.load(bytes);
    expect(pdf.getPageCount()).toBeGreaterThanOrEqual(1);
  });

  it("renders without a photo when none is available", async () => {
    expect(hasImage(await generateCvPdf(baseCv()))).toBe(false);
  });

  it("ignores an unreadable photo instead of failing the render", async () => {
    const cv = baseCv();
    cv.personal.photo = "data:image/png;base64,not-a-real-png";
    const bytes = await generateCvPdf(cv);
    expect(hasImage(bytes)).toBe(false);
    const pdf = await PDFDocument.load(bytes);
    expect(pdf.getPageCount()).toBeGreaterThanOrEqual(1);
  });

  it("renders German characters (ä ö ü ß) without errors", async () => {
    // drawText throws for characters the font encoding cannot represent —
    // a completed render with these strings is the proof.
    const cv = baseCv();
    cv.personal.fullName = "Größe Müller";
    cv.personal.professionalTitle = "Überwachung & Steuerung — Größe, Höhe, Breite";
    cv.summary = "Übung: ä ö ü ß Ä Ö Ü — Deutschland, Düsseldorf, München.";
    const pdf = await PDFDocument.load(await generateCvPdf(cv));
    expect(pdf.getAuthor()).toBe("Größe Müller");
    expect(pdf.getPageCount()).toBeGreaterThanOrEqual(1);
  });

  it("produces a deterministic, diacritic-safe filename", () => {
    expect(cvPdfFilename("Mustapha Drif")).toBe("Lebenslauf_Mustapha_Drif.pdf");
    expect(cvPdfFilename("Größe Müller")).toBe("Lebenslauf_Grosse_Muller.pdf");
  });

  it("emits a COMPLETE document: %PDF- head, xref + startxref + %%EOF tail (no truncation)", async () => {
    // Regression guard for the "broken document" preview symptom: a PDF
    // whose tail is missing (no %%EOF / no valid startxref) parses as
    // corrupted in strict viewers even though the %PDF- signature check
    // passes. Verified here on the REAL renderer output, with and without
    // an embedded photograph.
    for (const withPhoto of [false, true]) {
      const cv = baseCv();
      if (withPhoto) cv.personal.photo = TINY_PNG;
      const bytes = await generateCvPdf(cv);
      const text = new TextDecoder("latin1").decode(bytes);
      expect(text.startsWith("%PDF-")).toBe(true);
      expect(text).toContain("xref");
      expect(text).toContain("startxref");
      // %%EOF is the LAST marker of the file (trailer present, not cut off).
      expect(text.trimEnd().endsWith("%%EOF")).toBe(true);
      // Re-parsable by pdf-lib (a second, independent parse of the same
      // bytes that the preview and the export serve).
      const pdf = await PDFDocument.load(bytes);
      expect(pdf.getPageCount()).toBeGreaterThanOrEqual(1);
    }
  });
});
