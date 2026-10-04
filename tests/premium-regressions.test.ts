import { readFileSync } from "node:fs";
import { readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { dirForLang, lookup, translate } from "@/lib/i18n/core";
import {
  dictionaries,
  SUPPORTED_LANGUAGES,
} from "@/lib/i18n/dictionaries";
import {
  resolveEffectiveTheme,
  resolveThemeMode,
  themePreloadScript,
  THEME_STORAGE_KEY,
} from "@/lib/theme";

/**
 * Regression guards for the premium redesign (2026).
 *
 * The redesign shipped four user-visible bugs: raw `premium.*` keys
 * (the block was nested under `nav` in all four dictionaries), a theme
 * switcher that persisted but never applied the `dark` class, and mobile
 * RTL overflow (header wordmark, off-canvas drawer visible on desktop,
 * bottom nav covering the footer). These tests pin the fixes.
 */
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const read = (relative: string) => readFileSync(resolve(root, relative), "utf8");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = resolve(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith(".ts") || full.endsWith(".tsx")) out.push(full);
  }
  return out;
}

/** Every static `t("a.b.c")` key used anywhere in src. */
function collectStaticKeys(): string[] {
  const keys = new Set<string>();
  for (const file of walk(resolve(root, "src"))) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(/\bt\(\s*"([a-zA-Z][a-zA-Z0-9_.]+)"/g)) {
      keys.add(match[1]);
    }
  }
  return [...keys];
}

/** Every leaf path inside the `premium` namespace of the German dict. */
function collectPremiumPaths(node: unknown, prefix = "premium"): string[] {
  if (typeof node === "string") return [prefix];
  if (node && typeof node === "object") {
    return Object.entries(node as Record<string, unknown>).flatMap(
      ([key, value]) => collectPremiumPaths(value, `${prefix}.${key}`),
    );
  }
  return [];
}

describe("premium i18n: no raw keys reach the UI", () => {
  it("resolves every static t() key in src for the German source of truth", () => {
    const raw = collectStaticKeys().filter((key) => {
      let node: unknown = dictionaries.de;
      for (const segment of key.split(".")) {
        if (typeof node !== "object" || node === null || !(segment in node)) {
          return true;
        }
        node = (node as Record<string, unknown>)[segment];
      }
      return typeof node !== "string";
    });
    expect(raw).toEqual([]);
  });

  it("resolves every premium.* key DIRECTLY in all four dictionaries (no de fallback)", () => {
    const premiumKeys = collectStaticKeys().filter((key) =>
      key.startsWith("premium."),
    );
    expect(premiumKeys.length).toBeGreaterThan(5);
    for (const lang of SUPPORTED_LANGUAGES) {
      for (const key of premiumKeys) {
        const value = lookup(dictionaries[lang], key);
        expect(value, `${lang}:${key}`).not.toBeNull();
        expect(value?.length).toBeGreaterThan(0);
        expect(value).not.toBe(key);
      }
    }
  });

  it("keeps all four dictionaries structurally complete for premium.*", () => {
    const paths = collectPremiumPaths(dictionaries.de.premium);
    expect(paths.length).toBeGreaterThan(20);
    for (const lang of SUPPORTED_LANGUAGES) {
      for (const path of paths) {
        const value = lookup(dictionaries[lang], path);
        expect(value, `${lang}:${path}`).not.toBeNull();
        expect(typeof value).toBe("string");
        expect((value as string).length).toBeGreaterThan(0);
      }
    }
  });

  it("arabic premium values are real arabic text", () => {
    const arabic = /[\u0600-\u06FF]/;
    for (const path of collectPremiumPaths(dictionaries.ar.premium)) {
      const value = lookup(dictionaries.ar, path);
      expect(value, path).not.toBeNull();
      expect(arabic.test(value as string), `${path} must be arabic`).toBe(true);
    }
    expect(translate("ar", "premium.hero.title")).not.toBe(
      "premium.hero.title",
    );
  });
});

