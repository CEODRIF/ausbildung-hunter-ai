"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  updateProfileName,
  uploadProfileAvatar,
  validateProfileName,
} from "@/lib/profile-settings";
import { createClient } from "@/lib/supabase/server";

/**
 * Phase 19 — profile settings server actions.
 *
 * Both actions derive the user id from the Supabase session (never from the
 * form) and then write through the service role, which is the only way to
 * keep profiles.full_name in sync (the protect_profile_system_fields trigger
 * pins it for `authenticated` clients). Only first_name, last_name and
 * avatar_url are ever written — email, password, user id, account status,
 * plan/limits and every other profile column stay untouched.
 */

const PROFILE_PATH = "/settings/profile";

function scrub(message: string): string {
  return message
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+/gi, "Bearer [redacted]")
    .replace(
      /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
      "[redacted-jwt]",
    );
}

async function requireSessionUser() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  return { supabase, user };
}

export async function saveProfileName(formData: FormData): Promise<void> {
  const { user } = await requireSessionUser();
  const parsed = validateProfileName({
    firstName: formData.get("firstName"),
    lastName: formData.get("lastName"),
  });
  if (!parsed.ok) redirect(`${PROFILE_PATH}?error=${parsed.error}`);
  try {
    await updateProfileName(user.id, {
      firstName: parsed.firstName,
      lastName: parsed.lastName,
    });
  } catch (error) {
    console.error(
      `[profile] name update failed user="${user.id}" error="${scrub(
        error instanceof Error ? error.message : "unknown",
      )}"`,
    );
    redirect(`${PROFILE_PATH}?error=save_failed`);
  }
  revalidatePath(PROFILE_PATH);
  revalidatePath("/", "layout");
  redirect(`${PROFILE_PATH}?saved=1`);
}

export async function uploadAvatar(formData: FormData): Promise<void> {
  const { supabase, user } = await requireSessionUser();
  const file = formData.get("avatar");
  if (!(file instanceof File) || file.size === 0)
    redirect(`${PROFILE_PATH}?error=no_file`);
  // Read the current avatar (RLS-scoped to the session user) so the previous
  // object can be cleaned up after a successful upload.
  const { data: current } = await supabase
    .from("profiles")
    .select("avatar_url")
    .eq("id", user.id)
    .maybeSingle<{ avatar_url: string | null }>();
  try {
    await uploadProfileAvatar(user.id, file, current?.avatar_url ?? null);
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown";
    const code =
      message === "avatar_type" || message === "avatar_size"
        ? message
        : "avatar_failed";
    console.error(
      `[profile] avatar upload failed user="${user.id}" error="${scrub(message)}"`,
    );
    redirect(`${PROFILE_PATH}?error=${code}`);
  }
  revalidatePath(PROFILE_PATH);
  revalidatePath("/", "layout");
  redirect(`${PROFILE_PATH}?avatar=1`);
}
