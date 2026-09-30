import type { IconName } from "@/components/icon";
import type { Language } from "@/lib/i18n";

/**
 * FAQ data model.
 *
 * The whole FAQ is static, localized content (phase 1). Each item carries the
 * question + answer for ALL four supported languages plus a small set of
 * language-neutral search tokens, so a single source of truth guarantees
 * cross-language parity (every question exists in de/en/fr/ar).
 */

/** The 18 FAQ categories, in display order. */
export type CategoryId =
  | "general"
  | "account"
  | "search"
  | "saved"
  | "email-collector"
  | "excel-export"
  | "ai-search"
  | "ai-assistant"
  | "scanner"
  | "cv-templates"
  | "cover-letter"
  | "deckblatt"
  | "applications"
  | "email-sending"
  | "notifications"
  | "privacy"
  | "billing"
  | "technical";

/** A single question/answer entry. */
export interface FaqItem {
  /** Stable id, unique across the whole FAQ (accordion state + tests). */
  id: string;
  category: CategoryId;
  /** Localized question, keyed by language. */
  question: Record<Language, string>;
  /** Localized answer, keyed by language. */
  answer: Record<Language, string>;
  /**
   * Language-neutral search tokens (shared by all languages). Kept short and
   * technical (e.g. "pdf", "xlsx", "lebenslauf", "bewerbung") so a search that
   * does not literally appear in the localized text still matches.
   */
  keywords: string[];
}

/** A category with its localized display label + canonical icon. */
export interface FaqCategory {
  id: CategoryId;
  icon: IconName;
  label: Record<Language, string>;
}

export type { Language };
