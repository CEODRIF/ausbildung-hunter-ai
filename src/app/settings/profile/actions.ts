"use server";

import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { hasProfileAvatarColumn } from "@/lib/contact-name-support";
import { isProfileAvatarId, validateDisplayName } from "@/lib/profile-avatars";

/**
 * Result of a profile-identity update. `error` values are STABLE CODES
 * (not messages): the client maps them to translated UI copy, and the
 * server never leaks Supabase/Postgres error text to the browser.
 */
export type ProfileIdentityResult =
  | { ok: true }
  | {
      ok: false;
      error: "invalid_name" | "invalid_avatar" | "unauthorized" | "failed";
    };

/**
 * Updates the CURRENT session user's own display name and avatar.
 *
 * Security model (mirrors the repo's server-action patterns):
 *
 *  - The acting user comes EXCLUSIVELY from the Supabase session
 *    (`auth.getUser()`). The form data carries NO user id and the update
 *    is constrained with `.eq("id", user.id)` — a client cannot address
 *    any other profile, ever.
 *  - The write goes through the service-role admin client, which is
 *    REQUIRED: the `protect_profile_system_fields` trigger locks
 *    `full_name` for the `authenticated` role. Service role is the
 *    established exception (same pattern as onboarding / candidate
 *    corrections); it is scoped to the single session-user row and
 *    touches only `full_name` + `avatar`.
 *  - `avatar` is allowlist-validated (`isProfileAvatarId`) — only the 10
 *    canonical gallery identifiers can be stored; arbitrary URLs, file
 *    names or markup are rejected. The database CHECK constraint
 *    (migration 20261111000000) enforces the same allowlist as a second
 *    line of defence.
 *  - Email, account status, daily limit, goal and every other column are
 *    never part of the patch — no side effects on auth/subscription.
 *  - Deploy-before-migration safety: while the `avatar` column is not
 *    (yet) in the database, an avatar value is DROPPED (name still
 *    saved) instead of failing the whole request; the UI hides the
 *    picker in that window via hasProfileAvatarColumn().
 *
 * Form fields: `fullName` (string, required) and `avatar` ("" = keep
 * current value, otherwise one of the 10 allowlisted identifiers).
 */
export async function updateProfileIdentity(
  formData: FormData,
): Promise<ProfileIdentityResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "unauthorized" };

  // ---- display name (always available: full_name has existed forever)
  const name = validateDisplayName(formData.get("fullName"));
  if (!name.ok) return { ok: false, error: "invalid_name" };

  // ---- avatar (closed allowlist; empty string = "keep current")
  const rawAvatar = typeof formData.get("avatar") === "string"
    ? formData.get("avatar")
    : "";
  if (rawAvatar !== "" && !isProfileAvatarId(rawAvatar)) {
    return { ok: false, error: "invalid_avatar" };
  }

  const avatarSupported = await hasProfileAvatarColumn();
  const patch: Record<string, unknown> = { full_name: name.value };
  if (rawAvatar !== "") {
    if (!avatarSupported) {
      // Column missing (migration pending): keep the request alive for the
      // name, drop the avatar — the picker is not rendered in this window.
      return (await writeIdentity(user.id, patch))
        ? { ok: true }
        : { ok: false, error: "failed" };
    }
    patch.avatar = rawAvatar;
  }

  return await writeIdentity(user.id, patch)
    ? { ok: true }
    : { ok: false, error: "failed" };
}

/**
 * Service-role UPDATE constrained to the session user's own row,
 * returning true only when exactly that row was modified.
 */
async function writeIdentity(
  userId: string,
  patch: Record<string, unknown>,
): Promise<boolean> {
  try {
    const admin = createAdminClient();
    const { data, error } = await admin
      .from("profiles")
      .update(patch)
      .eq("id", userId)
      .select("id");
    if (error) return false;
    // Row must exist AND belong to the session user (eq() guarantees the
    // scope; an empty result means the profile row is missing entirely).
    return Array.isArray(data) && data.length > 0;
  } catch {
    return false;
  }
}
