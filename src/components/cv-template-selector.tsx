"use client";

/**
 * CV template selector. Each card renders the ACTUAL template renderer (the
 * same component the preview uses) inside a scaled container — no fake
 * screenshots.
 *
 * LARGE gallery scaling: the 794px A4 sheet is scaled by a factor MEASURED
 * from the card's actual rendered width (ResizeObserver → width / 794).
 * The original container-query-based scale did not resolve against the
 * card — the relative length unit fell back to the VIEWPORT width — so on
 * desktop the sheet rendered at viewport/794 ≈ 1.3–1.6× the card and
 * `overflow-hidden` clipped the right side, while mobile looked fine only
 * by coincidence (viewport ≈ card width). Measuring the container removes
 * the dependency on container-query resolution entirely.
 *
 * Two sizes share the same live-thumbnail pipeline:
 *  - "compact" (default): the dense 2/4-column row, previewing the USER's
 *    current CV data.
 *  - "large": the step-2 "Choose your template" gallery — large A4-ratio
 *    (794:1123 ≈ 1:1.414) previews that fill the card width. To show each
 *    design's complete visual identity, the gallery renders a dedicated
 *    DEMO document (`previewCv`) with reference-like content density —
 *    gallery-only data that is never written to the user's CV. Once a
 *    template is selected, the user's real document is used unchanged.
 *
 * Selecting a template only changes `cv.templateId` — the CV content and the
 * customization settings are untouched and persist with the document.
 */
import {
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { useI18n } from "@/lib/i18n";
import { Icon } from "@/components/icon";
import type { CvDocument, CvTemplateId } from "@/lib/templates/cv";
import {
  CV_SHEET_WIDTH,
  TEMPLATE_DESC_KEYS,
  TEMPLATE_NAME_KEYS,
  renderCvTemplate,
  type CvLabels,
} from "@/components/cv-templates";
import { CV_TEMPLATE_LIST } from "@/components/cv-templates";

/** Thumbnail boxes: A4 ratio (794:1123), fixed size → deterministic scale. */
const THUMB_W = 132;
const THUMB_H = Math.round((THUMB_W * 1123) / 794); // 187
const THUMB_SCALE = THUMB_W / CV_SHEET_WIDTH;

/**
 * Exact A4-fit scale for the LARGE gallery previews: the card's rendered
 * inline width divided by the 794px sheet width. Measured with a
 * ResizeObserver, so the scale stays exact through window resizes and the
 * 1-col ↔ 2-col grid breakpoint. Returns null until the first measurement
 * (SSR / pre-hydration) — the caller then renders at scale(0) inside the
 * aspect-ratio box, reserving height without ever overflowing.
 */
function useA4FitScale(boxRef: RefObject<HTMLDivElement | null>): number | null {
  const [scale, setScale] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const update = () => {
      const w = el.clientWidth;
      if (w > 0) setScale(w / CV_SHEET_WIDTH);
    };
    update();
    if (typeof ResizeObserver !== "undefined") {
      const ro = new ResizeObserver(update);
      ro.observe(el);
      return () => ro.disconnect();
    }
    // Fallback for engines without ResizeObserver:
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [boxRef]);
  return scale;
}

/** One large gallery preview: A4-ratio box + the real sheet scaled to fit
 *  the box width exactly (centered — the scaled sheet fills the box). */
function LargeA4Preview({ node }: { node: ReactNode }) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const scale = useA4FitScale(boxRef);
  return (
    <div
      ref={boxRef}
      className="pointer-events-none w-full overflow-hidden border-b border-line bg-surface-2/60"
      style={{ aspectRatio: "794 / 1123", direction: "ltr" }}
    >
      <div
        style={{
          width: CV_SHEET_WIDTH,
          transform: scale == null ? "scale(0)" : `scale(${scale})`,
          transformOrigin: "top left",
        }}
      >
        {node}
      </div>
    </div>
  );
}

