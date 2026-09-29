"use server";

import { z } from "zod";
import { getAuthCallbackUrl, validateInvitationCode } from "@/lib/auth";
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
});

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
  });
  if (!parsed.success)
    return {
      error:
        parsed.error.issues[0]?.message ?? "Check your details and try again.",
    };

  let step = "validate_invitation_code";
  try {
    if (
      !(await validateInvitationCode(
        parsed.data.invitationCode,
        "registration",
      ))
    )
      return { error: "That invitation code is invalid or no longer active." };

    step = "sign_up";
    const supabase = await createClient();
    // Standard Supabase Auth sign-up (anon key): creates the user, and Supabase
    // itself sends the confirmation email — no external email service, no
    // service-role user creation, no manual verification codes.
    const { data, error } = await supabase.auth.signUp({
      email: parsed.data.email,
      password: parsed.data.password,
      options: {
        // handle_new_user() creates the profile from `full_name`; the
        // on_auth_user_email_confirmed trigger consumes `invitation_code`
        // exactly once, when the email is verified.
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
