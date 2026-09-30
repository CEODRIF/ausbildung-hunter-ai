import type { Language } from "@/lib/i18n";

/**
 * Legal content model.
 *
 * All legal pages ship as static, fully-localized content (de/en/fr/ar) in
 * src/lib/legal/*. Content is grounded in the verified platform behavior:
 * no invented legal entity, no invented retention periods, no unproven
 * security or compliance claims. Deliberately missing legal facts are
 * marked with explicit, visible placeholders (e.g. [LEGAL ENTITY NAME])
 * that the platform owner must replace.
 */

/** A string in all four supported languages. */
export type T = Record<Language, string>;

/** One section of a legal document. */
export interface LegalSection {
  /** Anchor id (used by the table of contents). */
  id: string;
  /** Section heading (h2). */
  title: T;
  /** Paragraphs (optional), rendered before the list. */
  p?: T[];
  /** Bullet list items (optional). */
  li?: T[];
  /** Paragraphs rendered after the list (optional). */
  pAfter?: T[];
  /** Optional call-to-action link rendered at the end of the section. */
  to?: string;
  toLabel?: T;
}

/** A full legal document (one page). */
export interface LegalDoc {
  slug: LegalSlug;
  /** Page title (h1) + document intro paragraph. */
  title: T;
  intro: T;
  sections: LegalSection[];
  /** Real contact email rendered as a mailto card (Contact page only). */
  contactEmail?: string;
}

export type LegalSlug =
  | "privacy"
  | "terms"
  | "cookies"
  | "ai-usage"
  | "data-deletion"
  | "contact";

/** Placeholders that MUST be replaced by the platform owner. */
export const PLACEHOLDERS = {
  LEGAL_ENTITY: "[LEGAL ENTITY NAME]",
  BUSINESS_ADDRESS: "[BUSINESS ADDRESS]",
} as const;
