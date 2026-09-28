import type { NextConfig } from "next";

/**
 * Phase 12 — baseline security headers on every response.
 * Deliberately conservative: no CSP yet (a strict policy would break
 * Next.js inline scripts/styles and the Supabase client without a full
 * audit; documented as a known limitation). Everything below is safe for
 * a standalone, non-embedded app.
 */
const securityHeaders: Array<{ key: string; value: string }> = [
  { key: "x-content-type-options", value: "nosniff" },
  { key: "x-frame-options", value: "DENY" },
  { key: "referrer-policy", value: "strict-origin-when-cross-origin" },
  {
    key: "permissions-policy",
    value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  },
];

const nextConfig: NextConfig = {
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
