/**
 * Stable PDF failure code shared across server modules.
 *
 * Lives in this trivial module (instead of `@/lib/pdf-extract`) so callers
 * that only need the code do not link the PDF parsing stack: `pdf-extract`
 * contains the literal dynamic imports that make Vercel's file tracer ship
 * pdf-parse / pdfjs-dist / @napi-rs/canvas (~60 MB) into the deployable of
 * every function whose module graph reaches it.
 */
export const PDF_PARSE_FAILED = "PDF_PARSE_FAILED";
