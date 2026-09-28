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

/** The checks, in report order. `required` vars gate the exit code; optional
 *  vars are validated only when present (to catch typos/format errors). */
const CHECKS = [
  { name: "NEXT_PUBLIC_SUPABASE_URL", required: true, kind: "httpsUrl" },
  { name: "NEXT_PUBLIC_SUPABASE_ANON_KEY", required: true, kind: "jwt" },
  { name: "SUPABASE_SERVICE_ROLE_KEY", required: true, kind: "jwt" },
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
];

/** Pure validation. `env` is a map of variable name → value (or undefined).
 *  Returns per-variable results plus aggregated errors/warnings. */
export function validateEnv(env) {
  const errors = [];
  const warnings = [];
  const results = [];

  for (const check of CHECKS) {
    const raw = env[check.name];
    const present = typeof raw === "string" && raw.trim().length > 0;
    let status = "pass"; // "pass" | "warn" | "fail"
    let message = "";

    if (!present) {
      if (check.required) {
        status = "fail";
        message = "missing (required)";
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

  return { ok: errors.length === 0, errors, warnings, results };
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const { results, errors, warnings, ok } = validateEnv(process.env);
  console.log("Deployment environment check\n");
  for (const r of results) {
    const tag =
      r.status === "fail" ? "FAIL" : r.status === "warn" ? "WARN" : "PASS";
    const detail = r.message ? ` — ${r.message}` : "";
    console.log(`  [${tag}] ${r.name}${detail}`);
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
