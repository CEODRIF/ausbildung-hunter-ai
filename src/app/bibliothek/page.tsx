import Link from "next/link";
import { getServerT } from "@/lib/i18n/server";
import { getCurrentUserAndProfile } from "@/lib/auth";
import {
  bookCoverPublicUrl,
  getBookQuotaState,
  listPublishedBooks,
  parseLibraryQuery,
  type LibraryFilters,
  type PublishedBook,
} from "@/lib/book-library";
import { Button, ErrorState } from "@/components/ui";
import { EmptyState } from "@/components/empty-state";
import { Icon } from "@/components/icon";
import { LibraryBookGrid, type LibraryBookData } from "@/components/library-book-grid";
import { LibrarySearchForm } from "@/components/library-search-form";


/**
 * Deutsch Bibliothek — the PUBLIC book library.
 *
 * Browsing is public: the data path is the anon/auth Supabase client, so
 * the database RLS policy is the visibility boundary (published rows
 * only — drafts are unreachable here and through any direct API request;
 * see migration 20261203000000).
 *
 * DOWNLOADS are quota-gated (migration 20261204000000): each initiation
 * goes through the `initiateBookDownloadAction` server action — session
 * user → trusted subscription resolution (getEntitlements) → the atomic
 * quota RPC, which the browser can never call directly (see the
 * migration's grant block). The cards therefore do NOT carry the
 * external URL; the grid component receives it from the action result
 * after authorization (see library-book-grid.tsx).
 *
 * `force-dynamic` is deliberate: a book published in the admin panel must
 * appear here on the next request without any deployment or revalidation
 * step. The collection is small (a curated catalog), so a per-request
 * count+page query is the right cost profile.
 */
export const dynamic = "force-dynamic";

type T = (path: string, vars?: Record<string, string | number>) => string;

/**
 * URL form of the filters (the short `q` / `cat` names — deep-linkable,
 * shareable, back/forward-friendly). Page index 1 is omitted (clean URLs).
 */
function queryString(filters: LibraryFilters): string {
  const params = new URLSearchParams();
  if (filters.search) params.set("q", filters.search);
  if (filters.category) params.set("cat", filters.category);
  if (filters.page > 1) params.set("page", String(filters.page));
  const s = params.toString();
  return s ? `?${s}` : "";
}

export default async function BibliothekPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [t, rawParams, auth] = await Promise.all([
    getServerT(),
    searchParams,
    getCurrentUserAndProfile(),
  ]);
  // URL shape (q/cat/page) → data-layer shape (search/category/page).
  // parseLibraryQuery is the single, tested join point — passing the raw
  // URL keys straight to the data layer is exactly how title + category
  // filtering got silently dropped (2026-10 regression).
  const filters = parseLibraryQuery(rawParams);

  // Server-resolved daily download quota for the session user (guests get
  // the sign-in CTA; the action re-checks everything on each click).
  const initialQuota = await getBookQuotaState(auth.user?.id ?? null);

  let result: { books: PublishedBook[]; total: number; page: number; pageCount: number };
  try {
    result = await listPublishedBooks(filters);
  } catch (error) {
    // Server-rendered error state: the raw failure is logged (scrubbed of
    // any credential-shaped fragment) and the user sees a retryable state.
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `[bibliothek] listing failed — "${message.replace(/\beyJ[A-Za-z0-9._-]{8,}\.[A-Za-z0-9._-]{8,}\.[A-Za-z0-9._-]{8,}/g, "[redacted-jwt]")}"`,
    );
    return (
      <LibraryShell t={t}>
        <ErrorState
          title={t("library.error.title")}
          description={t("library.error.body")}
        />
      </LibraryShell>
    );
  }

  const hasFilters = Boolean(filters.search || filters.category);

  return (
    <LibraryShell t={t}>
      {/* Search + category filter: a CLIENT form that performs a soft
          App-Router navigation (no full page reload). The URL still carries
          q/cat/page, so results stay deep-linkable and back/forward works;
          the section's loading.tsx is the pending state. See
          library-search-form.tsx for the rationale. */}
      <LibrarySearchForm search={filters.search} category={filters.category} />

      {result.total > 0 && (
        <p className="mt-5 text-xs font-semibold text-faint" aria-live="polite">
          {t("library.count", { count: result.total })}
        </p>
      )}

      {result.total === 0 && !hasFilters ? (
        <div className="mt-6">
          <EmptyState
            icon="book"
            title={t("library.empty.title")}
            body={t("library.empty.body")}
          />
        </div>
      ) : result.total === 0 ? (
        <div className="mt-6">
          <EmptyState
            icon="search"
            title={t("library.noResults.title")}
            body={t("library.noResults.body")}
            footer={
              <Link
                href="/bibliothek"
                className="text-xs font-bold text-accent hover:underline"
              >
                {t("library.noResults.clear")}
              </Link>
            }
          />
        </div>
      ) : (
        <>
          <LibraryBookGrid
            books={result.books.map<LibraryBookData>((book) => ({
              id: book.id,
              title: book.title,
              category: book.category,
              description: book.description,
              coverUrl: book.cover_path
                ? bookCoverPublicUrl(book.cover_path)
                : null,
            }))}
            initialQuota={initialQuota}
          />

          {result.pageCount > 1 && (
            <nav
              aria-label={t("library.pagination.aria")}
              className="mt-8 flex items-center justify-center gap-3"
            >
              {result.page > 1 ? (
                <Link
                  href={`/bibliothek${queryString({ ...filters, page: result.page - 1 })}`}
                >
                  <Button variant="secondary" size="sm">
                    <Icon name="arrowLeft" size={14} className="rtl:rotate-180" />
                    {t("library.pagination.prev")}
                  </Button>
                </Link>
              ) : (
                <span aria-hidden className="w-[76px]" />
              )}
              <span className="text-xs font-semibold text-muted">
                {t("library.pagination.info", {
                  page: result.page,
                  total: result.pageCount,
                })}
              </span>
              {result.page < result.pageCount ? (
                <Link
                  href={`/bibliothek${queryString({ ...filters, page: result.page + 1 })}`}
                >
                  <Button variant="secondary" size="sm">
                    {t("library.pagination.next")}
                    <Icon name="arrowRight" size={14} className="rtl:rotate-180" />
                  </Button>
                </Link>
              ) : (
                <span aria-hidden className="w-[76px]" />
              )}
            </nav>
          )}
        </>
      )}
    </LibraryShell>
  );
}

/**
 * Page chrome INSIDE the shared AppShell (see bibliothek/layout.tsx): the
 * shell supplies the sidebar, top bar, mobile drawer, background/mesh and
 * the "Deutsch Bibliothek" heading (PAGE_HEADINGS entry). This is a plain
 * centered content column — the same pattern as /wohnen — with an intro
 * line so the section still reads on small viewports where the top-bar
 * heading is hidden.
 */
function LibraryShell({ t, children }: { t: T; children: React.ReactNode }) {
  return (
    <div className="relative mx-auto max-w-6xl px-4 py-6 sm:px-6 lg:px-10">
      <p className="text-sm leading-relaxed text-muted">{t("library.intro")}</p>
      <div className="mt-5">{children}</div>
    </div>
  );
}

