import type { CategoryId, FaqItem, Language } from "./types";
import { CATEGORY_BY_ID } from "./categories";
import { generalItems } from "./items/general";
import { accountItems } from "./items/account";
import { searchItems } from "./items/search";
import { savedItems } from "./items/saved";
import { emailCollectorItems } from "./items/email-collector";
import { excelExportItems } from "./items/excel-export";
import { aiAssistantItems } from "./items/ai-assistant";
import { scannerItems } from "./items/scanner";
import { cvTemplatesItems } from "./items/cv-templates";
import { coverLetterItems } from "./items/cover-letter";
import { deckblattItems } from "./items/deckblatt";
import { applicationsItems } from "./items/applications";
import { emailSendingItems } from "./items/email-sending";
import { privacyItems } from "./items/privacy";
import { billingItems } from "./items/billing";
import { technicalItems } from "./items/technical";
import { searchFaq } from "./search";

export type { CategoryId, FaqCategory, FaqItem, Language } from "./types";
export { CATEGORIES, CATEGORY_BY_ID } from "./categories";
export { searchFaq, normalizeQuery } from "./search";

/**
 * All FAQ items, across the 17 categories, in display order. This is the
 * single source of truth: every item carries all four languages, so cross-
 * language parity is guaranteed by construction.
 */
export const ALL_ITEMS: FaqItem[] = [
  ...generalItems,
  ...accountItems,
  ...searchItems,
  ...savedItems,
  ...emailCollectorItems,
  ...excelExportItems,
  ...aiAssistantItems,
  ...scannerItems,
  ...cvTemplatesItems,
  ...coverLetterItems,
  ...deckblattItems,
  ...applicationsItems,
  ...emailSendingItems,
  ...privacyItems,
  ...billingItems,
  ...technicalItems,
];

/** Localized display label of a category. */
export function categoryLabel(id: CategoryId, lang: Language): string {
  return CATEGORY_BY_ID.get(id)?.label[lang] ?? id;
}

/** Items of a single category, in display order. */
export function itemsForCategory(id: CategoryId): FaqItem[] {
  return ALL_ITEMS.filter((item) => item.category === id);
}

export interface FaqQuery {
  query?: string;
  lang: Language;
  category?: CategoryId | "all";
}

/** Convenience wrapper: search across all (or one) category. */
export function search(query: FaqQuery): FaqItem[] {
  return searchFaq({
    items: ALL_ITEMS,
    lang: query.lang,
    query: query.query ?? "",
    category: query.category ?? "all",
    categoryLabel,
  });
}
