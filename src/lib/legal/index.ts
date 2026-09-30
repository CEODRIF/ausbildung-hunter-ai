import type { LegalDoc, LegalSlug } from "./types";
import { privacyDoc } from "./privacy";
import { termsDoc } from "./terms";
import { cookiesDoc } from "./cookies";
import { aiUsageDoc } from "./ai-usage";
import { dataDeletionDoc } from "./data-deletion";
import { contactDoc } from "./contact";

export type { Language } from "@/lib/i18n";
export type { LegalDoc, LegalSection, LegalSlug, T } from "./types";
export { PLACEHOLDERS } from "./types";
export { CONTACT_EMAIL } from "./contact";

/** Route of each legal page (kept in one place for links + footer). */
export const LEGAL_ROUTES: Record<LegalSlug, string> = {
  privacy: "/privacy",
  terms: "/terms",
  cookies: "/cookies",
  "ai-usage": "/ai-usage",
  "data-deletion": "/data-deletion",
  contact: "/contact",
};

/** All six legal documents, keyed by slug. */
export const LEGAL_DOCS: Record<LegalSlug, LegalDoc> = {
  privacy: privacyDoc,
  terms: termsDoc,
  cookies: cookiesDoc,
  "ai-usage": aiUsageDoc,
  "data-deletion": dataDeletionDoc,
  contact: contactDoc,
};

/** Display order for the footer + cross-links. */
export const LEGAL_ORDER: LegalSlug[] = [
  "privacy",
  "terms",
  "cookies",
  "ai-usage",
  "data-deletion",
  "contact",
];
