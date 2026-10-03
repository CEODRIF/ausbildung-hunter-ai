/**
 * Deckblatt A4 PREVIEW — responsive fit-to-width regression.
 *
 * Production bug: on a phone the A4 sheet was wider than the preview area and
 * clipped horizontally (left text/edges cut off), because the preview scale
 * was derived from `outer.clientWidth` — which INCLUDES the container's own
 * `p-4 sm:p-6` padding. The frame therefore ended up wider than the usable
 * content box and was clipped on BOTH sides at every viewport width.
 *
 * Headless-Chrome measurements of the shipped markup (boundingClientRect):
 *   320px: sheet 310.98px in a 286px area → 12.50px clipped left / 12.48 right
 *   375px: sheet 364.76px in a 341px area → 12.00px clipped left / 11.76 right
 *   430px: sheet 418.55px in a 396px area → 11.50px clipped left / 11.05 right
 *   1280px: sheet 1124.61px in a 1102px area → 11.50 left / 11.11 right
 * After the fix (same harness, same widths): 0.00px clipped on both sides,
 * the sheet fits the area and the viewport at 320 / 375 / 390 / 393 / 430 /
 * 768 / 1280, with the 1240:1754 ratio preserved exactly.
 *
 * The document itself is untouched: it still renders at 1240 × 1754 with the
 * same coordinates — only the presentation scale changes.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { availableSheetWidth, computePreviewScale, SHEET_PREVIEW_PADDING } from "@/lib/use-scaled-sheet";
import { DECKBLATT_HEIGHT, DECKBLATT_WIDTH } from "@/lib/deckblatt/styles";

const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), "utf8");

/** TOTAL horizontal padding of the preview container (both sides):
 *  `p-4` = 32px on phones, `sm:p-6` = 48px from 640px up. */
function deckblattPaddingInline(viewport: number): number {
  return viewport >= 640 ? 48 : 32;
}

/** The GlassCard is `.glass` = 1px border on each side, so the measured
 *  container's clientWidth is the viewport minus those borders. */
const CARD_BORDER = 2;

/**
 * The deckblatt preview chain: viewport → full-bleed card (1px borders) →
 * the measured container (`p-4 sm:p-6`, whose padding is NOT usable space).
 * At 375px this yields clientWidth 373 / available 341 — exactly the geometry
 * measured in headless Chrome.
 */
function deckblattScale(viewport: number, current = 1): number {
  const clientWidth = viewport - CARD_BORDER;
  const available = availableSheetWidth(clientWidth, deckblattPaddingInline(viewport));
  return computePreviewScale(available, DECKBLATT_WIDTH, current);
}

interface Geometry {
  available: number;
  scale: number;
  displayWidth: number;
  displayHeight: number;
  marginLeft: number;
  marginRight: number;
}

function geometry(viewport: number): Geometry {
  const available = availableSheetWidth(
    viewport - CARD_BORDER,
    deckblattPaddingInline(viewport),
  );
  const scale = computePreviewScale(available, DECKBLATT_WIDTH, 1);
  const displayWidth = DECKBLATT_WIDTH * scale;
  const displayHeight = DECKBLATT_HEIGHT * scale;
  const side = (available - displayWidth) / 2;
  return { available, scale, displayWidth, displayHeight, marginLeft: side, marginRight: side };
}

const PHONE_WIDTHS = [320, 375, 390, 393, 430] as const;
const ALL_WIDTHS = [...PHONE_WIDTHS, 768, 1024, 1280, 1440] as const;

describe("availableSheetWidth — the padding is not usable space", () => {
  it("subtracts the container's horizontal padding from clientWidth", () => {
    // 375px phone: clientWidth 375, p-4 → 341px usable.
    expect(availableSheetWidth(375, 32)).toBe(343);
    expect(availableSheetWidth(375, 32 - 2)).toBe(345);
    // desktop sm:p-6 → 48px
    expect(availableSheetWidth(660, 48)).toBe(612);
  });

  it("padding-free containers behave exactly like before (CV / cover letter)", () => {
    for (const width of ALL_WIDTHS) {
      expect(availableSheetWidth(width, 0)).toBe(width);
      expect(computePreviewScale(availableSheetWidth(width, 0), 794, 1)).toBe(
        computePreviewScale(width, 794, 1),
      );
    }
  });

  it("guards hidden / invalid input (never a negative or NaN width)", () => {
    expect(availableSheetWidth(0, 32)).toBe(0);
    expect(availableSheetWidth(-5, 32)).toBe(-5);
    expect(availableSheetWidth(NaN, 32)).toBeNaN();
    expect(availableSheetWidth(300, NaN)).toBe(300);
    expect(availableSheetWidth(300, -10)).toBe(300);
    // Padding larger than the box must not go negative.
    expect(availableSheetWidth(20, 40)).toBe(0);
  });
});

