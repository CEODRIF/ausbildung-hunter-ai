"use client";

/**
 * CV template selector. Each card renders the ACTUAL template renderer (the
 * same component the preview uses) inside a scaled container — no fake
 * screenshots.
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
import { useMemo } from "react";
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
                /* Gallery: true A4 ratio (794:1123 ≈ 1:1.414) that FILLS the
                   card width. The real 794px sheet is scaled with a
                   container-query unit (100cqi = box inline size), so the
                   preview stays exact and responsive at any card width. */
                <div
                  className="pointer-events-none w-full overflow-hidden border-b border-line bg-surface-2/60"
                  style={{
                    aspectRatio: "794 / 1123",
                    containerType: "inline-size",
                    direction: "ltr",
                  }}
                >
                  <div
                    style={{
                      width: CV_SHEET_WIDTH,
                      transform: "scale(calc(100cqi / 794px))",
                      transformOrigin: "top left",
                    }}
                  >
                    {node}
                  </div>
                </div>
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
