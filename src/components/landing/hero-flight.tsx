"use client";

/**
 * The 3D flight hero: a continuously animated passenger aircraft (CC0 Grab3D
 * model, generic German livery) crossing a real-time sky — day or night.
 *
 * Layering (inside the .sky-hero wrapper):
 *   HeroFallbackSky (CSS)  — first paint, model load, and the complete
 *                            fallback when WebGL is unavailable
 *   <canvas>               — the Three.js scene, fades in once ready
 *   .hero-scrim            — readability veil (rendered by the page, above
 *                            this component)
 *
 * The theme system (the `dark` class on <html>, src/lib/theme.ts) is the
 * single source of truth: a MutationObserver tweens the scene over ~2 s
 * (sky darkens, sun sets, moon rises, stars in stages, clouds re-lit,
 * aircraft lights on) while the aircraft keeps flying.
 *
 * Performance / accessibility:
 *   - adaptive pixel ratio (steps down when frames run slow),
 *   - rendering pauses when the tab is hidden or the hero is off-screen,
 *   - prefers-reduced-motion: one static frame, no flight loop, no blinking
 *     strobes, theme changes apply near-instantly,
 *   - no WebGL: the CSS sky stays visible — never a blank hero.
 */
import { useEffect, useRef, useState } from "react";
import { HeroFallbackSky } from "./sky";

const MODEL_URL = "/models/airliner.glb";

type MemoryWindow = Window & { deviceMemory?: number };

function easeInOutCubic(x: number): number {
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}

