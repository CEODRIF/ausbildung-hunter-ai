import { Airplane } from "./airplane";

/**
 * The decorative sky layer for the hero: cumulus banks + the aircraft.
 *
 * Pure CSS/SVG, no images, no video, no JS. The aircraft animation is a
 * compositor-only `transform` keyframe (see `.plane` in globals.css) and is
 * disabled for `prefers-reduced-motion: reduce`, where the aircraft simply
 * rests in the sky instead of disappearing.
 *
 * Cloud banks are pushed past the edges on purpose: they frame the content
 * column instead of sitting on top of the headline, which is what keeps the
 * white type readable.
 */

/** One puffy cloud built from overlapping circles — same fill, so the
 *  circles read as a single silhouette without any blur or filter. */
function CloudShape({
  className = "",
  stretch = false,
}: {
  className?: string;
  /** Let the shape fill its box (wide, flat horizon banks). */
  stretch?: boolean;
}) {
  return (
    <svg
      viewBox="0 0 240 104"
      className={className}
      fill="currentColor"
      role="presentation"
      aria-hidden="true"
      focusable="false"
      preserveAspectRatio={stretch ? "none" : undefined}
    >
      <circle cx="62" cy="66" r="34" />
      <circle cx="112" cy="46" r="44" />
      <circle cx="168" cy="62" r="32" />
      <rect x="42" y="62" width="150" height="38" rx="19" />
    </svg>
  );
}

export function HeroScene() {
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
      {/* distant bank — small, faint, slow */}
      <CloudShape className="cloud cloud-slower start-[-16%] top-[20%] w-32 opacity-50 sm:w-44" />
      <CloudShape className="cloud cloud-slow end-[-14%] top-[28%] w-28 opacity-45 sm:w-40" />

      {/* mid bank — the readable layer, hugging both edges */}
      <CloudShape className="cloud cloud-slow start-[-14%] top-[48%] hidden w-40 opacity-60 sm:block sm:w-56" />
      <CloudShape className="cloud cloud-slower end-[-12%] top-[38%] hidden w-44 opacity-55 sm:block sm:w-60" />
      <CloudShape className="cloud cloud-slow end-[-16%] top-[68%] hidden w-32 opacity-45 sm:block sm:w-44" />

      {/* horizon bank — wide, flat, anchors the bottom edge. Explicit heights
          keep the bank a few dozen pixels tall instead of swallowing the CTA. */}
      <CloudShape stretch className="cloud cloud-slower start-[-24%] bottom-[-1.25rem] h-14 w-[74%] opacity-100 sm:h-20" />
      <CloudShape stretch className="cloud cloud-slow end-[-28%] bottom-[-1rem] h-12 w-[68%] opacity-95 sm:h-16" />
      <CloudShape stretch className="cloud start-[18%] bottom-[-1.5rem] h-10 w-[52%] opacity-90 sm:h-14" />

      {/* the aircraft: outer element crosses the hero, inner element bobs */}
      <div className="plane">
        <span className="plane-bob block">
          <Airplane className="h-auto w-full drop-shadow-[0_18px_28px_rgba(11,31,51,0.18)]" />
        </span>
      </div>
    </div>
  );
}
