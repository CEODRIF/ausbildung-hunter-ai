/**
 * The decorative day/night photo scene for the landing hero.
 *
 * A layered cinematic sky built from the two full-bleed photographs (day +
 * night) — the aircraft is part of the photographs, so the scenes crossfade
 * as one. Around them: a warm sun wash / cool moon wash, an atmospheric
 * haze band, the CSS-only star field, a faint moonlight sheen and two
 * drifting foreground cloud banks that pass in front of the aircraft.
 *
 * Which scene is visible is driven exclusively by the `dark` class on
 * <html> (see src/lib/theme.ts): the pre-paint script applies the persisted
 * theme before the first frame, so there is no flash of the wrong scene, no
 * hydration mismatch and no second theme state. The theme switcher toggles
 * that same class, and the whole cinematic transition is pure CSS (see the
 * "Day/night photo hero" block in globals.css).
 *
 * Depth: every layer reads the --hero-px / --hero-py / --hero-sy custom
 * properties written by HeroParallax (hero-parallax.tsx) with a per-layer
 * strength, so pointer and scroll motion moves the layers at different
 * rates. Where parallax is disabled (touch, reduced motion, low-memory
 * devices) the variables stay 0 and the layers hold still — the slow
 * camera drift on the photographs keeps the scene alive on its own.
 *
 * Responsive image selection: each scene is a <picture> whose <source>
 * serves the vertical (720 px) framing to phones, with the horizontal
 * (1280 px) framing as the <img> fallback for sm+. Only the matching
 * candidate loads, so a phone never receives the landscape crop: srcset
 * width hints cannot express orientation, and a high-DPR phone (needs
 * ≥750 px at 375 CSS px wide) would otherwise be served the 1280 w
 * landscape framing, cropped to a fuselage slice. The airplane is never
 * stretched (object-fit: cover).
 *
 * Server-rendered markup only; the single client component in the hero is
 * the parallax wrapper (a few KB, fully self-disabling where unsupported).
 */

const DAY_DESKTOP = "/hero/photo_6015007192047620735_y.jpg";
const DAY_MOBILE = "/hero/photo_6015007192047620736_y.jpg";
const NIGHT_DESKTOP = "/hero/photo_6015007192047620733_y.jpg";
const NIGHT_MOBILE = "/hero/photo_6015007192047620734_y.jpg";

export function HeroScene() {
  return (
    <div
      className="pointer-events-none absolute inset-0 overflow-hidden"
      aria-hidden="true"
    >
      {/* Sun wash (day) and moon wash (night) — one upper-right light
          source in both photographs; they crossfade with the theme and
          bloom over sky and fuselage alike. */}
      <div className="hero-glow hero-glow--sun" />
      <div className="hero-glow hero-glow--moon" />

      {/* Day scene — owns the light theme. Highest fetch priority: it is
          what the first paint shows for the default (light/system-light)
          visitor. */}
      <div className="hero-photo hero-photo--day">
        <div className="hero-cam hero-cam--day">
          <picture>
            <source media="(max-width: 767px)" srcSet={DAY_MOBILE} />
            <img
              src={DAY_DESKTOP}
              alt=""
              loading="eager"
              fetchPriority="high"
              decoding="async"
            />
          </picture>
        </div>
      </div>

      {/* Night scene — sits ABOVE the day scene and starts a few percent
          below its final position. Going dark lifts it into place (the
          moon rises) while it fades in; going light sinks it again (the
          moon sets) as it fades out. */}
      <div className="hero-photo hero-photo--night">
        <div className="hero-cam hero-cam--night">
          <picture>
            <source media="(max-width: 767px)" srcSet={NIGHT_MOBILE} />
            <img
              src={NIGHT_DESKTOP}
              alt=""
              loading="eager"
              decoding="async"
            />
          </picture>
        </div>
      </div>

      {/* Atmospheric haze — one neutral depth treatment that reads in both
          scenes (horizon glow below, faint cool lift at the top). */}
      <div className="hero-haze" />

      {/* CSS star field — two sparse radial-gradient layers that brighten
          with staggered delays AFTER the sky has started to darken, so
          the stars appear progressively rather than in one moment. */}
      <div className="hero-stars hero-stars--bright">
        <div className="hero-stars__field hero-stars__field--bright" />
      </div>
      <div className="hero-stars hero-stars--faint">
        <div className="hero-stars__field hero-stars__field--faint" />
      </div>

      {/* Faint cool sheen across the fuselage height — moonlight on the
          aircraft body at night, absent by day. */}
      <div className="hero-sheen" />

      {/* Drifting foreground cloud banks — the nearest depth plane: the far
          bank sits in the lower mid-sky, the near bank rises off the bottom
          edge. Both pass in front of the photographs (and the aircraft)
          and crossfade to moonlit tones with the theme. */}
      <div className="hero-bank hero-bank--far">
        <div className="hero-bank__drift">
          <div className="hero-bank__night" />
        </div>
      </div>
      <div className="hero-bank hero-bank--near">
        <div className="hero-bank__drift">
          <div className="hero-bank__night" />
        </div>
      </div>

      {/* Soft, theme-aware veil that keeps the white copy readable over
          the photographic sky (bright cumulus by day, lit fuselage at
          night). */}
      <div className="hero-scrim" />
    </div>
  );
}
