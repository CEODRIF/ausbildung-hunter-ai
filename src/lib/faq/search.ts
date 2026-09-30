import type { CategoryId, FaqItem, Language } from "./types";

/**
 * Pure, deterministic FAQ search — no React, no DOM, unit-testable in Node.
 *
 * Search matches against the localized question, the localized answer, the
 * language-neutral keyword tokens, and the localized category label. Multiple
 * whitespace-separated terms must ALL match somewhere (precision); results
 * are ranked so a hit in the question outranks one in the answer/keywords.
 */

/** Normalize text for matching: lowercase, strip Latin diacritics, collapse space. */
export function normalizeQuery(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export interface FaqSearchOptions {
  items: FaqItem[];
  lang: Language;
  /** Raw search query (may be empty). */
  query: string;
  /** Active category filter, or "all". */
  category: CategoryId | "all";
  /** Localized category label resolver (so the label is searchable too). */
  categoryLabel: (id: CategoryId, lang: Language) => string;
}

export function searchFaq({
  items,
  lang,
  query,
  category,
  categoryLabel,
}: FaqSearchOptions): FaqItem[] {
  const pool =
    category === "all" ? items : items.filter((item) => item.category === category);

  const normalized = normalizeQuery(query);
  if (!normalized) return pool;

  const terms = normalized.split(" ").filter(Boolean);
  const scored: { item: FaqItem; score: number }[] = [];

  for (const item of pool) {
    const question = normalizeQuery(item.question[lang]);
    const answer = normalizeQuery(item.answer[lang]);
    const keywords = item.keywords.map(normalizeQuery).join(" ");
    const label = normalizeQuery(categoryLabel(item.category, lang));

    let score = 0;
    let allMatch = true;
    for (const term of terms) {
      let s = 0;
      if (question.includes(term)) s += 3;
      if (keywords.includes(term)) s += 2;
      if (label.includes(term)) s += 1;
      if (answer.includes(term)) s += 1;
      if (s === 0) {
        allMatch = false;
        break;
      }
      score += s;
    }
    if (allMatch) scored.push({ item, score });
  }

  scored.sort((a, b) => b.score - a.score || a.item.id.localeCompare(b.item.id));
  return scored.map((s) => s.item);
}