describe("mobile fit-to-width — complete A4 visible inside the preview area", () => {
  it.each(PHONE_WIDTHS)("viewport %i: displayWidth ≤ availableWidth, nothing clipped", (viewport) => {
    const g = geometry(viewport);
    expect(g.scale).toBeGreaterThan(0);
    expect(g.scale).toBeLessThan(1);
    // The scaled frame never exceeds the usable content box …
    expect(g.displayWidth).toBeLessThanOrEqual(g.available + 1e-9);
    // … nor the viewport itself.
    expect(g.displayWidth).toBeLessThanOrEqual(viewport);
    // … and both side margins exist (the sheet is centered, never cut off).
    expect(g.marginLeft).toBeGreaterThan(0);
    expect(g.marginRight).toBeGreaterThan(0);
  });

  it.each(PHONE_WIDTHS)("viewport %i: the A4 ratio is preserved exactly", (viewport) => {
    const g = geometry(viewport);
    // Uniform scale on both axes → identical ratio as the 1240×1754 document.
    expect(g.displayHeight / g.displayWidth).toBeCloseTo(DECKBLATT_HEIGHT / DECKBLATT_WIDTH, 12);
    expect(g.displayWidth / DECKBLATT_WIDTH).toBeCloseTo(g.scale, 12);
    expect(g.displayHeight / DECKBLATT_HEIGHT).toBeCloseTo(g.scale, 12);
    // 1240/1754 is the A4 ratio (within the px rounding of 210:297mm).
    expect(DECKBLATT_WIDTH / DECKBLATT_HEIGHT).toBeCloseTo(210 / 297, 3);
  });

  it.each(PHONE_WIDTHS)("viewport %i: the pre-fix measurement WOULD have clipped (regression guard)", (viewport) => {
    // The exact old behaviour: clientWidth (padding INCLUDED) was fed to the
    // scale, so the frame came out wider than the content box by
    // 2·padding − SHEET_PREVIEW_PADDING·scale.
    const clientWidth = viewport - CARD_BORDER;
    const oldDisplayWidth = DECKBLATT_WIDTH * computePreviewScale(clientWidth, DECKBLATT_WIDTH, 1);
    const realAvailable = availableSheetWidth(clientWidth, deckblattPaddingInline(viewport));
    expect(oldDisplayWidth).toBeGreaterThan(realAvailable);
    // ~11–12px clipped per side on a phone — exactly what production showed.
    const clippedPerSide = (oldDisplayWidth - realAvailable) / 2;
    expect(clippedPerSide).toBeGreaterThan(9);
    expect(clippedPerSide).toBeLessThan(13);
    // The corrected computation removes it entirely.
    expect(geometry(viewport).displayWidth).toBeLessThanOrEqual(realAvailable);
  });
});

describe("desktop — larger scale, still inside the preview column", () => {
  // lg grid: max-w-6xl (1152) = 460px form column + 32px gap + preview column.
  const previewColumn = 1152 - 460 - 32; // 660

  it("the frame never exceeds the preview column nor its content box", () => {
    const available = availableSheetWidth(
      previewColumn - CARD_BORDER,
      deckblattPaddingInline(1024),
    );
    const scale = computePreviewScale(available, DECKBLATT_WIDTH, 1);
    const displayWidth = DECKBLATT_WIDTH * scale;
    expect(displayWidth).toBeLessThanOrEqual(available + 1e-9);
    expect(displayWidth).toBeLessThanOrEqual(previewColumn);
    expect(displayWidth).toBeGreaterThan(500); // desktop really does scale up
    expect((DECKBLATT_HEIGHT * scale) / displayWidth).toBeCloseTo(
      DECKBLATT_HEIGHT / DECKBLATT_WIDTH,
      12,
    );
  });

  it("never upscales beyond the natural size (scale caps at 1)", () => {
    for (const viewport of [1024, 1280, 1440, 1920]) {
      // Even an absurdly wide column cannot push the sheet past 100%.
      expect(computePreviewScale(5000, DECKBLATT_WIDTH, 1)).toBe(1);
      expect(deckblattScale(viewport)).toBeLessThanOrEqual(1);
    }
    expect(computePreviewScale(1440, DECKBLATT_WIDTH, 0.4)).toBe(1);
  });

  it("keeps the fit when the container shrinks (rotation / resize)", () => {
    // A previously large scale must immediately shrink and keep fitting.
    const shrunk = deckblattScale(375, 1);
    expect(shrunk).toBeLessThan(deckblattScale(1280, 1));
    expect(DECKBLATT_WIDTH * shrunk).toBeLessThanOrEqual(
      availableSheetWidth(375 - CARD_BORDER, deckblattPaddingInline(375)),
    );
  });
});

