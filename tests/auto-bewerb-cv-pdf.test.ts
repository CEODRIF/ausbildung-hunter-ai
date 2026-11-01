/**
 * AUTO BEWERB — A4 CV document renderer (functional tests).
 *
 * `generateCvPdf` renders the saved CvDocument to a real PDF using the
 * design of the CV builder's "modern" template (src/components/
 * cv-templates/modern-template.tsx): left-aligned header with a steel-blue
 * bold name, lighter-steel title and an icon contact line, the candidate
 * photo top-right (aspect preserved), steel-blue section headings with thin
 * blue rules, "Position, Unternehmen" entries with dates + location stacked
 * top-right, two-column skills, three-column languages (level under the
 * language), two-column certificates and project entries.
 *
 * The ONE-PAGE CONTRACT: the renderer measures the whole document and picks
 * the most comfortable density tier that fits exactly one A4 page — nothing
 * is ever removed to save space. Only a pathologically long profile (the
 * longCv fixture: 14 jobs × 5 bullets) overflows to further pages, where it
 * keeps a running header + subtle page numbers and renders EVERY entry.
 *
 * The preview and the PDF export serve the SAME bytes, so the document
 * contract verified here holds for both: true A4 page size, exactly one page
 * for realistic profiles, the embedded photograph (when present),
 * preservation of every verified candidate fact, and German characters
 * (ä ö ü ß) without rendering errors.
 *
 * The layout assertions parse the PDF content stream (text runs with their
 * exact x/y positions, fonts, fill colors, and the image placement matrix)
 * — they verify the actual geometry, not just the presence of text.
 */
import { readFileSync } from "node:fs";
import { deflateSync, inflateSync } from "node:zlib";
import { beforeAll, describe, expect, it } from "vitest";
import { PDFDocument, StandardFonts, type PDFFont } from "pdf-lib";
import { contactIconAxis, cvPdfFilename, generateCvPdf } from "@/lib/auto-bewerb/cv-pdf";
import {
  cvEmpty,
  emptyEducation,
  emptyExperience,
  emptyProject,
  type CvDocument,
} from "@/lib/templates/cv";
import { defaultCvCustomization } from "@/lib/templates/cv-customization";

/* Layout constants — mirror the tiers in src/lib/auto-bewerb/cv-pdf.ts. */
const A4_WIDTH = 595.28;
const A4_HEIGHT = 841.89;
const MM = 72 / 25.4;
/** comfortable tier margins (the largest tier a realistic profile uses). */
const MARGIN_X = 10 * MM;
const RIGHT = A4_WIDTH - MARGIN_X;
/** densest tier margins — the outer bound every run must respect. */
const OUTER_LEFT = 9 * MM - 1.5;
const OUTER_RIGHT = A4_WIDTH - 9 * MM + 1.5;

/** Smallest valid 1×1 PNG (data-URI) — the schema only accepts data: images. */
const TINY_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/* ------------------------------------------------------------------ */
/* Test photo with KNOWN dimensions (solid-color PNG, generated here) */
/* ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** Solid RGB PNG with exact pixel dimensions, as a data URL. */
function photoPngDataUrl(w: number, h: number): string {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor RGB
  const raw = Buffer.alloc(h * (1 + w * 3));
  for (let y = 0; y < h; y += 1) {
    const row = y * (1 + w * 3);
    raw[row] = 0; // filter: none
    for (let x = 0; x < w; x += 1) {
      raw[row + 1 + x * 3] = 120;
      raw[row + 2 + x * 3] = 100;
      raw[row + 3 + x * 3] = 80;
    }
  }
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
  return `data:image/png;base64,${png.toString("base64")}`;
}

/* ------------------------------------------------------------------ */
/* Content-stream parsing (positions, fonts, colors, image placement) */
/* ------------------------------------------------------------------ */

function pageStream(pdf: PDFDocument, pageIndex: number): string {
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
  return stream;
}

/** Standard 14 fonts use WinAnsiEncoding — map the 0x80–0x9F block. */
const WINANSI: Record<number, string> = {
  0x80: "€", 0x82: "‘", 0x83: "‚", 0x84: "„", 0x85: "…", 0x86: "†", 0x87: "‡",
  0x88: "ˆ", 0x89: "‰", 0x8a: "Š", 0x8b: "‹", 0x8c: "Œ", 0x8e: "Ž", 0x91: "‘",
  0x92: "’", 0x93: "“", 0x94: "”", 0x95: "•", 0x96: "–", 0x97: "—", 0x98: "˜",
  0x99: "™", 0x9a: "š", 0x9b: "›", 0x9c: "œ", 0x9e: "ž", 0x9f: "Ÿ",
};

function decodeWinAnsiHex(hex: string): string {
  const buf = Buffer.from(hex, "hex");
  let out = "";
  for (const b of buf) out += b >= 0x80 && b <= 0x9f && WINANSI[b] ? WINANSI[b] : String.fromCharCode(b);
  return out;
}

interface TextRun {
  x: number;
  y: number;
  size: number;
  font: string;
  text: string;
  /** Fill color (rgb 0–1) active for the run, when present in the stream. */
  color: [number, number, number] | null;
}

function pageTextRuns(pdf: PDFDocument, pageIndex: number): TextRun[] {
  const stream = pageStream(pdf, pageIndex);
  const runs: TextRun[] = [];
  for (const block of stream.matchAll(/BT([\s\S]*?)ET/g)) {
    const body = block[1];
    const font = body.match(/\/(Helvetica[^ ]*|Times[^ ]*) ([\d.]+) Tf/);
    const pos = body.match(/1 0 0 1 ([\d.]+) ([\d.]+) Tm/);
    const hex = body.match(/<([0-9A-Fa-f]+)> Tj/);
    if (!pos || !hex) continue;
    const colorMatch = body.match(/([0-9.]+) ([0-9.]+) ([0-9.]+) rg/);
    runs.push({
      x: Number(pos[1]),
      y: Number(pos[2]),
      size: font ? Number(font[2]) : 0,
      font: font?.[1] ?? "",
      text: decodeWinAnsiHex(hex[1]),
      color: colorMatch ? [Number(colorMatch[1]), Number(colorMatch[2]), Number(colorMatch[3])] : null,
    });
  }
  return runs;
}

const pageText = (pdf: PDFDocument, pageIndex: number): string =>
  pageTextRuns(pdf, pageIndex).map((r) => r.text).join(" ");

/** All text of the document, space-joined — line wrapping re-assembles the
 *  original strings exactly (wraps happen at word boundaries). */
const fullText = (pdf: PDFDocument): string => {
  const parts: string[] = [];
  for (let i = 0; i < pdf.getPageCount(); i += 1) parts.push(pageText(pdf, i));
  return parts.join(" ");
};

const colorOf = (run: TextRun): [number, number, number] | null => run.color;

/** Approximate RGB comparison (pdf-lib serialises with many decimals). */
const closeColor = (c: [number, number, number] | null, target: [number, number, number]): boolean =>
  Boolean(c) &&
  Math.abs(c![0] - target[0]) < 0.01 &&
  Math.abs(c![1] - target[1]) < 0.01 &&
  Math.abs(c![2] - target[2]) < 0.01;

