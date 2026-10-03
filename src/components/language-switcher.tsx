"use client";

/**
 * Global language switcher. Compact globe button + ISO code, polished
 * dropdown with native language names. Selecting a language updates the UI
 * immediately, persists to localStorage, and — for Arabic — flips the whole
 * layout to RTL (via <html dir="rtl">, handled by the i18n provider).
 */
import { useCallback, useState } from "react";
import { useI18n } from "@/lib/i18n";
import { useDismiss } from "@/lib/use-dismiss";
import { LANGUAGE_META, type Language } from "@/lib/i18n/dictionaries";
import { Icon } from "@/components/icon";

/**
 * `dropUp`  — anchor the menu ABOVE the button (controls at the bottom of
 *            a full-height rail: mobile drawer footer, collapsed sidebar).
 * `compact` — icon-only trigger for very narrow rails (collapsed sidebar).
 */
export function LanguageSwitcher({
  dropUp = false,
  compact = false,
}: {
  dropUp?: boolean;
  compact?: boolean;
}) {
  const { lang, setLang, supportedLanguages, t } = useI18n();
  const [open, setOpen] = useState(false);
  const rootRef = useDismiss(open, useCallback(() => setOpen(false), []));

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-label={t("lang.label")}
        aria-haspopup="menu"
        aria-expanded={open}
        className={`flex h-9 items-center gap-1.5 rounded-xl border border-line-strong text-sm font-semibold text-muted transition-colors hover:bg-surface-2 hover:text-ink ${
          compact ? "w-9 justify-center" : "px-2.5"
        }`}
      >
        <Icon name="globe" size={17} />
        {!compact && <span className="uppercase">{lang}</span>}
      </button>
      {open && (
        <div
          role="menu"
          aria-label={t("lang.label")}
          className={`absolute end-0 z-50 w-48 overflow-hidden rounded-xl border border-line bg-surface p-1 card-shadow ${
            dropUp ? "bottom-11" : "top-11"
          }`}
        >
          {supportedLanguages.map((value: Language) => {
            const active = value === lang;
            return (
              <button
                key={value}
                type="button"
                role="menuitemradio"
                aria-checked={active}
                onClick={() => {
                  setLang(value);
                  setOpen(false);
                }}
                className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-semibold transition-colors ${
                  active
                    ? "bg-accent-soft text-accent"
                    : "text-ink-soft hover:bg-surface-2"
                }`}
              >
                <span className="flex h-5 w-8 shrink-0 items-center justify-center rounded-md border border-line bg-surface-2 text-[10px] font-bold uppercase tracking-wide text-muted">
                  {LANGUAGE_META[value].code}
                </span>
                <span className="flex-1 text-start">{LANGUAGE_META[value].native}</span>
                {active && <Icon name="check" size={15} />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
