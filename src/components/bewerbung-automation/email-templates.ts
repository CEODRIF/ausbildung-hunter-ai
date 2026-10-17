/**
 * Bewerbung Automation — ready-made GERMAN e-mail message templates.
 *
 * These fill the CAMPAIGN-LEVEL e-mail (subject + body) — the short message
 * that carries the CV, the certificates and the recipient-specific
 * Anschreiben PDF. They are deliberately NOT the full cover letter:
 * the letter lives in the PDF attachment, the e-mail says "here it is".
 *
 * Authoring rules (same contract as the composer templates):
 *   - only the stable lib/personalization tokens — never invented
 *     placeholders (a token that cannot render would fail validation),
 *   - industry/occupation-neutral, nothing is invented,
 *   - applying a template only fills the editable draft — it NEVER sends
 *     anything and NEVER touches the per-company Anschreiben (or its PDF).
 */
import {
  CANDIDATE_TOKEN,
  COMPANY_TOKEN,
  GREETING_TOKEN,
} from "@/lib/personalization";
import type { BewPurpose } from "@/lib/bewerbung-automation";

export interface BewEmailTemplate {
  purpose: BewPurpose;
  subject: string;
  bodyHtml: string;
}

const CLOSING = [
  `<p>Mit freundlichen Grüßen</p>`,
  `<p>${CANDIDATE_TOKEN}</p>`,
].join("");

const ATTACHMENT_LINE =
  `<p>Meine vollständigen Bewerbungsunterlagen (Lebenslauf, Zeugnisse und mein Anschreiben für ${COMPANY_TOKEN}) finden Sie im Anhang.</p>`;

export const bewEmailTemplates: Record<BewPurpose, BewEmailTemplate> = {
  ausbildung: {
    purpose: "ausbildung",
    subject: `Bewerbung um einen Ausbildungsplatz bei ${COMPANY_TOKEN}`,
    bodyHtml: [
      `<p>${GREETING_TOKEN}</p>`,
      `<p>hiermit bewerbe ich mich um einen Ausbildungsplatz bei ${COMPANY_TOKEN}.</p>`,
      ATTACHMENT_LINE,
      `<p>Über die Gelegenheit, mich und meine Motivation in einem persönlichen Gespräch vorzustellen, freue ich mich sehr.</p>`,
      CLOSING,
    ].join(""),
  },
  arbeit: {
    purpose: "arbeit",
    subject: `Bewerbung bei ${COMPANY_TOKEN}`,
    bodyHtml: [
      `<p>${GREETING_TOKEN}</p>`,
      `<p>hiermit bewerbe ich mich um eine passende berufliche Möglichkeit bei ${COMPANY_TOKEN}.</p>`,
      ATTACHMENT_LINE,
      `<p>Gerne erläutere ich Ihnen in einem persönlichen Gespräch, wie ich Ihr Team unterstützen kann.</p>`,
      CLOSING,
    ].join(""),
  },
  praktikum: {
    purpose: "praktikum",
    subject: `Bewerbung um ein Praktikum bei ${COMPANY_TOKEN}`,
    bodyHtml: [
      `<p>${GREETING_TOKEN}</p>`,
      `<p>hiermit bewerbe ich mich um ein Praktikum bei ${COMPANY_TOKEN}.</p>`,
      ATTACHMENT_LINE,
      `<p>Gerne erläutere ich Ihnen in einem persönlichen Gespräch meine Motivation und meine Interessen.</p>`,
      CLOSING,
    ].join(""),
  },
};

export function bewEmailTemplateFor(purpose: string): BewEmailTemplate | null {
  return bewEmailTemplates[(purpose as BewPurpose)] ?? null;
}