export interface CvTemplateSelectorProps {
  cv: CvDocument;
  labels: CvLabels;
  selected: CvTemplateId;
  onSelect: (id: CvTemplateId) => void;
  /** "compact" = dense row (default); "large" = step-2 choice screen. */
  size?: "compact" | "large";
  /** Render the "CV Templates" heading (step-2 provides its own heading). */
  showTitle?: boolean;
  /**
   * Document used for the LARGE gallery previews (demo data). Compact size
   * and everything after selection always uses the real `cv`.
   */
  previewCv?: CvDocument;
}

export function CvTemplateSelector({
  cv,
  labels,
  selected,
  onSelect,
  size = "compact",
  showTitle = true,
  previewCv,
}: CvTemplateSelectorProps) {
  const { t } = useI18n();
  const large = size === "large";
  const thumbH = large ? undefined : THUMB_H;
  const thumbScale = large ? undefined : THUMB_SCALE;
  // The miniature renders the real renderer. Large gallery cards preview the
  // demo document (complete visual identity); compact cards preview the
  // user's own CV.
  const previewDoc = large && previewCv ? previewCv : cv;
  const thumbs = useMemo(
    () =>
      CV_TEMPLATE_LIST.map((id) => ({
        id,
        node: renderCvTemplate(id, previewDoc, labels),
      })),
    [previewDoc, labels],
  );

  return (
    <div>
      {showTitle && (
        <h3 className="mb-3 text-sm font-bold tracking-tight text-ink">
          {t("templates.templateSelectorTitle")}
        </h3>
      )}
      <div
        role="radiogroup"
        aria-label={t("templates.templateSelectorTitle")}
        className={
          large
            ? "grid grid-cols-1 gap-5 lg:grid-cols-2"
            : "grid grid-cols-2 gap-3 xl:grid-cols-4"
        }
      >
        {thumbs.map(({ id, node }) => {
          const isSel = id === selected;
          return (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={isSel}
              onClick={() => onSelect(id)}
              className={`group relative overflow-hidden rounded-2xl border text-left transition-all focus:outline-none focus-visible:ring-4 focus-visible:ring-accent/25 ${
                isSel
                  ? "border-accent shadow-[0_0_0_1.5px_var(--accent)]"
                  : "border-line hover:border-line-strong"
              }`}
            >
              {isSel && (
                <span className="absolute top-2 right-2 z-10 flex h-6 w-6 items-center justify-center rounded-full bg-accent text-white shadow">
                  <Icon name="check" size={13} strokeWidth={2.5} />
                </span>
              )}
              {/* Scaled live miniature (the actual renderer, demo/user data). */}
              {large ? (
                // A4-ratio box; the 794px sheet is scaled to EXACTLY the box
                // width — measured from the rendered card (see useA4FitScale),
                // preserving the document's true proportions at any size.
                <LargeA4Preview node={node} />
              ) : (
                <div
                  className="pointer-events-none overflow-hidden border-b border-line bg-surface-2/60"
                  style={{ height: thumbH, direction: "ltr" }}
                >
                  <div
                    className="mx-auto"
                    style={{
                      width: CV_SHEET_WIDTH,
                      transform: `scale(${thumbScale})`,
                      transformOrigin: "top center",
                    }}
                  >
                    {node}
                  </div>
                </div>
              )}
              <div className={`bg-surface ${large ? "px-4 py-3.5" : "px-3.5 py-3"}`}>
                <div
                  className={
                    large ? "text-sm font-bold text-ink" : "text-[13px] font-bold text-ink"
                  }
                >
                  {t(TEMPLATE_NAME_KEYS[id])}
                </div>
                <div
                  className={`mt-0.5 leading-4 text-muted ${
                    large ? "text-xs" : "text-[11px]"
                  }`}
                >
                  {t(TEMPLATE_DESC_KEYS[id])}
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
