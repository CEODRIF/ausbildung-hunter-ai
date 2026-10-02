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

describe("visual positioning — sheet centered in the container (not just the math)", () => {
  const cv = read("../src/components/cv-builder.tsx");
  const cl = read("../src/components/cover-letter-builder.tsx");
  const globals = read("../src/app/globals.css");

  // The complete preview subtree: outer → centering layer → frame → sheet.
  const previewBlock = (src: string) =>
    src.match(/<div ref=\{previewOuterRef\}[\s\S]*?<\/div>\s*<\/div>\s*<\/div>\s*<\/div>/)
      ?.[0] ?? "";

  it.each([
    ["CV", cv],
    ["Cover Letter", cl],
  ])("%s: centering is a flex inline-axis center — direction independent", (name, src) => {
    const block = previewBlock(src);
    expect(block).not.toBe("");
    // Flex `justify-center` centers along the INLINE axis: the result is
    // geometrically identical in LTR and RTL (no margin-based centering).
    expect(block).toContain("flex w-full justify-center");
    expect(block).not.toContain("mx-auto");
    expect(block).not.toContain(":dir(");
    expect(block).not.toContain("rtl:");
  });

  it.each([
    ["CV", cv],
    ["Cover Letter", cl],
  ])("%s: no directional offsets anywhere in the preview subtree", (name, src) => {
    const block = previewBlock(src);
    // No left/right positioning, no directional margins, no translate
    // compensation — the position comes from the container geometry.
    expect(block).not.toMatch(/(^|[^a-z-])left\s*:/);
    expect(block).not.toMatch(/(^|[^a-z-])right\s*:/);
    expect(block).not.toContain("margin-left");
    expect(block).not.toContain("margin-right");
    expect(block).not.toContain("translateX");
    expect(block).not.toMatch(/\bml-\d/);
    expect(block).not.toMatch(/\bmr-\d/);
    expect(block).not.toMatch(/\bms-\d/);
    expect(block).not.toMatch(/\bme-\d/);
  });

  it.each([
    ["CV", cv, "CV_SHEET_WIDTH"],
    ["Cover Letter", cl, "CL_SHEET_WIDTH"],
  ])(
    "%s: visual box === frame box (tight frame + origin top-left), frame centered ⇒ sheet centered",
    (name, src, widthConst) => {
      const block = previewBlock(src);
      // Sheet keeps its TRUE layout width (transform only scales the paint).
      expect(block).toMatch(new RegExp(`width: ${widthConst},`));
      expect(block).toContain("transform: `scale(${preview.scale})`");
      // Origin top-left inside the TIGHT frame (frame width =
      // SHEET_WIDTH * scale) makes the sheet's painted box coincide with
      // the frame box exactly — so the flex-centered frame IS the
      // centered sheet. (top-center would shift the painted box right
      // by 397*(1-scale) and be clipped by the frame.)
      expect(block).toContain('transformOrigin: "top left"');
      // Frame is tight (scaled dims), never full-width with inner offset.
      expect(block).toMatch(new RegExp(`width: ${widthConst} \\* preview\\.scale`));
      expect(block).toContain("height: preview.sheetHeight * preview.scale");
      expect(block).toContain("overflow-hidden");
    },
  );

  it("the FRAME (containing block) is direction: ltr — the verified RTL fix", () => {
    // Headless-Chrome boundingClientRect measurements proved: with an
    // RTL app, the 794px sheet (block child of the tight scaled frame)
    // anchors to the frame's RIGHT edge → layout box at
    // frame.right − 794 (e.g. x=−318 on a 390px phone) → the physical
    // `transform-origin: top left` scaled it 318px off-screen, leaving
    // only a thin strip inside the frame's clip. The parent's direction
    // governs child placement (the sheet's OWN direction does not), so
    // the fix is `direction: "ltr"` on the frame itself. Document
    // content keeps its own dir (cv-sheet / cover letter are dir="ltr").
    for (const src of [cv, cl]) {
      const block = previewBlock(src);
      expect(block).toContain('direction: "ltr"');
    }
  });

  it("outer still clip-guards the 1-frame pre-scale flash (no page scroll state)", () => {
    for (const src of [cv, cl]) {
      expect(src).toContain('ref={previewOuterRef} className="w-full overflow-x-clip"');
    }
  });

  it("no global page-level overflow hacks (fix must live in the preview geometry)", () => {
    // The earlier `html { overflow-x: clip }` attempt was reverted: the
    // headless measurements showed off-screen fixed drawers do NOT
    // extend WebKit page scrollable overflow, so a global clip would
    // have been an unexplained side effect on every page.
    const htmlRule = globals.match(/html\s*\{[^}]*\}/)?.[0] ?? "";
    expect(htmlRule).not.toContain("overflow-x");
  });

  it("final geometry fits on every phone width (no horizontal overflow by construction)", () => {
    for (const viewport of [320, 375, 390, 393, 430]) {
      const scale = computePreviewScale(viewport, SHEET, 1);
      const frame = SHEET * scale;
      // Frame ≤ available width, and the centered frame leaves equal
      // (≥ 0) margins on BOTH sides — the "empty strip on one side"
      // state is impossible.
      expect(frame).toBeLessThanOrEqual(viewport);
      const side = (viewport - frame) / 2;
      expect(side).toBeGreaterThanOrEqual(0);
    }
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