export function HeroFlight() {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return;

    // Capability probe on a THROWAWAY canvas: probing the real canvas would
    // claim its WebGL context and block Three.js from getting its own.
    const probe = document.createElement("canvas");
    const gl = probe.getContext("webgl2") ?? probe.getContext("webgl");
    if (!gl) return; // CSS fallback sky remains

    let disposed = false;
    let raf = 0;
    let stop: () => void = () => {};
    let disposeEngine: (() => void) | null = null;
    let themeObserver: MutationObserver | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let viewObserver: IntersectionObserver | null = null;
    let onPointerMove: ((e: PointerEvent) => void) | null = null;
    let onScroll: (() => void) | null = null;
    let onVisibility: (() => void) | null = null;
    let onContextLost: ((e: Event) => void) | null = null;
    let parallaxOn = false;

    (async () => {
      try {
        const THREE = await import("three");
        const { createEnvironment } = await import("@/lib/flight/environment");
        const { loadAircraft } = await import("@/lib/flight/aircraft");

        const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        const finePointer = window.matchMedia("(pointer: fine)").matches;
        const mem = (window as MemoryWindow).deviceMemory;
        const memOk = mem === undefined || mem > 2;
        parallaxOn = finePointer && !reduced && memOk;

        const renderer = new THREE.WebGLRenderer({
          canvas,
          // No MSAA: at the adaptive pixel ratios (up to 2x) the supersample
          // already resolves edges, and MSAA is a pure software cost without
          // a GPU (SwiftShader) — the scene is soft (sky gradient, fuzzy
          // cloud sprites) so aliasing would read on the aircraft only.
          antialias: false,
          alpha: false,
          powerPreference: "high-performance",
        });
        renderer.toneMapping = THREE.ACESFilmicToneMapping;
        renderer.toneMappingExposure = 1.05;

        const scene = new THREE.Scene();
        const camera = new THREE.PerspectiveCamera(42, 1, 0.5, 400);
        // Pulled back to 40 m so the full airframe (12.3 m to the fin top)
        // always fits in frame — see the altitude note in lib/flight/path.ts.
        const camBase = new THREE.Vector3(0, 2.2, 40);
        const lookBase = new THREE.Vector3(0, 5.0, 0);
        camera.position.copy(camBase);
        camera.lookAt(lookBase);

        const env = createEnvironment(scene);
        const aircraft = await loadAircraft(scene, MODEL_URL);
        if (disposed) {
          aircraft.dispose();
          env.dispose();
          renderer.dispose();
          return;
        }

        /* -- day/night state (driven by the `dark` class) -------------- */
        const tweenMs = reduced ? 450 : 2000;
        let dayNight = document.documentElement.classList.contains("dark") ? 1 : 0;
        let tweenFrom = dayNight;
        let tweenTo = dayNight;
        let tweenStart = -1;

        /* -- parallax state (gated) ------------------------------------- */
        let px = 0;
        let py = 0;
        let sy = 0;
        let targetX = 0;
        let targetY = 0;
        let targetS = 0;
        let heroHeight = wrap.offsetHeight || 1;
        onPointerMove = (e: PointerEvent) => {
          targetX = (e.clientX / window.innerWidth - 0.5) * 2;
          targetY = (e.clientY / window.innerHeight - 0.5) * 2;
        };
        onScroll = () => {
          targetS = Math.min(1, Math.max(0, window.scrollY / heroHeight));
        };

        /* -- sizing + adaptive pixel ratio -------------------------------- */
        const maxDpr = Math.min(window.devicePixelRatio || 1, 2);
        let dpr = maxDpr;
        const resize = () => {
          const w = wrap.clientWidth || 1;
          const h = wrap.clientHeight || 1;
          heroHeight = wrap.offsetHeight || 1;
          renderer.setPixelRatio(dpr);
          renderer.setSize(w, h, false);
          camera.aspect = w / h;
          // Portrait gets a wider frame: the airframe reads a size smaller
          // and sits in the gap between headline and subtitle.
          camera.fov = camera.aspect < 1 ? 54 : 42;
          camera.updateProjectionMatrix();
        };
        resizeObserver = new ResizeObserver(resize);
        resizeObserver.observe(wrap);
        resize();

        /* -- loop bookkeeping (declared before renderFrame) ---------------- */
        let inView = true;
        let last = 0;
        let elapsed = 0; // flight time (frozen under reduced motion)
        let emaMs = 16;
        let frames = 0;

        /* -- frame render --------------------------------------------------- */
        const renderFrame = (dt: number) => {
          if (tweenStart >= 0) {
            const k = Math.min(1, (performance.now() - tweenStart) / tweenMs);
            dayNight = THREE.MathUtils.lerp(tweenFrom, tweenTo, easeInOutCubic(k));
            if (k >= 1) tweenStart = -1;
          }

          if (parallaxOn) {
            px += (targetX - px) * 0.06;
            py += (targetY - py) * 0.06;
            sy += (targetS - sy) * 0.08;
            camera.position.set(camBase.x + px * 1.8, camBase.y - py * 1.0 - sy * 0.6, camBase.z);
            camera.lookAt(lookBase.x + px * 2.6, lookBase.y - py * 1.4, lookBase.z);
          } else {
            camera.position.copy(camBase);
            camera.lookAt(lookBase);
          }

          if (reduced) aircraft.setStaticPose();
          else {
            elapsed += dt;
            aircraft.setFlightPose(elapsed);
          }
          aircraft.update(reduced ? 0 : dt, dayNight);
          env.update(reduced ? 0 : dt, dayNight, performance.now() / 1000);
          renderer.render(scene, camera);
        };

        /* -- theme watcher -------------------------------------------------- */
        const onThemeChange = () => {
          const target = document.documentElement.classList.contains("dark") ? 1 : 0;
          if (target === tweenTo) return;
          tweenFrom = dayNight;
          tweenTo = target;
          if (reduced) {
            // No tween machinery: jump and render one frame.
            dayNight = target;
            renderFrame(0);
          } else {
            tweenStart = performance.now();
          }
        };
        themeObserver = new MutationObserver(onThemeChange);
        themeObserver.observe(document.documentElement, {
          attributes: true,
          attributeFilter: ["class"],
        });

        /* -- pause: hidden tab + hero off-screen ----------------------------- */
        stop = () => {
          if (raf) {
            cancelAnimationFrame(raf);
            raf = 0;
          }
        };
        const start = () => {
          if (raf || reduced) return;
          last = 0;
          raf = requestAnimationFrame(loop);
        };
        const loop = (now: number) => {
          raf = 0;
          if (document.hidden || !inView) return;
          const raw = last ? now - last : 16;
          last = now;
          renderFrame(Math.min(0.05, raw / 1000));

          // Adaptive quality: sustained slow frames -> lower the pixel ratio.
          emaMs = emaMs * 0.95 + raw * 0.05;
          if (++frames % 60 === 0 && emaMs > 45 && dpr > 1) {
            dpr = Math.max(1, dpr - 0.25);
            resize();
          }
          raf = requestAnimationFrame(loop);
        };

        viewObserver = new IntersectionObserver(
          (entries) => {
            inView = entries.some((e) => e.isIntersecting);
            if (!reduced) {
              if (inView && !document.hidden) start();
              else stop();
            }
          },
          { threshold: 0.02 },
        );
        viewObserver.observe(wrap);

        if (parallaxOn) {
          window.addEventListener("pointermove", onPointerMove, { passive: true });
          window.addEventListener("scroll", onScroll, { passive: true });
        }

        onVisibility = () => {
          if (document.hidden) stop();
          else start();
        };
        document.addEventListener("visibilitychange", onVisibility);

        onContextLost = (e: Event) => {
          e.preventDefault();
          stop();
          canvas.style.opacity = "0"; // the CSS fallback sky stays visible
        };
        canvas.addEventListener("webglcontextlost", onContextLost);

        /* -- first frame ------------------------------------------------------ */
        aircraft.setAnimated(!reduced);
        env.apply(dayNight);
        renderFrame(0);
        if (!disposed) setReady(true);
        start();

        disposeEngine = () => {
          aircraft.dispose();
          env.dispose();
          renderer.dispose();
        };
      } catch {
        // Model or engine failure: the CSS sky remains — never a blank hero.
      }
    })();

    return () => {
      disposed = true;
      stop();
      disposeEngine?.();
      themeObserver?.disconnect();
      resizeObserver?.disconnect();
      viewObserver?.disconnect();
      if (onVisibility) document.removeEventListener("visibilitychange", onVisibility);
      if (onContextLost) canvas.removeEventListener("webglcontextlost", onContextLost);
      if (parallaxOn) {
        if (onPointerMove) window.removeEventListener("pointermove", onPointerMove);
        if (onScroll) window.removeEventListener("scroll", onScroll);
      }
    };
  }, []);

  return (
    <div ref={wrapRef} className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
      <HeroFallbackSky />
      <canvas ref={canvasRef} className={`hero-flight-canvas${ready ? " is-ready" : ""}`} />
    </div>
  );
}
