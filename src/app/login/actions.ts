"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import {
  AUTH_RATE_LIMIT_MESSAGE,
  checkRateLimit,
  clientIpKey,
} from "@/lib/rate-limit";
import { createClient } from "@/lib/supabase/server";

/** Shown when the credentials are right but the email was never confirmed. */
const EMAIL_NOT_CONFIRMED =
  "Your email address is not confirmed yet. Click the verification link we sent you, or request a new one.";

export async function login(
  _previousState: { error?: string; needsVerification?: boolean },
  formData: FormData,
) {
  const parsed = z
    .object({
      email: z.string().trim().email("Enter a valid email address."),
      password: z.string().min(1, "Enter your password."),
    })
    .safeParse({
      email: formData.get("email"),
      password: formData.get("password"),
    });
  if (!parsed.success)
    return {
      error:
        parsed.error.issues[0]?.message ?? "Check your details and try again.",
    };

  try {
    // Per-IP cap on sign-in attempts (fail-open without an IP header).
    // Supabase Auth applies its own per-IP limits for signInWithPassword on
    // top of this; both only ever see the hashed key, never the address.
    const ipKey = await clientIpKey("login");
    if (ipKey) {
      const limited = await checkRateLimit("login", ipKey);
      if (!limited.allowed) return { error: AUTH_RATE_LIMIT_MESSAGE };
    }
  } catch {
    // The limiter must never block a legitimate sign-in (fail-open).
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword(parsed.data);
  if (error) {
    // "Email not confirmed" is only returned when the PASSWORD WAS CORRECT, so
    // telling the user about it discloses nothing they do not already know —
    // and it is the only way they can recover (the generic "incorrect" message
    // left confirmed-less users with no idea what to fix).
    if (error.message.toLowerCase().includes("not confirmed"))
      return { error: EMAIL_NOT_CONFIRMED, needsVerification: true };
    return { error: "Email or password is incorrect." };
  }
  redirect("/dashboard");
}

export async function logout() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}
