"use server";

import { redirect } from "next/navigation";
import { createVerificationCode, verifyCode } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { sendVerificationCodeEmail } from "@/lib/verification-email";

export type VerificationState = { error?: string; success?: string };

export async function submitVerificationCode(
  _previousState: VerificationState,
  formData: FormData,
): Promise<VerificationState> {
  const code = String(formData.get("code") ?? "").trim();
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Your session expired. Please sign in again." };
  if (!/^\d{6}$/.test(code))
    return { error: "Enter the 6-digit verification code." };

  try {
    const verified = await verifyCode(user.id, code);
    if (!verified)
      return {
        error:
          "That code is invalid, expired, or has reached its attempt limit.",
      };
  } catch {
    return {
      error: "Verification is temporarily unavailable. Please try again.",
    };
  }
  redirect("/onboarding");
}

export async function requestVerificationCode(
  _previousState: VerificationState,
  _formData: FormData,
): Promise<VerificationState> {
  void _previousState;
  void _formData;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Your session expired. Please sign in again." };
  if (!user.email)
    return {
      error: "We couldn't determine your email address. Please sign in again.",
    };

  try {
    // The RPC returns the fresh 6-digit code; that exact value is what the
    // email carries (the stored code_hash is never read or decoded).
    const code = await createVerificationCode(user.id);
    await sendVerificationCodeEmail({ email: user.email, code });
    return { success: "A new verification code has been sent to your email." };
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes("verification_rate_limited")
    )
      return { error: "Please wait a minute before requesting another code." };
    // sendVerificationCodeEmail already logged the scrubbed error server-side.
    return {
      error: "We couldn't send the verification email. Please try again.",
    };
  }
}
