"use client";

/**
 * FAQ page — fast, local, accessible.
 *
 *  - All content ships statically (no API call per question).
 *  - Search filters locally and synchronously; `useDeferredValue` keeps the
 *    input responsive during fast typing without re-rendering the whole list
 *    on every keystroke.
 *  - Accordion items are memoized, so opening/closing one item re-renders only
 *    that item. Open/close uses the CSS grid-rows 0fr→1fr trick (no JS height
 *    measurement → no layout thrashing) with a short, light transition.
 *  - Layout uses logical properties (start/end, ps/pe) so Arabic (dir=rtl)
 *    mirrors automatically.
 *  - Keyboard accessible: buttons toggle with Enter/Space; `aria-expanded`,
 *    `aria-controls`, `aria-pressed` and a live result counter are set.
 */
import {
  memo,
  useCallback,
  useDeferredValue,
  useId,
  useMemo,
  useState,
} from "react";
import { useI18n } from "@/lib/i18n";
import {
  CATEGORIES,
  search,
  type CategoryId,
  type FaqItem,
  type Language,
} from "@/lib/faq";
import { Icon, type IconName } from "@/components/icon";
import { EmptyState } from "@/components/empty-state";

type Filter = CategoryId | "all";

export function FaqPage() {
  const { t, lang } = useI18n();
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<Filter>("all");
  const [openIds, setOpenIds] = useState<ReadonlySet<string>>(new Set());

  // Keep the input snappy: the list filters on the deferred value, so rapid
  // typing never forces a synchronous full-list recompute per keystroke.
  const deferredQuery = useDeferredValue(query);

  const results = useMemo(
    () => search({ query: deferredQuery, lang, category }),
    [deferredQuery, lang, category],
  );

  const toggle = useCallback((id: string) => {
    setOpenIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const clear = useCallback(() => {
    setQuery("");
    setCategory("all");
  }, []);

  const hasActiveFilter = query.trim() !== "" || category !== "all";
  const count = results.length;

  return (
    <div className="mx-auto max-w-3xl px-4 py-6 sm:px-6 sm:py-8">
      {/* Hero */}
      <div className="mb-6">
        <h2 className="text-2xl font-bold tracking-[-0.03em] text-ink sm:text-3xl">
          {t("faq.title")}
        </h2>
        <p className="mt-1.5 text-sm leading-6 text-muted">{t("faq.description")}</p>
      </div>

      {/* Search */}
      <div className="relative mb-4">
        <Icon
          name="search"
          size={18}
          className="pointer-events-none absolute start-3.5 top-1/2 -translate-y-1/2 text-faint"
        />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("faq.searchPlaceholder")}
          aria-label={t("faq.searchLabel")}
          autoComplete="off"
          className="w-full rounded-xl border border-line bg-surface py-3 pe-11 ps-11 text-sm text-ink outline-none transition-colors placeholder:text-faint focus:border-accent focus:ring-4 focus:ring-accent/10"
        />
        {query !== "" && (
          <button
            type="button"
            onClick={() => setQuery("")}
            aria-label={t("faq.clearSearch")}
            className="absolute end-2 top-1/2 -translate-y-1/2 rounded-lg p-1.5 text-muted transition-colors hover:bg-surface-2 hover:text-ink focus:outline-none focus-visible:ring-4 focus-visible:ring-accent/10"
          >
            <Icon name="x" size={16} />
          </button>
        )}
      </div>

      {/* Category chips */}
      <div className="flex flex-wrap gap-2" aria-label={t("faq.categories")}>
        <CategoryChip
          active={category === "all"}
          onClick={() => setCategory("all")}
          label={t("faq.all")}
        />
        {CATEGORIES.map((c) => (
          <CategoryChip
            key={c.id}
            active={category === c.id}
            onClick={() => setCategory(c.id)}
            label={c.label[lang]}
            icon={c.icon}
          />
        ))}
      </div>

      {/* Result counter + clear filter */}
      <div className="mb-3 mt-5 flex items-center justify-between gap-3">
        <p className="text-xs font-semibold text-muted" aria-live="polite">
          {count === 1 ? t("faq.resultOne") : t("faq.results", { count })}
        </p>
        {hasActiveFilter && (
          <button
            type="button"
            onClick={clear}
            className="text-xs font-semibold text-accent underline-offset-2 hover:underline focus:outline-none focus-visible:ring-4 focus-visible:ring-accent/10"
          >
            {t("faq.clearSearch")}
          </button>
        )}
      </div>

      {/* List / empty state */}
      {results.length === 0 ? (
        <EmptyState
          icon="search"
          title={t("faq.noResults")}
          body={t("faq.noResultsHint")}
          action={{ label: t("faq.clearSearch"), onClick: clear }}
        />
      ) : (
        <div className="space-y-2">
          {results.map((item) => (
            <FaqAccordionItem
              key={item.id}
              item={item}
              lang={lang}
              open={openIds.has(item.id)}
              onToggle={toggle}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Category chip
// ---------------------------------------------------------------------------

function CategoryChip({
  active,
  onClick,
  label,
  icon,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  icon?: IconName;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors focus:outline-none focus-visible:ring-4 focus-visible:ring-accent/10 ${
        active
          ? "border-accent bg-accent-soft text-accent"
          : "border-line bg-surface text-muted hover:bg-surface-2 hover:text-ink"
      }`}
    >
      {icon && <Icon name={icon} size={14} />}
      {label}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Accordion item (memoized)
// ---------------------------------------------------------------------------

const FaqAccordionItem = memo(function FaqAccordionItem({
  item,
  lang,
  open,
  onToggle,
}: {
  item: FaqItem;
  lang: Language;
  open: boolean;
  onToggle: (id: string) => void;
}) {
  const uid = useId();
  const panelId = `faq-panel-${uid}`;
  const buttonId = `faq-button-${uid}`;

  return (
    <div
      className={`rounded-xl border bg-surface transition-colors ${
        open ? "border-line-strong" : "border-line"
      }`}
    >
      <h3 className="m-0">
        <button
          type="button"
          id={buttonId}
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => onToggle(item.id)}
          className="flex w-full items-center justify-between gap-3 rounded-xl px-4 py-3.5 text-start text-sm font-semibold text-ink transition-colors hover:bg-surface-2/50 focus:outline-none focus-visible:ring-4 focus-visible:ring-accent/10"
        >
          <span>{item.question[lang]}</span>
          <Icon
            name="chevron"
            size={16}
            className={`shrink-0 text-faint transition-transform duration-200 ${
              open ? "rotate-180" : ""
            }`}
          />
        </button>
      </h3>
      <div
        id={panelId}
        role="region"
        aria-labelledby={buttonId}
        className="grid transition-[grid-template-rows] duration-200 ease-out"
        style={{ gridTemplateRows: open ? "1fr" : "0fr" }}
      >
        <div className="min-h-0 overflow-hidden">
          <p className="px-4 pb-4 text-sm leading-6 text-muted">{item.answer[lang]}</p>
        </div>
      </div>
    </div>
  );
});
