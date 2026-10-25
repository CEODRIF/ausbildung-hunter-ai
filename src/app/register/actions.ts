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
  // Registration is OPEN (2026-10-25): the invitation code is optional.
  // When present it must still be well-formed — a code that exists in the
  // table matches this shape (A-Z0-9, 6..32). An empty/absent value is the
  // normal path and carries no code in the sign-up metadata.
  invitationCode: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9]{6,32}$/, "Enter a valid invitation code.")
    .optional()
    .or(z.literal("")),
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

/** Message for the pre-check rejection of a code the user EXPLICITLY
 *  entered and that is unknown, inactive or already used up. The code is
 *  optional, so the message points at the ordinary path: leave it out. */
const INVITATION_REJECTED =
  "That invitation code is invalid or no longer active. You can leave the invitation code out and continue without one.";

/**
 * Supabase Auth surfaces ANY exception raised inside the
 * on_auth_user_created trigger as the opaque "Database error saving new
 * user" (the real reason is only visible in the Postgres log). With open
 * registration (20261201000000) the trigger no longer raises for
 * invitation codes, so in the target state this mapping is defensive: it
 * still catches a transitional deployment (new app on a database where the
 * migration is not yet applied — code-less sign-ups rejected by the old
 * trigger) and keeps the user-facing message safe and diagnosable.
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
    // The field is no longer in the form; a code only arrives via a direct
    // API/form post. Absent (null) is the normal path — normalize to "".
    invitationCode: formData.get("invitationCode") ?? "",
    terms: formData.get("terms") ?? "",
  });
  if (!parsed.success)
    return {
      error:
        parsed.error.issues[0]?.message ?? "Check your details and try again.",
    };

  let step = "rate_limit";
  try {
    // Abuse protection for the unauthenticated flow: caps signup spam per
    // client IP (it also caps invitation-code probing for clients that do
    // post codes directly). Fail-open when no IP header is available (see
    // clientIpKey) — Supabase Auth's own limits still apply.
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

    const code = parsed.data.invitationCode;
    // The code is OPTIONAL (open registration, 2026-10-25). When the user
    // explicitly provided one, the pre-check gives fast, clear feedback for
    // a code that is unknown/inactive/exhausted — signup without a code
    // never touches the invitation table at all.
    step = "validate_invitation_code";
    if (code && !(await validateInvitationCode(code, "registration")))
      return { error: INVITATION_REJECTED };

    step = "sign_up";
    const supabase = await createClient();
    // Standard Supabase Auth sign-up (anon key): creates the user, and Supabase
    // itself sends the confirmation email — no external email service, no
    // service-role user creation, no manual verification codes.
    //
    // A provided invitation code is consumed ATOMICALLY by the
    // on_auth_user_created trigger, in the same transaction as the user
    // insert (migrations 20261021000000 / 20261201000000): the pre-check
    // above is UX only. A race for the last remaining use of a one-use code
    // means the code is simply not consumed for the loser — the account is
    // still created (a code must never block a sign-up), and no one ever
    // receives the same code's benefit twice.
    const { data, error } = await supabase.auth.signUp({
      email: parsed.data.email,
      password: parsed.data.password,
      options: {
        // handle_new_user() creates the profile from `full_name` and, only
        // when present, consumes `invitation_code` atomically; the
        // confirmation trigger only activates the profile.
        data: code
          ? {
              full_name: parsed.data.fullName,
              invitation_code: code,
            }
          : {
              full_name: parsed.data.fullName,
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
