/**
 * REAL-ARTIFACT tests for the simplified hiddenInformation contract:
 * the note lives in the draft only and the exported PDF carries NO trace
 * of it — visible or extractable.
 *
 * Feasibility finding (verified empirically in this environment and
 * re-verified by the "probe" artifact below in CI): the browser print
 * pipeline (headless Chrome --print-to-pdf) OMITS invisible text from the
 * PDF text layer — `opacity: 0`, `visibility: hidden` and `font-size: 0`
 * content all disappear. There is therefore no compliant way to embed an
 * invisible-but-extractable note; only forbidden techniques (white-on-
 * white, off-page text) could survive, and those are deliberately NOT
 * used (guarded by the shipped-CSS assertions below). If an invisible
 * layer is ever required, it needs a separate server-side PDF
 * post-processing pipeline — not this print flow.
 *
 * Verified on the exported PDF files themselves (not React state):
 *  1. empty-note export → visible CV intact, no note text anywhere;
 *  2. populated-note export → EXACTLY the same PDF (page count and full
 *     extracted text) as the empty export, no note marker;
 *  3. same for a second template (modern) — the note is template-agnostic
 *     because no template renders it;
 *  4. probe artifact: visible text is extracted, opacity:0 and
 *     visibility:hidden text is omitted by Chrome (documents WHY the
 *     export cannot contain a hidden layer);
 *  5. the shipped CV print CSS contains no hidden-text tricks.
 *
 * Environment: needs a Chrome binary (google-chrome or a Chrome-for-
 * Testing cache under ~/.cache/cht). Without one the Chrome-dependent
 * suite skips — same honest-failure mode as tests/deckblatt-composition.
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
import { cvEmpty, type CvDocument as CvDocModel } from "@/lib/templates/cv";

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
    /* no cache dir — fine */
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
// PDF text extraction (the repo's own pdf.js + pdf-parse priming chain —
// identical to src/lib/pdf-extract.ts; node env, no SSR involved)
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

// ---------------------------------------------------------------------------
// Harness: the EXACT print-root markup the builder portals, with the
// EXACT shipped print CSS from globals.css.
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

function sampleCv(
  templateId: CvDocModel["templateId"],
  hiddenInformation: string,
): CvDocModel {
  const cv = cvEmpty();
  cv.templateId = templateId;
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
  cv.hiddenInformation = hiddenInformation;
  return cv;
}

// Unique markers so any leakage into the artifact is impossible to miss.
const NOTE_DE = "Bismillahir Rahmanir Rahim — private test note (PDF probe)";

/** The builder's print-root content, exactly as portal-rendered today:
 *  ONLY the CV sheet — the note is intentionally not part of it. */
function printRootMarkup(templateId: CvDocModel["templateId"], note: string): string {
  const sheet = renderToStaticMarkup(
    <CvDocument cv={sampleCv(templateId, note)} labels={LABELS} />,
  );
  return `<div class="cv-print-root" aria-hidden="true">${sheet}</div>`;
}

/** Shipped print CSS: the CV print section of globals.css, verbatim. */
function shippedPrintCss(): string {
  const globals = read("src/app/globals.css");
  const start = globals.indexOf("/* CV builder print export (Templates page)");
  const end = globals.indexOf("/* Cover letter print export (Anschreiben builder)");
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return globals.slice(start, end);
}

function harnessHtml(markup: string): string {
  return `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<style>
/* Minimal stand-in for the Tailwind preflight that the browser print
   normally applies (box-sizing + zero body margins). The print section
   below is the SHIPPED CSS from src/app/globals.css, unmodified. */
*, *::before, *::after { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
${shippedPrintCss()}
</style>
</head>
<body class="cv-builder-active">
${markup}
</body>
</html>`;
}

