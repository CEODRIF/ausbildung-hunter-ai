/**
 * Pure i18n helpers — no React, no DOM. Unit-testable in isolation and
 * imported by both the provider (client) and tests (node).
 */
import {
  dictionaries,
  DEFAULT_LANGUAGE,
  LANGUAGE_META,
  SUPPORTED_LANGUAGES,
  type Dict,
  type Language,
} from "./dictionaries";

export type { Dict, Language } from "./dictionaries";

export type TranslateVars = Record<string, string | number>;

/** localStorage key for the persisted UI language (client mirror). */
export const LANG_STORAGE_KEY = "aha:lang";

/** Cookie holding the persisted UI language (server-readable source of
 *  truth, so server components render the chosen language). */
export const LANG_COOKIE = "aha_lang";

/**
 * Inline script that sets <html lang> and <html dir> before paint so Arabic
 * renders RTL on the very first frame. Reads the cookie first (authoritative),
 * localStorage as fallback. Mirrors the supported set in `dictionaries.ts`.
 */
export function langPreloadScript(): string {
  return `
(function(){
  function getCookie(name){
    try {
      var m = document.cookie.match(new RegExp("(?:^|; )"+name+"=([^;]*)"));
      return m ? decodeURIComponent(m[1]) : null;
    } catch (e) { return null; }
  }
  var lang = null;
  try {
    lang = getCookie("${LANG_COOKIE}") || window.localStorage.getItem("${LANG_STORAGE_KEY}");
  } catch (e) {}
  if (["de","en","fr","ar"].indexOf(lang) === -1) lang = "de";
  var dirs = { de: "ltr", en: "ltr", fr: "ltr", ar: "rtl" };
  document.documentElement.setAttribute("lang", lang);
  document.documentElement.setAttribute("dir", dirs[lang] || "ltr");
})();
`;
}

/** Coerce any stored/raw value into a supported language (else default). */
export function resolveLang(raw: string | null | undefined): Language {
  if (raw && (SUPPORTED_LANGUAGES as readonly string[]).includes(raw)) {
    return raw as Language;
  }
  return DEFAULT_LANGUAGE;
}

/** Text direction for a language (Arabic is the only RTL one). */
export function dirForLang(lang: Language): "ltr" | "rtl" {
  return LANGUAGE_META[lang].dir;
}

const LOCALES: Record<Language, string> = {
  de: "de-DE",
  en: "en-US",
  fr: "fr-FR",
  ar: "ar",
};

/** BCP-47 locale for date/number formatting in the active language. */
export function localeForLang(lang: Language): string {
  return LOCALES[lang];
}

/** Replace `{token}` placeholders; unknown tokens are left untouched. */
export function interpolate(template: string, vars?: TranslateVars): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (whole, key: string) =>
    key in vars ? String(vars[key]) : whole,
  );
}

/** Dot-path lookup into a dictionary; returns the leaf string or null. */
export function lookup(dict: Dict, path: string): string | null {
  let node: unknown = dict;
  for (const segment of path.split(".")) {
    if (typeof node !== "object" || node === null || !(segment in node)) {
      return null;
    }
    node = (node as Record<string, unknown>)[segment];
  }
  return typeof node === "string" ? node : null;
}

/**
 * Translate a dot-path key. Falls back to the German dictionary (the
 * source of truth) when the active language lacks the key, then to the raw
 * key as a last resort — so a missing translation is never a blank string.
 */
export function translate(
  lang: Language,
  path: string,
  vars?: TranslateVars,
): string {
  const dict = dictionaries[lang];
  const found = lookup(dict, path) ?? (dict !== dictionaries.de
    ? lookup(dictionaries.de, path)
    : null);
  return interpolate(found ?? path, vars);
}
