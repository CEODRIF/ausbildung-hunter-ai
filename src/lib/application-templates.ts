/**
 * The composer's starting-point templates (Ausbildung / Arbeit / Praktikum).
 *
 * Extracted from application-composer.tsx so the pure content (and its
 * personalization variables) is testable without the client component.
 *
 * All three templates carry the smart variables from lib/personalization:
 *   {{greeting}}     – personalized per recipient (formal German; falls
 *                      back to "Sehr geehrte Damen und Herren,")
 *   {{company_name}} – personalized per recipient (falls back to
 *                      "Ihrem Unternehmen", which reads naturally after
 *                      "bei" in every subject and sentence below)
 *
 * Authoring rules baked into the content:
 *   - industry- and occupation-neutral (works for administration, IT,
 *     marketing, engineering, logistics, retail, hospitality, healthcare,
 *     manufacturing, …) — nothing is invented,
 *   - no bracket placeholders like [Position]/[Branche] and no token
 *     beyond the supported ones (an unresolved token would fail the
 *     per-recipient render validation),
 *   - applying a template only fills the EDITABLE draft — it never sends
 *     anything; the user reviews and edits before sending, as before.
 */

import { COMPANY_TOKEN, GREETING_TOKEN } from "@/lib/personalization";

export type TemplateGoal = "ausbildung" | "arbeit" | "praktikum";

export interface ApplicationTemplate {
  subject: string;
  body: string;
}

const SIGNATURE = "Mustapha Drif";

export const applicationTemplates: Record<TemplateGoal, ApplicationTemplate> =
  {
    ausbildung: {
      subject: `Bewerbung um einen Ausbildungsplatz bei ${COMPANY_TOKEN}`,
      body: [
        `<p>${GREETING_TOKEN}</p>`,
        `<p>hiermit bewerbe ich mich um einen Ausbildungsplatz bei ${COMPANY_TOKEN}. Ich möchte meine Kenntnisse erweitern, praktische Erfahrungen sammeln und mich fachlich weiterentwickeln.</p>`,
        `<p>Ich bin motiviert, mich engagiert in Ihr Team einzubringen, neue Aufgaben zuverlässig zu übernehmen und von erfahrenen Fachkräften zu lernen.</p>`,
        `<p>Über die Gelegenheit, meine Motivation in einem persönlichen Gespräch näher vorzustellen, freue ich mich sehr.</p>`,
        `<p>Mit freundlichen Grüßen</p>`,
        `<p>${SIGNATURE}</p>`,
      ].join(""),
    },
    arbeit: {
      subject: `Bewerbung bei ${COMPANY_TOKEN}`,
      body: [
        `<p>${GREETING_TOKEN}</p>`,
        `<p>hiermit bewerbe ich mich um eine passende berufliche Möglichkeit bei ${COMPANY_TOKEN}.</p>`,
        `<p>Ich möchte meine Kenntnisse und Fähigkeiten gezielt einsetzen, Ihr Team zuverlässig unterstützen und mich engagiert in die anfallenden Aufgaben einarbeiten. Dabei sind mir sorgfältiges Arbeiten, Eigeninitiative und eine konstruktive Zusammenarbeit wichtig.</p>`,
        `<p>Gerne erläutere ich Ihnen in einem persönlichen Gespräch, wie ich Ihr Unternehmen unterstützen kann.</p>`,
        `<p>Mit freundlichen Grüßen</p>`,
        `<p>${SIGNATURE}</p>`,
      ].join(""),
    },
    praktikum: {
      subject: `Bewerbung um ein Praktikum bei ${COMPANY_TOKEN}`,
      body: [
        `<p>${GREETING_TOKEN}</p>`,
        `<p>hiermit bewerbe ich mich um ein Praktikum bei ${COMPANY_TOKEN}.</p>`,
        `<p>Ich möchte praktische Einblicke in den Berufsalltag gewinnen, meine bisherigen Kenntnisse erweitern und neue Fähigkeiten entwickeln. Besonders wichtig ist mir, Arbeitsabläufe kennenzulernen, neue Aufgaben engagiert anzugehen und Ihr Team zuverlässig zu unterstützen.</p>`,
        `<p>Gerne erläutere ich Ihnen in einem persönlichen Gespräch meine Motivation und Interessen.</p>`,
        `<p>Mit freundlichen Grüßen</p>`,
        `<p>${SIGNATURE}</p>`,
      ].join(""),
    },
  };
