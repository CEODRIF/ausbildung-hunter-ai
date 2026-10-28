"use client";

import { useState } from "react";
import Link from "next/link";
import { useI18n } from "@/lib/i18n";
import { categoryLabel } from "@/lib/book-categories";
import { initiateBookDownloadAction } from "@/app/bibliothek/actions";
import type { BookQuotaState } from "@/lib/book-library";
import { Icon } from "@/components/icon";

/**
 * Deutsch Bibliothek — client-side book grid + quota state.
 *
 * SECURITY MODEL (details in src/lib/book-library.ts):
 *   - the card NEVER receives the external download URL. The URL is
 *     delivered by the server action ONLY after it has resolved the
 *     session user + the trusted subscription state and the atomic
 *     quota RPC granted the initiation;
 *   - the displayed remaining count is a convenience — every click is
 *     re-checked server-side (session → entitlements → RPC row lock),
 *     so a stale/edited client state can never grant a download;
 *   - downloads open via window.open(url, "_blank", "noopener,noreferrer")
 *     — fresh, unassociated tab (the safe external-link behavior, kept
 *     from the plain-anchor implementation). The platform never
 *     follows, downloads, scrapes, or hosts the PDF.
 *
 * QUOTA UX:
 *   - guest            → sign-in CTA (the existing auth UX; absence of a
 *                        profile NEVER grants a trial — that is decided
 *                        server-side from the subscription row);
 *   - ready            → live "n of limit left today" counter, updated
 *                        in place after each initiation (no reload);
 *   - exhausted        → download buttons disabled + the exact message
 *                        (free tier: the mandated Arabic string; Plus/Pro:
 *                        the localized "daily limit reached").
 */
export interface LibraryBookData {
  id: string;
  title: string;
  category: string;
  description: string | null;
  /** Public storage URL (read-only display) — NOT the book file. */
  coverUrl: string | null;
}

interface LibraryBookGridProps {
  books: LibraryBookData[];
  /** Server-resolved quota state for the session user (guest = null user). */
  initialQuota: BookQuotaState;
}

export function LibraryBookGrid({
  books,
  initialQuota,
}: LibraryBookGridProps) {
  const { t } = useI18n();
  const [quota, setQuota] = useState<BookQuotaState>(initialQuota);
  const [pendingBookId, setPendingBookId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const exhaustedMessage =
    quota.tier === "plus" || quota.tier === "pro"
      ? t("library.quota.exhaustedPaid")
      : t("library.quota.exhaustedFree");

  async function handleDownload(bookId: string) {
    if (pendingBookId) return; // one in-flight initiation at a time
    setPendingBookId(bookId);
    setActionError(null);
    try {
      const result = await initiateBookDownloadAction(bookId);
      if (result.ok) {
        // Live quota update — no page reload required.
        setQuota((q) => ({
          ...q,
          remaining: result.remaining,
          state: result.remaining > 0 ? "ready" : "exhausted",
        }));
        window.open(result.url, "_blank", "noopener,noreferrer");
      } else {
        switch (result.error) {
          case "quota_exhausted":
          case "no_eligible_plan":
            setQuota((q) => ({
              ...q,
              tier: result.tier,
              remaining: 0,
              state: "exhausted",
            }));
            setActionError(null); // the exhausted bar carries the message
            break;
          case "not_signed_in":
            // Session expired mid-page: fall back to the guest UX.
            setQuota({
              state: "guest",
              tier: "none",
              limit: 0,
              used: 0,
              remaining: 0,
            });
            break;
          default:
            setActionError(result.error);
        }
      }
    } catch {
      setActionError("db_error");
    } finally {
      setPendingBookId(null);
    }
  }

  return (
    <>
      {/* Quota / access bar (polite live region: state changes announce) */}
      <div className="mt-5" aria-live="polite">
        {quota.state === "guest" && (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-line-strong bg-surface px-4 py-3">
            <p className="text-xs leading-5 text-muted">
              {t("library.quota.guestHint")}
            </p>
            <Link
              href="/login"
              className="inline-flex items-center gap-2 rounded-2xl border border-line-strong bg-surface px-4 py-2 text-xs font-bold text-ink-soft transition-colors hover:border-accent hover:text-accent"
            >
              <Icon name="download" size={14} />
              {t("library.download.signIn")}
            </Link>
          </div>
        )}
        {quota.state === "ready" && (
          <p className="rounded-2xl border border-line-strong bg-surface px-4 py-3 text-xs font-semibold text-muted">
            {t("library.quota.remaining", {
              n: quota.remaining,
              limit: quota.limit,
            })}
          </p>
        )}
        {quota.state === "exhausted" && (
          <p
            dir="auto"
            className="rounded-2xl border border-line-strong bg-surface px-4 py-3 text-xs font-semibold text-muted"
          >
            {exhaustedMessage}
          </p>
        )}
        {actionError && (
          <p role="alert" className="mt-2 text-xs font-semibold text-danger">
            {t(`library.download.errors.${actionError}`)}
          </p>
        )}
      </div>

      <ul className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {books.map((book) => (
          <BookCard
            key={book.id}
            book={book}
            quota={quota}
            pending={pendingBookId === book.id}
            exhaustedMessage={exhaustedMessage}
            onDownload={handleDownload}
          />
        ))}
      </ul>
    </>
  );
}

function BookCard({
  book,
  quota,
  pending,
  exhaustedMessage,
  onDownload,
}: {
  book: LibraryBookData;
  quota: BookQuotaState;
  pending: boolean;
  exhaustedMessage: string;
  onDownload: (bookId: string) => void;
}) {
  const { t } = useI18n();
  const buttonClasses =
    "mt-auto inline-flex items-center justify-center gap-2 rounded-2xl border border-line-strong bg-surface px-4 py-2.5 text-xs font-bold text-ink-soft transition-colors hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-line-strong disabled:hover:text-ink-soft";

  return (
    <li className="surface-elevated group flex flex-col overflow-hidden rounded-3xl transition-transform duration-200 hover:-translate-y-0.5">
      {book.coverUrl ? (
        // Remote Supabase storage origin (allowed by the CSP img-src built
        // from the Supabase URL); aspect ratio keeps the 3:4 cover box
        // stable. next/image would need a remotePatterns allowlist, which
        // would modify shared config — plain img keeps the feature additive.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={book.coverUrl}
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

        {quota.state === "guest" ? (
          <Link href="/login" className={buttonClasses}>
            <Icon name="download" size={14} />
            {t("library.download.signIn")}
            <Icon name="external" size={12} className="text-faint" />
          </Link>
        ) : quota.state === "exhausted" ? (
          <>
            <button
              type="button"
              disabled
              aria-disabled="true"
              className={buttonClasses}
            >
              <Icon name="download" size={14} />
              {t("library.download.button")}
            </button>
            <p
              dir="auto"
              className="text-center text-[11px] font-semibold leading-4 text-muted"
            >
              {exhaustedMessage}
            </p>
          </>
        ) : (
          <button
            type="button"
            onClick={() => onDownload(book.id)}
            disabled={pending}
            aria-busy={pending}
            className={buttonClasses}
          >
            <Icon name="download" size={14} />
            {pending ? t("library.download.pending") : t("library.download.button")}
            {!pending && <Icon name="external" size={12} className="text-faint" />}
          </button>
        )}
      </div>
    </li>
  );
}
