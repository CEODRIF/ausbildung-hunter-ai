/**
 * Deutsch Bibliothek — canonical book categories.
 *
 * Pure module (no React, no Supabase, no server imports) so it can be shared
 * by the admin form (client), the public page (server), the server actions
 * and the tests without leaking anything privileged into the browser graph.
 *
 * The DATABASE stores the canonical `slug` (ASCII, stable, URL-safe). The
 * display label is LOCALIZED through the i18n dictionary — `labelKey` points
 * at the `library.categories.*` block (German is the source of truth, as with
 * every other interface string). Adding a category = one entry here + the
 * four dictionary labels; no schema change is required (the table column is
 * length-constrained text by design).
 */

export interface BookCategory {
  slug: string;
  /** i18n key of the display label (library.categories.<slug>). */
  labelKey: string;
}

export const BOOK_CATEGORIES: readonly BookCategory[] = [
  { slug: "lehrbuch", labelKey: "library.categories.lehrbuch" },
  { slug: "grammatik", labelKey: "library.categories.grammatik" },
  { slug: "wortschatz", labelKey: "library.categories.wortschatz" },
  {
    slug: "pruefungsvorbereitung",
    labelKey: "library.categories.pruefungsvorbereitung",
  },
  { slug: "arbeitsbuch", labelKey: "library.categories.arbeitsbuch" },
  { slug: "hoeren", labelKey: "library.categories.hoeren" },
  { slug: "lesen", labelKey: "library.categories.lesen" },
  { slug: "sonstiges", labelKey: "library.categories.sonstiges" },
];

/** Canonical slug allowlist (server-side validation source). */
export const BOOK_CATEGORY_SLUGS: readonly string[] = BOOK_CATEGORIES.map(
  (category) => category.slug,
);

/** Type guard for an arbitrary input (formData values are unknown). */
export function isBookCategorySlug(value: unknown): value is string {
  return (
    typeof value === "string" && BOOK_CATEGORY_SLUGS.includes(value.trim())
  );
}

/** The label i18n key for a slug; null for unknown slugs. */
export function categoryLabelKey(slug: string): string | null {
  const found = BOOK_CATEGORIES.find((category) => category.slug === slug);
  return found ? found.labelKey : null;
}

/**
 * Display label for a stored slug: the localized text when the slug is
 * canonical, the slug itself otherwise (forward-compatibility — a category
 * added later is still shown, never blank, until its labels land).
 */
export function categoryLabel(
  slug: string,
  t: (key: string) => string,
): string {
  const key = categoryLabelKey(slug);
  return key ? t(key) : slug;
}
