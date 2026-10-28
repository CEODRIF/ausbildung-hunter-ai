"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { useI18n } from "@/lib/i18n";
import { BOOK_CATEGORIES } from "@/lib/book-categories";
import { createBookAction, updateBookAction } from "@/app/admin/books/actions";
import { Button, Input, Textarea } from "@/components/ui";
import { Icon } from "@/components/icon";

/**
 * Add/Edit form for library books (admin only — rendered exclusively under
 * the gated /admin/books page).
 *
 * VALIDATION is two-layered by design:
 *   - client: instant feedback (required fields, 5 MB cover ceiling, image
 *     accept list, http/https URL shape) — convenience, never the gate;
 *   - server actions: the same rules re-checked on the real bytes/values
 *     (content sniffing, protocol allowlist, category allowlist), after the
 *     requireAdmin gate. A direct POST cannot bypass either layer.
 *
 * The form NEVER sends an actor/user id — the action derives it from the
 * session (same contract as every other admin mutation in this repo).
 */

const COVER_ACCEPT = "image/jpeg,image/png,image/webp";
const COVER_MAX_BYTES = 5 * 1024 * 1024;

type FieldErrors = Partial<Record<"cover" | "title" | "category" | "url", string>>;

/** Client-side http(s)-only URL check (mirror of the server rule). */
function isSafeHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.username === "" &&
      url.password === ""
    );
  } catch {
    return false;
  }
}

interface FormValues {
  title: string;
  category: string;
  description: string;
  url: string;
  publish: boolean;
}

