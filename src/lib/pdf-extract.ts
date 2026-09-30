/**
 * Server-safe PDF text extraction (Bewerbung Scanner + AI file context).
 *
 * Why this module exists:
 * `pdf-parse` v2 wraps pdf.js 5. In Node the parser's worker bootstraps the
 * canvas-backed globals pdf.js expects (DOMMatrix / ImageData / Path2D via
 * `@napi-rs/canvas`). For that bootstrap to work the whole PDF stack must be
 * loaded **from node_modules at runtime**, not inlined by the Next.js
 * bundler — next.config.ts therefore lists the packages below in
 * `serverExternalPackages`. When inlined, the worker's native dependency is
 * lost and pdf.js falls back to a code path that references the bare browser
 * global and crashes with `ReferenceError: DOMMatrix is not defined`.
 *
 * Error contract:
 * every extraction failure is logged server-side (real technical detail
 * stays in the deployment logs) and surfaced to callers as the stable
 * user-safe code PDF_PARSE_FAILED — never as a library/stack message.
 */

/** Stable, user-safe error code for PDF extraction failures. */
export const PDF_PARSE_FAILED = "PDF_PARSE_FAILED";

export async function extractPdfText(
  data: Uint8Array | Buffer,
): Promise<string> {
  try {
    // Lazy import on purpose: the pdf.js module (and its worker bootstrap)
    // is only evaluated for a real parse call — never while SSR-ing a page
    // that transitively imports this module.
    const { PDFParse } = await import("pdf-parse");
    const parser = new PDFParse({ data: new Uint8Array(data) });
    try {
      const parsed = await parser.getText();
      return parsed.text;
    } finally {
      await parser.destroy().catch(() => undefined);
    }
  } catch (error) {
    console.error("[pdf-extract] PDF text extraction failed:", error);
    throw new Error(PDF_PARSE_FAILED);
  }
}
