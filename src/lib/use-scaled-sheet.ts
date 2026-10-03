"use client";

/**
 * Shared A4-sheet preview scaling for the CV and cover-letter builders.
 *
 * The document renders at its true 794px (210mm @ 96dpi) width and is
 * scaled with a uniform `transform: scale()` — so the A4 210:297 ratio
 * is always preserved and nothing is stretched or cropped. The frame
 * around the sheet is sized to the SCALED dimensions, so the preview
 * never exceeds the available width (fit-to-width on phones).
 *
 * The scale is derived from the AVAILABLE CONTENT width — `clientWidth`
 * minus the container's own horizontal padding (see availableSheetWidth).
 * Using the raw clientWidth over-sized the frame by the padding and clipped
 * the sheet on both sides (the Deckblatt preview bug).
 *
 * Note: this hook is responsible for SCALE only (fit-to-width). The
 * POSITION of the sheet is owned by the markup: the frame (containing
 * block) must be `direction: ltr` — in an RTL app an oversized block
 * child anchors to the container's right edge, which pushes the
 * top-left-anchored transform off-screen (verified via headless-Chrome
 * boundingClientRect measurements; see tests/preview-scaling.test.ts).
 *
 * Why the `active` re-measure exists:
 * On mobile the preview pane starts `display:none` (edit tab) with
 * `clientWidth === 0`, and WebKit does not always deliver a
 * ResizeObserver entry for the display:none → visible transition
 * (the element had no box to observe). A one-shot, deterministic
 * post-layout re-measure (double rAF = after layout, before paint) on
 * activation removes the dependence on that delivery. No polling, no
 * timers, no window visual-viewport APIs.
 */
import { useEffect, useState, type RefObject } from "react";

/** +28px of breathing room so the scaled sheet never touches the edges. */
export const SHEET_PREVIEW_PADDING = 28;

/**
 * The width the scaled sheet may actually occupy.
 *
 * `clientWidth` INCLUDES the element's own horizontal padding, but padding
 * is not usable space: a padded container (the Deckblatt preview uses
 * `p-4 sm:p-6`) sized its frame from the padded width, so the frame came
 * out wider than the content box and the A4 sheet was clipped on BOTH
 * sides at every viewport width (headless-Chrome measurement: ~12px left +
 * ~12px right on 320–1280px, the sheet never fully visible).
 *
 * Subtracting the padding makes the frame fit the real content box. For
 * padding-free containers (the CV / cover-letter preview) the result is
 * byte-identical to the raw clientWidth, so their behaviour is unchanged.
 */
export function availableSheetWidth(clientWidth: number, paddingInline: number): number {
  if (!Number.isFinite(clientWidth) || clientWidth <= 0) return clientWidth;
  const padding = Number.isFinite(paddingInline) && paddingInline > 0 ? paddingInline : 0;
  return Math.max(0, clientWidth - padding);
}

/** Horizontal padding of an element, from its computed style. */
function horizontalPadding(element: HTMLElement): number {
  const styles = getComputedStyle(element);
  return (parseFloat(styles.paddingLeft) || 0) + (parseFloat(styles.paddingRight) || 0);
}

/** Pure scale computation — unit-testable without a DOM.
 *  Returns the previous scale when no width is measurable (hidden /
 *  not laid out yet) instead of collapsing to 0. */
export function computePreviewScale(
  availableWidth: number,
  sheetWidth: number,
  current: number,
): number {
  if (!Number.isFinite(availableWidth) || availableWidth <= 0) return current;
  if (!Number.isFinite(sheetWidth) || sheetWidth <= 0) return 1;
  return Math.min(1, availableWidth / (sheetWidth + SHEET_PREVIEW_PADDING));
}

export interface ScaledSheetOptions {
  /** True sheet width in px (210mm @ 96dpi). */
  sheetWidth: number;
  /** Minimum sheet height in px (297mm @ 96dpi). */
  sheetMinHeight: number;
  /** Preview tab active (mobile) — triggers the post-layout re-measure. */
  active: boolean;
}

export function useScaledSheet(
  outerRef: RefObject<HTMLElement | null>,
  sheetRef: RefObject<HTMLElement | null>,
  { sheetWidth, sheetMinHeight, active }: ScaledSheetOptions,
) {
  const [scale, setScale] = useState(1);
  const [sheetHeight, setSheetHeight] = useState(sheetMinHeight);

  useEffect(() => {
    const outer = outerRef.current;
    const sheet = sheetRef.current;
    if (!outer || !sheet) return;

    const update = () => {
      setScale((prev) =>
        computePreviewScale(
          availableSheetWidth(outer.clientWidth, horizontalPadding(outer)),
          sheetWidth,
          prev,
        ),
      );
      setSheetHeight((prev) =>
        Math.max(sheet.offsetHeight || prev, sheetMinHeight),
      );
    };

    update();
    const observer = new ResizeObserver(update);
    observer.observe(outer);
    observer.observe(sheet);

    // One-shot deterministic re-measure after the browser has laid out
    // the (possibly just-unhidden) subtree: rAF #1 runs after layout is
    // resolved, rAF #2 after the resulting style pass — then update().
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(update);
    });

    return () => {
      observer.disconnect();
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, [outerRef, sheetRef, sheetWidth, sheetMinHeight, active]);

  return { scale, sheetHeight };
}
