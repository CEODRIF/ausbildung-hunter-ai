/**
 * AUTO BEWERB — A4 CV document renderer (functional tests).
 *
 * `generateCvPdf` renders the saved CvDocument to a real PDF using the
 * reference-based serif design: centered bold serif name + centered italic
 * title, an icon contact row, the candidate photo top-right (aspect
 * preserved), uppercase section headings with thin black rules,
 * right-aligned dates/locations, balanced two-column bullets for
 * skills/certificates/languages, and a clean multi-page flow with subtle
 * page numbers. The preview and the PDF export serve the SAME bytes, so
 * the document contract verified here holds for both: true A4 page size,
 * multi-page flow, the embedded photograph (when present), and German
 * characters (ä ö ü ß) without rendering errors.
 *
 * The layout assertions parse the PDF content stream (text runs with their
 * exact x/y positions + fonts, and the image placement matrix) — they
 * verify the actual geometry, not just the presence of text.
 */
import { deflateSync, inflateSync } from "node:zlib";
import { beforeAll, describe, expect, it } from "vitest";
import { PDFDocument, StandardFonts, type PDFFont } from "pdf-lib";
import { cvPdfFilename, generateCvPdf } from "@/lib/auto-bewerb/cv-pdf";
import {
  cvEmpty,
  emptyExperience,
  type CvDocument,
  type CvExperience,
} from "@/lib/templates/cv";

/* Layout constants — must mirror src/lib/auto-bewerb/cv-pdf.ts. */
const A4_WIDTH = 595.28;
const A4_HEIGHT = 841.89;
const MARGIN_X = 48;
const MARGIN_TOP = 50;
const RIGHT = A4_WIDTH - MARGIN_X;
const TOP = A4_HEIGHT - MARGIN_TOP;
const COL_GUTTER = 26;

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
/* Content-stream parsing (positions, fonts, image placement)         */
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
}

function pageTextRuns(pdf: PDFDocument, pageIndex: number): TextRun[] {
  const stream = pageStream(pdf, pageIndex);
  const runs: TextRun[] = [];
  for (const block of stream.matchAll(/BT([\s\S]*?)ET/g)) {
    const body = block[1];
    const font = body.match(/\/(Times[^ ]*|Helvetica[^ ]*) ([\d.]+) Tf/);
    const pos = body.match(/1 0 0 1 ([\d.]+) ([\d.]+) Tm/);
    const hex = body.match(/<([0-9A-Fa-f]+)> Tj/);
    if (!pos || !hex) continue;
    runs.push({
      x: Number(pos[1]),
      y: Number(pos[2]),
      size: font ? Number(font[2]) : 0,
      font: font?.[1] ?? "",
      text: decodeWinAnsiHex(hex[1]),
    });
  }
  return runs;
}

const pageText = (pdf: PDFDocument, pageIndex: number): string =>
  pageTextRuns(pdf, pageIndex).map((r) => r.text).join("\n");

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

/** Long CV that flows over multiple pages (shared by several tests). */
function longCv(): CvDocument {
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
  return cv;
}

let timesRoman: PDFFont;
let timesBold: PDFFont;
let timesItalic: PDFFont;
let helveticaBold: PDFFont;

beforeAll(async () => {
  const doc = await PDFDocument.create();
  timesRoman = await doc.embedFont(StandardFonts.TimesRoman);
  timesBold = await doc.embedFont(StandardFonts.TimesRomanBold);
  timesItalic = await doc.embedFont(StandardFonts.TimesRomanItalic);
  helveticaBold = await doc.embedFont(StandardFonts.HelveticaBold);
});

/** Rendered width of a run (exact font metrics, per embedded font family). */
function runWidth(run: TextRun): number {
  const font = run.font.startsWith("Times-Bold")
    ? timesBold
    : run.font.startsWith("Times-Italic")
      ? timesItalic
      : run.font.startsWith("Helvetica")
        ? helveticaBold
        : timesRoman;
  return font.widthOfTextAtSize(run.text, run.size);
}

