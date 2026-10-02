/**
 * CV / cover-letter PREVIEW — mobile fit-to-screen invariants.
 *
 * The A4 sheet (794px = 210mm @ 96dpi) is scaled with a uniform
 * transform inside a frame sized to the scaled dimensions. The pure
 * computePreviewScale() is the single source of truth (shared by both
 * builders via useScaledSheet) — these tests pin the fit-to-width
 * guarantee on every phone width, the A4 ratio preservation, the
 * print/PDF path isolation, and the absence of forbidden JS workarounds.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { computePreviewScale } from "@/lib/use-scaled-sheet";

const read = (relative: string) =>
  readFileSync(new URL(relative, import.meta.url), "utf8");

const SHEET = 794; // 210mm @ 96dpi (CV & CL documents)

describe("computePreviewScale — fit-to-width (the core invariant)", () => {
  // Phone widths from the acceptance list.
  it.each([320, 375, 390, 393, 430])(
    "mobile %i: scaled sheet fits inside the viewport (no overflow, no zoom-out needed)",
    (viewport) => {
      const scale = computePreviewScale(viewport, SHEET, 1);
      expect(scale).toBeGreaterThan(0);
      expect(scale).toBeLessThan(1);
      // The scaled sheet must never exceed the available width.
      expect(SHEET * scale).toBeLessThanOrEqual(viewport);
    },
  );

  it("desktop: no upscaling — scale caps at 1", () => {
    // 768px (tablet portrait) still fits with headroom < 100%.
    expect(computePreviewScale(768, SHEET, 1)).toBeLessThan(1);
    // 1024px and up: the sheet renders at its natural size (desktop unchanged).
    expect(computePreviewScale(1024, SHEET, 1)).toBe(1);
    expect(computePreviewScale(1440, SHEET, 1)).toBe(1);
    // A previously small scale must never jump above 1.
    expect(computePreviewScale(1440, SHEET, 0.4)).toBe(1);
  });

  it("hidden / not-yet-laid-out container (width 0 or NaN) keeps the last scale — never collapses to 0", () => {
    expect(computePreviewScale(0, SHEET, 0.4355)).toBe(0.4355);
    expect(computePreviewScale(-5, SHEET, 1)).toBe(1);
    expect(computePreviewScale(NaN, SHEET, 0.9)).toBe(0.9);
    // Invalid sheet width is a hard guard, not a divide-by-zero.
    expect(computePreviewScale(390, 0, 1)).toBe(1);
    expect(computePreviewScale(390, -1, 1)).toBe(1);
  });
});

describe("A4 ratio preservation (210:297) — uniform scaling only", () => {
  it.each([
    [1123], // exactly one A4 page
    [1500], // a long CV (multi-page)
    [2357], // a very long cover letter
  ] as const)(
    "frame stays proportional to the sheet at every phone width (sheet height %i)",
    (sheetHeight) => {
      for (const viewport of [320, 375, 390, 393, 430]) {
        const scale = computePreviewScale(viewport, SHEET, 1);
        const frameW = SHEET * scale;
        const frameH = sheetHeight * scale;
        // Same ratio as the real document → no stretching, no distortion.
        expect(frameW / frameH).toBeCloseTo(SHEET / sheetHeight, 10);
        // Uniform scale on both axes.
        expect(frameW / SHEET).toBeCloseTo(scale, 10);
        expect(frameH / sheetHeight).toBeCloseTo(scale, 10);
      }
    },
  );

  it("the 794/1123px sheet matches the 210:297 A4 ratio (96dpi rounding)", () => {
    // 210mm = 793.7px → 794; 297mm = 1122.5px → 1123, so the px pair
    // deviates from the exact mm ratio by < 4e-5.
    expect(SHEET / 1123).toBeCloseTo(210 / 297, 3);
  });
});

describe("shared rule — one implementation for CV and cover letter", () => {
  const cv = read("../src/components/cv-builder.tsx");
  const cl = read("../src/components/cover-letter-builder.tsx");

  it("both builders import the shared hook (no local duplicate)", () => {
    expect(cv).toContain('import { useScaledSheet } from "@/lib/use-scaled-sheet"');
    expect(cl).toContain('import { useScaledSheet } from "@/lib/use-scaled-sheet"');
    expect(cv).not.toContain("function useScaledSheet");
    expect(cl).not.toContain("function useScaledSheet");
  });

  it("both pass the mobile preview tab as `active` (the deterministic re-measure trigger)", () => {
    expect(cv).toContain("active: mobileView === \"preview\"");
    expect(cl).toContain("active: mobileView === \"preview\"");
  });

  it("both keep the uniform transform scaling with top-left origin", () => {
    for (const src of [cv, cl]) {
      expect(src).toContain("transform: `scale(${preview.scale})`");
      expect(src).toContain('transformOrigin: "top left"');
      // Frame sized to the scaled dimensions (fit-to-width container).
      expect(src).toMatch(/width: (CV|CL)_SHEET_WIDTH \* preview\.scale/);
      expect(src).toMatch(/height: preview\.sheetHeight \* preview\.scale/);
    }
  });

  it("edit mode is untouched (same tab toggle pattern)", () => {
    expect(cv).toContain('mobileView === "edit" ? "" : "hidden lg:block"');
    expect(cv).toContain("templates.tabEdit");
    expect(cv).toContain("templates.tabPreview");
    expect(cl).toContain('mobileView === "edit" ? "" : "hidden lg:block"');
    expect(cl).toContain("coverLetter.tabEdit");
    expect(cl).toContain("coverLetter.tabPreview");
  });
});

describe("PDF / print path isolation (download unchanged)", () => {
  const globals = read("../src/app/globals.css");
  const cv = read("../src/components/cv-builder.tsx");
  const cl = read("../src/components/cover-letter-builder.tsx");
  const cvDoc = read("../src/components/cv-document.tsx");
  const clDoc = read("../src/components/cover-letter-document.tsx");

  it("print CSS still uses real A4 millimeters", () => {
    expect(globals).toContain("size: A4");
    expect(globals).toContain("width: 210mm !important");
  });

  it("both builders keep their dedicated print portals (separate from the preview scale)", () => {
    expect(cv).toContain('className="cv-print-root"');
    expect(cl).toContain('className="cl-print-root"');
    expect(cv).toContain("createPortal(");
    expect(cl).toContain("createPortal(");
  });

  it("document constants are still the true A4 @ 96dpi", () => {
    expect(cvDoc).toContain("CV_SHEET_WIDTH = 794");
    expect(cvDoc).toContain("CV_SHEET_MIN_HEIGHT = 1123");
    expect(clDoc).toContain("CL_SHEET_WIDTH = 794");
    expect(clDoc).toContain("CL_SHEET_MIN_HEIGHT = 1123");
  });
});

describe("no forbidden workarounds (regression guard)", () => {
  const hook = read("../src/lib/use-scaled-sheet.ts");

  it("no polling, no timers, no visualViewport — one deterministic rAF pair", () => {
    expect(hook).not.toContain("setInterval");
    expect(hook).not.toContain("setTimeout");
    expect(hook).not.toContain("visualViewport");
    expect(hook).not.toContain("innerWidth");
    expect(hook).not.toMatch(/new Promise\([^)]*=>\s*setTimeout\(/);
  });

  it("every listener/observer is cleaned up on unmount / re-measure", () => {
    expect(hook).toContain("observer.disconnect()");
    expect(hook).toContain("cancelAnimationFrame(raf1)");
    expect(hook).toContain("cancelAnimationFrame(raf2)");
    // Exactly one ResizeObserver per effect run (no duplicates).
    expect(hook.match(/new ResizeObserver/g)?.length).toBe(1);
    expect(hook.match(/requestAnimationFrame/g)?.length).toBe(2);
  });
});
