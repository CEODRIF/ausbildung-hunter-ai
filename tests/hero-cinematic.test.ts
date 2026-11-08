import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Regression guards for the cinematic 2.5D hero.
 *
 * Pins the layer structure (day/night crossfade + atmosphere + foreground
 * banks), the parallax gating rules, the promise of honest 2.5D (no 3D
 * dependency), and the contracts the redesign must not touch: the four
 * provided aircraft photographs, the plain-GET search form, the headline
 * and the `dark` class as the single theme source of truth.
 */
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const read = (relative: string) =>
  readFileSync(resolve(root, relative), "utf8");

describe("cinematic hero: scene structure", () => {
  const sky = read("src/components/landing/sky.tsx");

  it("keeps the decorative root contract (no pointer capture, clipped)", () => {
    expect(sky).toContain(
      "pointer-events-none absolute inset-0 overflow-hidden",
    );
  });

  it("uses the four provided aircraft photographs (day/night × desktop/mobile)", () => {
    expect(sky).toContain("/hero/photo_6015007192047620735_y.jpg");
    expect(sky).toContain("/hero/photo_6015007192047620733_y.jpg");
    expect(sky).toContain("/hero/photo_6015007192047620736_y.jpg");
    expect(sky).toContain("/hero/photo_6015007192047620734_y.jpg");
  });

  it("builds the atmosphere in layers: glows, haze, sheen, two foreground banks", () => {
    expect(sky).toContain("hero-glow--sun");
    expect(sky).toContain("hero-glow--moon");
    expect(sky).toContain("hero-haze");
    expect(sky).toContain("hero-sheen");
    expect(sky).toContain("hero-bank--far");
    expect(sky).toContain("hero-bank--near");
  });

  it("keeps day first-paint fast (eager, high fetch priority)", () => {
    expect(sky).toContain('loading="eager"');
    expect(sky).toContain('fetchPriority="high"');
  });
});

describe("cinematic hero: CSS choreography", () => {
  const css = read("src/app/globals.css");

  it("camera drift is compositor-only and gated on no-preference", () => {
    expect(css).toContain("@keyframes hero-cam");
    expect(css).toContain("animation: hero-cam 30s ease-in-out infinite");
    expect(css).toContain("@keyframes bank-drift");
    expect(css).toContain("prefers-reduced-motion: no-preference");
  });

  it("depth comes from per-layer multipliers on shared custom properties", () => {
    expect(css).toContain("--hero-px");
    expect(css).toContain("--hero-py");
    expect(css).toContain("--hero-sy");
  });

  it("the theme transition stays a staged cross-fade (no image swap)", () => {
    expect(css).toContain("opacity 1.5s ease");
    expect(css).toContain("translateY(4.5%)");
    expect(css).toContain("transition-delay: 0.35s");
    expect(css).toContain("transition-delay: 0.75s");
  });

  it("reduced motion flattens the parallax and skips the entrance stagger", () => {
    expect(css).toContain(".sky-hero .anim-fade-up");
  });
});

describe("cinematic hero: parallax controller", () => {
  const parallax = read("src/components/landing/hero-parallax.tsx");

  it("is a client component that writes CSS variables (not element styles)", () => {
    expect(parallax).toContain('"use client"');
    expect(parallax).toContain("--hero-px");
  });

  it("gates itself off on touch, reduced motion and low memory", () => {
    expect(parallax).toContain("(pointer: fine)");
    expect(parallax).toContain("(prefers-reduced-motion: reduce)");
    expect(parallax).toContain("deviceMemory");
  });

  it("stops the rAF loop when settled, hidden or off-screen", () => {
    expect(parallax).toContain("requestAnimationFrame");
    expect(parallax).toContain("document.hidden");
    expect(parallax).toContain("IntersectionObserver");
  });
});

describe("cinematic hero: landing page contract", () => {
  const page = read("src/app/page.tsx");

  it("wraps the scene in the parallax controller", () => {
    expect(page).toContain("<HeroParallax>");
    expect(page).toContain("<HeroScene />");
  });

  it("keeps the headline and the plain-GET search untouched", () => {
    expect(page).toContain(
      "display-title hero-shadow mt-6 text-balance text-[clamp(2.25rem,8vw,4.5rem)] text-white",
    );
    expect(page).toContain('action="/opportunities"');
    expect(page).toContain('method="get"');
    expect(page).toContain('name="keyword"');
  });

  it("adds no 3D dependency (honest 2.5D)", () => {
    const pkg = JSON.parse(read("package.json")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    expect(Object.keys(deps)).not.toContain("three");
    expect(Object.keys(deps)).not.toContain("@react-three/fiber");
  });
});
