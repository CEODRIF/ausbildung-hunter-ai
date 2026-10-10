"use client";

/**
 * Interactive task checklist for the guides.
 *
 * Persistence is deliberately LOCALSTORAGE-ONLY (per browser): the task asks
 * for interactive checklists without touching the database, and checklists are
 * personal, non-sensitive progress state — there is no account linkage by
 * design. SSR renders the unchecked state; the stored state is applied after
 * hydration (same pattern as the i18n provider — no hydration mismatch).
 */
import { useCallback, useEffect, useMemo, useState } from "react";

export interface ChecklistItem {
  id: string;
  title: string;
  desc?: string;
  source?: { label: string; url: string };
}

interface Props {
  /** Unique storage key per page (e.g. "aha-guides-neu"). */
  storageKey: string;
  title: string;
  hint?: string;
  items: ChecklistItem[];
  /** "{done} von {total} erledigt" style template. */
  progressTemplate: string;
  resetLabel: string;
  doneAllLabel: string;
}

export function Checklist({
  storageKey,
  title,
  hint,
  items,
  progressTemplate,
  resetLabel,
  doneAllLabel,
}: Props) {
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [ready, setReady] = useState(false);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (raw) {
        const parsed = JSON.parse(raw) as Record<string, boolean>;
        // Intentional post-hydration restore of the persisted checklist (same
        // pattern as the i18n provider — keeps the SSR render identical).
        // eslint-disable-next-line react-hooks/set-state-in-effect
        if (parsed && typeof parsed === "object") setChecked(parsed);
      }
    } catch {
      /* corrupted storage — start fresh */
    }
    setReady(true);
  }, [storageKey]);

  const persist = useCallback(
    (next: Record<string, boolean>) => {
      try {
        window.localStorage.setItem(storageKey, JSON.stringify(next));
      } catch {
        /* storage full/unavailable — the checklist still works in-memory */
      }
    },
    [storageKey],
  );

  const toggle = useCallback(
    (id: string) => {
      setChecked((prev) => {
        const next = { ...prev, [id]: !prev[id] };
        persist(next);
        return next;
      });
    },
    [persist],
  );

  const reset = useCallback(() => {
    setChecked({});
    persist({});
  }, [persist]);

  const done = useMemo(
    () => items.filter((i) => checked[i.id]).length,
    [items, checked],
  );

  if (!ready) {
    // Post-hydration placeholder keeps SSR output identical (unchecked).
    return (
      <section className="surface-elevated rounded-3xl p-5 sm:p-6">
        <h2 className="text-base font-bold tracking-tight text-ink">{title}</h2>
        <ul className="mt-4 space-y-3">
          {items.map((i) => (
            <li key={i.id} className="flex items-start gap-3">
              <span className="mt-0.5 h-4 w-4 shrink-0 rounded border border-line-strong bg-surface" />
              <span className="text-sm font-semibold text-ink-soft">{i.title}</span>
            </li>
          ))}
        </ul>
      </section>
    );
  }

  const progressText = progressTemplate
    .replace("{done}", String(done))
    .replace("{total}", String(items.length));
  const pct = items.length ? Math.round((done / items.length) * 100) : 0;

  return (
    <section className="surface-elevated rounded-3xl p-5 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-bold tracking-tight text-ink">{title}</h2>
        <div className="flex items-center gap-3">
          <span className="num text-xs font-bold text-muted">{progressText}</span>
          {done > 0 && (
            <button
              type="button"
              onClick={reset}
              className="text-xs font-semibold text-faint underline-offset-2 transition-colors hover:text-danger hover:underline"
            >
              {resetLabel}
            </button>
          )}
        </div>
      </div>
      {hint && <p className="mt-1 text-xs text-muted">{hint}</p>}
      <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-surface-2">
        <div
          className="h-full rounded-full bg-success transition-[width] duration-300"
          style={{ width: `${pct}%` }}
          aria-hidden
        />
      </div>
      {done === items.length && items.length > 0 && (
        <p className="mt-3 text-sm font-semibold text-success">{doneAllLabel}</p>
      )}
      <ul className="mt-4 space-y-2">
        {items.map((i) => {
          const on = !!checked[i.id];
          return (
            <li key={i.id} className="rounded-2xl border border-line bg-surface p-3">
              <label className="flex cursor-pointer items-start gap-3">
                <input
                  type="checkbox"
                  checked={on}
                  onChange={() => toggle(i.id)}
                  className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--success)]"
                />
                <span className="min-w-0">
                  <span
                    className={`block text-sm font-semibold ${
                      on ? "text-faint line-through" : "text-ink"
                    }`}
                  >
                    {i.title}
                  </span>
                  {i.desc && (
                    <span className="mt-0.5 block text-xs leading-relaxed text-muted">
                      {i.desc}
                    </span>
                  )}
                  {i.source && (
                    <a
                      href={i.source.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="mt-1 inline-flex items-center gap-1 text-xs font-semibold text-accent underline-offset-2 hover:underline"
                    >
                      {i.source.label}
                      <span aria-hidden className="rtl:-scale-x-100">↗</span>
                    </a>
                  )}
                </span>
              </label>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
