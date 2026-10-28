"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { useI18n } from "@/lib/i18n";
import { BOOK_CATEGORIES, isBookCategorySlug } from "@/lib/book-categories";
import { Button } from "@/components/ui";
import { Icon } from "@/components/icon";

/**
 * Deutsch Bibliothek — search + category filter form (client).
 *
 * WHY A CLIENT FORM (2026-10 fix): the original markup was a native
 * `<form method="GET" action="/bibliothek">` inside the server component,
 * so every submit was a FULL page navigation — shell, covers and the
 * viewport state were torn down and re-fetched. This component intercepts
 * the submit (preventDefault) and performs a Next.js App-Router SOFT
 * navigation instead:
 *
 *   - no full page reload — only the /bibliothek segment re-renders;
 *   - the URL still carries `q` / `cat` / `page` (deep links, back/forward
 *     and sharing keep working — the server-rendered page is unchanged);
 *   - the section's `loading.tsx` boundary is the loading state while the
 *     real (server-side, asynchronous) search runs; there is deliberately
 *     NO spinner for local state updates;
 *   - the input is controlled: typing stays responsive and the value is
 *     preserved across the navigation (re-synced with the server-rendered
 *     criteria, so back/forward and the "clear search" link can never
 *     desync it from the URL);
 *   - the Search button (type="submit", inside the form) and Enter in the
 *     input trigger the SAME submit path;
 *   - the button is disabled while the navigation is in flight (guarded by
 *     the `router.push` promise, not by useTransition — the push promise
 *     settles exactly when the soft navigation completes) → no duplicate
 *     submissions and no redundant requests;
 *   - submitting resets the page index to 1 (a new criteria set always
 *     starts on the first page).
 *
 * The server remains the single source of truth: filtering happens in
 * `listPublishedBooks` (published-only, RLS-bound); this component only
 * builds the query string and navigates. It never renders book data.
 */
export function LibrarySearchForm({
  search,
  category,
}: {
  /** Active title query from the URL (trimmed) or null. */
  search: string | null;
  /** Active category slug from the URL or null. */
  category: string | null;
}) {
  const { t } = useI18n();
  const router = useRouter();
  const [searchValue, setSearchValue] = useState(search ?? "");
  const [categoryValue, setCategoryValue] = useState(category ?? "");
  // A navigation is in flight while router.push has not settled. Local
  // state (not useTransition): the push promise settles exactly when the
  // soft navigation completes, which is the window that must block a
  // duplicate submit.
  const [isPending, setIsPending] = useState(false);

  // The server-rendered criteria are the URL's truth. Whenever a
  // navigation changes them (back/forward, the "clear search" link, an
  // external deep link), resync the inputs DURING RENDER (React's
  // "adjusting state when a prop changes" pattern — no effect, no
  // cascading render) so the form can never disagree with the results on
  // screen.
  const [prevSearch, setPrevSearch] = useState(search);
  const [prevCategory, setPrevCategory] = useState(category);
  if (prevSearch !== search || prevCategory !== category) {
    setPrevSearch(search);
    setPrevCategory(category);
    setSearchValue(search ?? "");
    setCategoryValue(category ?? "");
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); // never a native GET → never a full page reload
    if (isPending) return; // one navigation at a time (duplicate guard)
    const q = searchValue.trim();
    const cat = isBookCategorySlug(categoryValue) ? categoryValue : "";
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (cat) params.set("cat", cat);
    // NOTE: no `page` param — a changed criteria set always starts at 1.
    const qs = params.toString();
    const href = qs ? `/bibliothek?${qs}` : "/bibliothek";
    setIsPending(true);
    const release = () => setIsPending(false);
    Promise.resolve(router.push(href, { scroll: false })).then(
      release,
      release,
    );
  }

  return (
    <form
      onSubmit={handleSubmit}
      role="search"
      className="mt-6 grid gap-3 sm:grid-cols-[1fr_auto_auto]"
    >
      <div className="relative">
        <span className="pointer-events-none absolute start-3.5 top-1/2 -translate-y-1/2 text-faint">
          <Icon name="search" size={16} />
        </span>
        <input
          type="search"
          name="q"
          value={searchValue}
          onChange={(event) => setSearchValue(event.target.value)}
          placeholder={t("library.searchPlaceholder")}
          aria-label={t("library.searchAria")}
          className="h-11 w-full rounded-2xl border border-line-strong bg-surface ps-10 pe-4 text-sm text-ink shadow-[var(--shadow-card)] outline-none transition placeholder:text-faint focus:border-accent focus:ring-4 focus:ring-accent/10"
        />
      </div>
      <select
        name="cat"
        value={categoryValue}
        onChange={(event) => setCategoryValue(event.target.value)}
        aria-label={t("library.categoryLabel")}
        className="h-11 rounded-2xl border border-line-strong bg-surface px-3.5 text-sm text-ink-soft shadow-[var(--shadow-card)] outline-none transition focus:border-accent focus:ring-4 focus:ring-accent/10"
      >
        <option value="">{t("library.allCategories")}</option>
        {BOOK_CATEGORIES.map((entry) => (
          <option key={entry.slug} value={entry.slug}>
            {t(entry.labelKey)}
          </option>
        ))}
      </select>
      <Button
        type="submit"
        variant="secondary"
        disabled={isPending}
        aria-busy={isPending}
      >
        {t("library.search")}
      </Button>
    </form>
  );
}
