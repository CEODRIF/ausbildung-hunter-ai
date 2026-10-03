"use client";

/**
 * Theme switcher (Light / Dark / System).
 *
 * The mode is persisted to localStorage and applied by toggling the `dark`
 * class on <html> — the only theme mutation. A pre-hydration inline script
 * (see themePreloadScript) already applied the right theme before first
 * paint, so there is no flash of the wrong theme. Manual switches get a
 * brief 200 ms color transition via the `theme-anim` class.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "@/lib/i18n";
import { useDismiss } from "@/lib/use-dismiss";
import {
  DEFAULT_THEME_MODE,
  resolveEffectiveTheme,
  resolveThemeMode,
  THEME_STORAGE_KEY,
  type ThemeMode,
} from "@/lib/theme";
import { Icon, type IconName } from "@/components/icon";

const MODE_ICONS: Record<ThemeMode, IconName> = {
  light: "sun",
  dark: "moon",
  system: "monitor",
};

const MODES: readonly ThemeMode[] = ["light", "dark", "system"];

export function ThemeSwitcher({ dropUp = false }: { dropUp?: boolean }) {
  const { t } = useI18n();
  // Server + first client render use the default mode; the persisted mode is
  // restored in an effect (no hydration mismatch).
  const [mode, setMode] = useState<ThemeMode>(DEFAULT_THEME_MODE);
  const [open, setOpen] = useState(false);
  const modeRef = useRef(mode);
  const rootRef = useDismiss(open, useCallback(() => setOpen(false), []));

  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  const applyMode = useCallback((next: ThemeMode, dark: boolean) => {
    document.documentElement.classList.toggle(
      "dark",
      resolveEffectiveTheme(next, dark) === "dark",
    );
  }, []);

  // Restore persisted mode + follow OS changes while in system mode.
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    let restored: ThemeMode = DEFAULT_THEME_MODE;
    try {
      restored = resolveThemeMode(window.localStorage.getItem(THEME_STORAGE_KEY));
    } catch {
      /* storage unavailable — keep default */
    }
    // Intentional post-hydration restore of the persisted external value
    // (localStorage); the server render uses the default on purpose.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMode(restored);
    applyMode(restored, media.matches);

    const onMediaChange = (event: MediaQueryListEvent) => {
      applyMode(modeRef.current, event.matches);
    };
    media.addEventListener("change", onMediaChange);
    return () => media.removeEventListener("change", onMediaChange);
  }, [applyMode]);

  const choose = (next: ThemeMode) => {
    setMode(next);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      /* ignore persistence errors */
    }
    // Apply the persisted choice immediately — the `dark` class on <html>
    // is the single theme mutation (same mechanism as themePreloadScript).
    try {
      applyMode(
        next,
        window.matchMedia("(prefers-color-scheme: dark)").matches,
      );
    } catch {
      /* DOM unavailable */
    }
    const html = document.documentElement;
    html.classList.add("theme-anim");
    window.setTimeout(() => html.classList.remove("theme-anim"), 350);
    setOpen(false);
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-label={t("theme.label")}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex h-9 w-9 items-center justify-center rounded-xl border border-line-strong text-muted transition-colors hover:bg-surface-2 hover:text-ink"
      >
        <Icon name={MODE_ICONS[mode]} size={18} />
      </button>
      {open && (
        <div
          role="menu"
          aria-label={t("theme.label")}
          className={`absolute end-0 z-50 w-44 overflow-hidden rounded-xl border border-line bg-surface p-1 card-shadow ${
            dropUp ? "bottom-11" : "top-11"
          }`}
        >
          {MODES.map((value) => {
            const active = value === mode;
            return (
              <button
                key={value}
                type="button"
                role="menuitemradio"
                aria-checked={active}
                onClick={() => choose(value)}
                className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-semibold transition-colors ${
                  active
                    ? "bg-accent-soft text-accent"
                    : "text-ink-soft hover:bg-surface-2"
                }`}
              >
                <Icon name={MODE_ICONS[value]} size={16} />
                <span className="flex-1 text-start">{t(`theme.${value}`)}</span>
                {active && <Icon name="check" size={15} />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
