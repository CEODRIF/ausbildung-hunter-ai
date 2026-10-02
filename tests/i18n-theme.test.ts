import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  LANG_COOKIE,
  LANG_STORAGE_KEY,
  dirForLang,
  interpolate,
  langPreloadScript,
  localeForLang,
  lookup,
  resolveLang,
  translate,
} from "@/lib/i18n/core";
import {
  DEFAULT_LANGUAGE,
  SUPPORTED_LANGUAGES,
  dictionaries,
} from "@/lib/i18n/dictionaries";
import {
  DEFAULT_THEME_MODE,
  THEME_STORAGE_KEY,
  resolveEffectiveTheme,
  resolveThemeMode,
  systemPrefersDark,
  themePreloadScript,
} from "@/lib/theme";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const read = (relative: string) =>
  readFileSync(resolve(root, relative), "utf8");

// ---------------------------------------------------------------------------
// Locale switching
// ---------------------------------------------------------------------------

describe("locale switching", () => {
  it("resolves supported languages and falls back to the default", () => {
    expect(resolveLang("en")).toBe("en");
    expect(resolveLang("fr")).toBe("fr");
    expect(resolveLang("ar")).toBe("ar");
    expect(resolveLang("de")).toBe("de");
    expect(resolveLang(null)).toBe(DEFAULT_LANGUAGE);
    expect(resolveLang("")).toBe(DEFAULT_LANGUAGE);
    expect(resolveLang("xx")).toBe(DEFAULT_LANGUAGE);
    expect(DEFAULT_LANGUAGE).toBe("de");
  });

  it("translates the same key across all four languages", () => {
    const sample = [
      { key: "nav.dashboard", de: "Dashboard", en: "Dashboard" },
      { key: "theme.dark", de: "Dunkel", en: "Dark" },
      { key: "account.disconnect", de: "Trennen", en: "Disconnect" },
      { key: "admin.title", de: "Benutzerverwaltung", en: "User administration" },
    ];
    for (const { key, de, en } of sample) {
      expect(translate("de", key)).toBe(de);
      expect(translate("en", key)).toBe(en);
      // Every language resolves the key to a non-empty string.
      for (const lang of SUPPORTED_LANGUAGES) {
        const value = translate(lang as keyof typeof dictionaries, key);
        expect(value.length, `${lang}:${key}`).toBeGreaterThan(0);
      }
    }
  });

  it("interpolates {vars} and leaves unknown tokens untouched", () => {
    expect(interpolate("A {x} B", { x: 2 })).toBe("A 2 B");
    expect(interpolate("A {x} B", { x: "y" })).toBe("A y B");
    expect(interpolate("A {x} B", { y: 1 })).toBe("A {x} B");
    expect(interpolate("A {x} B")).toBe("A {x} B");
    expect(translate("en", "account.matchAtSave", { score: 87 })).toBe(
      "Match at save: 87 %",
    );
  });

  it("persists the language via the documented storage keys", () => {
    expect(LANG_STORAGE_KEY).toBe("aha:lang");
    expect(LANG_COOKIE).toBe("aha_lang");
    const script = langPreloadScript();
    expect(script).toContain(LANG_COOKIE);
    expect(script).toContain(LANG_STORAGE_KEY);
  });

  it("returns the BCP-47 locale per language", () => {
    expect(localeForLang("de")).toBe("de-DE");
    expect(localeForLang("en")).toBe("en-US");
    expect(localeForLang("fr")).toBe("fr-FR");
    expect(localeForLang("ar")).toBe("ar");
  });

  it("falls back to German for a missing key, then to the raw key", () => {
    expect(translate("en", "nav.nonexistent.key")).toBe("nav.nonexistent.key");
    expect(lookup(dictionaries.de, "nope.nope")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Arabic RTL
// ---------------------------------------------------------------------------

describe("Arabic RTL", () => {
  it("marks only Arabic as rtl", () => {
    expect(dirForLang("ar")).toBe("rtl");
    expect(dirForLang("de")).toBe("ltr");
    expect(dirForLang("en")).toBe("ltr");
    expect(dirForLang("fr")).toBe("ltr");
  });

  it("sets lang + dir before first paint via the preload script", () => {
    const script = langPreloadScript();
    expect(script).toContain('setAttribute("lang"');
    expect(script).toContain('setAttribute("dir"');
    expect(script).toContain('ar: "rtl"');
  });

  it("uses logical properties in the shell and layout (no manual RTL overrides)", () => {
    const shell = read("src/components/app-shell.tsx");
    for (const logical of ["ms-", "me-", "ps-", "start-", "end-"]) {
      expect(shell, `app-shell should use ${logical}*`).toContain(logical);
    }
    // Physical left/right classes are reserved for true 50/50 cases (drawer).
    expect(read("src/app/globals.css")).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Theme switching + persistence
// ---------------------------------------------------------------------------

describe("theme switching", () => {
  it("resolves stored modes and falls back to the default", () => {
    expect(resolveThemeMode("light")).toBe("light");
    expect(resolveThemeMode("dark")).toBe("dark");
    expect(resolveThemeMode("system")).toBe("system");
    expect(resolveThemeMode(null)).toBe(DEFAULT_THEME_MODE);
    expect(resolveThemeMode("neon")).toBe(DEFAULT_THEME_MODE);
    expect(DEFAULT_THEME_MODE).toBe("system");
  });

  it("derives the effective theme from mode + OS preference", () => {
    expect(resolveEffectiveTheme("light", true)).toBe("light");
    expect(resolveEffectiveTheme("light", false)).toBe("light");
    expect(resolveEffectiveTheme("dark", true)).toBe("dark");
    expect(resolveEffectiveTheme("dark", false)).toBe("dark");
    expect(resolveEffectiveTheme("system", true)).toBe("dark");
    expect(resolveEffectiveTheme("system", false)).toBe("light");
    expect(systemPrefersDark({ matches: true })).toBe(true);
    expect(systemPrefersDark({ matches: false })).toBe(false);
    expect(systemPrefersDark(null)).toBe(false);
  });

  it("applies the theme before first paint (no flash of wrong theme)", () => {
    expect(THEME_STORAGE_KEY).toBe("aha:theme");
    const script = themePreloadScript;
    expect(script).toContain(THEME_STORAGE_KEY);
    expect(script).toContain('prefers-color-scheme: dark');
    expect(script).toContain('classList.add("dark")');
    const layout = read("src/app/layout.tsx");
    expect(layout).toContain("themePreloadScript");
    expect(layout).toContain("langPreloadScript");
  });
});

// ---------------------------------------------------------------------------
// Dictionary completeness (key parity across all four languages)
// ---------------------------------------------------------------------------

type Tree = { leaves: string[]; nodes: Tree[] };

function walk(node: unknown, prefix = ""): Tree {
  const result: Tree = { leaves: [], nodes: [] };
  if (node === null || typeof node !== "object") return result;
  for (const [key, value] of Object.entries(
    node as Record<string, unknown>,
  )) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "string") {
      result.leaves.push(path);
    } else if (value !== null && typeof value === "object") {
      const child = walk(value, path);
      if (child.leaves.length || child.nodes.length) result.nodes.push(child);
    }
  }
  return result;
}

function allLeaves(tree: Tree): string[] {
  return [...tree.leaves, ...tree.nodes.flatMap(allLeaves)];
}

describe("dictionary completeness", () => {
  const deLeaves = new Set(allLeaves(walk(dictionaries.de)));

  it("has a substantial German dictionary", () => {
    expect(deLeaves.size).toBeGreaterThan(150);
  });

  it("keeps en/fr/ar structurally identical to de (no missing/extra keys)", () => {
    for (const lang of ["en", "fr", "ar"] as const) {
      const others = new Set(allLeaves(walk(dictionaries[lang])));
      const missing = [...deLeaves].filter((key) => !others.has(key));
      const extra = [...others].filter((key) => !deLeaves.has(key));
      expect(missing, `${lang} missing keys`).toEqual([]);
      expect(extra, `${lang} extra keys`).toEqual([]);
    }
  });

  it("never contains an empty translation", () => {
    for (const lang of SUPPORTED_LANGUAGES) {
      const dict = dictionaries[lang];
      const visit = (node: unknown, path: string) => {
        for (const [key, value] of Object.entries(
          node as Record<string, unknown>,
        )) {
          const next = path ? `${path}.${key}` : key;
          if (typeof value === "string") {
            expect(value.trim(), `${lang}:${next}`).not.toBe("");
          } else if (value && typeof value === "object") {
            visit(value, next);
          }
        }
      };
      visit(dict, "");
    }
  });
});

// ---------------------------------------------------------------------------
// Navigation + AppShell critical behavior (source-level)
// ---------------------------------------------------------------------------

describe("navigation + app shell", () => {
  const shell = read("src/components/app-shell.tsx");

  it("groups navigation into WORKSPACE / TOOLS / ACCOUNT", () => {
    expect(shell).toContain('"nav.workspace"');
    expect(shell).toContain('"nav.tools"');
    expect(shell).toContain('"nav.account"');
  });

  it("only links to real routes (placeholder items are marked soon)", () => {
    const navRegion = shell.slice(
      shell.indexOf("const NAV_SECTIONS"),
      shell.indexOf("// Route → header"),
    );
    const hrefLines = navRegion
      .split("\n")
      .filter((line) => /href: "[^"]+"/.test(line));
    expect(hrefLines.length).toBeGreaterThan(6);
    for (const line of hrefLines) {
      const href = /href: "([^"]+)"/.exec(line)?.[1] ?? "";
      if (href === "#") {
        expect(line, `placeholder nav item must be marked soon: ${line}`).toContain(
          "soon: true",
        );
      } else {
        expect(href, `nav href must be a route: ${line}`).toMatch(/^\//);
      }
    }
  });

  it("includes the required workspace routes", () => {
    for (const route of [
      "/dashboard",
      "/ai",
      "/bewerbung-scanner",
      "/applications",
      "/opportunities/saved",
      "/settings/email",
      "/settings/usage",
    ]) {
      expect(shell, `nav must link ${route}`).toContain(`href: "${route}"`);
    }
  });

  it("provides accessible nav states (aria-current, collapsed tooltips)", () => {
    expect(shell).toContain('aria-current={active ? "page" : undefined}');
    expect(shell).toContain("title={collapsed ? label : undefined}");
  });

  it("renders exactly one global <main> in the shell", () => {
    const opens = (shell.match(/<main[\s>]/g) ?? []).length;
    const closes = (shell.match(/<\/main>/g) ?? []).length;
    expect(opens).toBe(1);
    expect(closes).toBe(1);
  });

  it("switchers are keyboard-accessible menus with labels", () => {
    for (const file of [
      "src/components/language-switcher.tsx",
      "src/components/theme-switcher.tsx",
    ]) {
      const source = read(file);
      expect(source).toContain('aria-haspopup="menu"');
      expect(source).toContain("aria-expanded");
      expect(source).toContain('role="menu"');
      expect(source).toContain('role="menuitemradio"');
      expect(source).toContain("aria-label");
    }
  });

  it("no shell-wrapped page keeps its own <main> or duplicate h1 header", () => {
    const offenders = [
      "src/app/settings/data/page.tsx",
      "src/app/settings/usage/page.tsx",
      "src/app/settings/email/page.tsx",
      "src/app/settings/billing/page.tsx",
      "src/app/opportunities/saved/page.tsx",
      "src/app/applications/new/page.tsx",
      "src/app/applications/campaign/[id]/page.tsx",
      "src/app/bewerbung-scanner/page.tsx",
      "src/app/bewerbung-scanner/[id]/page.tsx",
      "src/components/bewerbung-scanner-upload.tsx",
      "src/components/bewerbung-results.tsx",
    ];
    for (const file of offenders) {
      const source = read(file);
      expect(source, `${file} must not open its own <main>`).not.toContain(
        "<main",
      );
    }
  });
});
