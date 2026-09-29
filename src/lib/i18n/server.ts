import "server-only";

/**
 * Server-side i18n. Server components cannot read client context, so they
 * resolve the language from the persisted cookie (written by setLangAction)
 * and translate through the same pure `translate()` as the client.
 */
import { cookies } from "next/headers";
import { resolveLang, translate, type Language, type TranslateVars } from "./core";

/** The persisted UI language for the current request (default: de). */
export async function getRequestLang(): Promise<Language> {
  const store = await cookies();
  return resolveLang(store.get("aha_lang")?.value);
}

/** A bound `t` for server components. */
export async function getServerT(): Promise<
  (path: string, vars?: TranslateVars) => string
> {
  const lang = await getRequestLang();
  return (path, vars) => translate(lang, path, vars);
}