export function AdminBookForm({
  book,
  onDone,
}: {
  /** null = create mode; a book row = edit mode (prefilled). */
  book: {
    id: string;
    title: string;
    category: string;
    description: string;
    coverUrl: string | null;
    downloadUrl: string;
  } | null;
  /** Called after a successful create/update (the manager returns to the
   *  list; the page has already re-rendered via router.refresh()). */
  onDone: () => void;
}) {
  const { t } = useI18n();
  const isEdit = book !== null;

  const [state, formAction, pending] = useActionState(
    isEdit ? updateBookAction : createBookAction,
    {},
  );
  const [fields, setFields] = useState<FormValues>({
    title: book?.title ?? "",
    category: book?.category ?? "",
    description: book?.description ?? "",
    url: book?.downloadUrl ?? "",
    publish: true,
  });
  const [cover, setCover] = useState<File | null>(null);
  const [coverPreview, setCoverPreview] = useState<string | null>(null);
  const [errors, setErrors] = useState<FieldErrors>({});
  // Object-URL lifecycle: created in the event handler (not in an effect,
  // which React may re-run), revoked on replacement and on unmount.
  const previewUrlRef = useRef<string | null>(null);
  const setCoverFile = (file: File | null) => {
    setCover(file);
    if (previewUrlRef.current) {
      URL.revokeObjectURL(previewUrlRef.current);
      previewUrlRef.current = null;
    }
    if (file) {
      previewUrlRef.current = URL.createObjectURL(file);
      setCoverPreview(previewUrlRef.current);
    } else {
      setCoverPreview(null);
    }
  };
  useEffect(() => {
    return () => {
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    };
  }, []);

  const unknownCategory = isEdit
    ? !BOOK_CATEGORIES.some((category) => category.slug === book!.category)
    : false;

  const clientValidate = (): boolean => {
    const next: FieldErrors = {};
    if (!isEdit && !cover) next.cover = t("admin.books.form.coverError");
    else if (cover && cover.size > COVER_MAX_BYTES)
      next.cover = t("admin.books.form.coverSizeError");
    if (fields.title.trim().length < 1 || fields.title.trim().length > 200)
      next.title = t("admin.books.form.titleError");
    const categoryOk =
      fields.category === "" && !isEdit
        ? false
        : BOOK_CATEGORIES.some((c) => c.slug === fields.category);
    if (!categoryOk) next.category = t("admin.books.form.categoryError");
    if (!isSafeHttpUrl(fields.url))
      next.url = t("admin.books.form.urlError");
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  /** Client validation is UX only (the server re-checks everything): when
   *  it fails the submission is blocked so the admin gets instant,
   *  field-level feedback instead of a round-trip error. */
  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    if (!clientValidate()) e.preventDefault();
  };

  const field = (key: keyof FormValues) => ({
    value: key === "publish" ? String(fields.publish) : String(fields[key]),
    onChange: (
      e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>,
    ) => {
      const value =
        e.target instanceof HTMLInputElement && e.target.type === "checkbox"
          ? e.target.checked
          : e.target.value;
      setFields((prev) => ({ ...prev, [key]: value }));
    },
  });

  const errorFor = (code: string): string | null => {
    const message = t(`admin.books.errors.${code}`);
    // t() falls back to the raw key for unknown codes — surface a generic
    // message instead of a key leak.
    return message.startsWith("admin.books.errors.") ? t("admin.books.errors.db_error") : message;
  };

  const actionError = state.error ? errorFor(state.error) : null;

  return (
    <form
      action={formAction}
      onSubmit={handleSubmit}
      className="mt-4 space-y-4 rounded-3xl border border-line bg-surface p-5 shadow-[var(--shadow-card)]"
    >
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-base font-bold text-ink">
          {t(isEdit ? "admin.books.form.editTitle" : "admin.books.form.addTitle")}
        </h2>
        <button
          type="button"
          onClick={onDone}
          className="rounded-lg p-1.5 text-faint hover:bg-surface-2 hover:text-ink"
          aria-label={t("common.close")}
        >
          <Icon name="x" size={16} />
        </button>
      </div>

      {isEdit && <input type="hidden" name="bookId" value={book!.id} />}

      {/* Cover — file input + preview; required in create mode. */}
      <div>
        <span className="mb-1.5 block text-sm font-semibold text-ink-soft">
          {t("admin.books.form.cover")}
          {!isEdit && (
            <span className="ms-1.5 text-xs font-normal text-faint">
              {t("admin.books.form.required")}
            </span>
          )}
        </span>
        <div className="flex items-start gap-4">
          <div className="flex h-28 w-20 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-line-strong bg-surface-2">
            {coverPreview ? (
              // Local object-URL (blob:) preview of the admin's own
              // selection — next/image cannot optimize an unsent File.
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={coverPreview}
                alt=""
                className="h-full w-full object-cover"
              />
            ) : book?.coverUrl ? (
              // Admin-only view of a Supabase public-bucket object URL
              // (CSP-allowed origin; remote, so next/image would 403
              // without the remotePatterns allowlist — plain img keeps the
              // feature additive).
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={book.coverUrl}
                alt=""
                className="h-full w-full object-cover opacity-70"
              />
            ) : (
              <Icon name="image" size={22} className="text-faint" />
            )}
          </div>
          <div className="min-w-0 flex-1 space-y-1.5">
            <label className="inline-flex cursor-pointer items-center gap-2 rounded-xl border border-line-strong bg-surface px-3 py-2 text-xs font-semibold text-ink-soft transition-colors hover:bg-surface-2">
              <Icon name="upload" size={14} />
              {t("admin.books.form.coverChoose")}
              <input
                type="file"
                name="cover"
                accept={COVER_ACCEPT}
                className="sr-only"
                onChange={(e) => {
                  const file = e.target.files?.[0] ?? null;
                  setCoverFile(file);
                  if (file && file.size > COVER_MAX_BYTES) {
                    setErrors((prev) => ({
                      ...prev,
                      cover: t("admin.books.form.coverSizeError"),
                    }));
                  }
                }}
              />
            </label>
            <p className="text-xs text-muted">{t("admin.books.form.coverHint")}</p>
            {isEdit && cover === null && (
              <p className="text-xs text-faint">{t("admin.books.form.coverKeep")}</p>
            )}
            {errors.cover && (
              <p className="text-xs font-medium text-danger">{errors.cover}</p>
            )}
          </div>
        </div>
      </div>

      <Input
        id="book-title"
        name="title"
        label={t("admin.books.form.title")}
        placeholder={t("admin.books.form.titlePlaceholder")}
        maxLength={200}
        required
        error={errors.title}
        {...field("title")}
      />

      <div>
        <label className="block" htmlFor="book-category">
          <span className="mb-1.5 block text-sm font-semibold text-ink-soft">
            {t("admin.books.form.category")}
          </span>
          <select
            id="book-category"
            name="category"
            required
            value={fields.category}
            onChange={field("category").onChange}
            className={`h-10 w-full rounded-2xl border bg-surface px-3 text-sm text-ink shadow-[var(--shadow-card)] outline-none transition focus:border-accent focus:ring-4 focus:ring-accent/10 ${errors.category ? "border-danger" : "border-line-strong"}`}
          >
            <option value="" disabled>
              {t("admin.books.form.categoryPlaceholder")}
            </option>
            {BOOK_CATEGORIES.map((category) => (
              <option key={category.slug} value={category.slug}>
                {t(category.labelKey)}
              </option>
            ))}
            {/* A book stored under a category added after this deploy keeps
                its value selectable (label = raw slug via categoryLabel
                fallback on the public page). */}
            {unknownCategory && (
              <option value={book!.category}>{book!.category}</option>
            )}
          </select>
          {errors.category && (
            <span className="mt-1.5 block text-xs font-medium text-danger">
              {errors.category}
            </span>
          )}
        </label>
      </div>

      <Textarea
        id="book-description"
        name="description"
        label={
          t("admin.books.form.description") +
          " " +
          t("admin.books.form.optional")
        }
        placeholder={t("admin.books.form.descriptionPlaceholder")}
        maxLength={2000}
        {...field("description")}
      />

      <Input
        id="book-url"
        name="downloadUrl"
        label={t("admin.books.form.url")}
        placeholder="https://…/buch.pdf"
        required
        error={errors.url}
        hint={t("admin.books.form.urlHint")}
        {...field("url")}
      />

      {!isEdit && (
        <label className="flex cursor-pointer items-center gap-2.5 text-sm font-semibold text-ink-soft">
          <input
            type="checkbox"
            name="published"
            checked={fields.publish}
            onChange={field("publish").onChange}
            className="h-4 w-4 rounded border-line-strong accent-accent"
          />
          {t("admin.books.form.publishNow")}
          <span className="text-xs font-normal text-faint">
            {t("admin.books.form.publishNowHint")}
          </span>
        </label>
      )}

      {actionError && (
        <p
          role="alert"
          className="rounded-xl border border-danger/30 bg-danger-soft px-3.5 py-2.5 text-xs font-semibold text-danger"
        >
          {actionError}
        </p>
      )}

      <div className="flex items-center gap-2.5 pt-1">
        <Button type="submit" disabled={pending}>
          {pending && (
            <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/40 border-t-white" />
          )}
          {t(isEdit ? "admin.books.form.save" : "admin.books.form.create")}
        </Button>
        <Button type="button" variant="ghost" onClick={onDone}>
          {t("common.cancel")}
        </Button>
      </div>
    </form>
  );
}
