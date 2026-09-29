"use client";

/**
 * Client i18n provider.
 *
 * Design notes:
 *  - The persisted language is applied *after* mount (in an effect) so the
 *    first client render matches the server render — no hydration mismatch.
 *    The correct `lang`/`dir` for the very first paint is set by the
 *    pre-hydration inline script in the root layout, so RTL (Arabic) is
 *    correct before React even hydrates.
 *  - Only interface strings are translated. Data (CVs, AI output, company
 *    records) is rendered verbatim and never passes through `t()`.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  DEFAULT_LANGUAGE,
  SUPPORTED_LANGUAGES,
  type Language,
} from "./dictionaries";
import {
  dirForLang,
  LANG_COOKIE,
  LANG_STORAGE_KEY,
  resolveLang,
  translate,
  type TranslateVars,
} from "./core";
import { setLangAction } from "./actions";

interface I18nValue {
  lang: Language;
  dir: "ltr" | "rtl";
  setLang: (lang: Language) => void;
  t: (path: string, vars?: TranslateVars) => string;
  supportedLanguages: readonly Language[];
}

const I18nContext = createContext<I18nValue | null>(null);

function applyDocumentAttributes(lang: Language) {
  if (typeof document === "undefined") return;
  const dir = dirForLang(lang);
  document.documentElement.lang = lang;
  document.documentElement.dir = dir;
}

export function I18nProvider({ children }: { children: ReactNode }) {
  // Always start on the server/default so server and first client render agree.
  const [lang, setLangState] = useState<Language>(DEFAULT_LANGUAGE);

  // After hydration, restore the persisted choice (cookie first — it is the
  // server source of truth — then the localStorage mirror) and fix the
  // dir/lang attributes.
  useEffect(() => {
    let resolved: Language = DEFAULT_LANGUAGE;
    try {
      let cookieLang: string | null = null;
      const match = document.cookie.match(
        new RegExp("(?:^|; )" + LANG_COOKIE + "=([^;]*)"),
      );
      if (match) cookieLang = decodeURIComponent(match[1]);
      resolved = resolveLang(cookieLang ?? window.localStorage.getItem(LANG_STORAGE_KEY));
    } catch {
      /* storage unavailable — keep default */
    }
    applyDocumentAttributes(resolved);
    // Intentional post-hydration restore of the persisted language (cookie /
    // localStorage); the server render uses the default on purpose.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (resolved !== DEFAULT_LANGUAGE) setLangState(resolved);
  }, []);

  // Keep the document attributes in sync whenever the language changes.
  useEffect(() => {
    applyDocumentAttributes(lang);
  }, [lang]);

  const setLang = useCallback((next: Language) => {
    setLangState(next);
    try {
      window.localStorage.setItem(LANG_STORAGE_KEY, next);
    } catch {
      /* ignore persistence errors (private mode, etc.) */
    }
    // Persist server-side too, so the next server render matches. Fire and
    // forget: the UI already updated via context; a cookie failure only
    // costs SSR consistency on the next hard reload.
    void setLangAction(next).catch(() => undefined);
  }, []);

  const t = useCallback(
    (path: string, vars?: TranslateVars) => translate(lang, path, vars),
    [lang],
  );

  const value = useMemo<I18nValue>(
    () => ({
      lang,
      dir: dirForLang(lang),
      setLang,
      t,
      supportedLanguages: SUPPORTED_LANGUAGES,
    }),
    [lang, setLang, t],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const ctx = useContext(I18nContext);
  if (!ctx) {
    throw new Error("useI18n must be used within an <I18nProvider>");
  }
  return ctx;
}

export { resolveLang, dirForLang, translate, interpolate, lookup } from "./core";
export {
  dictionaries,
  LANGUAGE_META,
  DEFAULT_LANGUAGE,
  SUPPORTED_LANGUAGES,
  type Dict,
  type Language,
} from "./dictionaries";
export type { TranslateVars } from "./core";
