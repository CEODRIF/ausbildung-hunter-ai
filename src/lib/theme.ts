/**
 * Pure theme helpers — no DOM access so they are unit-testable in node.
 *
 * The effective theme is derived from the user's *mode* (light | dark |
 * system) and the OS preference. Components never decide colors themselves;
 * they render semantic token utilities (bg-surface, text-ink, border-line…)
 * which the `.dark` scope in globals.css remaps. Flipping the `dark` class
 * on <html> is the only theme mutation that happens.
 */

export type ThemeMode = "light" | "dark" | "system";
export type EffectiveTheme = "light" | "dark";

/** localStorage key for the persisted theme mode. */
export const THEME_STORAGE_KEY = "aha:theme";
export const DEFAULT_THEME_MODE: ThemeMode = "system";

const MODES: readonly string[] = ["light", "dark", "system"];

/** Coerce any stored value into a valid mode (else default). */
export function resolveThemeMode(raw: string | null | undefined): ThemeMode {
  if (raw && MODES.includes(raw)) return raw as ThemeMode;
  return DEFAULT_THEME_MODE;
}

/** Does the OS prefer dark right now? (media may be injected in tests) */
export function systemPrefersDark(
  media?: Pick<MediaQueryList, "matches"> | null,
): boolean {
  return Boolean(media?.matches);
}

/** The concrete light/dark theme for a mode + OS preference. */
export function resolveEffectiveTheme(
  mode: ThemeMode,
  osPrefersDark: boolean,
): EffectiveTheme {
  if (mode === "light") return "light";
  if (mode === "dark") return "dark";
  return osPrefersDark ? "dark" : "light";
}

/**
 * Inline script placed in <head> *before* any paint. It reads the persisted
 * mode and, for `system`, the OS media query, then sets the `dark` class on
 * <html>. This prevents a flash of the wrong theme on first load.
 */
export const themePreloadScript = `
(function(){
  try {
    var mode = null;
    try { mode = window.localStorage.getItem("${THEME_STORAGE_KEY}"); } catch (e) {}
    var dark = false;
    if (mode === "dark") { dark = true; }
    else if (mode === null || mode === undefined || mode === "system" || mode === "") {
      dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    }
    if (dark) document.documentElement.classList.add("dark");
  } catch (e) {}
})();
`;


