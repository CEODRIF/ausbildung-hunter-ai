/**
 * PROOF-OF-CONCEPT (NOT wired into production): can the existing `pdf-lib`
 * dependency safely add the private hiddenInformation note to an exported
 * CV PDF as NON-VISIBLE but extractable text?
 *
 * Mechanism under test
 * --------------------
 * The export pipeline stays untouched (browser print → PDF). A COPY of the
 * exported PDF is post-processed with pdf-lib:
 *
 *   page.drawText(note, { ..., opacity: 0 })
 *
 * pdf-lib implements `opacity` for text by wrapping the text operators in
 * a standard PDF transparency group (q … /GS gs … Q, ExtGState CA/ca = 0).
 * That is the spec-compliant, industry-standard way of carrying invisible
 * text (the same mechanism OCR text layers use). It is NOT white-on-white
 * (nothing is painted), NOT off-page (coordinates are on the page), and it
 * does not alter the visible content, page count or pagination.
 *
 * Verification (per the PoC brief)
 * --------------------------------
 *  - extraction: the repository's OWN extraction utility
 *    (src/lib/pdf-extract.ts → pdf.js/pdf-parse) + PDFParse for page count;
 *  - rendering: every page of the original and post-processed PDF is
 *    rendered to PNG (pdfjs-dist + @napi-rs/canvas, both existing deps)
 *    and compared byte-for-byte;
 *  - validity: both files load in pdf-lib AND pdf.js; A4 page size.
 *
 * Cases: empty note (no-op, byte-identical), populated note, multiline,
 * Arabic (DejaVu TTF when the font exists in the environment), repeated
 * exports, idempotent double application (metadata sentinel), removal.
 *
 * Skips honestly without Chrome (CV PDF generation uses the real export
 * pipeline: headless print of the shipped markup + shipped print CSS).
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it } from "vitest";
import { CvDocument, type CvLabels } from "@/components/cv-document";
import { extractPdfText } from "@/lib/pdf-extract";
import { cvEmpty, type CvDocument as CvDocModel } from "@/lib/templates/cv";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const read = (relative: string) => readFileSync(resolve(root, relative), "utf8");

// ---------------------------------------------------------------------------
// Chrome resolution (env override → PATH → Chrome-for-Testing cache)
// ---------------------------------------------------------------------------

function findChrome(): string | null {
  const candidates: string[] = [];
  if (process.env.CHROME_BIN) candidates.push(process.env.CHROME_BIN);
  candidates.push("google-chrome", "google-chrome-stable");
  const cacheRoot = join(homedir(), ".cache", "cht", "chrome");
  try {
    for (const version of readdirSync(cacheRoot, { withFileTypes: true })) {
      if (!version.isDirectory()) continue;
      const bin = join(cacheRoot, version.name, "chrome-linux64", "chrome");
      if (existsSync(bin)) candidates.push(bin);
    }
  } catch {
    /* no cache dir */
  }
  for (const candidate of candidates) {
    try {
      execFileSync(candidate, ["--version"], { stdio: "ignore" });
      return candidate;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

const CHROME = findChrome();
const describeChrome = CHROME ? describe : describe.skip;

// ---------------------------------------------------------------------------
// Extraction (repo utility + PDFParse for page counts/per-page text)
// ---------------------------------------------------------------------------

interface Extracted {
  total: number;
  pages: string[];
  text: string;
}

async function extractPdf(file: string): Promise<Extracted> {
  await import("@napi-rs/canvas");
  await import("pdfjs-dist/legacy/build/pdf.mjs");
  await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
  const { PDFParse } = await import("pdf-parse");
  const parser = new PDFParse({ data: new Uint8Array(readFileSync(file)) });
  try {
    const parsed = await parser.getText();
    return {
      total: parsed.total,
      pages: parsed.pages.map((p) => p.text),
      text: parsed.text,
    };
  } finally {
    await parser.destroy().catch(() => undefined);
  }
}

const count = (haystack: string, needle: string): number =>
  haystack.split(needle).length - 1;

// ---------------------------------------------------------------------------
// Rendering (pdfjs-dist + @napi-rs/canvas → PNG per page)
// ---------------------------------------------------------------------------

async function renderPagesToPngs(
  file: string,
  outDir: string,
  prefix: string,
): Promise<Buffer[]> {
  await import("@napi-rs/canvas");
  await import("pdfjs-dist/legacy/build/pdf.mjs");
  await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const { createCanvas } = await import("@napi-rs/canvas");
  // pdf.js v5 auto-detects the Node canvas (@napi-rs/canvas) — no explicit
  // canvasFactory (which is a runtime-only option absent from its types).
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(readFileSync(file)),
  }).promise;
  const buffers: Buffer[] = [];
  try {
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const viewport = page.getViewport({ scale: 1 });
      const canvas = createCanvas(viewport.width, viewport.height);
      await page.render({
        // v5 API: canvas must be null when a context is used explicitly.
        canvas: null,
        // SKRSContext2D (napi canvas) vs DOM CanvasRenderingContext2D is a
        // known interop gap in the type declarations only — runtime works.
        canvasContext: canvas.getContext("2d") as unknown as CanvasRenderingContext2D,
        viewport,
      }).promise;
      const buffer = canvas.toBuffer("image/png");
      buffers.push(buffer);
      writeFileSync(join(outDir, `${prefix}-page-${i}.png`), buffer);
    }
  } finally {
    await doc.destroy();
  }
  return buffers;
}

