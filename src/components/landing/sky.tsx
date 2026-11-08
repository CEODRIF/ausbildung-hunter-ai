/**
 * CSS-only sky for the landing hero.
 *
 * Two jobs:
 *   1. The layer UNDER the WebGL canvas in HeroFlight — it paints instantly
 *      (no JS, no model) so there is never a blank hero while the 3D scene
 *      loads, then the canvas fades in on top of it.
 *   2. The complete fallback when WebGL is unavailable (or the context is
 *      lost): a themed gradient sky with the progressive star field and soft
 *      cloud masses — the aircraft is honestly absent rather than faked.
 *
 * Day/night is driven exclusively by the `dark` class on <html> (see
 * src/lib/theme.ts); the pre-paint script applies the persisted theme before
 * the first frame, so there is no flash of the wrong sky and no second theme
 * state.
 *
 * Server-rendered markup only — zero client JavaScript.
 */
export function HeroFallbackSky() {
  return (
    <div
      className="pointer-events-none absolute inset-0 overflow-hidden"
      aria-hidden="true"
    >
      {/* Gradient sky — bright blue by day, deep navy by night. */}
      <div className="hero-fallback-sky" />

      {/* Soft cloud masses — static shapes, theme-tinted. */}
      <div className="hero-fallback-cloud hero-fallback-cloud--far" />
      <div className="hero-fallback-cloud hero-fallback-cloud--near" />

      {/* CSS star field — two sparse radial-gradient layers that brighten
          with staggered delays AFTER the sky has started to darken, so the
          stars appear progressively rather than in one moment. */}
      <div className="hero-stars hero-stars--bright">
        <div className="hero-stars__field hero-stars__field--bright" />
      </div>
      <div className="hero-stars hero-stars--faint">
        <div className="hero-stars__field hero-stars__field--faint" />
      </div>
    </div>
  );
}
