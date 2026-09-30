import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { PDF_PARSE_FAILED, extractPdfText } from "@/lib/pdf-extract";

const REPO_ROOT = resolve(__dirname, "..");
const SCAN_NFT = join(
  REPO_ROOT,
  ".next/server/app/api/bewerbung-scanner/scan/route.js.nft.json",
);

/** Files Next.js's tracer records for the scan route = the EXACT set Vercel
 *  ships into the serverless function. */
function scannedFiles(): string[] {
  if (!existsSync(SCAN_NFT)) return [];
  const nft = JSON.parse(readFileSync(SCAN_NFT, "utf8")) as { files?: string[] };
  return (nft.files ?? []).filter((f) =>
    /node_modules\/(pdf-parse|pdfjs-dist|@napi-rs)/.test(f),
  );
}

/**
 * Regression tests for the PDF analysis pipeline (Bewerbung Scanner).
 *
 * Background: pdf.js (via pdf-parse v2) requires the canvas-backed
 * DOMMatrix/ImageData/Path2D globals that the parser's worker bootstraps
 * from @napi-rs/canvas. If the PDF stack gets inlined by the bundler or a
 * browser-only code path is evaluated on the server, Node crashes with
 * `ReferenceError: DOMMatrix is not defined`. These tests run the real
 * extraction in plain Node — an environment that has NO browser globals —
 * so any future change that reintroduces that dependency fails here.
 */

/** Minimal valid single-page PDF whose page contains the text
 *  "Lebenslauf Test" (Helvetica, standard 14 font). */
const SAMPLE_PDF = Buffer.from(
  [
    "%PDF-1.4",
    "1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj",
    "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj",
    "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj",
    "4 0 obj<</Length 44>>stream",
    "BT /F1 24 Tf 72 720 Td (Lebenslauf Test) Tj ET",
    "endstream",
    "endobj",
    "5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj",
    "trailer<</Root 1 0 R/Size 6>>",
    "%%EOF",
  ].join("\n"),
  "latin1",
);

describe("pdf-extract (server-safe PDF text extraction)", () => {
  it("works in plain Node WITHOUT any browser globals (DOMMatrix must be undefined)", async () => {
    // Hard guard: if this is ever defined, the test no longer proves the
    // pipeline is browser-global free.
    expect(typeof (globalThis as Record<string, unknown>).DOMMatrix).toBe(
      "undefined",
    );
    expect(typeof document).toBe("undefined");
    const text = await extractPdfText(SAMPLE_PDF);
    expect(text).toContain("Lebenslauf Test");
  }, 30000);

  it("returns stable PDF_PARSE_FAILED code (never a library message) for invalid data", async () => {
    // The thrown message must be exactly the stable code — never a
    // library/stack message like "DOMMatrix is not defined".
    await expect(
      extractPdfText(Buffer.from("this is definitely not a pdf")),
    ).rejects.toThrow(/^PDF_PARSE_FAILED$/);
  }, 30000);

  it("rejects empty input with the same stable code", async () => {
    await expect(extractPdfText(new Uint8Array(0))).rejects.toThrow(
      PDF_PARSE_FAILED,
    );
  }, 30000);

  // ---------------------------------------------------------------------
  // Production (Vercel) regression: the function filesystem is PRUNED to
  // exactly the files in the route's nft manifest. Previously that set was
  // missing `pdf.worker.mjs` AND the whole `@napi-rs/canvas` package, so
  // pdf.mjs's module-scope `new DOMMatrix()` crashed in production while
  // every local run (full node_modules) passed.
  // ---------------------------------------------------------------------

  it("ships the complete pdf.js runtime into the scan function (nft manifest)", () => {
    const files = scannedFiles();
    if (files.length === 0) return; // no build present — nothing to assert
    expect(
      files.some((f) => f.includes("pdfjs-dist/legacy/build/pdf.mjs")),
      "pdf.mjs must be shipped",
    ).toBe(true);
    expect(
      files.some((f) => f.includes("pdfjs-dist/legacy/build/pdf.worker.mjs")),
      "pdf.worker.mjs must be shipped (fake worker + fallback)",
    ).toBe(true);
    expect(
      files.some((f) => f.includes("@napi-rs/canvas/")),
      "@napi-rs/canvas must be shipped (DOMMatrix polyfill)",
    ).toBe(true);
    expect(
      files.some((f) => f.endsWith(".node")),
      "canvas native binary must be shipped",
    ).toBe(true);
  });

  it("extracts text from the PRUNED production filesystem (Vercel simulation)", () => {
    const files = scannedFiles();
    if (files.length === 0) return; // no build present — nothing to simulate
    const scanDir = resolve(
      REPO_ROOT,
      ".next/server/app/api/bewerbung-scanner/scan",
    );
    const sandbox = join(tmpdir(), `vfunc-${Date.now()}`);
    try {
      mkdirSync(join(sandbox, "node_modules"), { recursive: true });
      for (const rel of files) {
        const actual = resolve(scanDir, rel);
        if (!existsSync(actual)) continue;
        const dest = join(
          sandbox,
          rel.replace(/^.*?node_modules\//, "node_modules/"),
        );
        mkdirSync(resolve(dest, ".."), { recursive: true });
        cpSync(actual, dest, { recursive: true });
      }
      const entry = join(sandbox, "repro.mjs");
      writeFileSync(
        entry,
        [
          "const pdf = Buffer.from(process.env.PDF_B64, 'base64');",
          "const { PDFParse } = await import('pdf-parse');",
          "const p = new PDFParse({ data: new Uint8Array(pdf) });",
          "const r = await p.getText();",
          "console.log(r.text);",
          "await p.destroy().catch(() => {});",
        ].join("\n"),
      );
      const out = execFileSync(
        process.execPath,
        [entry],
        {
          cwd: sandbox,
          env: { ...process.env, PDF_B64: SAMPLE_PDF.toString("base64") },
          encoding: "utf8",
          timeout: 60000,
        },
      );
      expect(out).toContain("Lebenslauf Test");
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  }, 120000);
});
