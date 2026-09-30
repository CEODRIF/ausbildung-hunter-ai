/**
 * Server-safe PDF text extraction (Bewerbung Scanner + AI file context).
 *
 * Why this module exists (two distinct production failures, both fixed here):
 *
 * 1. Bundling: `pdf-parse` v2 wraps pdf.js 5. The stack must be loaded from
 *    node_modules at runtime, not inlined — next.config.ts lists the packages
 *    in `serverExternalPackages`. Inlined, pdf.js falls back to a path that
 *    references the bare browser global and crashes with
 *    `ReferenceError: DOMMatrix is not defined`.
 *
 * 2. Serverless file pruning (verified against the built nft manifest and
 *    reproduced in a pruned-filesystem sandbox): Vercel functions only
 *    receive the files Next.js's tracer records. Two files pdf.js needs at
 *    runtime are invisible to the tracer:
 *      - `@napi-rs/canvas` — loaded via try/catch require INSIDE pdf.mjs to
 *        polyfill DOMMatrix/ImageData/Path2D. Missing on Vercel, the
 *        polyfill warns and the module-scope `new DOMMatrix()` crashes with
 *        `ReferenceError: DOMMatrix is not defined` (pdf.mjs:15620).
 *      - `pdf.worker.mjs` — resolved at runtime relative to pdf.mjs.
 *    The LITERAL imports below make the tracer ship both, and importing the
 *    worker registers `globalThis.pdfjsWorker`, so pdf.js uses the
 *    documented main-thread "fake worker" path — no worker_threads, no
 *    runtime file resolution.
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
    // Lazy on purpose: the pdf.js modules are only evaluated for a real
    // parse call — never while SSR-ing a page that transitively imports
    // this module.
    //
    // LITERAL specifiers (no variables): Next.js's file tracer only ships
    // files it can resolve statically. These imports are what make
    // `@napi-rs/canvas` and `pdf.worker.mjs` part of the Vercel function
    // (see header, issue #2). Order matters: canvas must be resolvable
    // before pdf.mjs evaluates its polyfill require.
    await import("@napi-rs/canvas");
    await import("pdfjs-dist/legacy/build/pdf.mjs");
    await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
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
