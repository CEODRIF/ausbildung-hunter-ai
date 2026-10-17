"use server";

import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import {
  hasApplicantProfileColumns,
  hasProfileAvatarColumn,
} from "@/lib/contact-name-support";
import { isProfileAvatarId, validateDisplayName } from "@/lib/profile-avatars";
import { validateApplicantProfile } from "@/lib/bewerbung-automation";

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
 * Result of an applicant-profile update. STABLE CODES, never server text:
 *
 *   - `invalid_profile`  — one or more of the seven fields missing/whitespace
 *                          or malformed (email syntax / phone shape / length);
 *   - `columns_pending`  — code deployed before the 20261114000000 migration
 *                          (the UI hides the form in this window);
 *   - `unauthorized` / `failed` — session / write problems.
 */
export type ApplicantProfileResult =
  | { ok: true }
  | { ok: false; error: "invalid_profile" | "columns_pending" | "unauthorized" | "failed" };

/**
 * Saves the seven mandatory applicant fields (the full header of a
 * generated Anschreiben PDF) for the CURRENT session user.
 *
 * Security model (identical to updateProfileIdentity):
 *  - the acting user comes EXCLUSIVELY from `auth.getUser()`; the update is
 *    constrained with `.eq("id", user.id)` via the service-role client —
 *    a client can never address another profile;
 *  - ALL seven fields are validated server-side (validateApplicantProfile —
 *    the same pure rules the UI uses); a save with any missing/whitespace
 *    value is REJECTED wholesale: the profile is all-or-nothing, so an
 *    existing complete profile can never be degraded by a partial write,
 *    and no value is ever overwritten with "" or a fabricated default;
 *  - values are normalized (whitespace collapsed, trimmed) before the
 *    length/syntax checks;
 *  - while the migration is pending the action reports `columns_pending`
 *    instead of writing half a row (the page hides the form then);
 *  - full_name + email are part of the same atomic write — they come from
 *    the same form the user just saw, so nothing is silently changed
 *    behind the scenes (they were already editable/visible on this page).
 */
export async function updateApplicantProfile(
  formData: FormData,
): Promise<ApplicantProfileResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "unauthorized" };

  const supported = await hasApplicantProfileColumns();
  if (!supported) return { ok: false, error: "columns_pending" };

  const check = validateApplicantProfile({
    fullName: formData.get("fullName"),
    street: formData.get("street"),
    postalCode: formData.get("postalCode"),
    city: formData.get("city"),
    country: formData.get("country"),
    email: formData.get("email"),
    phone: formData.get("phone"),
  });
  if (!check.ok) return { ok: false, error: "invalid_profile" };

  const { value } = check;
  const ok = await writeIdentity(user.id, {
    full_name: value.fullName,
    email: value.email,
    street: value.street,
    postal_code: value.postalCode,
    city: value.city,
    country: value.country,
    phone: value.phone,
  });
  return ok ? { ok: true } : { ok: false, error: "failed" };
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
