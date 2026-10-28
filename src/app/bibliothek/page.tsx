import Link from "next/link";
import { getServerT } from "@/lib/i18n/server";
import {
  bookCoverPublicUrl,
  listPublishedBooks,
  type PublishedBook,
} from "@/lib/book-library";
import { BOOK_CATEGORIES, categoryLabel } from "@/lib/book-categories";
import { Button, ErrorState } from "@/components/ui";
import { EmptyState } from "@/components/empty-state";
import { Icon } from "@/components/icon";
import { GradientMesh } from "@/components/ui/surfaces";

/**
 * Deutsch Bibliothek — the PUBLIC book library.
 *
 * No authentication required: the data path is the anon/auth Supabase
 * client, so the database RLS policy is the visibility boundary
 * (published rows only — drafts are unreachable here and through any
 * direct API request; see migration 20261203000000).
 *
 * `force-dynamic` is deliberate: a book published in the admin panel must
 * appear here on the next request without any deployment or revalidation
 * step. The collection is small (a curated catalog), so a per-request
 * count+page query is the right cost profile.
 */
export const dynamic = "force-dynamic";

type T = (path: string, vars?: Record<string, string | number>) => string;

interface LibraryQuery {
  q?: string;
  cat?: string;
  page?: number;
}

function parseQuery(raw: Record<string, string | string[] | undefined>): LibraryQuery {
  const first = (key: string): string | undefined => {
    const value = raw[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    return undefined;
  };
  const pageRaw = first("page");
  const page = pageRaw ? Math.max(1, Math.min(10_000, Number.parseInt(pageRaw, 10) || 1)) : 1;
  return { q: first("q"), cat: first("cat"), page };
}

function queryString(q: LibraryQuery): string {
  const params = new URLSearchParams();
  if (q.q) params.set("q", q.q);
  if (q.cat) params.set("cat", q.cat);
  if (q.page && q.page > 1) params.set("page", String(q.page));
  const s = params.toString();
  return s ? `?${s}` : "";
}

export default async function BibliothekPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [t, rawParams] = await Promise.all([getServerT(), searchParams]);
  const query = parseQuery(rawParams);

  let result: { books: PublishedBook[]; total: number; page: number; pageCount: number };
  try {
    result = await listPublishedBooks(query);
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

  const hasFilters = Boolean(query.q || query.cat);

  return (
    <LibraryShell t={t}>
      {/* Search + category filter (plain GET form — works without JS,
          deep-linkable, no client state to desync). */}
      <form method="GET" action="/bibliothek" className="mt-6 grid gap-3 sm:grid-cols-[1fr_auto_auto]">
        <div className="relative">
          <span className="pointer-events-none absolute start-3.5 top-1/2 -translate-y-1/2 text-faint">
            <Icon name="search" size={16} />
          </span>
          <input
            type="search"
            name="q"
            value={query.q ?? ""}
            placeholder={t("library.searchPlaceholder")}
            aria-label={t("library.searchAria")}
            className="h-11 w-full rounded-2xl border border-line-strong bg-surface ps-10 pe-4 text-sm text-ink shadow-[var(--shadow-card)] outline-none transition placeholder:text-faint focus:border-accent focus:ring-4 focus:ring-accent/10"
          />
        </div>
        <select
          name="cat"
          defaultValue={query.cat ?? ""}
          aria-label={t("library.categoryLabel")}
          className="h-11 rounded-2xl border border-line-strong bg-surface px-3.5 text-sm text-ink-soft shadow-[var(--shadow-card)] outline-none transition focus:border-accent focus:ring-4 focus:ring-accent/10"
        >
          <option value="">{t("library.allCategories")}</option>
          {BOOK_CATEGORIES.map((category) => (
            <option key={category.slug} value={category.slug}>
              {t(category.labelKey)}
            </option>
          ))}
        </select>
        <Button type="submit" variant="secondary">
          {t("library.search")}
        </Button>
      </form>

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
          <ul className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {result.books.map((book) => (
              <BookCard key={book.id} book={book} t={t} />
            ))}
          </ul>

          {result.pageCount > 1 && (
            <nav
              aria-label={t("library.pagination.aria")}
              className="mt-8 flex items-center justify-center gap-3"
            >
              {result.page > 1 ? (
                <Link
                  href={`/bibliothek${queryString({ ...query, page: result.page - 1 })}`}
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
                  href={`/bibliothek${queryString({ ...query, page: result.page + 1 })}`}
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

/** Page chrome: the standalone header (the page is public — visitors from
 *  the landing page see no app-shell). */
function LibraryShell({ t, children }: { t: T; children: React.ReactNode }) {
  return (
    <main className="min-h-screen bg-background text-ink">
      <GradientMesh />
      <div className="relative mx-auto max-w-6xl px-4 py-10 sm:px-6 sm:py-14 lg:px-10">
        <header>
          <p className="text-xs font-bold uppercase tracking-[0.16em] text-accent">
            {t("library.kicker")}
          </p>
          <h1 className="display-title mt-2 text-3xl text-ink sm:text-4xl">
            {t("library.pageTitle")}
          </h1>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-muted sm:text-base">
            {t("library.pageSubtitle")}
          </p>
        </header>
        {children}
      </div>
    </main>
  );
}

/** One book card: cover, title, localized category, optional description,
 *  and the external download link (target=_blank + noopener noreferrer
 *  nofollow — the URL is admin-provided metadata, opened in a fresh,
 *  unassociated tab; this app never follows it). */
function BookCard({ book, t }: { book: PublishedBook; t: T }) {
  const coverUrl = book.cover_path ? bookCoverPublicUrl(book.cover_path) : null;
  return (
    <li className="surface-elevated group flex flex-col overflow-hidden rounded-3xl transition-transform duration-200 hover:-translate-y-0.5">
      {coverUrl ? (
        // Remote Supabase storage origin (allowed by the CSP img-src built
        // from the Supabase URL); aspect ratio keeps the 3:4 cover box
        // stable. next/image would need a remotePatterns allowlist, which
        // would modify shared config — plain img keeps the feature additive.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={coverUrl}
          alt=""
          loading="lazy"
          className="aspect-[3/4] w-full object-cover"
        />
      ) : (
        <div
          aria-hidden
          className="flex aspect-[3/4] w-full items-center justify-center bg-surface-2 text-faint"
        >
          <Icon name="book" size={32} strokeWidth={1.4} />
        </div>
      )}
      <div className="flex flex-1 flex-col gap-2 p-4">
        <span className="w-fit rounded-full bg-accent-soft px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide text-accent">
          {categoryLabel(book.category, t)}
        </span>
        <h2 className="text-sm font-bold leading-snug text-ink">{book.title}</h2>
        {book.description && (
          <p className="line-clamp-3 text-xs leading-5 text-muted">
            {book.description}
          </p>
        )}
        <a
          href={book.download_url}
          target="_blank"
          rel="noopener noreferrer nofollow"
          className="mt-auto inline-flex items-center justify-center gap-2 rounded-2xl border border-line-strong bg-surface px-4 py-2.5 text-xs font-bold text-ink-soft transition-colors hover:border-accent hover:text-accent"
        >
          <Icon name="download" size={14} />
          {t("library.download")}
          <Icon name="external" size={12} className="text-faint" />
        </a>
      </div>
    </li>
  );
}
