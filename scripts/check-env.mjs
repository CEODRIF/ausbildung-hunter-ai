#!/usr/bin/env node
import { pathToFileURL } from "node:url";

/**
 * Phase 20 — deployment readiness check.
 *
 * Validates that the environment is configured for production BEFORE a
 * deploy. A half-configured deployment (placeholder Supabase keys, missing
 * token-encryption key, localhost OAuth redirect URIs, worker secret left at
 * its example value) otherwise only fails at runtime, in confusing ways.
 *
 * `validateEnv` is a pure, exported function (unit-tested). The CLI prints a
 * per-variable report — **names and statuses only, never values** — and
 * exits 1 if any check fails. Warnings do not affect the exit code.
 */

// Exact "you must change this" values shipped in .env.example. Deliberately
// EXCLUDES legitimately-usable defaults (the public ARBEITSAGENTUR client id,
// the default OpenAI-compatible base URL, localhost dev redirect URIs).
const PLACEHOLDER_VALUES = new Set([
  "your-project.supabase.co",
  "your-anon-key",
  "your-service-role-key",
  "your-google-client-id",
  "your-google-client-secret",
  "your-microsoft-client-id",
  "your-microsoft-client-secret",
  "replace-with-a-long-random-secret",
  "your-ai-api-key",
  "your-model-name",
  "your-vision-model-name",
]);

// Generic "obviously a placeholder" patterns (matched case-insensitively).
const PLACEHOLDER_PATTERN =
  /^(change[-_ ]?me|changeme|placeholder|example|your[-_].*|todo|fixme|x{3,}|dummy|not[-_ ]?set)$/i;

function isJwt(value) {
  if (typeof value !== "string") return false;
  const parts = value.split(".");
  // Three non-empty base64url segments (header.payload.signature).
  return (
    parts.length === 3 &&
    parts.every((p) => p.length >= 8 && /^[A-Za-z0-9_-]+$/.test(p))
  );
}

function isUrl(value) {
  try {
    const url = new URL(value);
    return typeof url.href === "string";
  } catch {
    return false;
  }
}

