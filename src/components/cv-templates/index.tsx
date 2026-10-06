/**
 * CV template registry.
 *
 * One data model (CvDocument), four presentations. `renderCvTemplate` picks
 * the renderer by `cv.templateId` (absent/unknown → "classic", so every
 * legacy stored document keeps its original look). The preview and the print
 * portal both call this, so the exported PDF is always the selected template.
 */
import type { ReactNode } from "react";
import type { CvDocument, CvTemplateId } from "@/lib/templates/cv";
import { CV_TEMPLATE_IDS, resolveCvTemplateId } from "@/lib/templates/cv";
import type { CvLabels, TemplateProps } from "./shared";
import { ClassicCvTemplate } from "./classic-template";
import { ExecutiveCvTemplate } from "./executive-template";
import { ModernCvTemplate } from "./modern-template";
import { ProfessionalCvTemplate } from "./professional-template";

export const CV_TEMPLATE_LIST = CV_TEMPLATE_IDS;
export type { CvLabels, TemplateProps };
export { resolveCvTemplateId, type CvTemplateId };
export { CV_SHEET_WIDTH, CV_SHEET_MIN_HEIGHT } from "./shared";

/** i18n key of the template's display name (templates.template*). */
export const TEMPLATE_NAME_KEYS: Record<CvTemplateId, string> = {
  classic: "templates.templateClassic",
  executive: "templates.templateExecutive",
  modern: "templates.templateModern",
  professional: "templates.templateProfessional",
};

/** i18n key of the template's short description (templates.template*Desc). */
export const TEMPLATE_DESC_KEYS: Record<CvTemplateId, string> = {
  classic: "templates.templateClassicDesc",
  executive: "templates.templateExecutiveDesc",
  modern: "templates.templateModernDesc",
  professional: "templates.templateProfessionalDesc",
};

const RENDERERS: Record<CvTemplateId, (p: TemplateProps) => ReactNode> = {
  classic: ClassicCvTemplate,
  executive: ExecutiveCvTemplate,
  modern: ModernCvTemplate,
  professional: ProfessionalCvTemplate,
};

export function renderCvTemplate(
  templateId: CvTemplateId | null | undefined,
  cv: CvDocument,
  labels: CvLabels,
): ReactNode {
  const id = resolveCvTemplateId(templateId ?? cv.templateId);
  const Render = RENDERERS[id];
  return <Render cv={cv} labels={labels} />;
}

export {
  ClassicCvTemplate,
  ExecutiveCvTemplate,
  ModernCvTemplate,
  ProfessionalCvTemplate,
};
