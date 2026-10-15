/**
 * Canonical profile-avatar registry (pure module — safe on client AND
 * server; no "server-only" import, no I/O).
 *
 * The profile avatar gallery ships exactly 10 ORIGINAL vector avatars,
 * hand-authored in-repo at `public/profile-avatars/avatar-01.svg` …
 * `avatar-10.svg` (1:1, 256×256 viewBox, ~1 KB each). Users persist an
 * IDENTIFIER (`avatar-01` … `avatar-10`), never a URL: the only mapping
 * between that identifier and a concrete asset is this module, and the
 * server validates every incoming identifier against `PROFILE_AVATAR_IDS`
 * before it can be written. No arbitrary URLs, no HTML/SVG uploads, no
 * external image services — by construction the avatar input space is a
 * closed allowlist of 10 local assets.
 *
 * Schema: migration 20261111000000_profile_avatar_gallery.sql adds the
 * `profiles.avatar` column with a matching CHECK constraint. That
 * migration is applied MANUALLY (this repo has no auto-migration step),
 * so runtime code gates on `hasProfileAvatarColumn()` — see
 * `src/lib/contact-name-support.ts`.
 */

/** The 10 approved avatar identifiers — the ONLY valid avatar values. */
export const PROFILE_AVATAR_IDS = [
  "avatar-01",
  "avatar-02",
  "avatar-03",
  "avatar-04",
  "avatar-05",
  "avatar-06",
  "avatar-07",
  "avatar-08",
  "avatar-09",
  "avatar-10",
] as const;

export type ProfileAvatarId = (typeof PROFILE_AVATAR_IDS)[number];

/** Local asset extension for the bundled gallery avatars. */
export const PROFILE_AVATAR_ASSET_EXT = "svg" as const;

/**
 * Allowlist check: true only for one of the 10 canonical identifiers.
 * Accepts `unknown` so it can be applied straight to raw form input —
 * anything else (URLs, file names, "avatar-11", upper-case variants,
 * injection attempts) is rejected.
 */
export function isProfileAvatarId(value: unknown): value is ProfileAvatarId {
  return (
    typeof value === "string" &&
    (PROFILE_AVATAR_IDS as readonly string[]).includes(value)
  );
}

/** Map a canonical identifier to its local public asset path. */
export function avatarAssetPath(id: ProfileAvatarId): string {
  return `/profile-avatars/${id}.${PROFILE_AVATAR_ASSET_EXT}`;
}

/** Short human suffix ("01" … "10") for display/labels. */
export function avatarNumber(id: ProfileAvatarId): string {
  return id.slice(-2);
}

/* ------------------------------------------------------------------ *
 * Display-name validation (client + server share these exact rules)
 * ------------------------------------------------------------------ */

/**
 * Maximum display-name length. The `profiles.full_name` CHECK constraint
 * allows 2…120 characters; the edit form deliberately caps at 50 so a
 * name can never overflow the header menu or the profile hero, while
 * staying well inside the database limit.
 */
export const DISPLAY_NAME_MAX_LENGTH = 50;

/**
 * Minimum display-name length. Matches the database lower bound (2) so a
 * client-accepted name can never be rejected server-side by the CHECK
 * constraint — and, being ≥ 2, also rejects the empty string the spec
 * requires.
 */
export const DISPLAY_NAME_MIN_LENGTH = 2;

export type DisplayNameValidation =
  | { ok: true; value: string }
  | { ok: false; error: "too_short" | "too_long" };

/**
 * Trim and validate a display name. Pure: the same result client and
 * server. `undefined`/non-string input is treated as empty.
 */
export function validateDisplayName(raw: unknown): DisplayNameValidation {
  const value = (typeof raw === "string" ? raw : "").trim();
  if (value.length < DISPLAY_NAME_MIN_LENGTH)
    return { ok: false, error: "too_short" };
  if (value.length > DISPLAY_NAME_MAX_LENGTH)
    return { ok: false, error: "too_long" };
  return { ok: true, value };
}

/* ------------------------------------------------------------------ *
 * Avatar resolution (pure, shared by every identity-display surface)
 * ------------------------------------------------------------------ */

/**
 * What an identity surface should render for a profile. Priority:
 *
 *   1. `avatar` — a VALID gallery identifier → bundled local SVG asset;
 *   2. `avatarUrl` — legacy/Phase-19 uploaded avatar (public bucket URL);
 *   3. initials derived from the full name ("Yassine Salmi" → "YS"),
 *      or "?" when the name is empty.
 *
 * An INVALID `avatar` value (anything outside the allowlist — should
 * never happen server-side, but the resolver must not trust it) simply
 * falls through to the next priority; it never renders user-supplied
 * content.
 */
export type ResolvedUserAvatar =
  | { kind: "asset"; id: ProfileAvatarId; src: string }
  | { kind: "url"; src: string }
  | { kind: "initials"; initials: string };

export function resolveUserAvatar(input: {
  avatar?: unknown;
  avatarUrl?: unknown;
  fullName?: unknown;
}): ResolvedUserAvatar {
  const { avatar, avatarUrl, fullName } = input;

  if (typeof avatar === "string" && isProfileAvatarId(avatar)) {
    return { kind: "asset", id: avatar, src: avatarAssetPath(avatar) };
  }

  if (typeof avatarUrl === "string" && avatarUrl.trim().length > 0) {
    return { kind: "url", src: avatarUrl };
  }

  const initials = (typeof fullName === "string" ? fullName : "")
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  return { kind: "initials", initials: initials || "?" };
}
