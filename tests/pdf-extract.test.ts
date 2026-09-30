import { describe, expect, it } from "vitest";
import { PDF_PARSE_FAILED, extractPdfText } from "@/lib/pdf-extract";

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
});
