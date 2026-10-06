"use client";

/**
 * CV template selector — a row of four cards. Each card renders the ACTUAL
 * template renderer (the same component the preview uses) inside a scaled
 * container, so the miniature is a true preview of what the user will get —
 * with the user's CURRENT CV data (no hard-coded sample text, no screenshots).
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

/** Thumbnail box: A4 ratio (794:1123), fixed size → deterministic scale. */
const THUMB_W = 132;
const THUMB_H = Math.round((THUMB_W * 1123) / 794); // 187
const THUMB_SCALE = THUMB_W / CV_SHEET_WIDTH;

export interface CvTemplateSelectorProps {
  cv: CvDocument;
  labels: CvLabels;
  selected: CvTemplateId;
  onSelect: (id: CvTemplateId) => void;
}

export function CvTemplateSelector({ cv, labels, selected, onSelect }: CvTemplateSelectorProps) {
  const { t } = useI18n();
  // The miniature renders the real renderer with the user's current data.
  const thumbs = useMemo(
    () =>
      CV_TEMPLATE_LIST.map((id) => ({
        id,
        node: renderCvTemplate(id, cv, labels),
      })),
    [cv, labels],
  );

  return (
    <div>
      <h3 className="mb-3 text-sm font-bold tracking-tight text-ink">
        {t("templates.templateSelectorTitle")}
      </h3>
      <div
        role="radiogroup"
        aria-label={t("templates.templateSelectorTitle")}
        className="grid grid-cols-2 gap-3 xl:grid-cols-4"
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
              className={`group relative overflow-hidden rounded-2xl border text-left transition-all ${
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
              {/* Scaled live miniature (the actual renderer, current data). */}
              <div
                className="pointer-events-none overflow-hidden border-b border-line bg-surface-2/60"
                style={{ height: THUMB_H, direction: "ltr" }}
              >
                <div
                  className="mx-auto"
                  style={{
                    width: CV_SHEET_WIDTH,
                    transform: `scale(${THUMB_SCALE})`,
                    transformOrigin: "top center",
                  }}
                >
                  {node}
                </div>
              </div>
              <div className="bg-surface px-3.5 py-3">
                <div className="text-[13px] font-bold text-ink">
                  {t(TEMPLATE_NAME_KEYS[id])}
                </div>
                <div className="mt-0.5 text-[11px] leading-4 text-muted">
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
