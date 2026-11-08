/**
 * The decorative day/night photo scene for the landing hero.
 *
 * Two full-bleed photographic layers — day and night — plus a CSS-only
 * star field and a readability scrim. Which scene is visible is driven
 * exclusively by the `dark` class on <html> (see src/lib/theme.ts): the
 * pre-paint script applies the persisted theme before the first frame,
 * so there is no flash of the wrong scene, no hydration mismatch and no
 * second theme state. The theme switcher toggles that same class, and
 * the cinematic cross-fade / moon-rise is pure CSS (see the
 * "Day/night photo hero" block in globals.css).
 *
 * Responsive image selection: each layer carries a srcset with the
 * vertical (720 px) and horizontal (1280 px) framings, so a phone
 * downloads exactly one framing and a desktop the other — never both,
 * and the airplane is never stretched (object-fit: cover).
 *
 * Pure server-rendered markup: no client JavaScript, no animation
 * library — everything is compositor-only transform/opacity CSS.
 */

const DAY_DESKTOP = "/hero/photo_6015007192047620735_y.jpg";
const DAY_MOBILE = "/hero/photo_6015007192047620736_y.jpg";
const NIGHT_DESKTOP = "/hero/photo_6015007192047620733_y.jpg";
const NIGHT_MOBILE = "/hero/photo_6015007192047620734_y.jpg";

export function HeroScene() {
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden">
      {/* Day scene — owns the light theme. Highest fetch priority: it is
          what the first paint shows for the default (light/system-light)
          visitor. */}
      <div className="hero-photo hero-photo--day">
        {/* eslint-disable-next-line @next/next/no-img-element -- native
            <img>: the hero needs srcset/fetch-priority/decoding control */}
        <img
          src={DAY_DESKTOP}
          srcSet={`${DAY_MOBILE} 720w, ${DAY_DESKTOP} 1280w`}
          sizes="100vw"
          alt=""
          loading="eager"
          fetchPriority="high"
          decoding="async"
        />
      </div>

      {/* Night scene — sits ABOVE the day scene and starts a few percent
          below its final position. Going dark lifts it into place (the
          moon rises) while it fades in; going light sinks it again (the
          moon sets) as it fades out. */}
      <div className="hero-photo hero-photo--night">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={NIGHT_DESKTOP}
          srcSet={`${NIGHT_MOBILE} 720w, ${NIGHT_DESKTOP} 1280w`}
          sizes="100vw"
          alt=""
          loading="eager"
          decoding="async"
        />
      </div>

      {/* CSS star field — two sparse radial-gradient layers that brighten
          with staggered delays AFTER the sky has started to darken, so
          the stars appear progressively rather than in one moment. */}
      <div className="hero-stars hero-stars--bright">
        <div className="hero-stars__field hero-stars__field--bright" />
      </div>
      <div className="hero-stars hero-stars--faint">
        <div className="hero-stars__field hero-stars__field--faint" />
      </div>

      {/* Soft, theme-aware veil that keeps the white copy readable over
          the photographic sky (bright cumulus by day, lit fuselage at
          night). */}
      <div className="hero-scrim" />
    </div>
  );
}
