import Link from "next/link";

/**
 * Centralized brand logo — the SINGLE source of the AusbildungsWeg identity.
 *
 * The official brand artwork (delivered 2026-11 logo: graduation cap with
 * aircraft and the Berlin skyline over an open book, "AusbildungsWeg"
 * wordmark) lives in `public/branding/`:
 *   - `logo-emblem.jpg`   — the emblem (mark + tricolor swoosh + tassel)
 *   - `logo-wordmark.jpg` — the official wordmark (navy "Ausbildungs" + gold "Weg")
 *   - `logo-full.jpg`     — the complete stacked lockup (static contexts)
 *   - `icon-512.png`      — the compact square symbol (favicon, PWA, "mark")
 *
 * The wordmark is official artwork cropped from the delivered logo — it is
 * NEVER re-typed as HTML text or re-drawn. Every surface that uses
 * `<BrandLogo />` (landing header/footer, legal, auth, app sidebar, AI
 * assistant, mobile nav) picks up the identity from this one component.
 *
 * The artwork carries a white background (its own white silhouettes make
 * clean background removal impossible), so on dark surfaces the white chip
 * reads as an intentional badge; on light surfaces it sits on a
 * white/near-white panel and carries a hairline boundary — the system
 * border token (theme-aware, subtle in both themes).
 */
export const BRAND_LOGO_URL = "/branding/logo-emblem.jpg";
export const BRAND_LOGO_WORDMARK_URL = "/branding/logo-wordmark.jpg";
export const BRAND_LOGO_MARK_URL = "/branding/icon-512.png";

/* Official artwork aspect ratios (1174x648 emblem, 1174x132 wordmark) —
 * explicit dimensions below so the lockup never shifts layout. */
const EMBLEM_RATIO = 1174 / 648;
const WORDMARK_RATIO = 1174 / 132;
/* Wordmark height relative to the emblem height in a horizontal lockup —
 * tuned so the official typeface reads at header scale (~14px at size 32). */
const WORDMARK_SCALE = 0.45;

const CHIP_CLASS = "shrink-0 bg-white object-contain ring-1 ring-line-strong dark:ring-black/5";

export interface BrandLogoProps {
  /** "full" = emblem + official wordmark, "mark" = compact square symbol. */
  variant?: "full" | "mark";
  /** Emblem height in px (default 36). */
  size?: number;
  className?: string;
  /** Optional link target (defaults to the landing page). */
  href?: string;
  /** Accessible label. */
  label?: string;
  /**
   * "light" is kept for API compatibility: the white logo chip already reads
   * as an intentional badge on dark brand surfaces (the dark auth panel),
   * so both tones render identically today.
   */
  tone?: "auto" | "light";
  /**
   * Extra classes for the wordmark image only (e.g. `truncate` to clip in a
   * narrow container). Never affects the emblem.
   */
  wordmarkClassName?: string;
}

function Symbol({ size }: { size: number }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element -- brand asset, fixed dimensions
    <img
      src={BRAND_LOGO_MARK_URL}
      alt=""
      width={size}
      height={size}
      style={{ width: size, height: size }}
      className={`${CHIP_CLASS} rounded-xl`}
    />
  );
}

export function BrandLogo({
  variant = "full",
  size = 36,
  className = "",
  href = "/",
  label = "AusbildungsWeg",
  wordmarkClassName = "",
}: BrandLogoProps) {
  const emblemW = Math.round(size * EMBLEM_RATIO);
  const wordmarkH = Math.max(10, Math.round(size * WORDMARK_SCALE));
  const wordmarkW = Math.round(wordmarkH * WORDMARK_RATIO);
  const content =
    variant === "mark" ? (
      <Symbol size={size} />
    ) : (
      <span className="flex min-w-0 items-center gap-2.5">
        {/* eslint-disable-next-line @next/next/no-img-element -- brand asset, fixed dimensions */}
        <img
          src={BRAND_LOGO_URL}
          alt=""
          width={emblemW}
          height={size}
          style={{ width: emblemW, height: size }}
          className={`${CHIP_CLASS} rounded-xl`}
        />
        <span className={`min-w-0 ${wordmarkClassName}`}>
          {/* eslint-disable-next-line @next/next/no-img-element -- brand asset, fixed dimensions */}
          <img
            src={BRAND_LOGO_WORDMARK_URL}
            alt="AusbildungsWeg"
            width={wordmarkW}
            height={wordmarkH}
            style={{ width: wordmarkW, height: wordmarkH }}
            className={`${CHIP_CLASS} rounded-md`}
          />
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
