import { readFileSync } from "node:fs";
import { readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Regression guards for the 3D flight hero (replaces the photo-based
 * cinematic hero).
 *
 * Pins:
 *   - the four static hero photos are GONE (files and every reference),
 *   - the hero is a real Three.js scene with a genuinely animated aircraft,
 *   - the theme `dark` class remains the single source of truth for
 *     day/night (MutationObserver, ~2 s tween),
 *   - performance/a11y wiring: WebGL detection + CSS fallback,
 *     prefers-reduced-motion, hidden-tab pause, off-screen pause,
 *     adaptive pixel ratio,
 *   - the landing-page contract: headline, GET search form, scrim.
 */
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const read = (relative: string) => readFileSync(resolve(root, relative), "utf8");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = resolve(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === "node_modules" || entry === ".next" || entry === "dist") continue;
      walk(full, out);
    } else {
      out.push(full);
    }
  }
  return out;
}

const OLD_PHOTOS = [
  "photo_6015007192047620733_y.jpg",
  "photo_6015007192047620734_y.jpg",
  "photo_6015007192047620735_y.jpg",
  "photo_6015007192047620736_y.jpg",
];

describe("photo-based hero removal", () => {
  it("the four hero photographs are deleted from public/", () => {
    for (const name of OLD_PHOTOS) {
      expect(() => readFileSync(resolve(root, `public/hero/${name}`)), name).toThrow();
    }
  });

  it("no source or test references the old photos or /hero/ paths", () => {
    const offenders: string[] = [];
    for (const dir of ["src", "tests"]) {
      const base = resolve(root, dir);
      for (const file of walk(base)) {
        if (file.endsWith("hero-flight.test.ts")) continue; // contains the literal probe strings
        const content = readFileSync(file, "utf8");
        for (const name of OLD_PHOTOS) {
          if (content.includes(name)) offenders.push(`${file} -> ${name}`);
        }
        if (content.includes("/hero/")) offenders.push(`${file} -> "/hero/"`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("obsolete photo CSS is removed from globals.css", () => {
    const css = read("src/app/globals.css");
    for (const gone of [
      ".hero-photo",
      ".hero-cam",
      ".hero-glow",
      ".hero-haze",
      ".hero-sheen",
      ".hero-bank",
      "@keyframes hero-cam",
      "@keyframes hero-float",
      "@keyframes bank-drift",
    ]) {
      expect(css, gone).not.toContain(gone);
    }
    // The shared sky primitives the fallback still uses stay.
    for (const kept of [".sky-hero", ".hero-stars", ".hero-scrim", ".hero-search"]) {
      expect(css, kept).toContain(kept);
    }
  });

  it("the parallax wrapper for the photos is gone", () => {
    expect(() => read("src/components/landing/hero-parallax.tsx")).toThrow();
    const page = read("src/app/page.tsx");
    expect(page).not.toContain("HeroParallax");
    expect(page).not.toContain("HeroScene");
  });
});

describe("3D flight hero", () => {
  const flight = read("src/components/landing/hero-flight.tsx");
  const sky = read("src/components/landing/sky.tsx");

  it("page.tsx mounts HeroFlight and keeps the search contract", () => {
    const page = read("src/app/page.tsx");
    expect(page).toContain('import { HeroFlight } from "@/components/landing/hero-flight";');
    expect(page).toContain("<HeroFlight />");
    expect(page).toContain('action="/opportunities"');
    expect(page).toContain('method="get"');
    expect(page).toContain('name="keyword"');
    expect(page).toContain(
      "display-title hero-shadow mt-6 text-balance text-[clamp(2.25rem,8vw,4.5rem)] text-white",
    );
  });

  it("is a client component on a canvas layered over the CSS sky", () => {
    expect(flight).toContain('"use client"');
    expect(flight).toContain("<canvas");
    expect(flight).toContain("<HeroFallbackSky />");
    // The decorative wrapper keeps the overflow-guarded contract.
    expect(flight).toContain("pointer-events-none absolute inset-0 overflow-hidden");
    // The fallback sky (read by premium-regressions) keeps its root too.
    expect(sky).toContain("pointer-events-none absolute inset-0 overflow-hidden");
  });

  it("watches the theme system as the single source of truth", () => {
    expect(flight).toContain("MutationObserver");
    expect(flight).toContain('attributeFilter: ["class"]');
    expect(flight).toContain("classList.contains(\"dark\")");
    // ~2 s day/night tween.
    expect(flight).toContain("2000");
  });

  it("ships the performance and accessibility wiring", () => {
    // WebGL detection on a throwaway canvas + graceful CSS fallback.
    expect(flight).toContain("getContext(\"webgl2\")");
    expect(flight).toContain("document.createElement(\"canvas\")");
    // Reduced motion: static frame, no flight loop, no blinking strobes.
    expect(flight).toContain("prefers-reduced-motion");
    expect(flight).toContain("setStaticPose");
    expect(flight).toContain("setAnimated");
    // Pause when hidden / off-screen.
    expect(flight).toContain("visibilitychange");
    expect(flight).toContain("IntersectionObserver");
    // Adaptive pixel ratio.
    expect(flight).toContain("setPixelRatio");
    // Context loss degrades to the CSS sky, never a blank hero.
    expect(flight).toContain("webglcontextlost");
  });

  it("loads the licensed model from /models/", () => {
    expect(flight).toContain("/models/airliner.glb");
    const glb = readFileSync(resolve(root, "public/models/airliner.glb"));
    expect(glb.length).toBeGreaterThan(1_000_000); // the full re-liveried model
    const license = read("public/models/airliner-LICENSE.txt");
    expect(license).toContain("CC0");
    expect(license).toContain("grab3d.com");
  });

  it("uses three.js as the only 3D dependency", () => {
    const pkg = JSON.parse(read("package.json"));
    expect(pkg.dependencies).toHaveProperty("three");
    expect(pkg.devDependencies).toHaveProperty("@types/three");
    const aircraft = read("src/lib/flight/aircraft.ts");
    expect(aircraft).toContain("three/examples/jsm/loaders/GLTFLoader.js");
    expect(aircraft).toContain("GERMANY"); // generic wordmark, no airline
    expect(aircraft).toContain("window_glass"); // night cabin glow
    const env = read("src/lib/flight/environment.ts");
    // Four cloud depth bands — two in front of the aircraft (positive z),
    // two behind (negative z).
    expect(env).toMatch(/z: -48/);
    expect(env).toMatch(/z: -18/);
    expect(env).toMatch(/z: 9/);
    expect(env).toMatch(/z: 16/);
  });
});
