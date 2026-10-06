/**
 * The CV document renderer — a thin dispatcher over the template registry.
 *
 * Every template lives in `./cv-templates/` and renders the SAME CvDocument
 * into the SAME A4 sheet. `CvDocument` picks the presentation by
 * `cv.templateId` (absent/unknown → "classic", so legacy stored documents
 * keep their original look).
 *
 * Used twice:
 *   1. live preview (right column, scaled to fit)
 *   2. print root (portal on <body>, rendered only in @media print)
 * so the exported PDF is the same document — and the same SELECTED
 * template — as the preview.
 *
 * The classic (original "Editorial Serif") renderer is preserved verbatim in
 * cv-templates/classic-template.tsx; its appearance is unchanged.
 */
import type { CvDocument as CvDocumentModel } from "@/lib/templates/cv";
import { resolveCvTemplateId } from "@/lib/templates/cv";
import {
  CV_SHEET_MIN_HEIGHT,
  CV_SHEET_WIDTH,
  renderCvTemplate,
  type CvLabels,
} from "./cv-templates";

export { CV_SHEET_MIN_HEIGHT, CV_SHEET_WIDTH };
export type { CvLabels };

interface Props {
  cv: CvDocumentModel;
  labels: CvLabels;
}

export function CvDocument({ cv, labels }: Props) {
  return renderCvTemplate(resolveCvTemplateId(cv.templateId), cv, labels);
}
