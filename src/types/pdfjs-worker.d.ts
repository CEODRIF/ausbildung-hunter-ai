/**
 * pdf.js ships no TypeScript declarations for the worker build. It is
 * imported as a side effect (registers globalThis.pdfjsWorker for the
 * main-thread "fake worker" path) — see src/lib/pdf-extract.ts.
 */
declare module "pdfjs-dist/legacy/build/pdf.worker.mjs";