describe("language switching", () => {
  it("maps every language to the correct text direction", () => {
    expect(dirForLang("ar")).toBe("rtl");
    expect(dirForLang("de")).toBe("ltr");
    expect(dirForLang("en")).toBe("ltr");
    expect(dirForLang("fr")).toBe("ltr");
  });

  it("setLang updates state, persists localStorage and syncs the cookie", () => {
    const provider = read("src/lib/i18n/index.tsx");
    const setLangBlock = provider.slice(
      provider.indexOf("const setLang = useCallback"),
      provider.indexOf("const t = useCallback"),
    );
    expect(setLangBlock).toContain("setLangState(next)");
    expect(setLangBlock).toContain("localStorage.setItem(LANG_STORAGE_KEY, next)");
    // The server-readable cookie keeps SSR in sync (same existing path).
    expect(setLangBlock).toContain("setLangAction(next)");
    // dir/lang are derived, never per-button: one effect applies them.
    const docBlock = provider.slice(
      provider.indexOf("function applyDocumentAttributes"),
      provider.indexOf("export function I18nProvider"),
    );
    expect(docBlock).toContain("document.documentElement.lang = lang;");
    expect(docBlock).toContain("document.documentElement.dir = dir;");
    expect(provider).toContain("applyDocumentAttributes(lang);");
  });

  it("switcher applies the clicked language through the existing context", () => {
    const switcher = read("src/components/language-switcher.tsx");
    expect(switcher).toContain("const { lang, setLang, supportedLanguages, t } = useI18n();");
    // The menu item must call the SAME setLang (no parallel language system).
    expect(switcher).toMatch(/onClick=\{\(\) => \{\s*setLang\(value\);/);
    expect(switcher).not.toContain("document.documentElement.lang =");
    // RTL/LTR is driven by the provider, never per-button.
    expect(switcher).toContain("const active = value === lang;");
    expect(switcher).toContain("aria-checked={active}");
  });

  it("the preload script pins lang + dir before first paint", () => {
    const layout = read("src/app/layout.tsx");
    expect(layout).toContain("langPreloadScript()");
    expect(layout).toContain("themePreloadScript");
  });
});

describe("theme switching", () => {
  it("derives the effective theme from mode + OS preference", () => {
    expect(resolveThemeMode("dark")).toBe("dark");
    expect(resolveThemeMode("nonsense")).toBe("system");
    expect(resolveEffectiveTheme("light", true)).toBe("light");
    expect(resolveEffectiveTheme("dark", false)).toBe("dark");
    expect(resolveEffectiveTheme("system", true)).toBe("dark");
    expect(resolveEffectiveTheme("system", false)).toBe("light");
  });

  it("applying a chosen mode toggles the .dark class immediately (the fix)", () => {
    const switcher = read("src/components/theme-switcher.tsx");
    const chooseStart = switcher.indexOf("const choose = (next: ThemeMode)");
    const chooseBlock = switcher.slice(
      chooseStart,
      switcher.indexOf("\n  return (", chooseStart),
    );
    // choose() must not only persist — it must APPLY the theme via the
    // single class-toggle mechanism, else the click visually does nothing.
    expect(chooseBlock).toContain(
      "window.localStorage.setItem(THEME_STORAGE_KEY, next)",
    );
    expect(chooseBlock).toContain("applyMode(");
    expect(chooseBlock).toContain("matchMedia(\"(prefers-color-scheme: dark)\")");
    const applyBlock = switcher.slice(
      switcher.indexOf("const applyMode = useCallback"),
      switcher.indexOf("// Restore persisted mode"),
    );
    expect(applyBlock).toContain('classList.toggle(');
    expect(applyBlock).toContain('"dark"');
  });

  it("persists and restores through the documented .dark-class mechanism", () => {
    expect(themePreloadScript).toContain(THEME_STORAGE_KEY);
    expect(themePreloadScript).toContain('classList.add("dark")');
    const globals = read("src/app/globals.css");
    expect(globals).toContain(".dark {");
    expect(globals).toContain(".dark .glass");
  });
});

describe("mobile shell: drawer, bottom nav, header fit", () => {
  const shell = read("src/components/app-shell.tsx");

  it("drawer exists only on mobile and stays inside the viewport", () => {
    expect(shell).toContain("fixed inset-y-0 start-0 z-40 hidden max-lg:flex");
    expect(shell).toContain("w-[290px] max-w-[calc(100vw-1.5rem)]");
    // Logical off-canvas for BOTH directions (right edge in RTL).
    expect(shell).toContain("ltr:max-lg:-translate-x-full rtl:max-lg:translate-x-full");
    expect(shell).toContain("bg-surface");
  });

  it("drawer content scrolls and the close button stays reachable", () => {
    expect(shell).toContain("overflow-y-auto");
    expect(shell).toContain('aria-label={t("common.close")}');
    expect(shell).toContain("onClick={closeMobile}");
  });

  it("bottom nav is safe-area aware and page content clears it", () => {
    expect(shell).toContain(
      'style={{ paddingBottom: "max(0.5rem, env(safe-area-inset-bottom))" }}',
    );
    expect(shell).toContain("fixed inset-x-3 bottom-3 z-30 flex items-center justify-around rounded-3xl px-2 py-2 lg:hidden");
    // main content AND the footer (which sits outside main) clear the nav.
    // Both class strings now live in template literals (so /community can opt
    // into full-height mode), so match on the tokens.
    expect(shell).toMatch(/<main[\s\S]{0,200}flex-1 pb-28 lg:pb-0/);
    expect(shell).toContain("pb-24 lg:pb-0");
  });

  it("the mobile header collapses to the mark so nothing overflows", () => {
    expect(shell).toContain('wordmarkClassName="hidden sm:inline"');
    const logo = read("src/components/brand-logo.tsx");
    expect(logo).toContain("wordmarkClassName?: string;");
    expect(logo).toContain("${wordmarkClass} ${wordmarkClassName}");
  });

  it("landing hero typography scales down and wraps on narrow screens", () => {
    const page = read("src/app/page.tsx");
    expect(page).toContain(
      "display-title text-neon-gradient anim-fade-up text-4xl break-words sm:text-5xl md:text-6xl xl:text-7xl",
    );
    // Decorative layers must never push the viewport horizontally.
    expect(page).toContain("overflow-hidden");
    expect(page).toContain("hero-orb pointer-events-none");
  });
});

describe("desktop sidebar (lg+): fixed start-edge rail, content beside it", () => {
  const shell = read("src/components/app-shell.tsx");

  it("sidebar is lg-only, fixed, full-height, on the LOGICAL start edge", () => {
    // start-0 => left in LTR, right in Arabic; border-e mirrors too.
    expect(shell).toContain("fixed inset-y-0 start-0 z-30 hidden flex-col border-e border-line");
    expect(shell).toContain("lg:flex");
    // 272px expanded / 84px icon rail (inside the required 240–280px band).
    expect(shell).toContain('collapsed ? "w-[84px]" : "w-[272px]"');
  });

  it("the content column offsets with a matching logical margin (RTL-safe)", () => {
    // margin-inline-start, not physical left — Arabic mirrors the layout.
    expect(shell).toContain('collapsed ? "lg:ms-[84px]" : "lg:ms-[272px]"');
  });

  it("reuses the SAME navigation model as the drawer (no duplicate nav)", () => {
    // One NAV_SECTIONS model, rendered by NavSectionList in BOTH surfaces.
    expect(shell).toContain("const NAV_SECTIONS: NavSection[]");
    expect(shell).not.toContain("PRIMARY_NAV");
    expect(shell).not.toContain("SecondaryMenu");
    // The sidebar's nav list is the shared component (icon-rail mode).
    const sidebarStart = shell.indexOf('aria-label={t("nav.workspace")}\n        className={`fixed inset-y-0');
    expect(sidebarStart).toBeGreaterThan(-1);
    const sidebarBlock = shell.slice(sidebarStart, shell.indexOf("</aside>", sidebarStart));
    expect(sidebarBlock).toContain("<NavSectionList");
    expect(sidebarBlock).toContain("collapsed={collapsed}");
  });

  it("sidebar footer hosts the REAL language/theme switchers (functional, dropUp)", () => {
    const sidebarStart = shell.indexOf('aria-label={t("nav.workspace")}\n        className={`fixed inset-y-0');
    const sidebarBlock = shell.slice(sidebarStart, shell.indexOf("</aside>", sidebarStart));
    // compact = icon-only trigger inside the 84px collapsed rail.
    expect(sidebarBlock).toContain("<LanguageSwitcher dropUp compact={collapsed} />");
    expect(sidebarBlock).toContain("<ThemeSwitcher dropUp />");
    // The compact prop is additive and defaults OFF (no behavior change
    // elsewhere); the menu itself is unchanged.
    const lang = read("src/components/language-switcher.tsx");
    expect(lang).toContain("compact = false");
    expect(lang).toContain("{!compact && <span className=\"uppercase\">{lang}</span>}");
  });

  it("the top header no longer carries desktop navigation (no duplication)", () => {
    // Mobile brand/trigger stays; desktop primary links + "More" are gone.
    expect(shell).toContain('wordmarkClassName="hidden sm:inline"');
    expect(shell).not.toContain("hidden items-center gap-1 lg:flex");
    // The collapse toggle still exists and drives the sidebar width.
    expect(shell).toContain("PanelLeftClose");
    expect(shell).toContain("PanelLeftOpen");
    expect(shell).toContain("toggleCollapsed");
    // Header switchers hand over to the sidebar at lg.
    expect(shell).toContain("hidden sm:block lg:hidden");
  });

  it("layering: sidebar above content/header, below drawer and modals", () => {
    // z ladder: content(auto) < header(20) < sidebar(30) < scrim/bottom-nav(30, mobile-only)
    // < drawer(40) < dropdowns/modals(50).
    expect(shell).toContain("fixed inset-y-0 start-0 z-30 hidden flex-col");
    expect(shell).toContain("sticky top-0 z-20");
    expect(shell).toContain("fixed inset-y-0 start-0 z-40 hidden max-lg:flex");
  });
});

describe("drawer language/theme controls: the menu must be ON-SCREEN (iPhone fix)", () => {
  const lang = read("src/components/language-switcher.tsx");
  const theme = read("src/components/theme-switcher.tsx");
  const shell = read("src/components/app-shell.tsx");

  it("both switchers support a dropUp anchor (menu above the button)", () => {
    for (const [name, src] of [
      ["LanguageSwitcher", lang],
      ["ThemeSwitcher", theme],
    ] as const) {
      expect(src, name).toContain("dropUp = false");
      // The menu position is the ONLY thing that flips — one menu, two anchors.
      expect(src, name).toContain('dropUp ? "bottom-11" : "top-11"');
    }
  });

  it("the drawer (bottom of the viewport) uses dropUp so taps produce a visible menu", () => {
    // The drawer footer is the full-height drawer's bottom edge: a
    // top-11 menu would render below the screen. dropUp puts it above.
    // (Located via the drawer's unique viewport-cap class — the desktop
    // sidebar is a second <aside> and appears earlier in the file.)
    const capIdx = shell.indexOf("max-w-[calc(100vw-1.5rem)]");
    const drawerStart = shell.lastIndexOf("<aside", capIdx);
    const drawerBlock = shell.slice(drawerStart, shell.indexOf("</aside>", drawerStart));
    expect(drawerBlock).toContain("<LanguageSwitcher dropUp />");
    expect(drawerBlock).toContain("<ThemeSwitcher dropUp />");
  });

  it("tapping an item still routes through the existing context (no parallel state)", () => {
    // Language: item -> setLang(value) from the provider (state + storage +
    // cookie action + <html lang/dir> effect all in that one path).
    expect(lang).toMatch(/onClick=\{\(\) => \{\s*setLang\(value\);\s*setOpen\(false\);/);
    // Theme: item -> choose(value) which persists AND applies the .dark class.
    expect(theme).toMatch(/onClick=\{\(\) => choose\(value\)\}/);
    // The toggle button itself must flip the open state (real pointer target).
    expect(lang).toContain("onClick={() => setOpen((value) => !value)}");
    expect(theme).toContain("onClick={() => setOpen((value) => !value)}");
    // Menus are conditionally rendered by the open state (tap -> UI change).
    expect(lang).toContain("{open && (");
    expect(theme).toContain("{open && (");
  });
});

describe("CV / cover-letter builders: mobile is a full-width single column", () => {
  const cv = read("src/components/cv-builder.tsx");
  const cl = read("src/components/cover-letter-builder.tsx");

  for (const [name, src] of [
    ["CV", cv],
    ["Cover Letter", cl],
  ] as const) {
    it(`${name}: control groups get their own full row on phones`, () => {
      // The cluster spans the full content width below sm (one control per
      // row); from sm up the groups sit side-by-side as before.
      expect(src).toContain(
        "flex w-full flex-wrap items-center gap-2.5 sm:w-auto sm:justify-end",
      );
      expect(src).toContain(
        "flex w-full rounded-xl border border-line-strong bg-surface p-1 sm:w-auto",
      );
    });

    it(`${name}: PDF button is full-width, never wraps its label, on phones`, () => {
      expect(src).toContain('className="w-full whitespace-nowrap sm:w-auto"');
    });

    it(`${name}: the editor column is explicitly full-width (no half-screen)`, () => {
      expect(src).toContain(
        'min-w-0 w-full ${mobileView === "edit" ? "" : "hidden lg:block"}',
      );
      // The workspace grid stays single-column until lg.
      expect(src).toContain(
        "grid w-full grid-cols-1 gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] lg:items-start",
      );
    });
  }

  it("CV inner form fields stay 100% wide until sm (no desktop 2-col leak)", () => {
    expect(cv).toContain("grid gap-3.5 sm:grid-cols-2");
    // Inputs are w-full by the shared Input primitive (audit the primitive).
    const ui = read("src/components/ui.tsx");
    expect(ui).toContain("h-12 w-full rounded-2xl");
  });
});
