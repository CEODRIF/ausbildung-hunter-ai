"use client";

/**
 * Depth parallax for the landing hero.
 *
 * Writes three custom properties (--hero-px, --hero-py, --hero-sy) onto its
 * own element; every scene layer in HeroScene reads them with a per-layer
 * strength, so pointer and scroll motion travel through the sky at
 * different depths. A single rAF loop eases the values toward their target
 * and STOPS ITSELF the moment they settle — there is no continuous
 * JS-driven rendering (the continuous motion is pure CSS keyframes
 * elsewhere).
 *
 * Self-disables (zero JS, variables stay 0) when:
 *   - the device has no fine pointer (touch — the scene keeps CSS motion),
 *   - prefers-reduced-motion is set,
 *   - deviceMemory <= 2 (weak mobile GPUs),
 *   - the tab is hidden or the hero has scrolled out of view.
 */
import { useEffect, useRef, type ReactNode } from "react";

type MemoryWindow = Window & { deviceMemory?: number };

function isSupported(win: Window): boolean {
  if (!win.matchMedia("(pointer: fine)").matches) return false;
  if (win.matchMedia("(prefers-reduced-motion: reduce)").matches) return false;
  const memory = (win as MemoryWindow).deviceMemory;
  return memory === undefined || memory > 2;
}

export function HeroParallax({ children }: { children: ReactNode }) {
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root || !isSupported(window)) return;

    let raf: number | null = null;
    let visible = true;
    let heroHeight = root.offsetHeight || 1;

    let px = 0;
    let py = 0;
    let sy = 0;
    let targetX = 0;
    let targetY = 0;
    let targetScroll = 0;

    const write = () => {
      root.style.setProperty("--hero-px", px.toFixed(4));
      root.style.setProperty("--hero-py", py.toFixed(4));
      root.style.setProperty("--hero-sy", sy.toFixed(4));
    };

    const stop = () => {
      if (raf !== null) {
        cancelAnimationFrame(raf);
        raf = null;
      }
    };

    const step = () => {
      raf = null;
      if (document.hidden || !visible) return;
      px += (targetX - px) * 0.055;
      py += (targetY - py) * 0.055;
      sy += (targetScroll - sy) * 0.08;
      write();
      const settled =
        Math.abs(targetX - px) < 0.0008 &&
        Math.abs(targetY - py) < 0.0008 &&
        Math.abs(targetScroll - sy) < 0.0008;
      if (!settled) raf = requestAnimationFrame(step);
    };

    const kick = () => {
      if (raf !== null || document.hidden || !visible) return;
      raf = requestAnimationFrame(step);
    };

    const onPointerMove = (event: PointerEvent) => {
      targetX = (event.clientX / window.innerWidth - 0.5) * 2;
      targetY = (event.clientY / window.innerHeight - 0.5) * 2;
      kick();
    };

    const onScroll = () => {
      targetScroll = Math.min(1, Math.max(0, window.scrollY / heroHeight));
      kick();
    };

    const onVisibility = () => {
      stop();
      if (!document.hidden) kick();
    };

    const onResize = () => {
      heroHeight = root.offsetHeight || 1;
      onScroll();
    };

    const observer = new IntersectionObserver((entries) => {
      visible = entries.some((entry) => entry.isIntersecting);
      stop();
      kick();
    });

    observer.observe(root);
    window.addEventListener("pointermove", onPointerMove, { passive: true });
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onResize);
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      observer.disconnect();
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onResize);
      document.removeEventListener("visibilitychange", onVisibility);
      stop();
    };
  }, []);

  return (
    <div ref={rootRef} className="absolute inset-0" aria-hidden="true">
      {children}
    </div>
  );
}
