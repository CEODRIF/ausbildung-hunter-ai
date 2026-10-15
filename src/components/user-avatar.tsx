import { resolveUserAvatar } from "@/lib/profile-avatars";

/**
 * Single source of truth for "how does this user's identity look?" —
 * used by every surface that displays the user (profile hero, header
 * account menu, …). Resolution priority (pure, see
 * src/lib/profile-avatars.ts):
 *
 *   gallery avatar id → bundled local SVG  →  uploaded avatar_url → initials
 *
 * Explicit width/height on the <img> (intrinsic 256×256) prevents layout
 * shift; the parent circle controls the rendered size. Universal
 * component (no "use client") so it renders in both the server-rendered
 * profile page and the client account menu.
 */
export function UserAvatar({
  avatar,
  avatarUrl,
  fullName,
  className = "",
  imgClassName = "h-full w-full object-cover",
  initialsClassName = "text-sm font-bold text-accent",
  label = "",
}: {
  avatar?: string | null;
  avatarUrl?: string | null;
  fullName?: string | null;
  /** Sizing/positioning of the circular container. */
  className?: string;
  /** Sizing of the rendered image (defaults to filling the circle). */
  imgClassName?: string;
  /** Font styling for the initials fallback. */
  initialsClassName?: string;
  /** Accessible label for the image (usually the display name). */
  label?: string;
}) {
  const resolved = resolveUserAvatar({ avatar, avatarUrl, fullName });

  return (
    <span
      aria-hidden={label ? undefined : true}
      className={`flex shrink-0 items-center justify-center overflow-hidden rounded-full ${className}`.trim()}
    >
      {resolved.kind === "initials" ? (
        <span className={initialsClassName}>{resolved.initials}</span>
      ) : (
        // eslint-disable-next-line @next/next/no-img-element -- fixed local SVG (intrinsic 256×256) or the user's own bucket URL, circular crop
        <img
          src={resolved.src}
          width={256}
          height={256}
          alt={label}
          className={imgClassName}
        />
      )}
    </span>
  );
}