function hasImage(bytes: Uint8Array): boolean {
  return new TextDecoder("latin1").decode(bytes).includes("/Image");
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
    const cv = longCv();
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

describe("AUTO BEWERB — serif reference design (layout geometry)", () => {
  it("uses the Times serif family for ALL text (Helvetica only for the LinkedIn 'in' glyph)", async () => {
    const cv = baseCv();
    cv.personal.linkedin = "linkedin.com/in/mustapha-drif";
    const pdf = await PDFDocument.load(await generateCvPdf(cv));
    const runs = pageTextRuns(pdf, 0);
    expect(runs.length).toBeGreaterThan(10);
    const name = runs.find((r) => r.text === "Mustapha Drif");
    expect(name).toBeTruthy();
    expect(name!.font.startsWith("Times-Bold")).toBe(true);
    const title = runs.find((r) => r.text === "Fachinformatiker — Bewerbung bei Tech GmbH");
    expect(title).toBeTruthy();
    expect(title!.font.startsWith("Times-Italic")).toBe(true);
    const nonSerif = runs.filter((r) => !r.font.startsWith("Times"));
    expect(nonSerif.length).toBe(1);
    expect(nonSerif[0].text).toBe("in");
    expect(nonSerif[0].font.startsWith("Helvetica")).toBe(true);
    expect(nonSerif[0].size).toBeLessThanOrEqual(6);
  });

  it("centers the name and sets the italic title below it (no photo: full content width)", async () => {
    const cv = baseCv();
    const pdf = await PDFDocument.load(await generateCvPdf(cv));
    const runs = pageTextRuns(pdf, 0);
    const name = runs.find((r) => r.text === "Mustapha Drif")!;
    const center = name.x + runWidth(name) / 2;
    // Centered over the full content width (no photo → full width).
    expect(center).toBeCloseTo(MARGIN_X + (A4_WIDTH - 2 * MARGIN_X) / 2, 0);
    const title = runs.find((r) => r.text === "Fachinformatiker — Bewerbung bei Tech GmbH")!;
    expect(title.y).toBeLessThan(name.y); // title line is BELOW the name
    expect(name.size).toBeGreaterThanOrEqual(23); // large name (design target 23–27pt)
    expect(title.size).toBeGreaterThanOrEqual(15); // title (design target 15–17pt)
  });

  it("places the photo flush in the upper-right corner with its aspect ratio preserved (never stretched)", async () => {
    // Portrait 3:4 (standard Bewerbungsfoto) and landscape 4:3.
    for (const [w, h] of [[300, 400], [400, 300]] as const) {
      const cv = baseCv();
      cv.personal.photo = photoPngDataUrl(w, h);
      const pdf = await PDFDocument.load(await generateCvPdf(cv));
      const placement = imagePlacement(pageStream(pdf, 0));
      expect(placement).toBeTruthy();
      // Top-right: the photo's top edge touches the top margin and its
      // right edge touches the right margin.
      expect(placement!.y + placement!.h).toBeCloseTo(TOP, 1);
      expect(placement!.x + placement!.w).toBeCloseTo(RIGHT, 1);
      // Aspect ratio preserved (3:4 → capped at the 116pt max height →
      // 87×116; 4:3 → capped at the 90pt max width → 90×67.5).
      expect(placement!.w / placement!.h).toBeCloseTo(w / h, 1);
      expect(placement!.w).toBeLessThanOrEqual(90 + 0.01);
      expect(placement!.h).toBeLessThanOrEqual(116 + 0.01);
    }
  });

  it("right-aligns the date on the job-title baseline and the location on the company baseline", async () => {
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
    const company = runs.find((r) => r.text === "Tech GmbH")!;
    const location = runs.find((r) => r.text === "Hamburg")!;
    expect(title.font.startsWith("Times-Bold")).toBe(true);
    expect(company.font.startsWith("Times-Italic")).toBe(true);
    // Date on the SAME baseline as the job title, flush right…
    expect(date.y).toBeCloseTo(title.y, 2);
    expect(date.x + runWidth(date)).toBeCloseTo(RIGHT, 0);
    // …location on the SAME baseline as the company, flush right.
    expect(location.y).toBeCloseTo(company.y, 2);
    expect(location.x + runWidth(location)).toBeCloseTo(RIGHT, 0);
  });

  it("lays out skills as balanced two columns with row-aligned bullets", async () => {
    const cv = baseCv(); // 5 skills → 3 left / 2 right
    const pdf = await PDFDocument.load(await generateCvPdf(cv));
    const runs = pageTextRuns(pdf, 0);
    const colW = (A4_WIDTH - 2 * MARGIN_X - COL_GUTTER) / 2;
    const java = runs.find((r) => r.text === "Java")!;
    const kubernetes = runs.find((r) => r.text === "Kubernetes")!;
    expect(java.x).toBeCloseTo(MARGIN_X + 14, 1);
    expect(kubernetes.x).toBeCloseTo(MARGIN_X + colW + COL_GUTTER + 14, 1);
    // First rows of both columns sit on the same baseline.
    expect(kubernetes.y).toBeCloseTo(java.y, 2);
  });

  it("omits sections that have no content (nothing is invented)", async () => {
    const cv = cvEmpty();
    cv.personal.fullName = "Test Person";
    cv.summary = "Kurzprofil.";
    const pdf = await PDFDocument.load(await generateCvPdf(cv));
    const text = pageText(pdf, 0);
    expect(text).toContain("PROFIL");
    for (const heading of ["BERUFSERFAHRUNG", "AUSBILDUNG", "KENNTNISSE", "ZERTIFIKATE", "SPRACHEN", "PROJEKTE", "INTERESSEN"]) {
      expect(text).not.toContain(heading);
    }
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
    const all = (pdf: PDFDocument) =>
      Array.from({ length: pdf.getPageCount() }, (_, i) => pageText(pdf, i)).join("\n");
    const textA = all(pdfA);
    const textB = all(pdfB);
    expect(textA).toContain("Kältebau Nord");
    expect(textA).not.toContain("Tech Süd");
    expect(textB).toContain("Tech Süd");
    expect(textB).not.toContain("Kältebau Nord");
    // Same section structure for both companies.
    for (const heading of ["PROFIL", "BERUFSERFAHRUNG & PRAKTIKA", "KENNTNISSE & FÄHIGKEITEN", "SPRACHEN"]) {
      expect(textA).toContain(heading);
      expect(textB).toContain(heading);
    }
  });

  it("keeps EVERY text run inside the A4 margins on every page (no overflow, no overlap)", async () => {
    const pdf = await PDFDocument.load(await generateCvPdf(longCv()));
    expect(pdf.getPageCount()).toBeGreaterThanOrEqual(2);
    for (let i = 0; i < pdf.getPageCount(); i += 1) {
      const runs = pageTextRuns(pdf, i);
      expect(runs.length).toBeGreaterThan(0);
      for (const run of runs) {
        expect(run.x, `page ${i + 1}: "${run.text}" starts at ${run.x}`).toBeGreaterThanOrEqual(MARGIN_X - 1.5);
        expect(run.x + runWidth(run), `page ${i + 1}: "${run.text}" ends at ${run.x + runWidth(run)}`).toBeLessThanOrEqual(RIGHT + 1.5);
      }
    }
  });

  it("numbers multi-page documents subtly and leaves single-page documents unnumbered", async () => {
    const pdf = await PDFDocument.load(await generateCvPdf(longCv()));
    const n = pdf.getPageCount();
    expect(n).toBeGreaterThanOrEqual(2);
    for (let i = 0; i < n; i += 1) {
      expect(pageText(pdf, i)).toContain(`Seite ${i + 1} von ${n}`);
    }
    const single = await PDFDocument.load(await generateCvPdf(baseCv()));
    expect(single.getPageCount()).toBe(1);
    expect(pageText(single, 0)).not.toContain("Seite 1 von 1");
  });

  it("continuation pages carry a running header with the candidate's name", async () => {
    const pdf = await PDFDocument.load(await generateCvPdf(longCv()));
    expect(pdf.getPageCount()).toBeGreaterThanOrEqual(2);
    expect(pageText(pdf, 1)).toContain("Mustapha Drif — Lebenslauf");
  });
});
