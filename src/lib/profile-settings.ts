import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Phase 19 — profile settings domain logic.
 *
 * Everything here is server-only and always scoped to a user id that the
 * caller derived from the Supabase session (never from client input):
 *  - name updates go through the service role because the
 *    protect_profile_system_fields trigger pins `full_name` for
 *    `authenticated` clients — the service role keeps `full_name` in sync
 *    with the two editable parts, so the rest of the app (CV templates,
 *    dashboard, notifications) keeps reading one authoritative display name;
 *  - avatar objects live under a `{user-id}/` prefix in the `avatars` bucket
 *    (the same ownership boundary the existing buckets use), so a user can
 *    only ever write inside their own folder.
 */

/** Bucket created by 20261013000000_profile_settings. */
export const AVATAR_BUCKET = "avatars";
/** 2 MB — avatars are header-sized images, not documents. */
export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
export const AVATAR_MIME_EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};
/** profiles.first_name / last_name column constraint. */
export const NAME_MAX_LENGTH = 60;
/** profiles.full_name check constraint (char_length between 2 and 120). */
export const FULL_NAME_MAX_LENGTH = 120;

export type ProfileNameInput = { firstName: string; lastName: string };
export type ProfileNameValidation =
  | { ok: true; firstName: string; lastName: string; fullName: string }
  | { ok: false; error: "name_required" | "name_too_long" };

function clean(value: unknown): string {
  return String(value ?? "")
    .trim()
    .replace(/\s+/g, " ");
}

/**
 * Validate the two editable name parts. Both are required: `full_name` is the
 * app-wide display name and the column has a 2..120 length contract.
 */
export function validateProfileName(input: {
  firstName: unknown;
  lastName: unknown;
}): ProfileNameValidation {
  const firstName = clean(input.firstName);
  const lastName = clean(input.lastName);
  if (!firstName || !lastName) return { ok: false, error: "name_required" };
  if (
    firstName.length > NAME_MAX_LENGTH ||
    lastName.length > NAME_MAX_LENGTH ||
    firstName.length + lastName.length + 1 > FULL_NAME_MAX_LENGTH
  )
    return { ok: false, error: "name_too_long" };
  return { ok: true, firstName, lastName, fullName: `${firstName} ${lastName}` };
}

/**
 * Fallback for accounts created before first_name/last_name existed (or by the
 * sign-up trigger, which only stores full_name): present the stored display
 * name as two editable parts without backfilling the database.
 */
export function splitFullName(fullName: string | null | undefined): ProfileNameInput {
  const parts = clean(fullName).split(" ").filter(Boolean);
  if (parts.length === 0) return { firstName: "", lastName: "" };
  if (parts.length === 1) return { firstName: parts[0], lastName: "" };
  return { firstName: parts[0], lastName: parts.slice(1).join(" ") };
}

export type AvatarValidation =
  | { ok: true; extension: string; mimeType: string }
  | { ok: false; error: "avatar_type" | "avatar_size" };

/** Signature check — a renamed non-image file must not pass the mime filter. */
export function looksLikeImage(bytes: Uint8Array): boolean {
  if (bytes.length < 12) return false;
  const jpeg =
    bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const png =
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a;
  const webp =
    bytes[0] === 0x52 && // R
    bytes[1] === 0x49 && // I
    bytes[2] === 0x46 && // F
    bytes[3] === 0x46 && // F
    bytes[8] === 0x57 && // W
    bytes[9] === 0x45 && // E
    bytes[10] === 0x42 && // B
    bytes[11] === 0x50; // P
  return jpeg || png || webp;
}

export function validateAvatar(input: {
  size: number;
  mimeType: string;
  bytes: Uint8Array;
}): AvatarValidation {
  const extension = AVATAR_MIME_EXTENSIONS[input.mimeType];
  if (!extension || !looksLikeImage(input.bytes))
    return { ok: false, error: "avatar_type" };
  if (input.size <= 0 || input.size > AVATAR_MAX_BYTES)
    return { ok: false, error: "avatar_size" };
  return { ok: true, extension, mimeType: input.mimeType };
}

/**
 * Ownership-bound storage path: always `{userId}/avatar-{timestamp}.{ext}`.
 * The timestamp makes every upload a fresh object URL (no stale CDN copy) and
 * keeps the previous file identifiable for the best-effort cleanup.
 */
export function createAvatarPath(
  userId: string,
  extension: string,
  now: number = Date.now(),
): string {
  return `${userId}/avatar-${now}.${extension}`;
}

/** Object path of a public avatar URL, or null when it is not one. */
export function avatarPathFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const marker = `/storage/v1/object/public/${AVATAR_BUCKET}/`;
  const index = url.indexOf(marker);
  if (index === -1) return null;
  const path = url.slice(index + marker.length);
  return path.length ? decodeURIComponent(path) : null;
}

/** Provider names linked to the account (Supabase auth identities). */
export function linkedProviders(
  identities: Array<{ provider?: string }> | null | undefined,
): string[] {
  const values = new Set<string>();
  for (const identity of identities ?? []) {
    const provider = identity?.provider?.toLowerCase().trim();
    if (provider) values.add(provider);
  }
  return [...values].sort();
}

export async function updateProfileName(
  userId: string,
  input: ProfileNameInput,
): Promise<{ fullName: string }> {
  const fullName = `${input.firstName} ${input.lastName}`;
  const admin = createAdminClient();
  const { error } = await admin
    .from("profiles")
    .update({
      first_name: input.firstName,
      last_name: input.lastName,
      full_name: fullName,
    })
    .eq("id", userId);
  if (error)
    throw new Error(
      `Saving profile name failed${error.code ? ` [${error.code}]` : ""}: ${error.message}`,
    );
  return { fullName };
}

/**
 * Store the avatar inside the caller's own folder and point the profile at it,
 * then best-effort remove the previous object (same-folder only). Returns the
 * public URL that is persisted in profiles.avatar_url.
 */
export async function uploadProfileAvatar(
  userId: string,
  file: File,
  previousUrl?: string | null,
): Promise<{ avatarUrl: string; path: string }> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const validation = validateAvatar({
    size: file.size,
    mimeType: file.type,
    bytes,
  });
  if (!validation.ok) throw new Error(validation.error);

  const path = createAvatarPath(userId, validation.extension);
  const admin = createAdminClient();
  const { error: uploadError } = await admin.storage
    .from(AVATAR_BUCKET)
    .upload(path, bytes, {
      contentType: validation.mimeType,
      upsert: false,
    });
  if (uploadError)
    throw new Error(`Avatar upload failed: ${uploadError.message}`);

  const { data } = admin.storage.from(AVATAR_BUCKET).getPublicUrl(path);
  const avatarUrl = data.publicUrl;
  if (!avatarUrl) throw new Error("Avatar upload failed: no public URL.");

  const { error: updateError } = await admin
    .from("profiles")
    .update({ avatar_url: avatarUrl })
    .eq("id", userId);
  if (updateError)
    throw new Error(
      `Saving avatar failed${updateError.code ? ` [${updateError.code}]` : ""}: ${updateError.message}`,
    );

  const previousPath = avatarPathFromUrl(
    typeof previousUrl === "string" ? previousUrl : null,
  );
  // Best-effort: never fail the save because an old object could not be
  // removed, and never touch a path outside the caller's own folder.
  if (previousPath && previousPath.startsWith(`${userId}/`))
    await admin.storage.from(AVATAR_BUCKET).remove([previousPath]);

  return { avatarUrl, path };
}
