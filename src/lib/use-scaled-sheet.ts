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
 * Why the `active` re-measure exists (the iPhone bug):
 * On mobile the preview pane starts `display:none` (edit tab). While
 * hidden, `outer.clientWidth === 0`, and WebKit (iOS Safari) does not
 * reliably deliver a ResizeObserver entry when an element transitions
 * from display:none to visible — the element had no box to observe.
 * The scale then stayed stale and the 794px sheet rendered unscaled,
 * overflowing the phone viewport. The fix is a one-shot, deterministic
 * post-layout re-measure (double rAF = after layout, before paint)
 * whenever the preview tab becomes active. No polling, no timers, no
 * window visual-viewport APIs.
 */
import { useEffect, useState, type RefObject } from "react";

/** +28px of breathing room so the scaled sheet never touches the edges. */
export const SHEET_PREVIEW_PADDING = 28;

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
        computePreviewScale(outer.clientWidth, sheetWidth, prev),
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
