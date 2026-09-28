"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";

export async function login(
  _previousState: { error?: string },
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

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword(parsed.data);
  if (error) return { error: "Email or password is incorrect." };
  redirect("/dashboard");
}

export async function logout() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}
