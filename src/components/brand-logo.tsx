import Link from "next/link";

/**
 * Centralized brand logo.
 *
 * The official logo image has not been delivered to this workspace yet, so
 * the mark renders the existing letter-tile identity (blue tile + "A") that
 * is already used across the app — it is NOT a CSS re-drawing of artwork:
 * it is the app's current brand mark, kept 1:1 (proportions, colors).
 *
 * ASSET SWAP POINT: drop the official file at `public/logo.svg` (or
 * `.png`) and set `BRAND_LOGO_URL` below to it — every surface (sidebar,
 * auth, dashboard, AI assistant, scanner, search, opportunities,
 * applications, settings, mobile nav, empty states) picks it up from this
 * single component. The tile version (`variant="mark"`) and the favicon
 * (`src/app/icon.svg`) are the compact crops.
 */
export const BRAND_LOGO_URL: string | null = null;

export interface BrandLogoProps {
  /** "full" = mark + wordmark, "mark" = compact icon only. */
  variant?: "full" | "mark";
  /** Rendered tile size in px (default 36). */
  size?: number;
  className?: string;
  /** Optional link target (defaults to the landing page). */
  href?: string;
  /** Accessible label. */
  label?: string;
  /**
   * "light" forces a white wordmark for placement on dark brand surfaces
   * (the auth panel is dark in both themes). Default follows the theme.
   */
  tone?: "auto" | "light";
}

function Mark({ size }: { size: number }) {
  if (BRAND_LOGO_URL) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- brand asset, fixed dimensions
      <img
        src={BRAND_LOGO_URL}
        alt=""
        width={size}
        height={size}
        style={{ width: size, height: size }}
        className="rounded-xl object-contain"
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.44) }}
      className="flex shrink-0 items-center justify-center rounded-xl bg-accent font-bold text-white shadow-[0_6px_14px_rgba(var(--glow-accent-rgb),0.25)] ring-1 ring-black/5 dark:shadow-[0_6px_14px_rgba(var(--glow-accent-rgb),0.3)] dark:ring-white/10"
    >
      A
    </span>
  );
}

export function BrandLogo({
  variant = "full",
  size = 36,
  className = "",
  href = "/",
  label = "Ausbildung Hunter AI",
  tone = "auto",
}: BrandLogoProps) {
  const wordmarkClass =
    tone === "light"
      ? "text-white"
      : "text-ink";
  const accentClass = tone === "light" ? "text-cyan" : "text-accent";
  let content =
    variant === "mark" ? (
      <Mark size={size} />
    ) : (
      <span className="flex items-center gap-2.5">
        <Mark size={size} />
        <span
          className={`text-sm font-bold tracking-[-0.02em] ${wordmarkClass}`}
          style={{ lineHeight: 1 }}
        >
          Ausbildung Hunter <span className={accentClass}>AI</span>
        </span>
      </span>
    );

  if (href) {
    content = (
      <Link
        href={href}
        aria-label={label}
        className={`inline-flex items-center ${className}`}
      >
        {content}
      </Link>
    );
  } else {
    content = (
      <span className={`inline-flex items-center ${className}`}>{content}</span>
    );
  }
  return content;
}
