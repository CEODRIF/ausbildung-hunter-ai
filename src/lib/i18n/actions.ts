"use server";

/**
 * Persists the UI language in a cookie (server-readable) so the next server
 * render — full reloads, links, email deep links — uses the chosen language.
 * The client mirror (localStorage) is written by the provider itself.
 */
import { cookies } from "next/headers";
import { LANG_COOKIE, resolveLang, type Language } from "./core";

export async function setLangAction(raw: string): Promise<Language> {
  const lang = resolveLang(raw);
  const store = await cookies();
  store.set(LANG_COOKIE, lang, {
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
    sameSite: "lax",
    httpOnly: false,
  });
  return lang;
}