function printPdf(chrome: string, htmlFile: string, pdfFile: string): void {
  execFileSync(
    chrome,
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
  expect(existsSync(pdfFile)).toBe(true);
}

// ---------------------------------------------------------------------------
// The suite (skips when no Chrome is available in the environment)
// ---------------------------------------------------------------------------

describeChrome("CV PDF export — hiddenInformation is absent from the artifact", () => {
  const workDir = mkdtempSync(join(tmpdir(), "cv-note-absent-"));

  const artifacts: Record<string, Extracted> = {};

  beforeAll(async () => {
    const specs: Array<[string, string]> = [
      ["empty-classic", printRootMarkup("classic", "")],
      ["filled-classic", printRootMarkup("classic", NOTE_DE)],
      ["empty-modern", printRootMarkup("modern", "")],
      ["filled-modern", printRootMarkup("modern", NOTE_DE)],
      // Feasibility probe: documents which invisible-text techniques the
      // Chrome print pipeline actually drops (none of them can be used).
      [
        "probe",
        `<div style="width:210mm;min-height:297mm;padding:14mm 15mm;font-family:sans-serif">
          <h1>PROBE-VISIBLE-7f3a</h1>
          <div style="opacity: 0;">PROBE-OPACITY-7f3a</div>
          <div style="visibility: hidden;">PROBE-VISIBILITY-7f3a</div>
        </div>`,
      ],
    ];
    for (const [name, markup] of specs) {
      const htmlFile = join(workDir, `${name}.html`);
      const pdfFile = join(workDir, `${name}.pdf`);
      writeFileSync(htmlFile, harnessHtml(markup), "utf8");
      printPdf(CHROME as string, htmlFile, pdfFile);
      artifacts[name] = await extractPdf(pdfFile);
    }
  }, 300_000);

  it("empty-note export: visible CV intact, no note text anywhere", () => {
    const extracted = artifacts["empty-classic"];
    expect(extracted.total).toBeGreaterThanOrEqual(1);
    expect(extracted.text).not.toContain(NOTE_DE);
    expect(extracted.text).toContain("Daniel Mercer");
    expect(extracted.text).toContain("Sales Manager");
  });

  it("populated note: exported PDF is EXACTLY the empty export (classic)", () => {
    const empty = artifacts["empty-classic"];
    const filled = artifacts["filled-classic"];
    // No trace of the note — visible or extractable:
    expect(filled.text).not.toContain(NOTE_DE);
    // The artifact is unchanged in every observable way:
    expect(filled.total).toBe(empty.total);
    expect(filled.text).toBe(empty.text);
  });

  it("populated note: exported PDF is EXACTLY the empty export (modern)", () => {
    const empty = artifacts["empty-modern"];
    const filled = artifacts["filled-modern"];
    expect(filled.text).not.toContain(NOTE_DE);
    expect(filled.total).toBe(empty.total);
    expect(filled.text).toBe(empty.text);
  });

  it("probe: Chrome omits invisible text from the PDF (why no hidden layer is possible)", () => {
    const probe = artifacts["probe"];
    // Visible text is extractable…
    expect(probe.text).toContain("PROBE-VISIBLE-7f3a");
    // …but opacity:0 and visibility:hidden text is OMITTED from the PDF
    // text layer — a non-visible extractable note is not achievable in
    // this pipeline without forbidden techniques.
    expect(probe.text).not.toContain("PROBE-OPACITY-7f3a");
    expect(probe.text).not.toContain("PROBE-VISIBILITY-7f3a");
  });
});

// Source-level guards (run without Chrome).
describe("shipped export code contains no hidden-text techniques", () => {
  it("the CV print CSS has no white-on-white / invisible / off-page tricks", () => {
    const printCss = shippedPrintCss();
    expect(printCss).not.toMatch(/(?<!background-)color:\s*#fff/i);
    expect(printCss).not.toContain("opacity: 0");
    expect(printCss).not.toContain("visibility: hidden");
    expect(printCss).not.toContain("font-size: 0");
    // The sheet stays the printable page: no negative offsets, no overflow
    // positioning that would push content off the page.
    expect(printCss).not.toMatch(/margin(-[a-z]+)?:\s*-/);
  });

  it("the print portal renders only the CV sheet (no note element)", () => {
    const builderSrc = read("src/components/cv-builder.tsx");
    expect(builderSrc).toContain('className="cv-print-root"');
    expect(builderSrc).not.toContain("CvNotePage");
    expect(builderSrc).not.toContain("cv-note-page");
    // The note field exists and is trimmed/gated nowhere in the print path:
    // it is only written, persisted and (for cover letters) blanked.
    expect(builderSrc).toContain("cv.hiddenInformation");
    const portal = builderSrc.match(
      /<div className="cv-print-root"[\s\S]*?<\/div>/,
    )?.[0] ?? "";
    expect(portal).toContain("<CvDocumentSheet cv={cv} labels={cvLabels} />");
    expect(portal).not.toContain("hiddenInformation");
  });
});
