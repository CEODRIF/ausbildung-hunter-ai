/**
 * REAL-ARTIFACT tests for the hiddenInformation PDF export.
 *
 * The DOM-level suite (cv-hidden-information.test.tsx) proves the gate and
 * the print-root wiring; this suite proves what the browser actually
 * exports: it prints the shipped print markup (the real CvDocument template
 * output + the real CvNotePage) with the shipped print CSS (extracted from
 * src/app/globals.css) through headless Chrome --print-to-pdf — the same
 * engine and CSS as the user's "PDF export" button — and extracts text
 * from the resulting PDF file (the repo's own pdf.js/pdf-parse stack, as
 * used by src/lib/pdf-extract.ts).
 *
 * Verified on the exported artifact itself (not React state):
 *  1. empty note  → PDF without a note page, no note text anywhere;
 *  2. filled note → exactly ONE extractable occurrence, on its OWN final
 *                   page, page count = empty export + 1;
 *  3. visible CV content (name/title) still present on the CV pages;
 *  4. repeated exports of the same state → still exactly one occurrence
 *     (nothing accumulates);
 *  5. a second template (modern) behaves identically (the note page is
 *     template-agnostic — it is appended after the sheet, outside every
 *     template);
 *  6. Arabic note (dir=rtl) → extracted exactly once.
 *
 * Environment: needs a Chrome binary (google-chrome or a Chrome-for-Testing
 * cache under ~/.cache/cht). Without one the whole suite skips — same
 * honest-failure mode as tests/deckblatt-composition.test.ts.
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
import { CvNotePage } from "@/components/cv-note-page";
import { dictionaries } from "@/lib/i18n/dictionaries";
import { defaultCvCustomization } from "@/lib/templates/cv-customization";
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

const count = (haystack: string, needle: string): number =>
  haystack.split(needle).length - 1;

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

function sampleCv(templateId: CvDocModel["templateId"]): CvDocModel {
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
  return cv;
}

// Unique marker so an accidental duplication is impossible to miss.
const NOTE_DE = "Bismillahir Rahmanir Rahim — private test note (PDF probe)";
const NOTE_AR = "ملاحظة اختبار خاصة — استخراج PDF (probe-ar-7f3a)";

/** The builder's print-root content, exactly as portal-rendered. */
function printRootMarkup(
  templateId: CvDocModel["templateId"],
  note: {
    text: string;
    title: string;
    caption: string;
    dir: "ltr" | "rtl";
  } | null,
): string {
  const customization = defaultCvCustomization();
  const sheet = renderToStaticMarkup(
    <CvDocument cv={sampleCv(templateId)} labels={LABELS} />,
  );
  const notePage = note
    ? renderToStaticMarkup(
        <CvNotePage
          text={note.text}
          title={note.title}
          caption={note.caption}
          dir={note.dir}
          topMm={customization.spacing.topBottomMarginMm}
          leftMm={customization.spacing.leftRightMarginMm}
        />,
      )
    : "";
  return `<div class="cv-print-root" aria-hidden="true">${sheet}${notePage}</div>`;
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

describeChrome("CV PDF export — hiddenInformation on the exported artifact", () => {
  const workDir = mkdtempSync(join(tmpdir(), "cv-note-pdf-"));
  const de = dictionaries.de.templates;
  const ar = dictionaries.ar.templates;

  interface Artifact {
    extracted: Extracted;
  }

  const artifacts: Record<string, Artifact> = {};

  beforeAll(async () => {
    const specs: Array<[string, string]> = [
      ["empty", printRootMarkup("classic", null)],
      [
        "filled",
        printRootMarkup("classic", {
          text: NOTE_DE,
          title: de.hiddenInfoPageTitle,
          caption: de.hiddenInfoPageCaption,
          dir: "ltr",
        }),
      ],
      [
        "filled-again",
        printRootMarkup("classic", {
          text: NOTE_DE,
          title: de.hiddenInfoPageTitle,
          caption: de.hiddenInfoPageCaption,
          dir: "ltr",
        }),
      ],
      [
        "filled-modern",
        printRootMarkup("modern", {
          text: NOTE_DE,
          title: de.hiddenInfoPageTitle,
          caption: de.hiddenInfoPageCaption,
          dir: "ltr",
        }),
      ],
      [
        "rtl",
        printRootMarkup("classic", {
          text: NOTE_AR,
          title: ar.hiddenInfoPageTitle,
          caption: ar.hiddenInfoPageCaption,
          dir: "rtl",
        }),
      ],
    ];
    for (const [name, markup] of specs) {
      const htmlFile = join(workDir, `${name}.html`);
      const pdfFile = join(workDir, `${name}.pdf`);
      writeFileSync(htmlFile, harnessHtml(markup), "utf8");
      printPdf(CHROME as string, htmlFile, pdfFile);
      artifacts[name] = { extracted: await extractPdf(pdfFile) };
    }
  }, 300_000);

  it("empty note: no note page, no note text, visible CV intact", () => {
    const { extracted } = artifacts["empty"];
    expect(extracted.total).toBeGreaterThanOrEqual(1);
    expect(count(extracted.text, NOTE_DE)).toBe(0);
    expect(count(extracted.text, de.hiddenInfoPageTitle)).toBe(0);
    // The visible CV is still exported:
    expect(extracted.text).toContain("Daniel Mercer");
    expect(extracted.text).toContain("Sales Manager");
  });

  it("filled note: exactly ONE extractable occurrence, on its own final page", () => {
    const empty = artifacts["empty"].extracted;
    const filled = artifacts["filled"].extracted;
    // One supplementary A4 page — and nothing else changed in the count.
    expect(filled.total).toBe(empty.total + 1);
    // Exactly one extractable occurrence in the whole document…
    expect(count(filled.text, NOTE_DE)).toBe(1);
    expect(count(filled.text, de.hiddenInfoPageTitle)).toBe(1);
    // …on the FINAL page, never on the first (CV) page.
    const last = filled.pages[filled.pages.length - 1];
    const first = filled.pages[0];
    expect(last).toContain(NOTE_DE);
    expect(last).toContain(de.hiddenInfoPageTitle);
    expect(first).not.toContain(NOTE_DE);
    // Honest caption present (extractable too):
    expect(last).toContain(de.hiddenInfoPageCaption);
  });

  it("visible CV content survives on the CV pages (layout untouched)", () => {
    const filled = artifacts["filled"].extracted;
    const first = filled.pages[0];
    expect(first).toContain("Daniel Mercer");
    expect(first).toContain("Vice President of Sales");
  });

  it("repeated exports of the same state never duplicate the note", () => {
    const a = artifacts["filled"].extracted;
    const b = artifacts["filled-again"].extracted;
    expect(b.total).toBe(a.total);
    expect(count(b.text, NOTE_DE)).toBe(1);
  });

  it("the second template (modern) exports the note identically", () => {
    const filled = artifacts["filled"].extracted;
    const modern = artifacts["filled-modern"].extracted;
    expect(modern.total).toBe(filled.total);
    expect(count(modern.text, NOTE_DE)).toBe(1);
    expect(modern.text).toContain("Daniel Mercer");
  });

  it("Arabic note (dir=rtl) is extractable exactly once", () => {
    const empty = artifacts["empty"].extracted;
    const rtl = artifacts["rtl"].extracted;
    expect(rtl.total).toBe(empty.total + 1);
    // pdf.js normalizes Arabic to presentation forms on extraction (the
    // characters are extractable, but not byte-identical to the source
    // string), so assert via the note's stable ASCII marker plus the
    // presence of Arabic Unicode on the final page.
    expect(count(rtl.text, "probe-ar-7f3a")).toBe(1);
    const last = rtl.pages[rtl.pages.length - 1];
    expect(/[؀-ۿ]/.test(last)).toBe(true);
    // The marker appears nowhere on the CV pages.
    expect(count(rtl.pages.slice(0, -1).join("\n"), "probe-ar-7f3a")).toBe(0);
  });
});

// The gate is trim-based, so whitespace-only notes export nothing.
describe("note-page gate (whitespace-only notes export nothing)", () => {
  it("the builder gates the note page on cv.hiddenInformation.trim()", () => {
    const builderSrc = read("src/components/cv-builder.tsx");
    expect(builderSrc).toContain(
      'const hasHiddenNote = cv.hiddenInformation.trim() !== "";',
    );
    expect(builderSrc).toMatch(/hasHiddenNote && \(\s*<CvNotePage/);
  });
});