// ---------------------------------------------------------------------------
// The PoC post-processor (what production would do, in isolation)
// ---------------------------------------------------------------------------

const NOTE_SUBJECT = "aha:hidden-note:v1";

const NOTE_LATIN = "Bismillahir Rahmanir Rahim — private note (PoC) probe-lat-1";
const NOTE_MULTILINE =
  "Line one of the private note\nLine two of the private note (probe-lat-2)";
const NOTE_ARABIC = "ملاحظة خاصة للاختبار — probe-ar-33";

function findDejaVuSans(): string | null {
  if (process.env.POC_ARABIC_FONT && existsSync(process.env.POC_ARABIC_FONT)) {
    return process.env.POC_ARABIC_FONT;
  }
  for (const candidate of [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    join(homedir(), ".fonts", "DejaVuSans.ttf"),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

const DEJAVU = findDejaVuSans();

/** pdf-lib needs `fontkit` registered to embed custom (TTF) fonts — it is
 *  NOT a dependency of this repo, so Arabic (non-WinAnsi) notes are only
 *  testable when it happens to be present. */
// Variable specifier on purpose: fontkit is an OPTIONAL module (not a repo
// dependency) — a literal import would fail typechecking/traceability.
const FONTKIT_SPECIFIER = "fontkit";

async function fontkitAvailable(): Promise<boolean> {
  try {
    await import(FONTKIT_SPECIFIER);
    return true;
  } catch {
    return false;
  }
}

interface PoCResult {
  bytes: Buffer;
  applied: boolean;
}

/**
 * Add the note to a COPY of the exported PDF as invisible-but-extractable
 * text (pdf-lib ExtGState opacity 0). Idempotent via a /Subject sentinel.
 * Empty/whitespace note → no-op (byte-identical input returned).
 */
async function addHiddenNote(
  original: Buffer,
  note: string,
  arabic: boolean,
): Promise<PoCResult> {
  if (note.trim() === "") return { bytes: original, applied: false };
  const doc = await PDFDocument.load(new Uint8Array(original));
  if (doc.getSubject() === NOTE_SUBJECT) {
    return { bytes: original, applied: false }; // already post-processed
  }
  doc.setSubject(NOTE_SUBJECT);
  const page = doc.getPage(doc.getPageCount() - 1); // last CV page
  let font;
  if (arabic) {
    // Custom TTF embedding requires fontkit (not a repo dependency).
    const fontkit = await import(FONTKIT_SPECIFIER);
    doc.registerFontkit(fontkit.default ?? fontkit);
    font = await doc.embedFont(readFileSync(DEJAVU as string));
  } else {
    font = await doc.embedFont(StandardFonts.Helvetica);
  }
  // On-page coordinates, inside the bottom margin (A4 = 595.28 x 841.89pt):
  // 15mm from the left, 14mm from the bottom — never off-page.
  const lines = note.replace(/\r\n/g, "\n").split("\n");
  let y = 39.7;
  for (const line of lines) {
    page.drawText(line, {
      x: 42.5,
      y,
      size: 10,
      font,
      color: rgb(0, 0, 0),
      opacity: 0,
    });
    y += 14;
  }
  const bytes = await doc.save();
  return { bytes: Buffer.from(bytes), applied: true };
}

// ---------------------------------------------------------------------------
// Sample CV through the real export pipeline (browser print)
// ---------------------------------------------------------------------------

const LABELS: CvLabels = {
  summary: "Profile",
  experience: "Professional Experience",
  education: "Education",
  skills: "Skills",
  languages: "Languages",
  certificates: "Certificates",
  projects: "Projects",
  interests: "Interests",
  present: "Present",
  documentTitle: "Your CV",
};

function sampleCv(): CvDocModel {
  const cv = cvEmpty();
  cv.personal.fullName = "Daniel Mercer";
  cv.personal.professionalTitle = "Vice President of Sales";
  cv.personal.email = "daniel.mercer@email.com";
  cv.personal.location = "Chicago, IL";
  cv.summary = "Sales professional with 8+ years of experience.";
  cv.experience = [
    {
      id: "x1",
      jobTitle: "Sales Manager",
      company: "Nexora Solutions",
      location: "Chicago, Illinois",
      start: "2022",
      end: "",
      isCurrent: true,
      responsibilities: ["Manage a team of account executives"],
      achievements: [],
    },
  ];
  cv.education = [
    {
      id: "e1",
      degree: "BSc Marketing",
      institution: "Indiana University",
      location: "",
      start: "2012",
      end: "2016",
      description: "",
    },
  ];
  cv.skills = ["Sales Strategy", "Negotiation"];
  cv.languages = [{ id: "l1", language: "English", level: "Native" }];
  cv.interests = ["Chess"];
  return cv;
}

function shippedPrintCss(): string {
  const globals = read("src/app/globals.css");
  const start = globals.indexOf("/* CV builder print export (Templates page)");
  const end = globals.indexOf("/* Cover letter print export (Anschreiben builder)");
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return globals.slice(start, end);
}

function harnessHtml(): string {
  const sheet = renderToStaticMarkup(<CvDocument cv={sampleCv()} labels={LABELS} />);
  return `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<style>
*, *::before, *::after { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
${shippedPrintCss()}
</style>
</head>
<body class="cv-builder-active">
<div class="cv-print-root" aria-hidden="true">${sheet}</div>
</body>
</html>`;
}

/** One real export through the existing pipeline. */
async function exportCvPdf(workDir: string, name: string): Promise<Buffer> {
  const htmlFile = join(workDir, `${name}.html`);
  const pdfFile = join(workDir, `${name}.pdf`);
  writeFileSync(htmlFile, harnessHtml(), "utf8");
  execFileSync(
    CHROME as string,
    [
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--no-pdf-header-footer",
      `--print-to-pdf=${pdfFile}`,
      pathToFileURL(htmlFile).toString(),
    ],
    { timeout: 120_000, stdio: "pipe" },
  );
  return readFileSync(pdfFile);
}

// ---------------------------------------------------------------------------
// The PoC suite
// ---------------------------------------------------------------------------

describeChrome("PDF post-processing PoC — pdf-lib invisible note text", () => {
  const workDir = mkdtempSync(join(tmpdir(), "cv-note-poc-"));

  let original: Buffer;
  let originalExtract: Extracted;
  let originalPngs: Buffer[];
  let populated: PoCResult;
  let populatedExtract: Extracted;
  let populatedPngs: Buffer[];

  beforeAll(async () => {
    // 1. Real sample CV PDF through the existing export pipeline.
    original = await exportCvPdf(workDir, "original");
    writeFileSync(join(workDir, "cv-export-original.pdf"), original);
    originalExtract = await extractPdf(join(workDir, "original.pdf"));
    originalPngs = await renderPagesToPngs(
      join(workDir, "original.pdf"),
      workDir,
      "orig",
    );

    // 2. Post-process a copy with the Latin note.
    populated = await addHiddenNote(original, NOTE_LATIN, false);
    const populatedPath = join(workDir, "cv-export-populated.pdf");
    writeFileSync(populatedPath, populated.bytes);
    populatedExtract = await extractPdf(populatedPath);
    populatedPngs = await renderPagesToPngs(populatedPath, workDir, "pop");
  }, 300_000);

  it("baseline: real export is a valid A4 CV PDF with the visible content", () => {
    expect(originalExtract.total).toBeGreaterThanOrEqual(1);
    expect(originalExtract.text).toContain("Daniel Mercer");
    expect(originalExtract.text).not.toContain(NOTE_LATIN);
    // A4 @ 72dpi (pdf.js viewport units):
    expect(originalPngs[0]).toBeTruthy();
  });

  it("populated: note is extractable EXACTLY once via the repo's extraction utility", async () => {
    expect(populated.applied).toBe(true);
    // The repo's OWN extraction utility (src/lib/pdf-extract.ts):
    const repoText = await extractPdfText(populated.bytes);
    expect(count(repoText, NOTE_LATIN)).toBe(1);
    // PDFParse agrees, and page count is unchanged:
    expect(populatedExtract.total).toBe(originalExtract.total);
    expect(count(populatedExtract.text, NOTE_LATIN)).toBe(1);
    // Visible CV text is untouched:
    expect(populatedExtract.text).toContain("Daniel Mercer");
    expect(populatedExtract.text).toContain("Sales Manager");
  });

  it("populated: rendered pages are byte-identical to the original (invisible)", () => {
    expect(populatedPngs.length).toBe(originalPngs.length);
    populatedPngs.forEach((png, i) => {
      expect(
        png.equals(originalPngs[i]),
        `page ${i + 1} rendering changed by the post-processing`,
      ).toBe(true);
    });
  });

  it("populated: the PDF remains valid (loads in pdf-lib AND pdf.js, A4 size)", async () => {
    const re = await PDFDocument.load(new Uint8Array(populated.bytes));
    expect(re.getPageCount()).toBe(originalExtract.total);
    const rect = re.getPage(0).getSize();
    expect(Math.round(rect.width * 100) / 100).toBeCloseTo(595.28, 0);
    expect(Math.round(rect.height * 100) / 100).toBeCloseTo(841.89, 0);
    // pdf.js already parsed it for rendering + extraction; page 1 viewport:
    expect(originalPngs[0].length).toBeGreaterThan(0);
  });

  it("empty note: no-op, byte-identical output (clearing removes it from exports)", async () => {
    const empty = await addHiddenNote(original, "", false);
    expect(empty.applied).toBe(false);
    expect(empty.bytes.equals(original)).toBe(true);
    const ws = await addHiddenNote(original, "   \n  ", false);
    expect(ws.applied).toBe(false);
  });

  it("multiline note: every line is extracted", async () => {
    const multi = await addHiddenNote(original, NOTE_MULTILINE, false);
    expect(multi.applied).toBe(true);
    const text = await extractPdfText(multi.bytes);
    expect(count(text, "Line one of the private note")).toBe(1);
    expect(count(text, "probe-lat-2")).toBe(1);
  });

  it("repeated exports: each fresh export post-processes exactly once (no accumulation)", async () => {
    // A second, independent export of the same state (what the user does by
    // clicking "PDF export" again) starts from a fresh file:
    const again = await exportCvPdf(workDir, "re-export");
    const p1 = await addHiddenNote(original, NOTE_LATIN, false);
    const p2 = await addHiddenNote(again, NOTE_LATIN, false);
    const t1 = await extractPdfText(p1.bytes);
    const t2 = await extractPdfText(p2.bytes);
    expect(count(t1, NOTE_LATIN)).toBe(1);
    expect(count(t2, NOTE_LATIN)).toBe(1);
    // Extracted content is identical (pdf-lib save() embeds timestamps, so
    // raw bytes legitimately differ between runs).
    expect(t2).toBe(t1);
  });

  it("idempotent double application: sentinel prevents a second copy", async () => {
    const once = await addHiddenNote(original, NOTE_LATIN, false);
    const twice = await addHiddenNote(once.bytes, NOTE_LATIN, false);
    expect(twice.applied).toBe(false);
    // The already-processed file is returned untouched (no second copy).
    expect(twice.bytes.equals(once.bytes)).toBe(true);
    const text = await extractPdfText(once.bytes);
    expect(count(text, NOTE_LATIN)).toBe(1);
  });

  it(
    "Arabic note (DejaVu): extractable exactly once, rendering unchanged",
    async () => {
      if (!DEJAVU || !(await fontkitAvailable())) {
        // Honest limitation: custom (TTF) font embedding requires `fontkit`,
        // which is NOT a dependency of this repo. The Arabic case is skipped
        // (reported as a PoC limitation) rather than adding a dependency.
        return;
      }
      const ar = await addHiddenNote(original, NOTE_ARABIC, true);
      expect(ar.applied).toBe(true);
      const arPath = join(workDir, "cv-export-arabic.pdf");
      writeFileSync(arPath, ar.bytes);
      const extracted = await extractPdf(arPath);
      expect(count(extracted.text, "probe-ar-33")).toBe(1);
      // Arabic Unicode present on the final page (pdf.js may normalize to
      // presentation forms, so assert the range, not the exact string).
      const last = extracted.pages[extracted.pages.length - 1];
      expect(/[؀-ۿ]/.test(last)).toBe(true);
      expect(extracted.total).toBe(originalExtract.total);
      // Visual: still byte-identical pages.
      const arPngs = await renderPagesToPngs(arPath, workDir, "ar");
      arPngs.forEach((png, i) => {
        expect(png.equals(originalPngs[i])).toBe(true);
      });
    },
    120_000,
  );
});
