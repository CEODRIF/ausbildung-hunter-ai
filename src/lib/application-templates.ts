/**
 * The composer's starting-point templates (Ausbildung / Arbeit).
 *
 * Extracted from application-composer.tsx so the pure content (and its
 * personalization variables) is testable without the client component.
 *
 * Both templates carry the smart variables:
 *   {{greeting}}     – personalized per recipient (formal German)
 *   {{company_name}} – personalized per recipient (falls back to
 *                      "Ihrem Unternehmen", which reads naturally after
 *                      "bei" / "in")
 *
 * Applying a template only fills the editable draft — it NEVER sends
 * anything; the user reviews and edits before sending, as before.
 */

import { COMPANY_TOKEN, GREETING_TOKEN } from "@/lib/personalization";

export type TemplateGoal = "ausbildung" | "arbeit";

export interface ApplicationTemplate {
  subject: string;
  body: string;
}

export const applicationTemplates: Record<TemplateGoal, ApplicationTemplate> =
  {
    ausbildung: {
      subject: `Bewerbung um einen Ausbildungsplatz bei ${COMPANY_TOKEN}`,
      body: `<p>${GREETING_TOKEN}</p><p>hiermit bewerbe ich mich mit großem Interesse um einen Ausbildungsplatz bei ${COMPANY_TOKEN}.</p><p>Über die Gelegenheit zu einem persönlichen Gespräch freue ich mich sehr.</p><p>Mit freundlichen Grüßen</p>`,
    },
    arbeit: {
      subject: `Bewerbung um eine Position bei ${COMPANY_TOKEN}`,
      body: `<p>${GREETING_TOKEN}</p><p>mit großem Interesse bewerbe ich mich um eine Position bei ${COMPANY_TOKEN}.</p><p>Über die Gelegenheit zu einem persönlichen Gespräch freue ich mich sehr.</p><p>Mit freundlichen Grüßen</p>`,
    },
  };
