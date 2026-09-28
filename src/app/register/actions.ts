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

  try {
    if (
      !(await validateInvitationCode(
        parsed.data.invitationCode,
        "registration",
      ))
    )
      return { error: "That invitation code is invalid or no longer active." };
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
    if (
      !(await consumeInvitationCode(parsed.data.invitationCode, "registration"))
    )
      return {
        error: "That invitation code is no longer active. Please try again.",
      };
    const { error: signInError } = await (
      await createClient()
    ).auth.signInWithPassword({
      email: parsed.data.email,
      password: parsed.data.password,
    });
    if (signInError)
      return { error: "Your account was created. Please sign in to continue." };
    await createVerificationCode(created.user.id);
  } catch (error) {
    if (error instanceof Error && error.message.includes("already registered"))
      return { error: "An account with this email already exists." };
    return {
      error: "Registration is temporarily unavailable. Please try again.",
    };
  }
  redirect("/verify");
}