function isPlaceholder(value) {
  if (typeof value !== "string") return false;
  const v = value.trim();
  if (v.length === 0) return false;
  if (PLACEHOLDER_VALUES.has(v) || PLACEHOLDER_PATTERN.test(v)) return true;
  // Scheme-prefixed placeholders (e.g. "https://your-project.supabase.co").
  const stripped = v.replace(/^https?:\/\//i, "");
  return PLACEHOLDER_VALUES.has(stripped) || PLACEHOLDER_PATTERN.test(stripped);
}

/** A variable is "set" when present, non-empty, and not a placeholder. */
function isSet(env, name) {
  const raw = env[name];
  return (
    typeof raw === "string" && raw.trim().length > 0 && !isPlaceholder(raw)
  );
}

/** The checks, in report order. `required` vars gate the exit code; optional
 *  vars are validated only when present (to catch typos/format errors).
 *  `required: "production"` = required for a production deployment (the
 *  check:env CLI runs in production mode) but intentionally optional in
 *  development/test — e.g. LiveKit, which the voice feature degrades
 *  around (503 + eviction no-op) when unconfigured. */
const CHECKS = [
  { name: "NEXT_PUBLIC_SUPABASE_URL", required: true, kind: "httpsUrl" },
  { name: "NEXT_PUBLIC_SUPABASE_ANON_KEY", required: true, kind: "jwt" },
  { name: "SUPABASE_SERVICE_ROLE_KEY", required: true, kind: "jwt" },
  { name: "APP_URL", required: true, kind: "httpsUrl" },
  { name: "EMAIL_TOKEN_ENCRYPTION_KEY", required: true, kind: "secret" },
  { name: "EMAIL_WORKER_SECRET", required: true, kind: "secret" },
  { name: "GOOGLE_CLIENT_ID", required: false, kind: "id" },
  { name: "GOOGLE_CLIENT_SECRET", required: false, kind: "secret" },
  { name: "GOOGLE_REDIRECT_URI", required: false, kind: "redirectUrl" },
  { name: "MICROSOFT_CLIENT_ID", required: false, kind: "id" },
  { name: "MICROSOFT_CLIENT_SECRET", required: false, kind: "secret" },
  { name: "MICROSOFT_REDIRECT_URI", required: false, kind: "redirectUrl" },
  { name: "AI_API_KEY", required: false, kind: "secret" },
  { name: "AI_API_URL", required: false, kind: "url" },
  { name: "AI_MODEL", required: false, kind: "id" },
  { name: "AI_VISION_MODEL", required: false, kind: "id" },
  { name: "ARBEITSAGENTUR_API_KEY", required: false, kind: "id" },
  { name: "TAVILY_API_KEY", required: false, kind: "secret" },
  { name: "GEMINI_API_KEY", required: false, kind: "secret" },
  // Community voice (Phase 4 + 6B eviction seam): server-side only.
  { name: "LIVEKIT_URL", required: "production", kind: "wsUrl" },
  { name: "LIVEKIT_API_KEY", required: "production", kind: "id" },
  { name: "LIVEKIT_API_SECRET", required: "production", kind: "secret" },
];

/**
 * Phase 21 — external integration seams.
 *
 * These are the resources the deployment MUST obtain from outside the
 * repository to go fully live. `validateEnv` reports each seam's readiness
 * derived purely from in-repo environment state. This section is
 * **informational only**: it never affects the exit code and prints names,
 * statuses, and static notes — never values. Two seams (payment provider,
 * additional vacancy providers) have no in-repo switch and are always
 * `pending` until their provider is configured in code + credentials are set.
 */
const SEAMS = [
  {
    name: "ai-assistant",
    status: (env) => (isSet(env, "AI_API_KEY") ? "configured" : "pending"),
    note: "AI chat, document generation, and the scanner need an AI provider key (AI_API_KEY).",
  },
  {
    name: "email-oauth",
    status: (env) =>
      (isSet(env, "GOOGLE_CLIENT_ID") && isSet(env, "GOOGLE_CLIENT_SECRET")) ||
      (isSet(env, "MICROSOFT_CLIENT_ID") &&
        isSet(env, "MICROSOFT_CLIENT_SECRET"))
        ? "configured"
        : "pending",
    note: "Connecting Gmail/Microsoft needs real OAuth app credentials (client id + secret + redirect URI).",
  },
  {
    name: "email-worker-poller",
    status: (env) =>
      isSet(env, "EMAIL_WORKER_SECRET") ? "configured" : "pending",
    note: "A durable external poller/scheduler must drive /api/internal/email-worker (and /api/internal/storage-reconcile and /api/internal/voice-sweep); the web process never sends.",
  },
  {
    name: "livekit-voice",
    status: (env) =>
      isSet(env, "LIVEKIT_URL") &&
      isSet(env, "LIVEKIT_API_KEY") &&
      isSet(env, "LIVEKIT_API_SECRET")
        ? "configured"
        : "pending",
    note: "Community voice (join tokens + suspend-time eviction, Phase 6B) needs a LiveKit SFU: LIVEKIT_URL + LIVEKIT_API_KEY + LIVEKIT_API_SECRET (server-side only). Unconfigured, voice degrades to 503 and eviction is a no-op.",
  },
  {
    name: "payment-provider",
    status: () => "pending",
    note: "No payment provider is wired (seam: src/lib/billing/provider.ts); quota upgrades are invitation-code only and /api/billing/webhook answers 501.",
  },
  {
    name: "vacancy-providers",
    status: () => "pending",
    note: "Bundesagentur f\u00fcr Arbeit is the only vacancy provider; additional providers need their own API credentials.",
  },
  {
    name: "web-discovery",
    status: (env) =>
      isSet(env, "TAVILY_API_KEY") ? "configured" : "pending",
    note: "AI Ausbildung Search broad web discovery uses the official Tavily Search API (TAVILY_API_KEY, server-side only; at most 3 requests per search operation). Without it the web layer is skipped and the official BA source still works.",
  },
];

/** Pure validation. `env` is a map of variable name → value (or undefined).
 *  `opts.production` (default false) = production/deployment mode: vars with
 *  `required: "production"` (LiveKit) are then gated like required vars —
 *  dev/test environments may intentionally run without them.
 *  Returns per-variable results plus aggregated errors/warnings. */
export function validateEnv(env, opts = {}) {
  const production = opts.production === true;
  const errors = [];
  const warnings = [];
  const results = [];

  for (const check of CHECKS) {
    const raw = env[check.name];
    const present = typeof raw === "string" && raw.trim().length > 0;
    const required =
      check.required === true ||
      (check.required === "production" && production);
    let status = "pass"; // "pass" | "warn" | "fail"
    let message = "";

    if (!present) {
      if (required) {
        status = "fail";
        message =
          check.required === "production"
            ? "missing (required in production)"
            : "missing (required)";
      } else {
        status = "pass";
        message = "not set (optional)";
      }
    } else {
      const value = raw.trim();
      if (isPlaceholder(value)) {
        status = "fail";
        message = "still contains an example/placeholder value";
      } else {
        switch (check.kind) {
          case "jwt":
            if (!isJwt(value)) {
              status = "fail";
              message = "not a valid JWT (Supabase keys are JWTs)";
            }
            break;
          case "httpsUrl":
            if (!isUrl(value)) {
              status = "fail";
              message = "not a valid URL";
            } else if (!value.startsWith("https://")) {
              status = "warn";
              message = "URL is not https";
            }
            break;
          case "wsUrl":
            // LiveKit SFU: wss(s) for production, ws/http tolerated for
            // local dev (mirrors the token route, which uses the URL as-is
            // for the join endpoint).
            if (!isUrl(value)) {
              status = "fail";
              message = "not a valid URL";
            } else if (/^(ws|http):/i.test(value)) {
              status = "warn";
              message = "URL is not TLS (wss:// or https:// expected; dev only)";
            }
            break;
          case "url":
          case "redirectUrl":
            if (!isUrl(value)) {
              status = "fail";
              message = "not a valid URL";
            } else if (
              check.kind === "redirectUrl" &&
              /^http:\/\/(localhost|127\.0\.0\.1)/i.test(value)
            ) {
              status = "warn";
              message = "redirect URI points at localhost (dev only)";
            }
            break;
          case "secret":
            if (value.length < 16) {
              status = "warn";
              message = "secret looks short (use a long random value)";
            }
            break;
           case "id":
          default:
            // No strict format; placeholder/empty checks already applied.
            break;
        }
      }
    }

    results.push({ name: check.name, status, message });
    if (status === "fail") errors.push(`${check.name}: ${message}`);
    if (status === "warn") warnings.push(`${check.name}: ${message}`);
  }

  // Informational only: readiness of each external integration seam, derived
  // from in-repo state. Never contributes to errors/warnings or the exit code.
  const seams = SEAMS.map((seam) => ({
    name: seam.name,
    status: seam.status(env),
    note: seam.note,
  }));

  return { ok: errors.length === 0, errors, warnings, results, seams };
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  // The CLI is the PRE-DEPLOY check: it validates production readiness,
  // so `required: "production"` vars (LiveKit) are gated here. Pure
  // callers (tests, dev tooling) use validateEnv(env) in dev mode.
  const { results, errors, warnings, ok, seams } = validateEnv(process.env, {
    production: true,
  });
  console.log("Deployment environment check\n");
  for (const r of results) {
    const tag =
      r.status === "fail" ? "FAIL" : r.status === "warn" ? "WARN" : "PASS";
    const detail = r.message ? ` — ${r.message}` : "";
    console.log(`  [${tag}] ${r.name}${detail}`);
  }
  console.log(
    "\nExternal integration seams (informational — external resources still required to go fully live)\n",
  );
  for (const s of seams) {
    const tag = s.status === "configured" ? "READY" : "PENDING";
    console.log(`  [${tag}] ${s.name} — ${s.note}`);
  }
  console.log("");
  if (warnings.length > 0) console.log(`${warnings.length} warning(s).`);
  if (ok) {
    console.log("Environment is ready for deployment.");
    process.exit(0);
  }
  console.log(`${errors.length} problem(s) must be fixed before deploying.`);
  process.exit(1);
}
