"use server";

import { z } from "zod";
import { getAuthCallbackUrl, validateInvitationCode } from "@/lib/auth";
import {
  AUTH_RATE_LIMIT_MESSAGE,
  checkRateLimit,
  clientIpKey,
} from "@/lib/rate-limit";
import { createClient } from "@/lib/supabase/server";

const schema = z.object({
  fullName: z
    .string()
    .trim()
    .min(2, "Enter your full name.")
    .max(120, "Your name is too long."),
  email: z.string().trim().email("Enter a valid email address."),
  password: z.string().min(8, "Use at least 8 characters."),
  invitationCode: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9]{6,32}$/, "Enter a valid invitation code."),
  // The Terms/Privacy checkbox is `required` in the form, but that is only a
  // browser hint: the acceptance is re-validated here so a direct POST cannot
  // create an account without it.
  terms: z
    .string()
    .refine(
      (value) => value === "on" || value === "true" || value === "1",
      "Please accept the Terms of Service and Privacy Policy to continue.",
    ),
});

/** Message for both the pre-check and the database-level rejection of a code
 *  that is unknown, inactive or already used up. */
const INVITATION_REJECTED =
  "That invitation code is invalid or no longer active.";

/**
 * Supabase Auth surfaces ANY exception raised inside the
 * on_auth_user_created trigger as this opaque message (the real reason —
 * `invitation_code_required` / `invitation_code_invalid_or_exhausted` — is
 * only visible in the Postgres log). Since this action always sends a code,
 * that error means the code lost the race for its last remaining use.
 */
function isInvitationRejection(message: string): boolean {
  return (
    message.includes("Database error saving new user") ||
    message.includes("invitation_code") ||
    message.includes("invitation code")
  );
}

/**
 * Safe server-side diagnostic logging for the registration flow.
 *
 * The registration action must never surface a raw Supabase/database/provider
 * error to the browser, but it also must not swallow it silently — otherwise a
 * production failure (e.g. a misconfigured service-role key, or a migration not
 * applied to the production database) is impossible to diagnose. This records
 * the failing step plus the upstream error to the server log while scrubbing
 * anything that could be a credential (Bearer tokens, JWT / service-role keys).
 * It never logs the password, service-role key, anon key, or user tokens.
 */
function logRegistrationError(step: string, error: unknown): void {
  let message = error instanceof Error ? error.message : String(error);
  message = message
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+/gi, "Bearer [redacted]")
    .replace(
      /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
      "[redacted-jwt]",
    )
    .replace(/service_role[=:][A-Za-z0-9._~-]+/gi, "service_role=[redacted]");
  console.error(`[register] step="${step}" error="${message}"`);
}

export async function register(
  _previousState: { error?: string; success?: string },
  formData: FormData,
) {
  const parsed = schema.safeParse({
    fullName: formData.get("fullName"),
    email: formData.get("email"),
    password: formData.get("password"),
    invitationCode: formData.get("invitationCode"),
    terms: formData.get("terms") ?? "",
  });
  if (!parsed.success)
    return {
      error:
        parsed.error.issues[0]?.message ?? "Check your details and try again.",
    };

  let step = "rate_limit";
  try {
    // Abuse protection for the unauthenticated flow: caps invitation-code
    // guessing and signup spam per client IP. Fail-open when no IP header is
    // available (see clientIpKey) — Supabase Auth's own limits still apply.
    // The limiter is protection, never a gate: a limiter outage must not stop
    // a legitimate sign-up, so its own errors are swallowed here.
    try {
      const ipKey = await clientIpKey("register");
      if (ipKey) {
        const limited = await checkRateLimit("register", ipKey);
        if (!limited.allowed) return { error: AUTH_RATE_LIMIT_MESSAGE };
      }
    } catch {
      // Fail open (documented limiter policy).
    }

    step = "validate_invitation_code";
    if (
      !(await validateInvitationCode(
        parsed.data.invitationCode,
        "registration",
      ))
    )
      return { error: INVITATION_REJECTED };

    step = "sign_up";
    const supabase = await createClient();
    // Standard Supabase Auth sign-up (anon key): creates the user, and Supabase
    // itself sends the confirmation email — no external email service, no
    // service-role user creation, no manual verification codes.
    //
    // The invitation code is consumed ATOMICALLY by the on_auth_user_created
    // trigger, in the same transaction as the user insert (migration
    // 20261021000000): the pre-check above is UX only. A race for the last
    // remaining use of a one-use code therefore fails here instead of creating
    // a second account.
    const { data, error } = await supabase.auth.signUp({
      email: parsed.data.email,
      password: parsed.data.password,
      options: {
        // handle_new_user() creates the profile from `full_name` and consumes
        // `invitation_code` atomically; the confirmation trigger only activates
        // the profile.
        data: {
          full_name: parsed.data.fullName,
          invitation_code: parsed.data.invitationCode,
        },
        emailRedirectTo: getAuthCallbackUrl(),
      },
    });
    if (error) {
      if (error.message.includes("already registered"))
        return { error: "An account with this email already exists." };
      if (isInvitationRejection(error.message)) {
        logRegistrationError(step, error);
        return { error: INVITATION_REJECTED };
      }
      return { error: error.message };
    }
    if (!data.user)
      return { error: "Unable to create your account. Please try again." };
    if (!getAuthCallbackUrl())
      console.error(
        "[register] APP_URL is not set — the confirmation link uses the Supabase Site URL",
      );
  } catch (error) {
    if (error instanceof Error && error.message.includes("already registered"))
      return { error: "An account with this email already exists." };
    if (error instanceof Error && isInvitationRejection(error.message)) {
      logRegistrationError(step, error);
      return { error: INVITATION_REJECTED };
    }
    // Record the real, non-sensitive error server-side so a production failure
    // is diagnosable, while keeping the user-facing message safe and generic.
    logRegistrationError(step, error);
    return {
      error: "Registration is temporarily unavailable. Please try again.",
    };
  }
  return {
    success:
      "Check your email and click the verification link to activate your account.",
  };
}
