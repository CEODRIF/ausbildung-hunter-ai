/**
 * Phase 13 — security header assembly (pure, fully tested).
 *
 * The single source of truth for the headers Next serves on every
 * response; consumed by next.config.ts at build time. Keeping it a pure
 * function (no env access here) makes the policy unit-testable and
 * prevents silent drift between the config and the docs.
 *
 * Origin audit (verified against the code):
 * - The browser talks to exactly two origins: the app itself ('self')
 *   and the Supabase project (auth + REST + storage via supabase-js).
 *   All other integrations — OpenAI, Google/Microsoft OAuth, the BA
 *   jobs API — run exclusively server-side; OAuth provider domains are
 *   only top-level redirects, which CSP does not constrain.
 * - Images: the app's own assets, `data:`/`blob:` URLs (AI Deckblatt
 *   background, generated previews) and the Supabase storage public URL
 *   persisted in `profiles.avatar_url` (see uploadProfileAvatar →
 *   storage.getPublicUrl). The Supabase origin is therefore REQUIRED in
 *   img-src: omitting it silently blocks every avatar in production.
 * - No web fonts, no third-party scripts, no WebSockets, no analytics.
 *
 * Documented trade-off: script-src includes 'unsafe-inline' because
 * Next 16.3.x has no CSP nonce support for App Router RSC payload
 * scripts (verified in the installed next dist). Nonce-based script-src
 * is a documented future hardening step. 'unsafe-eval' is never present.
 */

const OTHER_HEADERS = [
  { key: "x-content-type-options", value: "nosniff" },
  { key: "x-frame-options", value: "DENY" },
  { key: "referrer-policy", value: "strict-origin-when-cross-origin" },
  {
    key: "permissions-policy",
    value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  },
  // HSTS: only meaningful over HTTPS (browsers ignore it on plain HTTP, so
  // local development is unaffected). No `preload` — that is an irreversible
  // commitment to the preload list and belongs to an explicit ops decision.
  {
    key: "strict-transport-security",
    value: "max-age=63072000; includeSubDomains",
  },
];

/** Origin of the configured Supabase project, or null when unset/malformed. */
function supabaseOrigin(supabaseUrl: string | undefined): string | null {
  if (!supabaseUrl) return null;
  try {
    return new URL(supabaseUrl).origin;
  } catch {
    // Malformed env value: degrade to 'self' only — never emit a broken or
    // attacker-influenced CSP directive.
    return null;
  }
}

function cspFor(supabaseUrl: string | undefined): string {
  const connectOrigins: string[] = ["'self'"];
  const imageOrigins: string[] = ["'self'", "data:", "blob:"];
  const origin = supabaseOrigin(supabaseUrl);
  if (origin) {
    if (!connectOrigins.includes(origin)) connectOrigins.push(origin);
    // Avatars are public storage objects served from the Supabase origin;
    // without it the browser blocks them (broken profile images).
    imageOrigins.push(origin);
  }
  return [
    "default-src 'self'",
    `connect-src ${connectOrigins.join(" ")}`,
    // data:/blob: are inert for exfiltration; they keep the Deckblatt
    // background and inline previews working without widening the surface.
    `img-src ${imageOrigins.join(" ")}`,
    "style-src 'self' 'unsafe-inline'",
    "script-src 'self' 'unsafe-inline'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "upgrade-insecure-requests",
  ].join("; ");
}

export function buildSecurityHeaders(
  supabaseUrl?: string,
): Array<{ key: string; value: string }> {
  return [
    { key: "content-security-policy", value: cspFor(supabaseUrl) },
    ...OTHER_HEADERS,
  ];
}
