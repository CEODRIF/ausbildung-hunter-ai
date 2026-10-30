/**
 * pdf.js ships no TypeScript declarations for the worker builds. They are
 * imported as a side effect (registers globalThis.pdfjsWorker for the
 * main-thread "fake worker" path) — see src/lib/pdf-extract.ts (server,
 * legacy build) and src/components/auto-bewerb/step4-cv-generation.tsx
 * (client canvas preview, minified build).
 */
declare module "pdfjs-dist/legacy/build/pdf.worker.mjs";
declare module "pdfjs-dist/build/pdf.worker.min.mjs";
