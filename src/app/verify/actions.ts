"use server";

import { z } from "zod";
import { getAuthCallbackUrl } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

const schema = z.object({
  email: z.string().trim().email("Enter a valid email address."),
});

/**
 * Request another Supabase Auth confirmation email (pure Supabase —
 * `auth.resend`, no external email service).
 *
 * The response is intentionally identical for unknown emails and errors:
 * it must not reveal whether an address is registered (user enumeration).
 * Failures are logged server-side without leaking credentials.
 */
export async function resendVerificationEmail(
  _previousState: { error?: string; success?: string },
  formData: FormData,
) {
  const parsed = schema.safeParse({ email: formData.get("email") });
  if (!parsed.success)
    return {
      error:
        parsed.error.issues[0]?.message ?? "Check your details and try again.",
    };

  const result =
    "If that email address is registered, a new verification link is on its way.";
  try {
    const supabase = await createClient();
    const { error } = await supabase.auth.resend({
      type: "signup",
      email: parsed.data.email,
      options: { emailRedirectTo: getAuthCallbackUrl() },
    });
    if (error) console.error(`[verify] resend error="${scrub(error.message)}"`);
  } catch (error) {
    console.error(
      `[verify] resend error="${scrub(error instanceof Error ? error.message : String(error))}"`,
    );
  }
  return { success: result };
}

function scrub(message: string): string {
  return message
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+/gi, "Bearer [redacted]")
    .replace(
      /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
      "[redacted-jwt]",
    );
}