describe("the scaling source of truth (hook) — padding-aware, no raw clientWidth", () => {
  const hook = read("../src/lib/use-scaled-sheet.ts");

  it("measures the available CONTENT width (padding subtracted)", () => {
    expect(hook).toContain("export function availableSheetWidth(");
    expect(hook).toContain(
      "availableSheetWidth(outer.clientWidth, horizontalPadding(outer))",
    );
    // The raw padded width must never be fed to the scale computation again.
    expect(hook).not.toMatch(/computePreviewScale\(\s*outer\.clientWidth/);
    expect(hook).toContain("getComputedStyle(element)");
  });

  it("keeps the shared slack constant and the single pure scale function", () => {
    expect(SHEET_PREVIEW_PADDING).toBe(28);
    expect(hook).toContain("export function computePreviewScale(");
    expect(hook).toContain("return Math.min(1, availableWidth / (sheetWidth + SHEET_PREVIEW_PADDING))");
  });
});

describe("deckblatt preview markup — tight, clipping, direction-pinned frame", () => {
  const generator = read("../src/components/deckblatt-generator.tsx");

  it("the measured container is the padded one, and it stays clip-guarded", () => {
    // Same element both measured and padded — its padding is subtracted by
    // the hook, so the frame still fits.
    expect(generator).toContain('ref={previewOuterRef}');
    expect(generator).toContain("flex w-full justify-center overflow-x-clip p-4 sm:p-6");
  });

  it("the frame reserves the SCALED dimensions (layout box, not just paint)", () => {
    expect(generator).toContain("width: Math.round(DECKBLATT_WIDTH * preview.scale),");
    expect(generator).toContain("height: Math.round(DECKBLATT_HEIGHT * preview.scale),");
    // Tight frame that clips and cannot be clamped to the 1240px min-content.
    expect(generator).toContain("relative overflow-hidden rounded-lg shadow-[var(--shadow-float)]");
    // Direction is pinned so an oversized block child can never anchor to the
    // container's right edge (the verified RTL failure mode).
    expect(generator).toContain('direction: "ltr",');
  });

  it("the sheet keeps its TRUE 1240px width and a uniform transform", () => {
    expect(generator).toContain("ref={previewSheetRef}");
    expect(generator).toContain("width: DECKBLATT_WIDTH,");
    expect(generator).toContain("transform: `scale(${preview.scale})`");
    expect(generator).toContain('transformOrigin: "top left"');
    // No width: 100% shortcut on the transformed sheet.
    expect(generator).not.toMatch(/ref=\{previewSheetRef\}[\s\S]{0,200}width: "100%"/);
  });

  it("the 1240×1754 document constants are untouched", () => {
    expect(DECKBLATT_WIDTH).toBe(1240);
    expect(DECKBLATT_HEIGHT).toBe(1754);
    const renderer = read("../src/lib/deckblatt/render.ts");
    expect(renderer).toContain("canvas.width = DECKBLATT_WIDTH;");
    expect(renderer).toContain("canvas.height = DECKBLATT_HEIGHT;");
  });
});

describe("mobile bottom navigation — the sheet's bottom stays reachable", () => {
  it("the preview column reserves bottom space on phones only", () => {
    const generator = read("../src/components/deckblatt-generator.tsx");
    expect(generator).toContain('className="min-w-0 pb-24 lg:pb-0"');
    // 96px of clearance under the preview column ≥ the fixed bar's height.
    expect(generator).toMatch(/pb-24 lg:pb-0/);
  });

  it("the shell keeps its own nav clearance and the mobile bar itself", () => {
    const shell = read("../src/components/app-shell.tsx");
    // <main class="flex-1 pb-28 lg:pb-0"> — the existing page-level clearance.
    expect(shell).toContain('className="flex-1 pb-28 lg:pb-0"');
    // The fixed bottom nav must still exist (not removed by this fix).
    expect(shell).toContain("fixed inset-x-3 bottom-3 z-30");
    expect(shell).toContain("lg:hidden");
  });

  it("the print/PDF path is not touched by the preview changes", () => {
    const globals = read("../src/app/globals.css");
    expect(globals).toContain(".deckblatt-print-root .deckblatt-sheet {");
    expect(globals).toContain("width: 210mm !important;");
    expect(globals).toContain("height: 297mm !important;");
    expect(globals).toContain("transform: scale(0.64) !important;");
  });
});
