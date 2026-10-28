"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useI18n } from "@/lib/i18n";
import { categoryLabel } from "@/lib/book-categories";
import {
  deleteBookAction,
  setBookPublishedAction,
} from "@/app/admin/books/actions";
import { AdminBookForm } from "@/components/admin-book-form";
import { Button } from "@/components/ui";
import { Icon } from "@/components/icon";

/**
 * Admin book management: list + create + edit + publish/unpublish + delete.
 *
 * The ACTOR is never part of any request — the server actions derive it
 * from the authenticated session (requireAdmin). This component only sends
 * the book id and the form values.
 *
 * Delete is two-step (the repo's established confirmation contract for
 * destructive admin actions): the first click opens an inline
 * confirmation naming the exact book; only the second click fires the
 * request, and a busy guard makes double-fire impossible.
 */

export interface AdminBookView {
  id: string;
  title: string;
  category: string;
  description: string;
  coverUrl: string | null;
  downloadUrl: string;
  published: boolean;
  createdAt: string;
}

type RowState =
  | { kind: "idle" }
  | { kind: "confirm_delete" }
  | { kind: "working" }
  | { kind: "error"; message: string };

export function AdminBookManager({ books }: { books: AdminBookView[] }) {
  const { t } = useI18n();
  const router = useRouter();
  const [editing, setEditing] = useState<AdminBookView | "new" | null>(null);
  const [rowStates, setRowStates] = useState<Record<string, RowState>>({});

  const setRowState = (id: string, state: RowState) =>
    setRowStates((prev) => ({ ...prev, [id]: state }));

  const rowErrorFor = (code: string): string => {
    const message = t(`admin.books.errors.${code}`);
    return message.startsWith("admin.books.errors.")
      ? t("admin.books.errors.db_error")
      : message;
  };

  const togglePublish = async (book: AdminBookView) => {
    setRowState(book.id, { kind: "working" });
    const result = await setBookPublishedAction(book.id, !book.published);
    if (result.ok) {
      setRowState(book.id, { kind: "idle" });
      router.refresh(); // re-render the table from server data (no stale row)
    } else {
      setRowState(book.id, {
        kind: "error",
        message:
          result.error === "book_not_found"
            ? t("admin.books.rowNotFound")
            : rowErrorFor(result.error),
      });
    }
  };

  const confirmDelete = async (book: AdminBookView) => {
    setRowState(book.id, { kind: "working" });
    const result = await deleteBookAction(book.id);
    if (result.ok) {
      if (editing === book) setEditing(null); // form target vanished
      router.refresh();
    } else {
      setRowState(book.id, {
        kind: "error",
        message:
          result.error === "book_not_found"
            ? t("admin.books.rowNotFound")
            : rowErrorFor(result.error),
      });
    }
  };

  if (editing !== null) {
    return (
      <AdminBookForm
        book={editing === "new" ? null : editing}
        onDone={() => {
          setEditing(null);
          router.refresh();
        }}
      />
    );
  }

  return (
    <>
      <div className="mt-6 flex items-center justify-between gap-3">
        <Button onClick={() => setEditing("new")}>
          <Icon name="plus" size={15} />
          {t("admin.books.add")}
        </Button>
        <span className="text-xs font-semibold text-faint">
          {t("admin.books.count", { count: books.length })}
        </span>
      </div>

      {books.length === 0 ? (
        <p className="mt-6 rounded-3xl border border-dashed border-line-strong bg-surface/50 px-6 py-12 text-center text-sm text-muted">
          {t("admin.books.empty")}
        </p>
      ) : (
        <div className="mt-4 overflow-x-auto rounded-3xl border border-line bg-surface shadow-[var(--shadow-card)]">
          <table className="w-full min-w-[760px] text-start text-sm">
            <thead>
              <tr className="border-b border-line text-[11px] uppercase tracking-[0.08em] text-faint">
                <th className="px-5 py-3 text-start">{t("admin.books.table.book")}</th>
                <th className="px-5 py-3 text-start">{t("admin.books.table.type")}</th>
                <th className="px-5 py-3 text-start">{t("admin.books.table.status")}</th>
                <th className="px-5 py-3 text-start">{t("admin.books.table.added")}</th>
                <th className="px-5 py-3 text-end">{t("admin.books.table.actions")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {books.map((book) => {
                const state = rowStates[book.id] ?? { kind: "idle" };
                const busy = state.kind === "working";
                return (
                  <tr key={book.id} className="align-middle">
                    <td className="px-5 py-3">
                      <div className="flex items-center gap-3">
                        <span className="flex h-14 w-10 shrink-0 items-center justify-center overflow-hidden rounded-md border border-line bg-surface-2">
                          {book.coverUrl ? (
                            // eslint-disable-next-line @next/next/no-img-element -- remote Supabase storage (CSP-allowed origin)
                            <img
                              src={book.coverUrl}
                              alt=""
                              loading="lazy"
                              className="h-full w-full object-cover"
                            />
                          ) : (
                            <Icon name="book" size={14} className="text-faint" />
                          )}
                        </span>
                        <div className="min-w-0">
                          <p className="max-w-[320px] truncate font-semibold text-ink-soft">
                            {book.title}
                          </p>
                          <a
                            href={book.downloadUrl}
                            target="_blank"
                            rel="noopener noreferrer nofollow"
                            className="block max-w-[320px] truncate text-xs text-faint hover:text-accent"
                            title={book.downloadUrl}
                          >
                            {book.downloadUrl}
                          </a>
                        </div>
                      </div>
                    </td>
                    <td className="px-5 py-3 text-xs font-semibold text-muted">
                      {categoryLabel(book.category, t)}
                    </td>
                    <td className="px-5 py-3">
                      <span
                        className={`rounded-md px-1.5 py-0.5 text-[10px] font-bold ${
                          book.published
                            ? "bg-success-soft text-success"
                            : "bg-surface-2 text-muted"
                        }`}
                      >
                        {t(
                          book.published
                            ? "admin.books.status.published"
                            : "admin.books.status.draft",
                        )}
                      </span>
                    </td>
                    <td className="px-5 py-3 text-xs text-muted">{book.createdAt}</td>
                    <td className="px-5 py-3">
                      <div className="flex items-center justify-end gap-2">
                        {state.kind === "error" && (
                          <span
                            role="alert"
                            className="me-1 max-w-[220px] truncate text-[11px] font-semibold text-danger"
                            title={state.message}
                          >
                            {state.message}
                          </span>
                        )}
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => setEditing(book)}
                          className="rounded-lg border border-line-strong bg-surface px-2.5 py-1.5 text-xs font-semibold text-ink-soft hover:bg-surface-2 disabled:opacity-50"
                        >
                          {t("admin.books.edit")}
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => togglePublish(book)}
                          className={`rounded-lg border px-2.5 py-1.5 text-xs font-semibold disabled:opacity-50 ${
                            book.published
                              ? "border-line-strong bg-surface text-ink-soft hover:bg-surface-2"
                              : "border-success/40 bg-success-soft text-success hover:bg-success/20"
                          }`}
                        >
                          {t(
                            book.published
                              ? "admin.books.unpublish"
                              : "admin.books.publish",
                          )}
                        </button>
                        {state.kind === "confirm_delete" ? (
                          <span className="flex items-center gap-1.5">
                            <span className="text-[11px] font-semibold text-danger">
                              {t("admin.books.confirmDelete", { title: book.title })}
                            </span>
                            <button
                              type="button"
                              onClick={() => confirmDelete(book)}
                              className="rounded-lg bg-danger px-2.5 py-1.5 text-xs font-bold text-white hover:opacity-90"
                            >
                              {t("admin.books.confirmYes")}
                            </button>
                            <button
                              type="button"
                              onClick={() => setRowState(book.id, { kind: "idle" })}
                              className="rounded-lg border border-line-strong bg-surface px-2.5 py-1.5 text-xs font-semibold text-ink-soft hover:bg-surface-2"
                            >
                              {t("admin.books.confirmNo")}
                            </button>
                          </span>
                        ) : (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() =>
                              setRowState(book.id, { kind: "confirm_delete" })
                            }
                            className="rounded-lg border border-danger/40 bg-surface px-2.5 py-1.5 text-xs font-semibold text-danger hover:bg-danger-soft disabled:opacity-50"
                            aria-label={t("admin.books.delete")}
                          >
                            <Icon name="trash" size={13} />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