/** The modern template palette (modern-template.tsx IDENTITY). */
const C_ACCENT: [number, number, number] = [47 / 255, 92 / 255, 153 / 255]; // #2f5c99
const C_TITLE: [number, number, number] = [74 / 255, 120 / 255, 176 / 255]; // #4a78b0
const C_BODY: [number, number, number] = [31 / 255, 41 / 255, 55 / 255]; // #1f2937
const C_META: [number, number, number] = [85 / 255, 95 / 255, 107 / 255]; // #555f6b

/** The `w 0 0 h x y cm` image placement matrix of the (single) photo. */
function imagePlacement(stream: string): { x: number; y: number; w: number; h: number } | null {
  const m = stream.match(
    /1 0 0 1 ([\d.]+) ([\d.]+) cm\s*1 0 0 1 0 0 cm\s*([\d.]+) 0 0 ([\d.]+) 0 0 cm\s*1 0 0 1 0 0 cm\s*\/Image-/,
  );
  return m ? { x: Number(m[1]), y: Number(m[2]), w: Number(m[3]), h: Number(m[4]) } : null;
}

/* ------------------------------------------------------------------ */
/* Fixtures + scratch fonts for width math                            */
/* ------------------------------------------------------------------ */

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

/** A realistic, content-rich profile (every section filled) — the shape of
 *  a real AUTO BEWERB CV and the "must fit one page" test case. */
function richCv(): CvDocument {
  const cv = baseCv();
  cv.personal = {
    ...cv.personal,
    professionalTitle: "Fachinformatiker für Systemintegration — Bewerbung bei Henkel",
    linkedin: "linkedin.com/in/mustapha-drif",
    website: "www.mustapha-drif.de",
    dateOfBirth: "04.06.2007",
    availability: "ab 01.09.2026",
  };
  const e1 = emptyExperience();
  e1.jobTitle = "Praktikant Kältetechnik";
  e1.company = "Kältebau Nord GmbH";
  e1.location = "Hamburg";
  e1.start = "06/2025";
  e1.end = "08/2025";
  e1.responsibilities = ["Montage von Heizungsanlagen", "Wartung der IT-Infrastruktur", "Erfassung von Schaltplänen"];
  e1.achievements = ["Eigenständige Abnahme einer Anlage"];
  const e2 = emptyExperience();
  e2.jobTitle = "Auszubildender Fachinformatiker";
  e2.company = "Tech Süd AG";
  e2.location = "Düsseldorf";
  e2.start = "09/2023";
  e2.isCurrent = true;
  e2.responsibilities = ["Systemintegration kleiner Netzwerke", "Support der Endanwender"];
  cv.experience = [e1, e2];
  const ed1 = emptyEducation();
  ed1.degree = "Abitur — Gymnasium";
  ed1.institution = "Berthold-Brecht-Schule";
  ed1.location = "Düsseldorf";
  ed1.start = "2022";
  ed1.end = "2025";
  ed1.description = "Fächer: Mathematik, Informatik, Physik.";
  const ed2 = emptyEducation();
  ed2.degree = "Schulvorbereitung";
  ed2.institution = "Realschule";
  ed2.location = "Düsseldorf";
  ed2.end = "2022";
  cv.education = [ed1, ed2];
  cv.skills = ["Java", "Netzwerktechnik", "Systemintegration", "Kubernetes", "Linux", "Bewerbung", "Schaltpläne lesen", "Teamarbeit"];
  cv.languages = [
    { id: "l1", language: "Deutsch", level: "verhandlungssicher" },
    { id: "l2", language: "Englisch", level: "sehr gut" },
    { id: "l3", language: "Arabisch", level: "Muttersprache" },
  ];
  cv.certificates = [
    { id: "c1", name: "IT-Support-Zertifikat", issuer: "Tech Süd AG", date: "2025", description: "" },
    { id: "c2", name: "Kältetechnik-Grundkurs", issuer: "Kältebau Nord", date: "2025", description: "" },
    { id: "c3", name: "Erste Hilfe", issuer: "DRK", date: "2024", description: "" },
  ];
  const p1 = emptyProject();
  p1.name = "Heimnetzwerk";
  p1.role = "Eigenbau";
  p1.date = "2024";
  p1.description = "Aufbau und Konfiguration eines Heimnetzwerks.";
  p1.technologies = "Linux, VLAN, DNS";
  const p2 = emptyProject();
  p2.name = "Schul-Wiki";
  p2.role = "Entwicklung";
  p2.date = "2023";
  p2.description = "Dokumentation der Schul-IT.";
  p2.technologies = "Markdown";
  cv.projects = [p1, p2];
  cv.interests = ["IT-Projekte", "Fußball", "Musik"];
  return cv;
}

