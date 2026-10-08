import type { NextConfig } from "next";
import { buildSecurityHeaders } from "./src/lib/security-headers";

/**
 * Phase 12/13 — security headers (rate-limit era baseline) plus a full
 * Content Security Policy, assembled by the tested pure builder in
 * src/lib/security-headers.ts.
 *
 * Deployment implication: the CSP bakes in the Supabase origin from
 * NEXT_PUBLIC_SUPABASE_URL at build time. If the Supabase project URL
 * changes, rebuild (documented in README → Phase 13).
 */
const securityHeaders = buildSecurityHeaders(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
);

const nextConfig: NextConfig = {
  // Container deployment (Azure Container Apps / any OCI runner): emit the
  // self-contained `.next/standalone` server. The Dockerfile copies it plus
  // `.next/static` and `public/` only — no dev tooling, no tests, no
  // node_modules beyond what the server actually traces (incl. the PDF
  // stack below, which is traced into standalone/node_modules).
  output: "standalone",
  // PDF stack (pdf-parse v2 → pdf.js 5 + @napi-rs/canvas) must load from
  // node_modules at runtime, NOT be inlined by the bundler: the parser's
  // worker bootstraps the canvas-backed DOMMatrix/ImageData/Path2D globals
  // pdf.js needs in Node. Inlined, that bootstrap is lost and pdf.js falls
  // back to a path referencing the bare browser global →
  // `DOMMatrix is not defined` (see src/lib/pdf-extract.ts).
  serverExternalPackages: ["pdf-parse", "pdfjs-dist", "@napi-rs/canvas"],
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
