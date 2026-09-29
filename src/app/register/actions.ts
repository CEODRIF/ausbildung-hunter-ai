"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import {
  createVerificationCode,
  consumeInvitationCode,
  validateInvitationCode,
} from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
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
  _previousState: { error?: string },
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
    step = "create_user";
    const admin = createAdminClient();
    const { data: created, error: authError } =
      await admin.auth.admin.createUser({
        email: parsed.data.email,
        password: parsed.data.password,
        email_confirm: true,
        user_metadata: { full_name: parsed.data.fullName },
      });
    if (authError || !created.user)
      return { error: authError?.message ?? "Unable to create your account." };

    step = "upsert_profile";
    const { error: profileError } = await admin.from("profiles").upsert(
      {
        id: created.user.id,
        full_name: parsed.data.fullName,
        email: parsed.data.email,
        account_status: "pending",
        daily_email_limit: 50,
      },
      { onConflict: "id" },
    );
    if (profileError)
      return {
        error:
          "Your account was created, but setup could not finish. Please contact support.",
      };
    step = "consume_invitation_code";
    if (
      !(await consumeInvitationCode(parsed.data.invitationCode, "registration"))
    )
      return {
        error: "That invitation code is no longer active. Please try again.",
      };
    step = "sign_in";
    const { error: signInError } = await (
      await createClient()
    ).auth.signInWithPassword({
      email: parsed.data.email,
      password: parsed.data.password,
    });
    if (signInError)
      return { error: "Your account was created. Please sign in to continue." };
    step = "create_verification_code";
    await createVerificationCode(created.user.id);
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
  redirect("/verify");
}
