import Link from "next/link";

/**
 * Centralized brand logo — the SINGLE source of the AusbildungsWeg identity.
 *
 * The official artwork (delivered brand image) lives in `public/`:
 *   - `public/logo-mark.jpg` — the compact mark (A whose right stroke is a
 *     road leading up to a graduation cap); rendered here as the tile.
 *   - `public/logo.jpg` — full logo (mark + wordmark) for static contexts
 *     (downloads, social cards).
 *
 * Every surface that uses `<BrandLogo />` (sidebar, auth, dashboard, AI
 * assistant, scanner, search, opportunities, applications, settings, mobile
 * nav, empty states) picks up the identity from this one component. The
 * wordmark is HTML text — not CSS art — so it stays crisp, theme-aware and
 * accessible: "Ausbildungs" in the surface ink color, "Weg" in brand blue.
 */
export const BRAND_LOGO_URL = "/logo-mark.jpg";

/** Brand accent for the "Weg" part of the wordmark. */
const WEG_CLASS =
  "text-[#0B63E5] dark:text-[#168CFF]";
const WEG_CLASS_LIGHT = "text-[#168CFF]";

export interface BrandLogoProps {
  /** "full" = mark + wordmark, "mark" = compact icon only. */
  variant?: "full" | "mark";
  /** Rendered mark size in px (default 36). */
  size?: number;
  className?: string;
  /** Optional link target (defaults to the landing page). */
  href?: string;
  /** Accessible label. */
  label?: string;
  /**
   * "light" forces a light wordmark for placement on dark brand surfaces
   * (the auth panel is dark in both themes). Default follows the theme.
   */
  tone?: "auto" | "light";
  /**
   * Extra classes for the wordmark text only (e.g. `hidden sm:inline` to
   * collapse to the mark on narrow headers). Never affects the mark.
   */
  wordmarkClassName?: string;
}

function Mark({ size }: { size: number }) {
  // The official mark artwork carries a white background; the rounded tile
  // makes that read as an intentional badge on dark surfaces and blends
  // invisibly into light ones.
  return (
    // eslint-disable-next-line @next/next/no-img-element -- brand asset, fixed dimensions
    <img
      src={BRAND_LOGO_URL}
      alt=""
      width={size}
      height={size}
      style={{ width: size, height: size }}
      className="shrink-0 rounded-xl bg-white object-contain ring-1 ring-black/5"
    />
  );
}

export function BrandLogo({
  variant = "full",
  size = 36,
  className = "",
  href = "/",
  label = "AusbildungsWeg",
  tone = "auto",
  wordmarkClassName = "",
}: BrandLogoProps) {
  const wordmarkClass = tone === "light" ? "text-white" : "text-ink";
  const wegClass = tone === "light" ? WEG_CLASS_LIGHT : WEG_CLASS;
  const content =
    variant === "mark" ? (
      <Mark size={size} />
    ) : (
      <span className="flex min-w-0 items-center gap-2.5">
        <Mark size={size} />
        <span
          className={`min-w-0 truncate text-sm font-bold tracking-[-0.02em] ${wordmarkClass} ${wordmarkClassName}`}
          style={{ lineHeight: 1 }}
        >
          Ausbildungs<span className={wegClass}>Weg</span>
        </span>
      </span>
    );

  if (href) {
    return (
      <Link
        href={href}
        aria-label={label}
        className={`inline-flex items-center ${className}`}
      >
        {content}
      </Link>
    );
  }
  return (
    <span className={`inline-flex items-center ${className}`}>{content}</span>
  );
}
