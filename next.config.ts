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
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