/** Long CV that overflows even the densest tier (shared by several tests). */
function longCv(): CvDocument {
  const cv = richCv();
  cv.summary = "Langes Profil. ";
  const entries = Array.from({ length: 14 }, (_, i) => {
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
  return cv;
}

let helvetica: PDFFont;
let helveticaBold: PDFFont;
let helveticaOblique: PDFFont;

beforeAll(async () => {
  const doc = await PDFDocument.create();
  helvetica = await doc.embedFont(StandardFonts.Helvetica);
  helveticaBold = await doc.embedFont(StandardFonts.HelveticaBold);
  helveticaOblique = await doc.embedFont(StandardFonts.HelveticaOblique);
});

/** Rendered width of a run (exact font metrics, per embedded font family). */
function runWidth(run: TextRun): number {
  const font = run.font.startsWith("Helvetica-Bold")
    ? helveticaBold
    : run.font.startsWith("Helvetica-Oblique")
      ? helveticaOblique
      : helvetica;
  return font.widthOfTextAtSize(run.text, run.size);
}

function hasImage(bytes: Uint8Array): boolean {
  return new TextDecoder("latin1").decode(bytes).includes("/Image");
}

/* ------------------------------------------------------------------ */
/* Core document contract                                              */
/* ------------------------------------------------------------------ */

describe("AUTO BEWERB — one-page A4 CV renderer (modern template design)", () => {
  it("renders true A4 page dimensions with German document metadata", async () => {
    const pdf = await PDFDocument.load(await generateCvPdf(baseCv()));
    expect(pdf.getPageCount()).toBe(1);
    const { width, height } = pdf.getPage(0).getSize();
    // A4 in PDF points: 210mm × 297mm
    expect(width).toBeCloseTo(595.28, 0);
    expect(height).toBeCloseTo(841.89, 0);
    expect(pdf.getTitle()).toBe("Lebenslauf");
    expect(pdf.getAuthor()).toBe("Mustapha Drif");
  });

  it("fits a realistic content-rich profile on EXACTLY one page", async () => {
    const pdf = await PDFDocument.load(await generateCvPdf(richCv()));
    expect(pdf.getPageCount()).toBe(1);
  });

  it("fits the rich profile on one page even with a photograph", async () => {
    const cv = richCv();
    cv.personal.photo = photoPngDataUrl(300, 400);
    const pdf = await PDFDocument.load(await generateCvPdf(cv));
    expect(pdf.getPageCount()).toBe(1);
    expect(hasImage(await generateCvPdf(cv))).toBe(true);
  });

  it("keeps a modest profile on one page at the most comfortable tier", async () => {
    const pdf = await PDFDocument.load(await generateCvPdf(baseCv()));
    expect(pdf.getPageCount()).toBe(1);
    const name = pageTextRuns(pdf, 0).find((r) => r.text === "Mustapha Drif")!;
    // comfortable tier name size (the baseCv fixture is lean enough for it)
    expect(name.size).toBeCloseTo(21, 0);
  });

  it("flows to further pages ONLY when the content cannot fit one page — and loses nothing", async () => {
    const cv = longCv();
    const pdf = await PDFDocument.load(await generateCvPdf(cv));
    expect(pdf.getPageCount()).toBeGreaterThanOrEqual(2);
    // every page is A4
    for (let i = 0; i < pdf.getPageCount(); i += 1) {
      const { width, height } = pdf.getPage(i).getSize();
      expect(width).toBeCloseTo(595.28, 0);
      expect(height).toBeCloseTo(841.89, 0);
    }
    // all 14 experience entries survive the overflow
    const all = fullText(pdf);
    for (let i = 1; i <= 14; i += 1) expect(all).toContain(`Systemadministrator (${i})`);
    // densest tier (the largest density that was tried)
    const name = pageTextRuns(pdf, 0).find((r) => r.text === "Mustapha Drif")!;
    expect(name.size).toBeCloseTo(17.5, 1);
  });

  it("embeds the candidate photograph top-right when present", async () => {
    const cv = baseCv();
    cv.personal.photo = TINY_PNG;
    const bytes = await generateCvPdf(cv);
    expect(hasImage(bytes)).toBe(true);
    const pdf = await PDFDocument.load(bytes);
    expect(pdf.getPageCount()).toBe(1);
  });

  it("lets options.photoDataUrl win over a legacy inline photo", async () => {
    const cv = baseCv();
    cv.personal.photo = TINY_PNG; // 1×1 — would render tiny if used
    const pdf = await PDFDocument.load(await generateCvPdf(cv, { photoDataUrl: photoPngDataUrl(300, 400) }));
    const placement = imagePlacement(pageStream(pdf, 0));
    expect(placement).toBeTruthy();
    // the 300×400 (3:4) photo is used, not the 1×1
    expect(placement!.w / placement!.h).toBeCloseTo(300 / 400, 1);
  });

  it("ignores an unreadable photo instead of failing the render", async () => {
    const cv = baseCv();
    cv.personal.photo = "data:image/png;base64,not-a-real-png";
    const bytes = await generateCvPdf(cv);
    expect(hasImage(bytes)).toBe(false);
    const pdf = await PDFDocument.load(bytes);
    expect(pdf.getPageCount()).toBe(1);
  });

  it("never interprets an abphoto: reference itself (server's job)", async () => {
    const cv = baseCv();
    cv.personal.photo = "abphoto:v1:0123456789abcdef:png";
    const bytes = await generateCvPdf(cv);
    expect(hasImage(bytes)).toBe(false);
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(1);
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
    expect(pdf.getPageCount()).toBe(1);
    const text = fullText(pdf);
    expect(text).toContain("Größe Müller");
    expect(text).toContain("Überwachung & Steuerung");
    expect(text).toContain("ä ö ü ß Ä Ö Ü");
  });

  it("produces a deterministic, diacritic-safe filename", () => {
    expect(cvPdfFilename("Mustapha Drif")).toBe("Lebenslauf_Mustapha_Drif.pdf");
    expect(cvPdfFilename("Größe Müller")).toBe("Lebenslauf_Grosse_Muller.pdf");
  });

  it("emits a COMPLETE document: %PDF- head, xref + startxref + %%EOF tail (no truncation)", async () => {
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
      const pdf = await PDFDocument.load(bytes);
      expect(pdf.getPageCount()).toBe(1);
    }
  });
});

/* ------------------------------------------------------------------ */
/* Modern-template design (typography, color, geometry)                */
/* ------------------------------------------------------------------ */

describe("AUTO BEWERB — modern template port (layout geometry)", () => {
  it("uses the Helvetica family for ALL text (no serif anywhere)", async () => {
    const cv = richCv();
    cv.personal.linkedin = "linkedin.com/in/mustapha-drif";
    const pdf = await PDFDocument.load(await generateCvPdf(cv));
    const runs = pageTextRuns(pdf, 0);
    expect(runs.length).toBeGreaterThan(30);
    const nonSans = runs.filter((r) => !r.font.startsWith("Helvetica"));
    expect(nonSans.length).toBe(0);
    const name = runs.find((r) => r.text === "Mustapha Drif")!;
    expect(name.font.startsWith("Helvetica-Bold")).toBe(true);
    const company = runs.find((r) => r.text === " , Kältebau Nord GmbH")!;
    expect(company.font.startsWith("Helvetica-Oblique")).toBe(true);
    // the LinkedIn "in" glyph is a small bold vector complement
    const inGlyph = runs.find((r) => r.text === "in")!;
    expect(inGlyph.font.startsWith("Helvetica-Bold")).toBe(true);
    expect(inGlyph.size).toBeLessThanOrEqual(6);
  });

  it("paints the modern palette: steel-blue name + headings, lighter-steel title, meta-toned contact/entries", async () => {
    const cv = richCv();
    const pdf = await PDFDocument.load(await generateCvPdf(cv));
    const runs = pageTextRuns(pdf, 0);
    const name = runs.find((r) => r.text === "Mustapha Drif")!;
    expect(closeColor(colorOf(name), C_ACCENT)).toBe(true);
    const title = runs.find((r) => r.text === "Fachinformatiker für Systemintegration — Bewerbung bei Henkel")!;
    expect(closeColor(colorOf(title), C_TITLE)).toBe(true);
    const heading = runs.find((r) => r.text === "Berufserfahrung")!;
    expect(closeColor(colorOf(heading), C_ACCENT)).toBe(true);
    expect(heading.font.startsWith("Helvetica-Bold")).toBe(true);
    const contact = runs.find((r) => r.text === "mustapha.drif@example.de")!;
    expect(closeColor(colorOf(contact), C_META)).toBe(true);
    const bullet = runs.find((r) => r.text === "Montage von Heizungsanlagen")!;
    expect(closeColor(colorOf(bullet), C_BODY)).toBe(true);
    const date = runs.find((r) => r.text === "06/2025 – 08/2025")!;
    expect(closeColor(colorOf(date), C_META)).toBe(true);
  });

  it("lays out a LEFT-aligned header (name → title → icon contact line → other facts)", async () => {
    const cv = baseCv();
    const pdf = await PDFDocument.load(await generateCvPdf(cv));
    const runs = pageTextRuns(pdf, 0);
    const name = runs.find((r) => r.text === "Mustapha Drif")!;
    expect(name.x).toBeCloseTo(MARGIN_X, 1); // left edge, not centered
    const title = runs.find((r) => r.text === "Fachinformatiker — Bewerbung bei Tech GmbH")!;
    expect(title.y).toBeLessThan(name.y); // below the name
    expect(title.x).toBeCloseTo(MARGIN_X, 1);
    // contact line: first item is the email, right of its icon
    const email = runs.find((r) => r.text === "mustapha.drif@example.de")!;
    expect(email.y).toBeLessThan(title.y);
    expect(email.x).toBeGreaterThan(MARGIN_X + 10);
    const phone = runs.find((r) => r.text === "+49 151 23456789")!;
    expect(phone.y).toBeCloseTo(email.y, 1); // same line
    expect(phone.x).toBeGreaterThan(email.x);
    // the other-facts line (nationality) sits below the contact line
    const other = runs.find((r) => r.text === "deutscher")!;
    expect(other.y).toBeLessThan(email.y);
    expect(other.x).toBeCloseTo(MARGIN_X, 1);
  });

  it("lists the contact items in the builder's order (email, phone, location, website, linkedin)", async () => {
    const cv = baseCv();
    cv.personal.website = "www.example.de";
    cv.personal.linkedin = "linkedin.com/in/md";
    const pdf = await PDFDocument.load(await generateCvPdf(cv));
    const runs = pageTextRuns(pdf, 0).filter((r) =>
      ["www.example.de", "linkedin.com/in/md", "+49 151 23456789", "mustapha.drif@example.de", "Düsseldorf, Deutschland"].includes(r.text),
    );
    // row-first reading order (top line left→right, then next line)
    const sorted = [...runs].sort((a, b) => (Math.abs(a.y - b.y) < 0.5 ? a.x - b.x : b.y - a.y));
    expect(sorted.map((r) => r.text).slice(0, 3)).toEqual([
      "mustapha.drif@example.de",
      "+49 151 23456789",
      "Düsseldorf, Deutschland",
    ]);
  });

  it("places the photo flush in the upper-right with its aspect ratio preserved (never stretched)", async () => {
    // Portrait 3:4 (standard Bewerbungsfoto) and landscape 4:3.
    for (const [w, h] of [[300, 400], [400, 300]] as const) {
      const cv = baseCv();
      cv.personal.photo = photoPngDataUrl(w, h);
      const pdf = await PDFDocument.load(await generateCvPdf(cv));
      const placement = imagePlacement(pageStream(pdf, 0));
      expect(placement).toBeTruthy();
      const { width, height } = pdf.getPage(0).getSize();
      // Top-right: the photo's top edge touches the top margin and its
      // right edge touches the right margin (photo-bearing baseCv is lean
      // → comfortable tier, mt 12mm).
      const mt = 12 * MM;
      expect(placement!.y + placement!.h).toBeCloseTo(height - mt, 1);
      expect(placement!.x + placement!.w).toBeCloseTo(width - MARGIN_X, 1);
      // Aspect ratio preserved inside the 96×128pt box.
      expect(placement!.w / placement!.h).toBeCloseTo(w / h, 1);
      expect(placement!.w).toBeLessThanOrEqual(96 + 0.01);
      expect(placement!.h).toBeLessThanOrEqual(128 + 0.01);
    }
  });

  it("right-aligns the date on the job-title baseline and the location on the next line", async () => {
    const cv = baseCv();
    const e = emptyExperience();
    e.jobTitle = "Systemadministrator";
    e.company = "Tech GmbH";
    e.location = "Hamburg";
    e.start = "2022/03";
    e.isCurrent = true;
    e.responsibilities = ["Wartung der IT-Infrastruktur"];
    cv.experience = [e];
    const pdf = await PDFDocument.load(await generateCvPdf(cv));
    const runs = pageTextRuns(pdf, 0);
    const title = runs.find((r) => r.text === "Systemadministrator")!;
    const date = runs.find((r) => r.text === "2022/03 – heute")!;
    const company = runs.find((r) => r.text === " , Tech GmbH")!;
    const location = runs.find((r) => r.text === "Hamburg")!;
    expect(title.font.startsWith("Helvetica-Bold")).toBe(true);
    expect(company.font.startsWith("Helvetica-Oblique")).toBe(true);
    // Date on the SAME baseline as the job title, flush right…
    expect(date.y).toBeCloseTo(title.y, 2);
    expect(date.x + runWidth(date)).toBeCloseTo(RIGHT, 0.5);
    // …location on the line below, also flush right (stacked top-right).
    expect(location.y).toBeLessThan(date.y);
    expect(location.y).toBeGreaterThan(date.y - 20);
    expect(location.x + runWidth(location)).toBeCloseTo(RIGHT, 0.5);
  });

  it("lays out skills as two row-aligned columns (modern template grid)", async () => {
    const cv = baseCv(); // 5 skills → row-first: left Java/Systemintegration/Bewerbung, right Netzwerktechnik/Kubernetes
    const pdf = await PDFDocument.load(await generateCvPdf(cv));
    const runs = pageTextRuns(pdf, 0);
    const skillsContentW = A4_WIDTH - 2 * MARGIN_X;
    const gap = 21; // comfortable tier skillsGap
    const colW = (skillsContentW - gap) / 2;
    const java = runs.find((r) => r.text === "Java")!;
    const netzwerk = runs.find((r) => r.text === "Netzwerktechnik")!;
    expect(java.x).toBeCloseTo(MARGIN_X + 10.5, 1); // bullet indent
    expect(netzwerk.x).toBeCloseTo(MARGIN_X + colW + gap + 10.5, 1);
    // First rows of both columns sit on the same baseline.
    expect(netzwerk.y).toBeCloseTo(java.y, 2);
  });

  it("lays out languages as a three-column grid with the level under each language", async () => {
    const cv = richCv();
    const pdf = await PDFDocument.load(await generateCvPdf(cv));
    const runs = pageTextRuns(pdf, 0);
    const de = runs.find((r) => r.text === "Deutsch")!;
    const en = runs.find((r) => r.text === "Englisch")!;
    const ar = runs.find((r) => r.text === "Arabisch")!;
    expect(en.x).toBeGreaterThan(de.x + 50);
    expect(ar.x).toBeGreaterThan(en.x + 50);
    expect(en.y).toBeCloseTo(de.y, 2);
    expect(ar.y).toBeCloseTo(de.y, 2);
    const deLevel = runs.find((r) => r.text === "verhandlungssicher")!;
    expect(deLevel.x).toBeCloseTo(de.x, 1);
    expect(deLevel.y).toBeLessThan(de.y);
    expect(de.font.startsWith("Helvetica-Bold")).toBe(true);
    expect(deLevel.font.startsWith("Helvetica-Oblique")).toBe(false);
  });

  it("renders certificate bullets with the FULL fact set (name — issuer — date)", async () => {
    const pdf = await PDFDocument.load(await generateCvPdf(richCv()));
    const text = fullText(pdf);
    expect(text).toContain("IT-Support-Zertifikat — Tech Süd AG — 2025");
    expect(text).toContain("Kältetechnik-Grundkurs — Kältebau Nord — 2025");
    expect(text).toContain("Erste Hilfe — DRK — 2024");
  });
});

/* ------------------------------------------------------------------ */
/* Information preservation (the top-priority contract)                */
/* ------------------------------------------------------------------ */

describe("AUTO BEWERB — candidate-information preservation", () => {
  it("keeps EVERY verified fact of a rich profile on the single page", async () => {
    const pdf = await PDFDocument.load(await generateCvPdf(richCv()));
    expect(pdf.getPageCount()).toBe(1);
    const text = fullText(pdf);
    // personal header
    for (const fact of [
      "Mustapha Drif",
      "Fachinformatiker für Systemintegration — Bewerbung bei Henkel",
      "mustapha.drif@example.de",
      "+49 151 23456789",
      "Düsseldorf, Deutschland",
      "www.mustapha-drif.de",
      "linkedin.com/in/mustapha-drif",
      "deutscher",
      "04.06.2007",
      "ab 01.09.2026",
    ]) expect(text, `missing: ${fact}`).toContain(fact);
    // profile
    expect(text).toContain("Motivierter Fachinformatiker mit Erfahrung in Systemintegration und Netzwerktechnik");
    // experience 1 (dates, place, ALL responsibilities + achievement)
    for (const fact of [
      "Praktikant Kältetechnik",
      "Kältebau Nord GmbH",
      "06/2025 – 08/2025",
      "Hamburg",
      "Montage von Heizungsanlagen",
      "Wartung der IT-Infrastruktur",
      "Erfassung von Schaltplänen",
      "Eigenständige Abnahme einer Anlage",
    ]) expect(text, `missing: ${fact}`).toContain(fact);
    // experience 2 (open-ended date preserved verbatim)
    for (const fact of [
      "Auszubildender Fachinformatiker",
      "Tech Süd AG",
      "09/2023 – heute",
      "Systemintegration kleiner Netzwerke",
      "Support der Endanwender",
    ]) expect(text, `missing: ${fact}`).toContain(fact);
    // education (both entries, dates, description)
    for (const fact of [
      "Abitur — Gymnasium",
      "Berthold-Brecht-Schule",
      "2022 – 2025",
      "Fächer: Mathematik, Informatik, Physik.",
      "Schulvorbereitung",
      "Realschule",
    ]) expect(text, `missing: ${fact}`).toContain(fact);
    // every skill, every language with its level
    for (const fact of ["Java", "Netzwerktechnik", "Systemintegration", "Kubernetes", "Linux", "Bewerbung", "Schaltpläne lesen", "Teamarbeit",
      "Deutsch", "verhandlungssicher", "Englisch", "sehr gut", "Arabisch", "Muttersprache"]) {
      expect(text, `missing: ${fact}`).toContain(fact);
    }
    // projects (name, role, date, description, technologies)
    for (const fact of [
      "Heimnetzwerk", "Eigenbau", "Aufbau und Konfiguration eines Heimnetzwerks.", "Linux, VLAN, DNS",
      "Schul-Wiki", "Entwicklung", "Dokumentation der Schul-IT.", "Markdown",
    ]) expect(text, `missing: ${fact}`).toContain(fact);
    // interests
    for (const fact of ["IT-Projekte", "Fußball", "Musik"]) expect(text).toContain(fact);
  });

  it("keeps every entry of an overflowing profile (nothing deleted, no clipping)", async () => {
    const pdf = await PDFDocument.load(await generateCvPdf(longCv()));
    const text = fullText(pdf);
    for (let i = 1; i <= 14; i += 1) {
      expect(text).toContain(`Systemadministrator (${i})`);
      expect(text).toContain(`Firma ${i} GmbH`);
    }
    // every bullet line of the last entry is present
    for (let j = 1; j <= 5; j += 1) expect(text).toContain(`Verantwortungsbereich ${j}: Wartung, Betrieb und Ausweitung`);
    // every run stays inside the page (no clipping beyond the outer margin)
    for (let i = 0; i < pdf.getPageCount(); i += 1) {
      const runs = pageTextRuns(pdf, i);
      expect(runs.length).toBeGreaterThan(0);
      for (const run of runs) {
        expect(run.x, `page ${i + 1}: "${run.text}" starts at ${run.x}`).toBeGreaterThanOrEqual(OUTER_LEFT);
        expect(run.x + runWidth(run), `page ${i + 1}: "${run.text}" ends at ${run.x + runWidth(run)}`).toBeLessThanOrEqual(OUTER_RIGHT);
        expect(run.y, `page ${i + 1}: "${run.text}" too low`).toBeLessThanOrEqual(A4_HEIGHT - OUTER_LEFT + 1);
        expect(run.y, `page ${i + 1}: "${run.text}" too high`).toBeGreaterThanOrEqual(14);
      }
    }
  });

  it("omits sections that have no content (nothing is invented)", async () => {
    const cv = cvEmpty();
    cv.personal.fullName = "Test Person";
    cv.summary = "Kurzprofil.";
    const pdf = await PDFDocument.load(await generateCvPdf(cv));
    const text = fullText(pdf);
    expect(text).toContain("Profil");
    for (const heading of ["Berufserfahrung", "Ausbildung & Studium", "Kenntnisse", "Zertifikate", "Sprachen", "Projekte", "Interessen"]) {
      expect(text).not.toContain(heading);
    }
  });

  it("honors the document's section order (builder's organization logic)", async () => {
    const cv = richCv();
    const s = defaultCvCustomization();
    s.layout.sectionOrder = ["experience", "education", "summary", "skills", "languages", "certificates", "projects", "interests"];
    cv.customization = s;
    const pdf = await PDFDocument.load(await generateCvPdf(cv));
    const runs = pageTextRuns(pdf, 0);
    const exp = runs.find((r) => r.text === "Berufserfahrung")!;
    const edu = runs.find((r) => r.text === "Ausbildung & Studium")!;
    const sum = runs.find((r) => r.text === "Profil")!;
    expect(exp.y).toBeGreaterThan(edu.y); // experience now sits above education
    expect(edu.y).toBeGreaterThan(sum.y);
  });

  it("honors per-section visibility (hidden sections are not rendered)", async () => {
    const cv = richCv();
    const s = defaultCvCustomization();
    s.sections.visibility.skills = false;
    cv.customization = s;
    const pdf = await PDFDocument.load(await generateCvPdf(cv));
    const runs = pageTextRuns(pdf, 0);
    const text = fullText(pdf);
    expect(runs.some((r) => r.text === "Kenntnisse")).toBe(false);
    expect(text).not.toContain("Java");
    // the rest is still there
    expect(runs.some((r) => r.text === "Berufserfahrung")).toBe(true);
    expect(runs.some((r) => r.text === "Sprachen")).toBe(true);
  });

  it("renders company-specific content: the layout is shared, the document per company", async () => {
    const mk = (title: string, company: string): CvDocument => {
      const cv = baseCv();
      cv.personal.professionalTitle = title;
      const e = emptyExperience();
      e.jobTitle = "Auszubildende:r Anlagenmechaniker SHK";
      e.company = company;
      e.start = "08/2026";
      e.responsibilities = ["Montage von Heizungsanlagen"];
      cv.experience = [e];
      return cv;
    };
    const pdfA = await PDFDocument.load(await generateCvPdf(mk("Kältebau Nord — Anlagenmechaniker SHK", "Kältebau Nord GmbH")));
    const pdfB = await PDFDocument.load(await generateCvPdf(mk("Tech Süd — Systemintegration", "Tech Süd AG")));
    const textA = fullText(pdfA);
    const textB = fullText(pdfB);
    expect(textA).toContain("Kältebau Nord GmbH");
    expect(textA).not.toContain("Tech Süd AG");
    expect(textB).toContain("Tech Süd AG");
    expect(textB).not.toContain("Kältebau Nord GmbH");
    // Same section structure for both companies.
    for (const heading of ["Profil", "Berufserfahrung", "Kenntnisse", "Sprachen"]) {
      expect(textA).toContain(heading);
      expect(textB).toContain(heading);
    }
  });

  it("numbers multi-page documents subtly and leaves single-page documents unnumbered", async () => {
    const pdf = await PDFDocument.load(await generateCvPdf(longCv()));
    const n = pdf.getPageCount();
    expect(n).toBeGreaterThanOrEqual(2);
    for (let i = 0; i < n; i += 1) {
      expect(pageText(pdf, i)).toContain(`Seite ${i + 1} von ${n}`);
    }
    const single = await PDFDocument.load(await generateCvPdf(richCv()));
    expect(single.getPageCount()).toBe(1);
    expect(pageText(single, 0)).not.toContain("Seite 1 von 1");
  });

  it("continuation pages carry a running header with the candidate's name", async () => {
    const pdf = await PDFDocument.load(await generateCvPdf(longCv()));
    expect(pdf.getPageCount()).toBeGreaterThanOrEqual(2);
    expect(pageText(pdf, 1)).toContain("Mustapha Drif — Lebenslauf");
  });
});

/* ------------------------------------------------------------------ */
/* Round-11 design: header hierarchy, icon alignment, rounded photo    */
/* ------------------------------------------------------------------ */

/** A drawSvgPath group: anchor (translate), flip, color, width, path data. */
interface SvgGroup {
  x: number;
  y: number;
  flip: boolean;
  fill: [number, number, number] | null;
  stroke: [number, number, number] | null;
  width: number | null;
  d: string;
  close: string;
}

/** `(?:(?!Q)[\s\S])*` = any run that never crosses a group boundary (Q). */
function svgGroups(stream: string): SvgGroup[] {
  const out: SvgGroup[] = [];
  // q [color/width ops] 1 0 0 1 X Y cm [more cm] path-ops (f|S|B) Q —
  // the anchor cm is the FIRST translate in the group (the flip cm has −1).
  const re = /q(?:(?!Q)[\s\S])*?1 0 0 1 ([\d.]+) ([\d.]+) cm(?:(?!Q)[\s\S])*?\b(f|S|B)\b\s*Q/g;
  for (const m of stream.matchAll(re)) {
    const body = m[0];
    const fill = body.match(/([\d.]+) ([\d.]+) ([\d.]+) rg/);
    const stroke = body.match(/([\d.]+) ([\d.]+) ([\d.]+) RG/);
    const width = body.match(/([\d.]+) w/);
    out.push({
      x: Number(m[1]),
      y: Number(m[2]),
      flip: body.includes("1 0 0 -1 0 0 cm"),
      fill: fill ? [Number(fill[1]), Number(fill[2]), Number(fill[3])] : null,
      stroke: stroke ? [Number(stroke[1]), Number(stroke[2]), Number(stroke[3])] : null,
      width: width ? Number(width[1]) : null,
      d: body,
      close: m[3],
    });
  }
  return out;
}

/** Absolute-coordinate circle groups (drawCircle): `q <color> rg 0 w [] 0 d q m + 4 cubics Q f Q`. */
interface CircleGroup {
  cx: number;
  cy: number;
  r: number;
  fill: [number, number, number] | null;
}

function circleGroups(stream: string): CircleGroup[] {
  const out: CircleGroup[] = [];
  const re = /q\s*([\d.]+) ([\d.]+) ([\d.]+) rg\s*0 w\s*\[\] 0 d\s*q\s*([\d.]+) ([\d.]+) m([\s\S]*?)Q\s*f\s*Q/g;
  for (const m of stream.matchAll(re)) {
    const first = m[6].match(/[\d.]+ [\d.]+ [\d.]+ [\d.]+ ([\d.]+) ([\d.]+) c/);
    if (!first) continue;
    const mx = Number(m[4]);
    const my = Number(m[5]);
    const r = Number(first[1]) - mx; // first bezier ends at (cx, cy − r)
    out.push({ cx: mx + r, cy: my, r, fill: [Number(m[1]), Number(m[2]), Number(m[3])] });
  }
  return out;
}

/** Bezier midpoint (t = 0.5) of one cubic. */
const cubicMid = (p0: [number, number], c1: [number, number], c2: [number, number], p3: [number, number]): [number, number] => [
  (p0[0] + 3 * c1[0] + 3 * c2[0] + p3[0]) / 8,
  (p0[1] + 3 * c1[1] + 3 * c2[1] + p3[1]) / 8,
];

describe("AUTO BEWERB — header hierarchy, icon alignment, rounded photo", () => {
  it("separates the header from the body with a full-width steel-blue divider rule", async () => {
    const cv = baseCv();
    cv.personal.photo = photoPngDataUrl(300, 400);
    const pdf = await PDFDocument.load(await generateCvPdf(cv));
    const runs = pageTextRuns(pdf, 0);
    const name = runs.find((r) => r.text === "Mustapha Drif")!;
    expect(name.size).toBeCloseTo(21, 0); // comfortable tier (lean profile)
    const stream = pageStream(pdf, 0);
    const placement = imagePlacement(stream)!;
    // The header rule: an ACCENT stroke, 0.75pt wide, spanning the full content width.
    const rule = stream.match(
      /0\.1843137254901961 0\.3607843137254902 0\.6 RG\s*0\.75 w\s*\[\] 0 d\s*([\d.]+) ([\d.]+) m\s*[\d.]+ [\d.]+ m\s*([\d.]+) ([\d.]+) l\s*S/,
    );
    expect(rule, "header divider rule missing").toBeTruthy();
    expect(Number(rule![1])).toBeCloseTo(MARGIN_X, 1); // full width: left margin …
    expect(Number(rule![3])).toBeCloseTo(A4_WIDTH - MARGIN_X, 1); // … to right margin
    // … directly below the photo's bottom edge (comfortable headerRuleGap = 8pt).
    expect(Number(rule![2])).toBeCloseTo(placement.y - 8, 1);
    // and below every header text line.
    const other = runs.find((r) => r.text === "deutscher")!;
    expect(Number(rule![2])).toBeLessThan(other.y - 4);
  });

  it("vertically centers the header text block against the photo band (no dead space beside the photo)", async () => {
    const cv = baseCv();
    cv.personal.photo = photoPngDataUrl(300, 400);
    const pdf = await PDFDocument.load(await generateCvPdf(cv));
    const runs = pageTextRuns(pdf, 0);
    const name = runs.find((r) => r.text === "Mustapha Drif")!;
    const other = runs.find((r) => r.text === "deutscher")!;
    // Name top / other-facts bottom via the renderer's line-box math
    // (firstBaseline: (size·lh − size)/2 + 0.72·size; descent 0.28·size).
    const nameTop = name.y + ((21 * 1.15 - 21) / 2 + 21 * 0.72);
    const otherBottom = other.y - other.size * 0.28;
    const textCenter = (nameTop + otherBottom) / 2;
    const placement = imagePlacement(pageStream(pdf, 0))!;
    const photoCenter = placement.y + placement.h / 2;
    expect(Math.abs(textCenter - photoCenter), `text ${textCenter} vs photo ${photoCenter}`).toBeLessThan(1.5);
  });

  it("applies NO header shift without a photo, and none when the text is taller than the photo", async () => {
    const contentTop = A4_HEIGHT - 12 * MM; // comfortable tier
    const nameTopOf = (pdf: PDFDocument): number => {
      const name = pageTextRuns(pdf, 0).find((r) => r.text === "Mustapha Drif")!;
      return name.y + ((21 * 1.15 - 21) / 2 + 21 * 0.72);
    };
    // (a) without a photo: the name starts at the very top.
    const a = await PDFDocument.load(await generateCvPdf(baseCv()));
    expect(nameTopOf(a)).toBeCloseTo(contentTop, 0.5);
    // (b) photo + a header text block TALLER than the 128pt photo band: no shift.
    const cv = baseCv();
    cv.personal.photo = photoPngDataUrl(300, 400);
    cv.personal.professionalTitle =
      "Fachinformatiker für Systemintegration und Vernetzte Systeme — Bewerbung als Auszubildender in der Fachrichtung " +
      "Informaticstechniker für Daten- und Systemanalyse bei der sehr sehr sehr sehr sehr langen Unternehmensname " +
      "GmbH & Co. KG mit Sitz in einem überregional bedeutenden Wirtschaftsstandort";
    const b = await PDFDocument.load(await generateCvPdf(cv));
    const titleRuns = pageTextRuns(b, 0).filter((r) => r.size === 13);
    expect(titleRuns.length).toBeGreaterThanOrEqual(4); // the title really wraps into several lines
    expect(nameTopOf(b)).toBeGreaterThanOrEqual(contentTop - 0.5);
  });

  it("contactIconAxis: every icon shares one optical axis per contact line (baseline + 0.22·size)", () => {
    // Matches the template's flex centering (1.5em line box, 0.72em ascent).
    expect(contactIconAxis(731.0093, 9.5)).toBeCloseTo(733.0993, 4);
    expect(contactIconAxis(0, 10)).toBeCloseTo(2.2, 6);
    expect(contactIconAxis(100, 8)).toBeCloseTo(101.76, 6);
  });

  it("centers EVERY icon glyph (mail, phone, pin, globe, linkedin) on its line's axis", async () => {
    const cv = baseCv();
    cv.personal.photo = photoPngDataUrl(300, 400);
    cv.personal.website = "www.mustapha-drif.de";
    cv.personal.linkedin = "linkedin.com/in/mustapha-drif";
    const pdf = await PDFDocument.load(await generateCvPdf(cv));
    const stream = pageStream(pdf, 0);
    const runs = pageTextRuns(pdf, 0);
    const groups = svgGroups(stream);
    const circles = circleGroups(stream);

    // Line 1: mail / phone / pin — axis from the email baseline.
    const email = runs.find((r) => r.text === "mustapha.drif@example.de")!;
    const axis1 = contactIconAxis(email.y, email.size);
    const mail = groups.find(
      (g) => !g.flip && g.fill && closeColor(g.fill, C_BODY) && g.close === "f" && /0 0 m\s*0 5\.8 l\s*8\.4 5\.8 l\s*8\.4 0 l\s*h/.test(g.d),
    );
    expect(mail, "mail envelope rect missing").toBeTruthy();
    expect(mail!.y + 2.9).toBeCloseTo(axis1, 1); // rect center on the axis
    const phone = groups.find((g) => g.flip && g.fill && closeColor(g.fill, C_BODY) && g.d.includes("2.38 3.88 m"));
    expect(phone, "phone handset missing").toBeTruthy();
    expect(phone!.y).toBeCloseTo(axis1 + 4.23, 1); // scaled handset center on the axis
    const pinOuter = circles.find((c) => closeColor(c.fill, C_BODY) && Math.abs(c.cy - (axis1 + 0.7)) < 0.5 && c.r > 1 && c.r < 4);
    expect(pinOuter, "pin circle missing").toBeTruthy();
    expect(pinOuter!.r).toBeCloseTo(3.1, 1);
    const pinTip = groups.find((g) => g.flip && g.fill && closeColor(g.fill, C_BODY) && g.d.includes("1.2 0 m"));
    expect(pinTip, "pin tip triangle missing").toBeTruthy();
    expect(pinTip!.y).toBeCloseTo(axis1 - 2.4, 1);
    // All three glyphs agree on the SAME axis.
    expect(mail!.y + 2.9).toBeCloseTo(phone!.y - 4.23, 1);
    expect(pinOuter!.cy - 0.7).toBeCloseTo(axis1, 1);

    // Line 2: globe / linkedin — axis from the website baseline.
    const web = runs.find((r) => r.text === "www.mustapha-drif.de")!;
    const axis2 = contactIconAxis(web.y, web.size);
    const globe = circles.find((c) => closeColor(c.fill, C_BODY) && Math.abs(c.cy - axis2) < 0.3 && Math.abs(c.r - 3.7) < 0.3);
    expect(globe, "globe circle missing").toBeTruthy();
    const linkedin = groups.find(
      (g) => !g.flip && g.fill && closeColor(g.fill, C_BODY) && g.close === "f" && /0 0 m\s*0 7\.4 l\s*7\.4 7\.4 l\s*7\.4 0 l\s*h/.test(g.d),
    );
    expect(linkedin, "linkedin rect missing").toBeTruthy();
    expect(linkedin!.y + 3.7).toBeCloseTo(axis2, 1);
    // …and the white "in" glyph sits inside the box.
    const inRun = runs.find((r) => r.text === "in")!;
    expect(closeColor(inRun.color, [1, 1, 1])).toBe(true);
  });

  it("gives the photograph professionally rounded corners: four white arc notches + a 0.75pt accent frame", async () => {
    const cv = baseCv();
    cv.personal.photo = photoPngDataUrl(300, 400);
    const pdf = await PDFDocument.load(await generateCvPdf(cv));
    const stream = pageStream(pdf, 0);
    const placement = imagePlacement(stream)!;
    const { x, y, w, h } = placement; // y = bottom edge
    const top = y + h;
    const rr = 6.5; // comfortable-tier photoRadius
    const groups = svgGroups(stream);

    // Exactly four white-filled, y-flipped, arc-closed groups (the notches).
    const notches = groups.filter(
      (g) => g.flip && g.fill && closeColor(g.fill, [1, 1, 1]) && g.close === "f" && /0 0 m\s*[-\d.]+ 0 l\s*[-\d.]+ [-\d.]+ [-\d.]+ [-\d.]+ [-\d.]+ [-\d.]+ c\s*h/.test(g.d),
    );
    expect(notches.length, "expected exactly 4 corner notches").toBe(4);

    // Each notch: anchored at one photo corner, line along one edge, quarter-arc
    // whose bezier midpoint sits rr·(1−1/√2) ≈ 0.2929·rr from BOTH edges —
    // an inverted sweep flag would put the midpoint near the corner itself
    // (≈ 0.7071·rr) and fail this check.
    const expected: [number, number, number, number][] = [
      [x, top, +1, +1], // TL: line right, arc down — midpoint (+, +)
      [x + w, top, -1, +1], // TR: line left, arc down — midpoint (−, +)
      [x, y, +1, -1], // BL: line right, arc up — midpoint (+, −)
      [x + w, y, -1, -1], // BR: line left, arc up — midpoint (−, −)
    ];
    for (const [ax, ay, sx, sy] of expected) {
      const notch = notches.find((g) => Math.abs(g.x - ax) < 0.05 && Math.abs(g.y - ay) < 0.05);
      expect(notch, `notch at (${ax}, ${ay}) missing`).toBeTruthy();
      const m = notch!.d.match(/0 0 m\s*([-\d.]+) 0 l\s*([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+) c/)!;
      const p0: [number, number] = [Number(m[1]), 0];
      const c1: [number, number] = [Number(m[2]), Number(m[3])];
      const c2: [number, number] = [Number(m[4]), Number(m[5])];
      const p3: [number, number] = [Number(m[6]), Number(m[7])];
      expect(Math.abs(p0[0]), "notch line length = radius").toBeCloseTo(rr, 1);
      expect(Math.sign(p0[0])).toBe(sx);
      expect(Math.sign(p3[1])).toBe(sy);
      const [mx, my] = cubicMid(p0, c1, c2, p3);
      expect(Math.abs(mx), "arc midpoint x").toBeCloseTo(0.2929 * rr, 1);
      expect(Math.abs(my), "arc midpoint y").toBeCloseTo(0.2929 * rr, 1);
    }

    // The frame: stroked (not filled), 0.75pt, ACCENT, anchored at the photo's
    // TOP-LEFT and spanning exactly the photo rect (0..w × 0..h local).
    const frame = groups.find(
      (g) => g.flip && g.stroke && closeColor(g.stroke, C_ACCENT) && g.width !== null && Math.abs(g.width - 0.75) < 0.01 && g.close === "S",
    );
    expect(frame, "accent frame missing").toBeTruthy();
    expect(frame!.x).toBeCloseTo(x, 1);
    expect(frame!.y).toBeCloseTo(top, 1); // the frame sits ON the photo, not below it
    expect(frame!.d).toContain("6.5 0 m"); // bottom edge
    expect(frame!.d).toContain("89.5 0 l");
    expect(frame!.d).toContain("96 121.5 l"); // right edge
    expect(frame!.d).toContain("6.5 128 l"); // top edge
    expect(frame!.d).toContain("0 6.5 l"); // left edge
  });

  it("renders a SQUARE photo with rounded corners too (notches follow the placed image)", async () => {
    const cv = baseCv();
    cv.personal.photo = photoPngDataUrl(300, 300); // 1:1 → placed 96×96
    const pdf = await PDFDocument.load(await generateCvPdf(cv));
    const stream = pageStream(pdf, 0);
    const placement = imagePlacement(stream)!;
    expect(placement!.w).toBeCloseTo(placement!.h, 1); // aspect preserved (square)
    const groups = svgGroups(stream);
    const notches = groups.filter(
      (g) => g.flip && g.fill && closeColor(g.fill, [1, 1, 1]) && g.close === "f" && /0 0 m\s*[-\d.]+ 0 l\s*[-\d.]+ [-\d.]+ [-\d.]+ [-\d.]+ [-\d.]+ [-\d.]+ c\s*h/.test(g.d),
    );
    expect(notches.length).toBe(4);
    const corners = notches.map((g) => [g.x, g.y]);
    const top = placement!.y + placement!.h;
    for (const [cx, cy] of [
      [placement!.x, top],
      [placement!.x + placement!.w, top],
      [placement!.x, placement!.y],
      [placement!.x + placement!.w, placement!.y],
    ]) {
      expect(corners.some(([gx, gy]) => Math.abs(gx - cx) < 0.05 && Math.abs(gy - cy) < 0.05), `notch at (${cx}, ${cy})`).toBe(true);
    }
  });
});

describe("AUTO BEWERB — one-page contract under long content (round 11)", () => {
  /**
   * Long-but-realistic profile: a ~4-line PROFIL (the 900-char cap keeps
   * longer ones honest), every contact field, 2 jobs × 3-4 bullets +
   * achievement, 2 educations, 8 skills, 3 languages, 3 certificates,
   * 2 projects with descriptions, 3 interests + a 3:4 photo.
   */
  function stressCv(): CvDocument {
    const cv = richCv();
    cv.personal.photo = photoPngDataUrl(300, 400);
    cv.summary =
      "Motivierter und zuverlässiger Fachinformatiker für Systemintegration mit Erfahrung im Aufbau und Betrieb " +
      "kleiner Netzwerke: Systemintegration, Netzwerktechnik, Linux-Betriebssysteme und Kubernetes-Administration. " +
      "Gewohnt, strukturiert und eigenständig zu arbeiten, komplexe Zusammenhänge verständlich zu dokumentieren " +
      "und technische Lösungen sorgfältig zu planen, umzusetzen und abzunehmen — möchte die eigene Erfahrung " +
      "jetzt in einem engagierten Team einbringen und Verantwortung übernehmen.";
    cv.skills = ["Java", "Netzwerktechnik", "Systemintegration", "Kubernetes", "Linux", "Bewerbung", "Schaltpläne lesen", "Teamarbeit"];
    return cv;
  }

  it("fits long-but-realistic content on EXACTLY one A4 page", async () => {
    const pdf = await PDFDocument.load(await generateCvPdf(stressCv()));
    expect(pdf.getPageCount(), "the one-page contract must hold for realistic content").toBe(1);
    // …and nothing is lost: every fact of the stress profile is present.
    const text = fullText(pdf);
    for (const fact of [
      "Mustapha Drif",
      "Praktikant Kältetechnik",
      "Auszubildender Fachinformatiker",
      "Abitur — Gymnasium",
      "Schulvorbereitung",
      "Java",
      "Netzwerktechnik",
      "Schaltpläne lesen",
      "Deutsch",
      "verhandlungssicher",
      "Arabisch",
      "IT-Support-Zertifikat",
      "Erste Hilfe — DRK — 2024",
      "Heimnetzwerk",
      "Schul-Wiki",
      "IT-Projekte",
      "Fußball",
      "Musik",
      "Verantwortung übernehmen", // end of the long PROFIL
    ]) {
      expect(text, `missing: ${fact}`).toContain(fact);
    }
  });

  it("long words and long text wrap without clipping the page or overlapping the photo", async () => {
    const cv = stressCv();
    // A word far longer than any line width (character-level wrap kicks in).
    cv.personal.website = "www.unser-sehr-langes-unternehmens-webportal-mit-einem-sehr-langem-domain-namen.example";
    const pdf = await PDFDocument.load(await generateCvPdf(cv));
    expect(pdf.getPageCount()).toBe(1);
    const placement = imagePlacement(pageStream(pdf, 0));
    for (let i = 0; i < pdf.getPageCount(); i += 1) {
      const runs = pageTextRuns(pdf, i);
      expect(runs.length).toBeGreaterThan(0);
      for (const run of runs) {
        const w = runWidth(run);
        expect(run.x, `p${i + 1} "${run.text}" left of page`).toBeGreaterThanOrEqual(OUTER_LEFT);
        expect(run.x + w, `p${i + 1} "${run.text}" right of page`).toBeLessThanOrEqual(OUTER_RIGHT);
        expect(run.y - run.size * 0.28, `p${i + 1} "${run.text}" clipped below`).toBeGreaterThanOrEqual(9 * MM - 1.5);
        expect(run.y + run.size * 0.72, `p${i + 1} "${run.text}" clipped above`).toBeLessThanOrEqual(A4_HEIGHT - 9 * MM + 1.5);
        // No text run may intersect the photograph.
        if (placement) {
          const topEdge = run.y + run.size * 0.72;
          const bottomEdge = run.y - run.size * 0.28;
          const intersects =
            run.x < placement.x + placement.w + 1 &&
            run.x + w > placement.x - 1 &&
            topEdge > placement.y + 1 &&
            bottomEdge < placement.y + placement.h - 1;
          expect(intersects, `p${i + 1} "${run.text}" overlaps the photo`).toBe(false);
        }
      }
    }
  });
});

describe("AUTO BEWERB — preview/PDF design consistency (builder template twin)", () => {
  const readSource = (p: string): string =>
    readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
  const modern = readSource("src/components/cv-templates/modern-template.tsx");
  const shared = readSource("src/components/cv-templates/shared.tsx");

  it("the modern template (the PDF's design twin) carries the rounded photo + header divider identity", () => {
    expect(modern).toContain('photoShape: "rounded-portrait"');
    expect(modern).toContain('alignItems: "center"'); // header text vertically centered against the photo band
    expect(modern).toContain("borderBottom"); // the header divider (1px, like the PDF's 0.75pt rule)
  });

  it("the template identity honors an explicit user photo shape (keep() guard)", () => {
    expect(shared).toMatch(/identity\.photoShape\s*\?\s*keep\(s\.photo\.shape, d\.photo\.shape, identity\.photoShape\)\s*:\s*s\.photo\.shape/);
  });
});
